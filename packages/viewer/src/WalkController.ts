import * as THREE from 'three'
import type { SceneViewer } from './SceneViewer'

export interface WalkOptions {
  /** Camera height above the floor, in metres. */
  eyeHeight?: number
  /** Metres per second. The reference product walks at 2.68. */
  speed?: number
  /** Clamp on how far the user may look up/down, in degrees. */
  maxPitch?: number
}

/**
 * First-person walk controls.
 *
 * Drag to look, WASD/arrows to move, shift to move faster. Deliberately not
 * PointerLock: on a sales page the visitor has not opted into a game, and a
 * page that swallows the cursor on first click reads as broken. Drag-to-look
 * is what every published architectural walkthrough uses, for that reason.
 *
 * There is no collision detection here. Adding it needs a navmesh or a physics
 * pass over the model, which is a property of the *scene*, not of the controls
 * — so it belongs with the geometry that does not exist yet, and pretending
 * otherwise would let a visitor walk through a wall and think the model is
 * broken rather than the controls unfinished.
 */
export class WalkController {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: THREE.PerspectiveCamera
  private readonly keys = new Set<string>()

  private dragging = false
  private lastX = 0
  private lastY = 0
  private yaw = 0
  private pitch = 0
  private enabled = false
  private frame = 0
  private lastTime = 0

  private readonly eyeHeight: number
  private readonly speed: number
  private readonly maxPitch: number

  constructor(
    private readonly viewer: SceneViewer,
    canvas: HTMLCanvasElement,
    options: WalkOptions = {},
  ) {
    this.canvas = canvas
    this.camera = viewer.cameraObject
    this.eyeHeight = options.eyeHeight ?? 1.6
    this.speed = options.speed ?? 2.68
    this.maxPitch = THREE.MathUtils.degToRad(options.maxPitch ?? 85)
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.viewer.setOrbitEnabled(false)
    this.syncFromCamera()

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    this.canvas.style.cursor = 'grab'
    this.lastTime = performance.now()
    this.frame = requestAnimationFrame(this.tick)
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    cancelAnimationFrame(this.frame)

    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)

    this.keys.clear()
    this.canvas.style.cursor = ''
    this.viewer.setOrbitEnabled(true)
  }

  /** Adopt whatever the camera is currently looking at as the walk heading. */
  syncFromCamera(): void {
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
    this.yaw = euler.y
    this.pitch = euler.x
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true
    this.lastX = event.clientX
    this.lastY = event.clientY
    this.canvas.style.cursor = 'grabbing'
    this.canvas.setPointerCapture?.(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    const dx = event.clientX - this.lastX
    const dy = event.clientY - this.lastY
    this.lastX = event.clientX
    this.lastY = event.clientY

    // 0.0025 rad/px is roughly the sensitivity of every published walkthrough
    // I compared against; much faster and the view feels twitchy on a trackpad.
    this.yaw -= dx * 0.0025
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0025, -this.maxPitch, this.maxPitch)
    this.applyRotation()
  }

  private onPointerUp = (): void => {
    this.dragging = false
    this.canvas.style.cursor = 'grab'
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    this.keys.add(event.key.toLowerCase())
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase())
  }

  private applyRotation(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    this.viewer.requestRender()
  }

  private tick = (): void => {
    if (!this.enabled) return
    this.frame = requestAnimationFrame(this.tick)

    const now = performance.now()
    const delta = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    const forward = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0)
      || (this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('arrowdown') ? 1 : 0)
    const strafe = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0)
      || (this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('arrowleft') ? 1 : 0)

    if (forward === 0 && strafe === 0) return

    const distance = this.speed * (this.keys.has('shift') ? 2.2 : 1) * delta

    // Movement is horizontal only. Walking "forward" while looking at the
    // ceiling should not lift the camera off the floor.
    const heading = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))

    this.camera.position.addScaledVector(heading, forward * distance)
    this.camera.position.addScaledVector(right, strafe * distance)
    this.viewer.requestRender()
  }

  /** Snap the camera to standing height at the current floor level. */
  setFloorLevel(y: number): void {
    this.camera.position.y = y + this.eyeHeight
    this.viewer.requestRender()
  }

  dispose(): void {
    this.disable()
  }
}
