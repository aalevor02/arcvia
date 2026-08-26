import * as THREE from 'three'

export interface PanoramaViewerOptions {
  canvas: HTMLCanvasElement
  src: string
  onLoad?: () => void
  onError?: (error: unknown) => void
}

/** Interactive renderer for a 2:1 equirectangular image. */
export class PanoramaViewer {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(70, 2, 0.01, 100)
  private readonly geometry = new THREE.SphereGeometry(10, 64, 40)
  private readonly material = new THREE.MeshBasicMaterial({ color: 0x20242a })
  private readonly texture: THREE.Texture
  private readonly observer: ResizeObserver
  private pointer: { id: number; x: number; y: number } | null = null
  private yaw = 0
  private pitch = 0
  private disposed = false

  constructor({ canvas, src, onLoad, onError }: PanoramaViewerOptions) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.camera.rotation.order = 'YXZ'
    this.geometry.scale(-1, 1, 1)
    this.scene.add(new THREE.Mesh(this.geometry, this.material))

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.texture = new THREE.TextureLoader().load(
      src,
      (loaded) => {
        if (this.disposed) {
          loaded.dispose()
          return
        }
        loaded.colorSpace = THREE.SRGBColorSpace
        this.material.map = loaded
        this.material.color.set(0xffffff)
        this.material.needsUpdate = true
        onLoad?.()
        this.render()
      },
      undefined,
      (error) => {
        if (!this.disposed) onError?.(error)
      },
    )
    this.resize()
  }

  resize(): void {
    if (this.disposed) return
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.render()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.texture.dispose()
    this.geometry.dispose()
    this.material.dispose()
    this.renderer.dispose()
  }

  private render(): void {
    if (!this.disposed) this.renderer.render(this.scene, this.camera)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
    this.canvas.setPointerCapture(event.pointerId)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.pointer || this.pointer.id !== event.pointerId) return
    this.yaw -= (event.clientX - this.pointer.x) * 0.004
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - (event.clientY - this.pointer.y) * 0.004,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    )
    this.camera.rotation.set(this.pitch, this.yaw, 0)
    this.pointer.x = event.clientX
    this.pointer.y = event.clientY
    this.render()
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pointer?.id === event.pointerId) this.pointer = null
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + event.deltaY * 0.03, 35, 90)
    this.camera.updateProjectionMatrix()
    this.render()
  }
}
