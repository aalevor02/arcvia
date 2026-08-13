import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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
    this.renderer.toneMappingExposure = 1.0
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
   * Three neutral lights so an imported model is never invisible.
   *
   * These are replaced the moment a real rig is applied. Their only job is to
   * make sure "I uploaded a model and got a black screen" never happens.
   */
  private addDefaultRig(): void {
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(5, 8, 5)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.far = 60

    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5)
    fill.position.set(-6, 3, -4)

    const ambient = new THREE.HemisphereLight(0xdfe9ff, 0x35302b, 0.6)

    this.lightGroup.add(key, fill, ambient)
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

    this.renderer.setSize(width, height, false)
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

    const damping = this.controls.update(this.clock.getDelta())
    if (this.needsRender || damping) {
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
