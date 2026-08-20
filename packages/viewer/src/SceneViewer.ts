import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

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
      this.renderer.render(this.scene, this.camera)
      this.needsRender = false
    }
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    window.removeEventListener('resize', this.resize)
    this.clearModel()
    this.controls.dispose()
    this.renderer.dispose()
  }
}
