import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { deriveFloors, isFloorNode } from './floors'
import type { FloorBox, FloorLevel } from './floors'

/**
 * How much environment survives once a lightmap is in charge.
 *
 * Low enough not to double-light the diffuse the bake already accounts for,
 * high enough to keep specular reflection alive — glass, polished stone and
 * metal have nothing else to reflect, and a lightmap supplies no specular at
 * all.
 */
const BAKED_ENVIRONMENT = 0.12

/**
 * Environment intensity when the scene is NOT lit by a bake.
 *
 * Named because it now has two callers — `setBakedLighting` restoring it and
 * `loadEnvironment` asserting it for a freshly picked HDRI — and two literals
 * that have to agree about one physical fact will eventually stop agreeing.
 */
const LIT_ENVIRONMENT = 0.85

export interface LightSpec {
  id: string
  type: 'point' | 'spot' | 'sun' | 'area'
  position: { x: number; y: number; z: number }
  target?: { x: number; y: number; z: number }
  color: [number, number, number]
  intensity: number
  angle?: number
  blend?: number
  size?: number
}

/**
 * A named camera bookmark.
 *
 * Mirrors the `views` array in a published scene manifest: a position, a
 * yaw/pitch pair rather than a quaternion (authors think in "facing which way",
 * not in four-component rotations), and the mode the view should be entered in.
 */
export interface SceneView {
  id: string
  name: string
  position: [number, number, number]
  /** [yaw, pitch] in degrees. Yaw 0 looks down -Z; pitch 0 is level. */
  rotation: [number, number]
  mode?: 'fps' | 'orbit'
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement
  onProgress?: (fraction: number) => void
  onReady?: (info: { triangles: number; objects: number }) => void
  onError?: (error: Error) => void
  /**
   * Called when the viewer downgrades itself to keep the frame rate usable.
   * Worth surfacing rather than swallowing: the picture visibly changes, and a
   * silent change looks like a bug in whatever the user did last.
   */
  onQualityDrop?: (reason: string) => void
}

/**
 * The 3D viewport.
 *
 * Deliberately a plain class rather than a React component tree. A render loop
 * that runs at 60fps has no business going through React's reconciler — React
 * owns the panels around the canvas, this owns everything inside it. The two
 * talk through explicit method calls.
 *
 * Lives in a shared package because the studio editor and the published
 * walkthrough must render through the same code path. When published output
 * had its own renderer (a third-party one, in the system this was rebuilt
 * from), the editor preview and the thing the client saw drifted apart and
 * nobody noticed until a client did.
 */
export class SceneViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly lightGroup = new THREE.Group()
  private readonly clock = new THREE.Clock()

  private model: THREE.Object3D | null = null
  private disposed = false
  private needsRender = true

  /**
   * The post-processing chain, or null when drawing straight to the canvas.
   *
   * Null is a real, supported state — see `setAmbientOcclusion`. Ambient
   * occlusion costs a depth-normal prepass and a blur every frame, which is a
   * poor trade on a phone, and on a scene already wearing a baked lightmap it
   * is redundant with something better.
   */
  private composer: EffectComposer | null = null
  private gtao: GTAOPass | null = null
  private framesDrawn = 0
  private slowFrames = 0

  /**
   * How long the last draw took to submit, in milliseconds.
   *
   * The time to *issue* a frame, not to finish drawing it — GPU work is
   * asynchronous. It is still the number worth having, because the only
   * alternative available from a page is to time `requestAnimationFrame`
   * intervals, and those are throttled to a crawl whenever the tab is not
   * visible. That makes rAF timing useless for judging cost: it reports
   * seconds per frame for an empty scene on a hidden tab, which is a
   * measurement of the throttle and nothing else.
   */
  lastFrameMs = 0

  /** Non-null while a goToView transition is in flight. */
  private transition: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromQuat: THREE.Quaternion
    toQuat: THREE.Quaternion
    elapsed: number
    duration: number
  } | null = null

  constructor(private readonly options: ViewerOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })

    // Cap at 2. On a 3x phone display the pixel count triples for a difference
    // almost nobody can see, and it is the fastest way to tank frame rate.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    // WebXR. Enabling it changes nothing until a session is actually requested
    // (see enterVR) — a desktop with no headset renders exactly as before — but
    // it must be set on the renderer before the first frame, and it is why the
    // loop below is driven by setAnimationLoop rather than requestAnimationFrame:
    // an XR device owns its own frame timing and rAF cannot serve it.
    this.renderer.xr.enabled = true

    // ACES filmic maps the wide dynamic range of an HDRI-lit interior into
    // something a monitor can show. Without it, bright windows clip to flat
    // white and the whole render looks like a video game from 2008.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // Slightly under 1: an interior lit by both a sun and an environment tends
    // to clip on the wall facing the window, and clipped white is the single
    // most "computer graphics" thing an image can do.
    this.renderer.toneMappingExposure = 0.95
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color(0x11151c)
    this.scene.add(this.lightGroup)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500)
    this.camera.position.set(6, 4, 6)

    this.controls = new OrbitControls(this.camera, options.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.495 // never let the user go under the floor
    this.controls.addEventListener('change', () => (this.needsRender = true))

    this.addDefaultRig()
    this.resize()
    // After resize, which is where the canvas first gets a real size: the
    // composer allocates its render targets from it, and a 0x0 target is a
    // black screen.
    this.setAmbientOcclusion(true)
    window.addEventListener('resize', this.resize)
    // setAnimationLoop, not requestAnimationFrame: it is the one driver that
    // serves both a normal page and a live XR session. Three swaps to the
    // headset's frame timing under the hood when a session starts; the loop
    // body does not have to know which it is running in.
    this.renderer.setAnimationLoop(this.loop)
  }

  /**
   * A default rig that reads as daylight in a room.
   *
   * ── Why the environment matters more than the lights ────────────────────
   * Three point lights on untextured geometry is what makes a render look like
   * a diagram: every surface is lit from a handful of directions and reflects
   * nothing, so nothing has any sense of being *in* a place.
   *
   * An image-based environment fixes that in one step. It lights every surface
   * from every direction at once and gives materials something to reflect,
   * which is where the impression of real material comes from. `RoomEnvironment`
   * generates one procedurally — no HDRI file to download, no CDN dependency,
   * and it is already tuned to look like a lit interior.
   *
   * The sun on top of it does the job the environment cannot: a single strong
   * direction, so there are real cast shadows and a bright side and a dark side.
   * Without it everything is evenly lit and the room reads flat again.
   *
   * What this still is *not* is baked global illumination. There is no colour
   * bleed between surfaces and no contact darkening in the corners, and that is
   * the remaining gap to a photoreal walkthrough — see docs/roadmap-parity.md.
   */
  /** The default rig's sun and sky bounce, for the sun study to drive. */
  private defaultSun: THREE.DirectionalLight | null = null
  private defaultBounce: THREE.DirectionalLight | null = null

  /**
   * Point the default sun along a real solar direction.
   *
   * ── What it drives, and what it deliberately does not ────────────────────
   * The direction and a plain intensity/colour ramp: low sun is warmer and
   * dimmer, below the horizon is night. It does NOT recolour the sky or the
   * environment — the study answers "where do the shadows fall at 4pm", and a
   * full time-of-day sky is a different feature wearing the same slider.
   *
   * No-ops (returning false) when an authored light rig has replaced the
   * default one: the author placed those lights on purpose, and a slider that
   * silently rewrites an authored rig is the editor arguing with its user.
   *
   * `direction` is the unit vector FROM the scene TOWARD the sun, world
   * space. The caller owns the compass convention; this owns the light.
   */
  setSunDirection(direction: { x: number; y: number; z: number }): boolean {
    const sun = this.defaultSun
    if (!sun || !sun.parent) return false

    if (direction.y <= 0) {
      // Night. The sun is off rather than repositioned below the floor, where
      // it would light interiors from beneath — memorably wrong. The bounce
      // stays faintly on so the model remains legible: this is a study, not a
      // power cut.
      sun.intensity = 0
      if (this.defaultBounce) this.defaultBounce.intensity = 0.25
      this.needsRender = true
      return true
    }

    // Inside the shadow camera's reach (far = 60, box ±20), whatever the angle.
    const DISTANCE = 30
    sun.position.set(direction.x * DISTANCE, direction.y * DISTANCE, direction.z * DISTANCE)

    // Low sun: dimmer and warmer. The ramp is perceptual, not radiometric —
    // enough that 8am reads as morning next to noon, no more.
    const height = Math.min(1, Math.max(0, direction.y))
    sun.intensity = 2.6 * (0.3 + 0.7 * Math.min(1, height * 2.2))
    sun.color.setHSL(0.084, 0.55, 0.62 + 0.28 * Math.min(1, height * 2))
    if (this.defaultBounce) this.defaultBounce.intensity = 0.55

    this.needsRender = true
    return true
  }

  private addDefaultRig(): void {
    // Warm, low-ish sun. Pure white from directly above is the giveaway look
    // of a default rig; real daylight arrives at an angle and has a colour.
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.6)
    sun.position.set(6, 9, 4)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.far = 60
    sun.shadow.camera.left = -20
    sun.shadow.camera.right = 20
    sun.shadow.camera.top = 20
    sun.shadow.camera.bottom = -20
    // Without a bias, a surface shadows itself in bands — "shadow acne".
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02

    // Cool sky bounce from the opposite side, so shadowed faces are blue-ish
    // rather than black. This is the cheap stand-in for sky illumination.
    const bounce = new THREE.DirectionalLight(0xbdd4ff, 0.55)
    bounce.position.set(-7, 4, -5)

    // Kept as fields so the sun study can drive them. Assigned here rather
    // than where they are declared, because this rig can be rebuilt — an
    // authored light rig replaces it, and clearing one re-creates it.
    this.defaultSun = sun
    this.defaultBounce = bounce

    this.lightGroup.add(sun, bounce)
    this.applyRoomEnvironment()
    this.applySkyBackground()
  }

  /**
   * A sky to see through the windows.
   *
   * ── Why an empty background is so damaging ──────────────────────────────
   * A window looking out onto flat darkness is not a neutral choice. Windows
   * are the brightest thing in almost every interior photograph, and the eye
   * uses them to calibrate everything else in the frame. When they come out
   * *darker* than the wall around them, the whole image reads as an object
   * floating in a void rather than a room inside a building — no amount of
   * work on the interior recovers from it.
   *
   * A vertical gradient is enough. What matters is that the opening is bright,
   * that there is a horizon so the building has an outside, and that the
   * ground below it is duller than the sky above.
   *
   * Generated rather than downloaded: an HDRI is several megabytes and a CDN
   * dependency, for something the client mostly perceives as "the window is
   * bright". A real HDRI remains the right call for a published walkthrough,
   * which is why `loadEnvironment` exists.
   */
  applySkyBackground(): void {
    const canvas = document.createElement('canvas')
    // Tall and narrow: the gradient only varies vertically, so horizontal
    // resolution buys nothing. Two pixels wide keeps the linear filter honest
    // at the seam.
    canvas.width = 2
    canvas.height = 256

    const context = canvas.getContext('2d')
    if (!context) return

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, '#5b86bd') // zenith — deeper blue overhead
    gradient.addColorStop(0.46, '#b9d0e6')
    gradient.addColorStop(0.5, '#dfe6ec') // haze at the horizon
    gradient.addColorStop(0.54, '#8a8378') // ground, and duller than the sky
    gradient.addColorStop(1, '#5f5a52')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)

    const texture = new THREE.CanvasTexture(canvas)
    // Equirectangular, so it wraps the whole scene and has a real horizon
    // line rather than being pasted flat behind the camera.
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.colorSpace = THREE.SRGBColorSpace

    // `background` may hold a plain Color, which has no GPU resource behind it
    // and no dispose. Only a texture needs releasing.
    if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose()
    this.scene.background = texture
    this.needsRender = true
  }

  /**
   * Light the scene from a generated interior environment.
   *
   * Also used as a fallback when no HDRI has been loaded, which is the normal
   * case in the editor — the alternative is an unlit-looking preview until
   * someone thinks to add one.
   */
  applyRoomEnvironment(intensity = 0.85): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()

    const room = new RoomEnvironment()
    const target = pmrem.fromScene(room, 0.04)

    this.scene.environment = target.texture
    this.scene.environmentIntensity = intensity

    // The generated scene and the generator are both throwaway; only the
    // resulting cube texture is kept. Not disposing them leaks a render target
    // and a scene graph on every call.
    room.dispose?.()
    pmrem.dispose()

    this.needsRender = true
  }

  /**
   * Turn screen-space ambient occlusion on or off.
   *
   * ── Why this is the single biggest realism lever before baking ───────────
   * Look at an untextured render of a room and what makes it read as a
   * computer model is not the lack of texture — it is that every surface meets
   * every other surface at a perfectly clean edge. In a real room, the corner
   * where two walls meet is darker than either wall, the line where a wall
   * meets the floor is darker still, and a sofa sits in a soft pool of shade.
   * That darkening is light that *failed to arrive* because nearby geometry was
   * in the way, and no amount of direct lighting produces it.
   *
   * Ambient occlusion approximates it from the depth buffer, per frame, for
   * everything on screen — including furniture the moment it is placed, with no
   * bake and no waiting. A baked lightmap does the same job properly (and adds
   * colour bleed, which this cannot), so this is the fast approximation that
   * makes the editor look right while you work, and the bake is the finish.
   *
   * Off by default on a scene wearing a lightmap: doubling up darkens corners
   * twice and looks dirty rather than lit.
   *
   * ── What it costs, measured ─────────────────────────────────────────────
   * On an Intel Iris Xe — integrated graphics, and the realistic case for a
   * client opening a walkthrough on a work laptop — a room at 2x pixel ratio:
   *
   *   plain render          1.4 ms per frame
   *   with this chain       2.2 ms per frame
   *   first frame          12.3 s   (shader compilation, once)
   *
   * Under a millisecond of real cost, so it is on by default.
   *
   * Beware of measuring this the obvious way. Timing `requestAnimationFrame`
   * intervals from an automated browser reported *seconds* per frame — for the
   * plain path as well — because a tab that is not visible has its rAF
   * throttled. That number is a measurement of the throttle. `lastFrameMs`
   * times the draw call itself, which is why it exists.
   *
   * A bake is still better where it applies: it computes true occlusion rather
   * than a screen-space approximation, adds colour bleed, and then costs
   * nothing per frame. This is what makes the editor look right *while you
   * work*, before anything has been baked, and it covers furniture the instant
   * it is placed. `loop` measures real frame cost and switches the chain off
   * if some other device cannot keep up.
   */
  setAmbientOcclusion(enabled: boolean): void {
    if (enabled === Boolean(this.composer)) return

    if (!enabled) {
      this.composer?.dispose()
      this.composer = null
      this.gtao = null
      // Back to drawing straight to the canvas, so the renderer owns
      // resolution again — restore what the constructor chose.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      this.resize()
      this.needsRender = true
      return
    }

    // Same pixel ratio as the plain path. Toggling post-processing should
    // change how the scene is lit, not how sharp it is.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // Two different sizes, and mixing them up is silent.
    //
    //   getSize()              CSS pixels   — what EffectComposer.setSize wants
    //   getDrawingBufferSize() device pixels — what a render target must be
    //
    // The composer multiplies by the pixel ratio itself. Hand it a target
    // already sized in device pixels and it will do it a second time.
    const css = this.renderer.getSize(new THREE.Vector2())
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2())

    // Half-float, and multisampled. Both matter:
    //   - The default 8-bit target clamps at 1.0, so every highlight is crushed
    //     to white *before* ACES gets a chance to roll it off — which is the
    //     exact flat, blown-out look tone mapping exists to prevent.
    //   - The renderer's own `antialias: true` does nothing once drawing goes
    //     through a render target, so the samples have to be asked for here or
    //     every edge in the scene turns to stairsteps.
    const target = new THREE.WebGLRenderTarget(buffer.x, buffer.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    })

    const composer = new EffectComposer(this.renderer, target)
    // Constructing with a target sets the composer's idea of its own size from
    // that target — device pixels — while every later `setSize` passes CSS
    // pixels. Restating both here puts them back in the same unit, and without
    // it the first resize scales the whole chain by the pixel ratio again.
    composer.setPixelRatio(this.renderer.getPixelRatio())
    composer.setSize(css.x, css.y)

    composer.addPass(new RenderPass(this.scene, this.camera))

    const gtao = new GTAOPass(this.scene, this.camera, buffer.x, buffer.y)
    // Radius is in world units, and the model is in metres. Around half a metre
    // is the distance over which a real corner visibly darkens; much larger and
    // whole walls go grey, much smaller and only the seam itself darkens, which
    // reads as an outline rather than as shade.
    gtao.updateGtaoMaterial({
      radius: 0.5,
      distanceExponent: 1,
      thickness: 1,
      scale: 1,
      samples: 16,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    })
    // Under 1 on purpose. Full-strength AO is the other way to look fake —
    // interiors end up with sooty corners, which no photograph has.
    gtao.blendIntensity = 0.75
    composer.addPass(gtao)

    // Last, always. This is what applies tone mapping and the output colour
    // space; without it the whole chain renders in linear space and the image
    // comes out washed-out and grey.
    composer.addPass(new OutputPass())

    this.composer = composer
    this.gtao = gtao
    this.needsRender = true
  }

  /** Whether the post chain is currently running. */
  hasAmbientOcclusion(): boolean {
    return this.composer !== null
  }

  /**
   * Hand lighting over to a baked atlas, or take it back.
   *
   * ── Why a bake is invisible without this ────────────────────────────────
   * Three.js *adds* lightmap irradiance to environment irradiance rather than
   * replacing it. So a scene lit by a sun, a bounce light and an environment at
   * 0.85 does not start looking baked when an atlas is attached — the
   * real-time lighting still supplies most of the diffuse, and the bake reads
   * as a slight overall brightening. Every corner the bake darkened is filled
   * straight back in by an environment that has no idea the walls exist.
   *
   * Which is the whole problem baking solves. The atlas already contains the
   * sun, the sky, the bounce and the occlusion, computed properly against the
   * real enclosure — so the real-time versions of all of those are not just
   * redundant, they are actively cancelling it out.
   *
   * The environment is dimmed rather than removed: it is the only source of
   * *specular* reflection, and a lightmap contributes none. Take it to zero and
   * every glazed, polished or metal surface goes dead flat — the room reads
   * correctly lit and made entirely of chalk.
   */
  setBakedLighting(enabled: boolean): void {
    this.lightGroup.visible = !enabled
    // Shadow maps have nothing left to do once the lights are off, and they
    // are the most expensive thing in the frame.
    this.renderer.shadowMap.enabled = !enabled
    this.scene.environmentIntensity = enabled ? BAKED_ENVIRONMENT : LIT_ENVIRONMENT

    // Screen-space AO on top of a baked scene darkens corners that are already
    // darkened, and the result reads as grime rather than shade. The bake
    // computes better occlusion than GTAO can, including colour bleed.
    if (enabled && this.composer) this.setAmbientOcclusion(false)

    this.needsRender = true
  }

  /**
   * Draw the scene right now and return it as a data URL.
   *
   * Synchronous on purpose, and that is the whole trick: the drawing buffer is
   * cleared when the browser next composites, so reading it from a later
   * callback returns a blank image. Rendering and reading in the same task is
   * what makes this work without `preserveDrawingBuffer`, which would cost
   * every frame in the session for the sake of an occasional capture.
   *
   * Downscaled through a 2D canvas rather than captured at full device
   * resolution — a project thumbnail is a few hundred pixels wide, and a 4.8
   * megapixel PNG to produce it is pure waste.
   */
  snapshot({ width = 960, type = 'image/jpeg', quality = 0.88 } = {}): string {
    if (this.composer) this.composer.render(0)
    else this.renderer.render(this.scene, this.camera)

    const source = this.options.canvas
    const scaled = document.createElement('canvas')
    scaled.width = width
    scaled.height = Math.round((width * source.height) / source.width)

    const context = scaled.getContext('2d')
    if (!context) return ''

    context.drawImage(source, 0, 0, scaled.width, scaled.height)
    return scaled.toDataURL(type, quality)
  }

  /**
   * Change the camera's field of view.
   *
   * ── Why this matters more than walking speed ────────────────────────────
   * 50 degrees is right for looking *at* a building from outside and wrong for
   * being inside one. At 50 a 3 m room fills the screen with a single wall,
   * there is no peripheral vision to steer by, and a doorway two metres to the
   * side is off-screen — which is what makes moving around feel cramped and
   * disorienting rather than slow.
   *
   * Games settled on 65 to 75 for exactly this reason, and interior
   * walkthroughs are the same problem. The cost is mild perspective
   * exaggeration at the frame edges, which nobody notices while moving and
   * everybody notices the absence of.
   */
  setFieldOfView(degrees: number): void {
    this.camera.fov = Math.max(30, Math.min(100, degrees))
    this.camera.updateProjectionMatrix()
    this.needsRender = true
  }

  getFieldOfView(): number {
    return this.camera.fov
  }

  /**
   * Stand the camera inside the model, at eye height.
   *
   * Entering a walkthrough from wherever the orbit camera happened to be puts
   * the visitor outside the building looking at it — which reads as the
   * walkthrough being broken, because nothing about pressing "walk through it"
   * suggests you will end up in the garden.
   *
   * The studio has better information and uses it: it drops you into the
   * largest *room*, which it knows from the plan graph. A published
   * walkthrough has only geometry, so this is the honest fallback — the centre
   * of the model's footprint, at eye height above its floor. For a single
   * building that is inside it; for a scene of several detached masses it may
   * land between them, which is the limit of what a bounding box can tell you.
   *
   * Returns false when there is no model, so the caller can decline to enter
   * rather than walking around inside nothing.
   */
  standInside(eyeHeight = 1.6): boolean {
    if (!this.model) return false

    const box = new THREE.Box3().setFromObject(this.model)
    if (box.isEmpty()) return false

    const centre = box.getCenter(new THREE.Vector3())
    this.camera.position.set(centre.x, box.min.y + eyeHeight, centre.z)

    // Face along the longer horizontal axis. A room is usually entered looking
    // down its length, and it puts more of the space in the first frame than
    // facing the nearest wall does.
    const size = box.getSize(new THREE.Vector3())
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(0, size.x >= size.z ? Math.PI / 2 : 0, 0)

    // ── A near plane for standing in the room, not orbiting it ──────────────
    // `frameModel` sets `near = distance / 100`, which is scaled to the WHOLE
    // model's radius — correct for orbiting, and on a real reconstruction that
    // is 0.25–0.39 m. From inside, a wall 30 cm ahead of the eye is then
    // clipped away entirely, and `WalkController` deliberately has no collision
    // so a visitor does walk right up to surfaces: the client's buyer sees
    // straight through a wall into the next room. 5 cm is closer than anyone
    // stands to a wall and clears the z-fighting a fixed small near causes on a
    // big site plan — which is why it belongs on the walking path, not the
    // orbit one. `frameModel` restores its own values on exit, and both walk
    // callers (view/index.astro, SceneView) already call it when leaving.
    this.camera.near = 0.05
    this.camera.far = Math.max(this.camera.far, 200)
    this.camera.updateProjectionMatrix()

    this.needsRender = true
    return true
  }

  /**
   * Load a baked lightmap atlas and hand lighting over to it.
   *
   * ── Why this lives here and not in each app ─────────────────────────────
   * It was written twice — once in the studio, once inline in the published
   * viewer page — and the second copy had a bug the first did not: it assigned
   * an *array* of materials to every mesh, and a mesh with an array material
   * and no geometry groups draws nothing at all. The published walkthrough
   * rendered an empty sky.
   *
   * That is exactly the drift this package exists to prevent. The editor
   * preview and the thing a client opens must render through one code path, or
   * they disagree and nobody notices until a client does.
   *
   * Resolves to the number of meshes lit. Zero is meaningful: it means the
   * geometry arrived without lightmap UVs, so the atlas has nothing to address.
   */
  async applyBakedLightmap(url: string, intensity = 2.2): Promise<number> {
    const texture = await new Promise<THREE.Texture>((resolve, reject) => {
      new THREE.TextureLoader()
        .setCrossOrigin('anonymous')
        .load(url, resolve, undefined, () =>
          reject(new Error('The baked lightmap could not be loaded.')),
        )
    })

    texture.flipY = false
    texture.colorSpace = THREE.SRGBColorSpace
    // Channel 1, always. Since r152 a texture picks its UV attribute with
    // `channel`, and the default of 0 is the albedo set — which runs 0-1 across
    // every face, so every surface renders the whole atlas smeared over it.
    texture.channel = 1
    texture.needsUpdate = true

    let applied = 0

    this.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      // No lightmap UVs, nothing to address. Applying anyway would light the
      // mesh with whatever the albedo UVs happen to point at.
      if (!child.geometry.getAttribute('uv1')) return

      const wasArray = Array.isArray(child.material)
      const materials = wasArray ? child.material : [child.material]

      const lit = materials.map((material: THREE.Material) => {
        // Cloned per mesh: materials are shared across a scene, and a shared
        // one carrying a lightmap would light every other mesh with it.
        const clone = material.clone() as THREE.MeshStandardMaterial
        clone.lightMap = texture
        clone.lightMapIntensity = intensity
        return clone
      })

      // Preserve the original shape. Handing a single-material mesh an array
      // is not a harmless generalisation — without geometry groups to index
      // it, the mesh renders nothing.
      child.material = wasArray ? lit : lit[0]
      applied++
    })

    // The atlas already contains the sun, sky, bounce and occlusion. Leaving
    // the real-time rig on top does not add to it, it cancels it out.
    if (applied > 0) this.setBakedLighting(true)
    this.needsRender = true

    return applied
  }

  /**
   * The AO pass itself, for tuning.
   *
   * Exposed because "the corners are not dark enough" cannot be diagnosed from
   * the outside: the fix is to flip `output` to `GTAOPass.OUTPUT.AO` and look
   * at the raw occlusion buffer, and there is no other way to reach it.
   */
  get ambientOcclusionPass(): GTAOPass | null {
    return this.gtao
  }

  async loadModel(url: string): Promise<void> {
    const loader = new GLTFLoader()

    // Draco-compressed geometry is common in architectural exports and can be a
    // 5-10x size saving. Without the decoder attached the load simply fails
    // with an unhelpful parse error.
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    loader.setDRACOLoader(draco)

    try {
      const gltf = await loader.loadAsync(url, (event) => {
        if (event.lengthComputable) {
          this.options.onProgress?.(event.loaded / event.total)
        }
      })

      this.clearModel()
      this.model = gltf.scene

      let triangles = 0
      let objects = 0
      this.model.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        objects += 1
        child.castShadow = true
        child.receiveShadow = true

        const geometry = child.geometry as THREE.BufferGeometry
        triangles += geometry.index
          ? geometry.index.count / 3
          : geometry.attributes.position.count / 3
      })

      this.scene.add(this.model)
      this.frameModel()
      this.needsRender = true
      this.options.onReady?.({ triangles: Math.round(triangles), objects })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Could not load the model.')
      this.options.onError?.(failure)

      // ⚠ Rethrow. Reporting is not the same as succeeding, and this used to do
      // only the first — `onError` fired and the promise RESOLVED, so `await
      // loadModel(url)` continued into the success path with no model in the
      // scene.
      //
      // What that looked like, measured on the published walkthrough with a
      // scene whose GLB 404s: the client got a serene empty sky-and-ground
      // world with the full chrome on top of it — room chip, "Walk through it",
      // "Overview", "Leave a note" — and no error anywhere. `view/index.astro`
      // DID write one, via this callback, and then deleted it four hundred
      // lines later when its success path ran `els.status.classList.add('gone')`
      // and revealed the controls. A message that is overwritten by the
      // success path is not an error report.
      //
      // The callers already assumed this contract. `apps/studio`'s SceneView
      // has attached `.catch(() => setStatus('The stored model could not be
      // loaded.'))` to this call since it was written, and that handler had
      // never once run — while its `.then()` reported "Ready" over a failed
      // load. Rejecting makes the code that was already there correct.
      //
      // `onError` is kept as well as the throw: it carries the specific message
      // to a UI that is already showing a progress bar, while the throw is what
      // stops the caller proceeding. They answer different questions — what to
      // tell the visitor, and whether to carry on.
      throw failure
    } finally {
      draco.dispose()
    }
  }

  /**
   * Show geometry that was built in memory rather than loaded from a file.
   *
   * This is how the floor-plan editor previews itself in 3D: the plan is
   * extruded to meshes locally and handed straight over, with no round-trip
   * through a GLB. Going via a file would mean exporting, uploading and
   * re-parsing on every wall edit, which is both slow and a chance for the
   * preview to disagree with the plan.
   *
   * Takes ownership: the previous model is disposed exactly as `loadModel`
   * would, so repeated calls while editing do not leak GPU buffers.
   */
  setModel(object: THREE.Object3D): void {
    this.clearModel()
    this.model = object

    let triangles = 0
    let objects = 0
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      objects += 1
      child.castShadow = true
      child.receiveShadow = true

      const geometry = child.geometry as THREE.BufferGeometry
      triangles += geometry.index
        ? geometry.index.count / 3
        : geometry.attributes.position.count / 3
    })

    this.scene.add(object)
    this.needsRender = true
    this.options.onReady?.({ triangles: Math.round(triangles), objects })
  }

  /**
   * Light the scene from an HDRI.
   *
   * ── Three faults this had, all of them silent ──────────────────────────────
   * Found by the session wiring the asset hub's 301 CC0 HDRIs to a picker, and
   * verified here before fixing. None of them throws; each produces a viewer
   * that looks subtly wrong and blames the HDRI.
   *
   * 1. THE PREVIOUS TEXTURE WAS NEVER DISPOSED. `applySkyBackground` a few
   *    hundred lines up disposes carefully and explains why; this did not, so
   *    every pick leaked a cubemap. Three.js does not free GPU memory on its
   *    own — that is the first thing this repo's own notes say about it.
   *
   *    This was NOT merely latent, which is worth recording because the report
   *    that found it said "only reachable once something calls it".
   *    `loadEnvironment` already has two callers — `apps/visualisation`'s
   *    dollhouse-live and walkthrough-live pages — so the leak has been
   *    reachable in production all along. Bounded there because those pages
   *    load once per scene, which is exactly why nobody saw it.
   *
   * 2. IT NEVER SET `environmentIntensity`. Enabling a lightmap bake drops that
   *    to BAKED_ENVIRONMENT (0.12), because a baked scene already carries its
   *    indirect light and would double-count. An HDRI chosen AFTER a bake
   *    therefore arrived seven times dimmer than the 0.85 default and looked
   *    like a bad HDRI. The user's next move is to pick a different one, which
   *    is also dim.
   *
   * 3. NO ERROR PATH. A failed fetch or a malformed .hdr rejected into whatever
   *    called it. `models.ts` deliberately warns and keeps its stand-in rather
   *    than tearing down the scene; an environment is strictly less essential
   *    than a model, so it has even less business taking the viewer with it.
   *
   * Returns whether the environment actually loaded, so a caller can leave its
   * picker on the previous selection instead of showing one that is not applied.
   */
  async loadEnvironment(url: string): Promise<boolean> {
    let texture: THREE.DataTexture
    try {
      texture = await new RGBELoader().loadAsync(url)
    } catch (error) {
      // Keep whatever is lighting the scene now. A viewer with the wrong
      // environment is usable; a viewer that threw during a picker click is not.
      console.warn(`[SceneViewer] could not load environment ${url}:`, error)
      return false
    }

    texture.mapping = THREE.EquirectangularReflectionMapping

    // Dispose the outgoing one AFTER the new one is in hand, never before: on a
    // failed load the old environment is still the one on screen.
    const previous = this.scene.environment
    this.scene.environment = texture
    if (previous instanceof THREE.Texture && previous !== texture) previous.dispose()

    // An HDRI is a real environment, so it gets the un-baked intensity. If a
    // bake is subsequently toggled, `setBaked` reasserts BAKED_ENVIRONMENT.
    this.scene.environmentIntensity = LIT_ENVIRONMENT

    this.needsRender = true
    return true
  }

  /** Replace the light rig with the one the user authored. */
  applyLights(lights: LightSpec[]): void {
    this.lightGroup.clear()

    for (const spec of lights) {
      const color = new THREE.Color(...spec.color)
      let light: THREE.Light

      switch (spec.type) {
        case 'sun':
          light = new THREE.DirectionalLight(color, spec.intensity)
          break
        case 'spot': {
          const spot = new THREE.SpotLight(color, spec.intensity)
          spot.angle = spec.angle ?? 0.6
          spot.penumbra = spec.blend ?? 0.2
          light = spot
          break
        }
        case 'area':
          // Three has no baked area light in the standard renderer; a point
          // light approximates it in the viewport. The Blender bake uses a real
          // area light, so the final render will be softer than the preview.
          light = new THREE.PointLight(color, spec.intensity, 0, 2)
          break
        default:
          light = new THREE.PointLight(color, spec.intensity, 0, 2)
      }

      light.position.set(spec.position.x, spec.position.y, spec.position.z)
      light.castShadow = spec.type !== 'area'

      if (spec.target && 'target' in light) {
        const target = new THREE.Object3D()
        target.position.set(spec.target.x, spec.target.y, spec.target.z)
        this.lightGroup.add(target)
        ;(light as THREE.SpotLight).target = target
      }

      this.lightGroup.add(light)
    }

    if (lights.length === 0) this.addDefaultRig()
    this.needsRender = true
  }

  /** Frame the whole model regardless of the units it was authored in. */
  frameModel(): void {
    if (!this.model) return

    const box = new THREE.Box3().setFromObject(this.model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1

    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360)

    this.camera.position.copy(center).add(
      new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(distance * 1.4),
    )
    // Clip planes scaled to the model: a fixed near plane of 0.1 z-fights badly
    // on a 200m site plan, and clips through walls on a 3m room.
    this.camera.near = distance / 100
    this.camera.far = distance * 20
    this.camera.updateProjectionMatrix()

    this.controls.target.copy(center)
    this.controls.update()
    this.needsRender = true
  }

  /**
   * What is under a screen point, in world space.
   *
   * For placing a hotspot: the author clicks the worktop and the marker lands
   * on the worktop. Returns null when the click misses the model, which is a
   * real outcome — clicking the sky should place nothing rather than guess a
   * distance.
   *
   * Client coordinates, not canvas-relative, because that is what a pointer
   * event carries and converting at the call site is one more thing for each
   * caller to get subtly wrong.
   */
  pick(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.model) return null

    const rect = this.options.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)

    const hits = raycaster.intersectObject(this.model, true)
    return hits.length > 0 ? hits[0].point.clone() : null
  }

  /**
   * Where a world point falls on screen, and whether it should be drawn.
   *
   * Hotspot markers are DOM elements rather than sprites — real text, real
   * links, selectable, accessible, and legible at any distance without a
   * texture. The cost is that something has to place them every frame, which
   * is this.
   *
   * `visible` is false behind the camera and, when `occlude` is set, when the
   * model itself is in the way. Without the occlusion test a marker labelling
   * the kitchen worktop hovers over the wall you are facing while standing in
   * the hall, which reads as a bug rather than as a label on something
   * elsewhere.
   */
  project(
    position: [number, number, number],
    { occlude = true } = {},
  ): { x: number; y: number; visible: boolean; distance: number } {
    const point = new THREE.Vector3(...position)
    const distance = point.distanceTo(this.camera.position)

    const ndc = point.clone().project(this.camera)
    const rect = this.options.canvas.getBoundingClientRect()

    // z beyond 1 is behind the near/far range — in practice, behind the camera.
    let visible = ndc.z < 1 && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1

    if (visible && occlude && this.model) {
      const direction = point.clone().sub(this.camera.position).normalize()
      const raycaster = new THREE.Raycaster(this.camera.position.clone(), direction)
      const hits = raycaster.intersectObject(this.model, true)
      // A small tolerance, because the marker sits *on* a surface: without it
      // every hotspot occludes itself against the very thing it labels.
      if (hits.length > 0 && hits[0].distance < distance - 0.05) visible = false
    }

    return {
      x: ((ndc.x + 1) / 2) * rect.width,
      y: ((1 - ndc.y) / 2) * rect.height,
      visible,
      distance,
    }
  }

  /** Fires after every draw, for overlays that must track the camera. */
  onAfterRender: (() => void) | null = null

  /**
   * Capture where the camera is now as a named view.
   *
   * The exact counterpart to `goToView`, and deliberately next to it: between
   * them they own two conventions that are easy to get wrong in opposite
   * directions — rotation stored as `[yaw, pitch]` rather than a quaternion,
   * and stored in *degrees*. Split them across files and one side eventually
   * saves radians while the other reads degrees, which produces a view that
   * points at the floor and no error at all.
   *
   * Yaw and pitch rather than a quaternion because a view is authored by a
   * person: "facing the window" is a direction someone can reason about and
   * hand-edit, and four normalised components are not.
   */
  currentView(name: string, mode: 'fps' | 'orbit' = 'fps'): SceneView {
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')

    return {
      // Not a random id: a view keyed by its own name survives the scene being
      // exported, hand-edited and re-imported, which a generated id does not.
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'view',
      name,
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      rotation: [THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.x)],
      mode,
    }
  }

  /**
   * Move to a named view, easing rather than cutting.
   *
   * A hard cut between two interior cameras is genuinely disorienting — the
   * viewer loses all sense of how the rooms connect. The published system this
   * was modelled on animates every view switch for the same reason.
   */
  goToView(view: SceneView, animate = true): void {
    const toPos = new THREE.Vector3(...view.position)
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(view.rotation[1]),
      THREE.MathUtils.degToRad(view.rotation[0]),
      0,
      'YXZ',
    )
    const toQuat = new THREE.Quaternion().setFromEuler(euler)

    if (!animate) {
      this.camera.position.copy(toPos)
      this.camera.quaternion.copy(toQuat)
      this.syncOrbitTarget()
      this.needsRender = true
      return
    }

    this.transition = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromQuat: this.camera.quaternion.clone(),
      toQuat,
      elapsed: 0,
      duration: 1.1,
    }
    this.needsRender = true
  }

  /**
   * Keep the orbit target a metre in front of the camera.
   *
   * Without this, re-enabling orbit after a walk sequence snaps the view back
   * to wherever the target was last left — usually the centre of the model,
   * which reads as the camera lurching across the room.
   */
  private syncOrbitTarget(): void {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
    this.controls.target.copy(this.camera.position).add(forward)
    this.controls.update()
  }

  /** Current camera state, in the shape the render API expects. */
  cameraSpec() {
    const quaternion = this.camera.quaternion
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      rotation: {
        x: quaternion.x,
        y: quaternion.y,
        z: quaternion.z,
        w: quaternion.w,
      },
      focalLength: this.camera.getFocalLength(),
    }
  }

  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value
    this.needsRender = true
  }

  /** Whether a model is currently loaded. */
  hasModel(): boolean {
    return this.model !== null
  }

  /**
   * The loaded model's root, for presentations that animate parts of it.
   *
   * The published villas export one object per floor (`floor_lower-ground`,
   * `floor_stilt`, …) so a dollhouse view can lift each level independently.
   */
  get modelRoot(): THREE.Object3D | null {
    return this.model
  }

  /** The camera, for controllers that drive it directly (e.g. walk mode). */
  get cameraObject(): THREE.PerspectiveCamera {
    return this.camera
  }

  /**
   * The storeys this model contains, bottom-up — [] for a single-storey model.
   *
   * Derived from the geometry's own names (see floors.ts for the three naming
   * conventions and why the scene record cannot answer this), so it works on
   * the published page, which receives no plan, exactly as it does in the
   * studio. `WalkController.setFloorLevel` existed for years with one caller;
   * this is what lets the published walkthrough reach the other floors.
   */
  floorLevels(): FloorLevel[] {
    if (!this.model) return []
    const nodes: { name: string; box: FloorBox }[] = []
    this.model.updateWorldMatrix(true, true)
    this.model.traverse((object) => {
      if (!object.name || !isFloorNode(object.name)) return
      const box = new THREE.Box3().setFromObject(object)
      if (!box.isEmpty()) nodes.push({ name: object.name, box })
    })
    return deriveFloors(nodes)
  }

  /**
   * Hand camera control to something else.
   *
   * Orbit and walk cannot both own the camera; whichever is enabled last would
   * fight the other every frame.
   */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled
    if (enabled) this.syncOrbitTarget()
    this.needsRender = true
  }

  /** Ask for one more frame — for external controllers that moved the camera. */
  requestRender(): void {
    this.needsRender = true
  }

  private clearModel(): void {
    if (!this.model) return
    this.scene.remove(this.model)

    // Three does not garbage-collect GPU memory. Loading five models without
    // disposing leaks all five sets of buffers and textures until the tab dies.
    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose()
        }
        material.dispose()
      }
    })
    this.model = null
  }

  private resize = (): void => {
    const canvas = this.options.canvas
    const parent = canvas.parentElement
    if (!parent) return

    const width = parent.clientWidth
    const height = parent.clientHeight
    if (width === 0 || height === 0) return

    // `true` — let Three set the CSS size as well as the backing store.
    //
    // This was `false`, which means "the caller owns the element's CSS size",
    // and no caller did. With no CSS size a canvas displays at its *attribute*
    // size in CSS pixels, and the attribute size is width x pixelRatio. At
    // devicePixelRatio 1 that happens to equal the parent and everything looks
    // fine; at 2 the canvas renders twice its box, stretches the parent it is
    // measured against, and each resize makes it bigger — a feedback loop that
    // ends with a canvas thousands of pixels tall and a black viewport.
    //
    // Only reproducible on a HiDPI display, which is why it survived this long.
    this.renderer.setSize(width, height, true)
    // The composer owns its own render targets, so it has to be told
    // separately — miss this and the post chain keeps rendering at the old
    // size and the result is stretched across the new canvas.
    //
    // CSS pixels, and only here: `setSize` forwards device pixels on to every
    // pass, so calling `gtao.setSize` as well would immediately overwrite that
    // with the wrong unit.
    this.composer?.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.needsRender = true
  }

  /**
   * Render on demand rather than every frame.
   *
   * An architectural scene is static most of the time. Redrawing a stationary
   * view at 60fps burns battery on a laptop and throttles a phone for no visual
   * gain, so we only draw when something actually changed — or while the
   * damping from the last drag is still settling.
   */
  private loop = (): void => {
    if (this.disposed) return
    // No requestAnimationFrame here — setAnimationLoop calls this every frame.

    // ── In VR, render every frame, straight to the headset ───────────────────
    // A headset is never "still": the head moves continuously, so the on-demand
    // gate below would starve it. And the post-processing composer is not
    // XR-aware — it renders into its own targets, not the per-eye framebuffers —
    // so presenting must go through the plain renderer. Head pose is the camera;
    // orbit controls and view transitions are meaningless and skipped.
    if (this.renderer.xr.isPresenting) {
      this.renderer.render(this.scene, this.camera)
      return
    }

    const delta = this.clock.getDelta()
    let moving = false

    if (this.transition) {
      const t = this.transition
      t.elapsed += delta
      const raw = Math.min(t.elapsed / t.duration, 1)
      // easeInOutCubic — starts and ends still, which is what makes the move
      // read as a camera rather than a teleport.
      const k = raw < 0.5 ? 4 * raw ** 3 : 1 - (-2 * raw + 2) ** 3 / 2

      this.camera.position.lerpVectors(t.fromPos, t.toPos, k)
      this.camera.quaternion.slerpQuaternions(t.fromQuat, t.toQuat, k)
      moving = true

      if (raw >= 1) {
        this.transition = null
        this.syncOrbitTarget()
      }
    }

    const damping = this.controls.enabled && this.controls.update(delta)
    if (this.needsRender || damping || moving) {
      // Still on demand with the composer attached. Post-processing does not
      // change when a static scene needs redrawing, only what a redraw costs —
      // and it costs more, so demand-driven matters more, not less.
      const started = performance.now()
      if (this.composer) this.composer.render(delta)
      else this.renderer.render(this.scene, this.camera)
      this.lastFrameMs = performance.now() - started

      // Only the composed path is judged. The plain path has nothing to fall
      // back to, so measuring it would only ever produce a number nobody acts
      // on.
      if (this.composer) this.recordFrameCost(this.lastFrameMs)
      this.needsRender = false

      // After the draw, not before: an overlay that positions itself against
      // the previous frame's camera lags one frame behind the scene, which on
      // a drag looks like the markers are sliding around independently.
      this.onAfterRender?.()
    }
  }

  /**
   * Give up on post-processing if this machine cannot afford it.
   *
   * GPU work is asynchronous, so this measures the time to *submit* a frame,
   * not to finish drawing it — but when a driver is genuinely saturated the
   * submission blocks too, which is exactly the case worth catching. Measured
   * on an Intel Iris Xe, the unusable configuration reported seconds here, so
   * the signal is not subtle.
   *
   * The first frames are discarded: they include shader compilation, which is
   * a one-off and on this hardware was fifteen seconds by itself. Judging on
   * those would disable AO on every machine.
   */
  private recordFrameCost(ms: number): void {
    this.framesDrawn += 1
    if (this.framesDrawn <= 3) return

    // Never judge a tab that is not on screen.
    //
    // A hidden tab is throttled and its frames are never presented, so the swap
    // chain fills and the *draw call itself* starts blocking — measured at over
    // a second for a 664-triangle scene that draws in about two milliseconds
    // when visible. Without this guard, switching tabs and coming back would
    // silently and permanently turn off ambient occlusion, and it would look
    // like the editor had broken itself.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.slowFrames = 0
      return
    }

    // A tolerant threshold, because this is a hard fallback rather than a
    // quality dial. 250ms is already a viewport that feels stuck to a drag;
    // anything worse is not a trade-off, it is a broken preview.
    if (ms < 250) {
      this.slowFrames = 0
      return
    }

    // Two in a row, so a single stall — a texture upload, a tab regaining
    // focus — does not permanently downgrade the scene.
    if (++this.slowFrames < 2) return

    this.setAmbientOcclusion(false)
    this.options.onQualityDrop?.(
      'Ambient occlusion is off — this device could not draw it smoothly.',
    )
  }

  dispose(): void {
    this.disposed = true
    // Stop the driver installed in the constructor. cancelAnimationFrame is the
    // wrong tool now — nothing hands out a frame handle — and leaving the loop
    // registered keeps the renderer (and the whole scene) alive after dispose.
    this.renderer.setAnimationLoop(null)
    window.removeEventListener('resize', this.resize)
    this.clearModel()
    this.composer?.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }

  // ---------------------------------------------------------------------------
  // WebXR
  // ---------------------------------------------------------------------------

  /**
   * Whether this browser and device can present immersive VR.
   *
   * Async because `isSessionSupported` is — the browser may ask the runtime.
   * Returns false rather than throwing anywhere it cannot answer (no WebXR,
   * an insecure context, a runtime that refuses the query), so a caller can
   * `if (await viewer.isVRSupported())` without a guard of its own.
   */
  async isVRSupported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr
    if (!xr?.isSessionSupported) return false
    try {
      return await xr.isSessionSupported('immersive-vr')
    } catch {
      return false
    }
  }

  /**
   * Enter immersive VR, standing where a walkthrough would put the visitor.
   *
   * The headset provides head pose relative to a floor-level reference space;
   * `standInside` decides WHERE that floor is in the model. Without offsetting
   * the reference space the visitor would start at the model's origin — which
   * for a reconstructed building is a corner of the site, outside the walls —
   * so the reference space is shifted to the eye position `standInside` chose.
   *
   * Resolves when the session is running; rejects if the request is refused
   * (no device, permission denied, another session already active), so the UI
   * can put its button back rather than lie that VR is on.
   */
  async enterVR(eyeHeight = 1.6): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr
    if (!xr) throw new Error('This browser has no WebXR support.')

    // Position the camera as the walkthrough would, so the offset below starts
    // the visitor inside the building rather than at the site origin.
    this.standInside(eyeHeight)
    const start = this.camera.position.clone()

    const session = await xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    })
    await this.renderer.xr.setSession(session as unknown as XRSession)

    // Shift the reference space so physical floor-origin maps to `start`. The
    // XR transform is in the headset's own axes (y up, -z forward, metres),
    // which is the same as the model's here; only the horizontal placement and
    // the standing height need to move. The offset is the INVERSE of where we
    // want to stand, because it moves the world under a fixed viewer.
    const base = this.renderer.xr.getReferenceSpace()
    if (base && typeof XRRigidTransform !== 'undefined') {
      const offset = new XRRigidTransform({
        x: -start.x,
        y: -(this.model ? new THREE.Box3().setFromObject(this.model).min.y : 0),
        z: -start.z,
      })
      this.renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(offset))
    }

    // When the visitor takes the headset off, hand control back to orbit and
    // reframe, so the desktop view is not left standing in a wall.
    session.addEventListener(
      'end',
      () => {
        this.needsRender = true
        this.frameModel()
      },
      { once: true },
    )
  }

  /** Leave VR, if a session is running. */
  async exitVR(): Promise<void> {
    await this.renderer.xr.getSession()?.end()
  }
}
