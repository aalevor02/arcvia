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
  private frameHandle = 0
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
    this.loop()
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
      this.options.onError?.(
        error instanceof Error ? error : new Error('Could not load the model.'),
      )
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

  async loadEnvironment(url: string): Promise<void> {
    const texture = await new RGBELoader().loadAsync(url)
    texture.mapping = THREE.EquirectangularReflectionMapping
    this.scene.environment = texture
    this.needsRender = true
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
    this.frameHandle = requestAnimationFrame(this.loop)

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
    cancelAnimationFrame(this.frameHandle)
    window.removeEventListener('resize', this.resize)
    this.clearModel()
    this.composer?.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }
}
