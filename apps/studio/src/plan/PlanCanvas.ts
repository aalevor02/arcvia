import type { Floor, Plan, Room, Vec2 } from './types'
import { activeFloor, vertexAt, wallAt } from './planStore'
import { detectRooms, displayName } from './rooms'
import { add, distance, normalise, perpendicular, scale, snapToAxis, snapToGrid, sub } from './geometry'
import { DEFAULT_UNITS, formatArea, formatLength, type UnitSystem } from '../lib/format'
import type { ProposedWall } from './detections'
import type { CatalogueItem, PlacedObject } from '../catalogue/types'
import { itemById } from '../catalogue/items'
import { footprint, objectsNear, resolvePlacement, sizeOf } from '../catalogue/placement'

export type Tool = 'select' | 'wall' | 'delete' | 'measure' | 'calibrate' | 'place'

export interface CanvasCallbacks {
  /** A wall was drawn. The store decides what that means. */
  onDrawWall(from: Vec2, to: Vec2): void
  onDeleteWall(wallId: string): void
  onMoveVertex(vertexId: string, to: Vec2): void
  /** Fired at the end of a drag, so history records one entry, not sixty. */
  onCommit(): void
  onSelect(selection: Selection | null): void
  /**
   * Two points were picked over a known dimension on the underlay. The screen
   * asks the user how long it really is — the canvas does not own dialogs.
   */
  onCalibrate(from: Vec2, to: Vec2): void
  /** A catalogue item was dropped. Rejected placements report a problem. */
  onPlaceObject(itemId: string, at: Vec2, rotation: number, wallId?: string): void
  onMoveObject(objectId: string, to: Vec2, rotation: number, wallId?: string): void
  /** Chatty status line at the bottom of the viewport. */
  onHint(text: string): void
}

export type Selection =
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'object'; id: string }

export interface ViewState {
  /** World metres per screen pixel is 1/zoom. */
  zoom: number
  /** World coordinate at the centre of the viewport. */
  centre: Vec2
}

/**
 * The 2D floor-plan canvas: renderer and input handler.
 *
 * ── Why plain canvas and not SVG or React ───────────────────────────────────
 * A plan is thousands of short strokes that all change together on every pan.
 * As SVG that is thousands of DOM nodes being re-laid-out; as React it is a
 * reconciliation pass per pointermove. Immediate-mode canvas draws the frame
 * and forgets it, which is the right shape for this.
 *
 * ── Why it redraws on demand, not every frame ───────────────────────────────
 * Same reasoning as SceneViewer: an idle editor should use no GPU and no
 * battery. `invalidate()` schedules exactly one frame.
 */
export class PlanCanvas {
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private observer: ResizeObserver

  private plan: Plan
  private rooms: Room[] = []
  private tool: Tool = 'wall'
  private units: UnitSystem = DEFAULT_UNITS
  private selection: Selection | null = null

  private view: ViewState = { zoom: 40, centre: { x: 0, y: 0 } }

  /** Pointer state for the in-progress operation. */
  private pointer: Vec2 | null = null
  private drawFrom: Vec2 | null = null
  private draggingVertex: string | null = null
  private panning: { from: Vec2; centre: Vec2 } | null = null
  private measureFrom: Vec2 | null = null
  private calibrateFrom: Vec2 | null = null

  /**
   * The decoded underlay, cached by URL.
   *
   * Reloading the image on every repaint would re-decode a multi-megabyte
   * drawing sixty times a second while panning. Keyed by URL so swapping the
   * drawing replaces it and nothing else does.
   */
  private underlayImage: { url: string; image: HTMLImageElement } | null = null

  /**
   * Walls the detector has proposed but the user has not accepted.
   *
   * Held separately from the plan on purpose. Inserting forty guessed walls and
   * relying on undo would mean the room list, areas and 3D model all churn
   * before anyone has agreed to any of it.
   */
  private proposal: ProposedWall[] = []

  /** Catalogue item currently being placed, following the pointer. */
  private placing: CatalogueItem | null = null
  /** Extra rotation the user has dialled in while placing, radians. */
  private placingSpin = 0
  private draggingObject: string | null = null

  /** Suspends axis snapping while held — see `snapToAxis` for why it is inverted. */
  private freeAngle = false
  private gridSize = 0.1

  constructor(
    private canvas: HTMLCanvasElement,
    plan: Plan,
    private callbacks: CanvasCallbacks,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot provide a 2D canvas context.')
    this.ctx = ctx
    this.plan = plan
    this.recomputeRooms()

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas.parentElement ?? canvas)
    this.resize()

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }

  // ---- External state ------------------------------------------------------

  setPlan(plan: Plan): void {
    this.plan = plan
    this.recomputeRooms()
    this.syncUnderlay()
    this.invalidate()
  }

  /** Fetch the underlay bitmap when the URL changes, and only then. */
  private syncUnderlay(): void {
    const underlay = this.floor.underlay

    if (!underlay) {
      this.underlayImage = null
      return
    }
    if (this.underlayImage?.url === underlay.url) return

    const image = new Image()
    // Same-origin in development, a CDN in production; either way the canvas
    // is never read back, so this only matters if that changes.
    image.crossOrigin = 'anonymous'
    image.onload = () => this.invalidate()
    image.src = underlay.url

    this.underlayImage = { url: underlay.url, image }
  }

  setTool(tool: Tool): void {
    this.tool = tool
    this.drawFrom = null
    this.measureFrom = null
    this.calibrateFrom = null
    if (tool !== 'place') this.placing = null
    this.callbacks.onHint(HINTS[tool])
    this.invalidate()
  }

  setUnits(units: UnitSystem): void {
    this.units = units
    this.invalidate()
  }

  /** Show a detector proposal as a ghost overlay. Empty array clears it. */
  /** Arm the place tool with a catalogue item, or disarm it with null. */
  setPlacing(itemId: string | null): void {
    this.placing = itemId ? (itemById(itemId) ?? null) : null
    this.placingSpin = 0
    if (this.placing) {
      this.tool = 'place'
      this.callbacks.onHint(
        `Click to place the ${this.placing.name.toLowerCase()}. R rotates, Esc cancels.`,
      )
    }
    this.invalidate()
  }

  setProposal(walls: ProposedWall[]): void {
    this.proposal = walls
    this.invalidate()
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection
    this.invalidate()
  }

  /** Cancel whatever is half-done. Bound to Escape. */
  cancel(): void {
    this.drawFrom = null
    this.measureFrom = null
    this.calibrateFrom = null
    this.draggingVertex = null
    this.draggingObject = null
    this.placing = null
    this.callbacks.onHint(HINTS[this.tool])
    this.invalidate()
  }

  private recomputeRooms(): void {
    this.rooms = detectRooms(activeFloor(this.plan))
  }

  private get floor(): Floor {
    return activeFloor(this.plan)
  }

  // ---- View ----------------------------------------------------------------

  /**
   * The pan and zoom, so it can outlive this renderer.
   *
   * The editor tears the 2D canvas down when it switches to the 3D view and
   * builds a fresh one on the way back. Without carrying the view across, every
   * trip through 3D drops you back at the default framing — which, on a plan
   * you had zoomed into to nudge one wall, means finding your place again every
   * single time.
   */
  getView(): ViewState {
    return { zoom: this.view.zoom, centre: { ...this.view.centre } }
  }

  setView(view: ViewState): void {
    this.view = { zoom: view.zoom, centre: { ...view.centre } }
    this.invalidate()
  }

  /** Frame everything drawn, with margin. No geometry means a sensible default. */
  zoomToFit(): void {
    const vertices = Object.values(this.floor.vertices)
    const { width, height } = this.canvas.getBoundingClientRect()

    if (vertices.length === 0) {
      this.view = { zoom: 40, centre: { x: 0, y: 0 } }
      this.invalidate()
      return
    }

    const xs = vertices.map((v) => v.x)
    const ys = vertices.map((v) => v.y)
    const min = { x: Math.min(...xs), y: Math.min(...ys) }
    const max = { x: Math.max(...xs), y: Math.max(...ys) }

    const span = { x: Math.max(1, max.x - min.x), y: Math.max(1, max.y - min.y) }
    const MARGIN = 1.25

    this.view = {
      zoom: Math.min(width / (span.x * MARGIN), height / (span.y * MARGIN)),
      centre: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 },
    }
    this.invalidate()
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas
    const { width, height } = parent.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    // Backing store in device pixels, CSS box in CSS pixels. Skipping this is
    // why hand-rolled canvases look soft on every laptop made since 2016.
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`

    this.invalidate()
  }

  /**
   * World to screen.
   *
   * Y is negated: world Y increases north, screen Y increases down. Doing this
   * in one place means no other code has to remember it — and forgetting it
   * somewhere is why a plan sometimes appears mirrored.
   */
  private toScreen(p: Vec2): Vec2 {
    const { width, height } = this.canvas.getBoundingClientRect()
    return {
      x: width / 2 + (p.x - this.view.centre.x) * this.view.zoom,
      y: height / 2 - (p.y - this.view.centre.y) * this.view.zoom,
    }
  }

  private toWorld(p: Vec2): Vec2 {
    const { width, height } = this.canvas.getBoundingClientRect()
    return {
      x: this.view.centre.x + (p.x - width / 2) / this.view.zoom,
      y: this.view.centre.y - (p.y - height / 2) / this.view.zoom,
    }
  }

  private eventPoint(event: PointerEvent | WheelEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  // ---- Snapping ------------------------------------------------------------

  /** Screen-space snap tolerance converted to world metres at current zoom. */
  private get snapRadius(): number {
    return 10 / this.view.zoom
  }

  /**
   * Resolve a raw pointer position to the point the user means.
   *
   * Priority is deliberate and matches what a person expects: an existing
   * corner beats a wall, a wall beats the axis constraint, and the grid is only
   * a fallback. Reversing any of those makes it impossible to land exactly on a
   * corner, which is the one thing that must always work.
   */
  private resolve(screen: Vec2): { point: Vec2; kind: string; id?: string } {
    const world = this.toWorld(screen)
    const floor = this.floor

    const vertexId = vertexAt(floor, world, this.snapRadius)
    if (vertexId) {
      const v = floor.vertices[vertexId]
      return { point: { x: v.x, y: v.y }, kind: 'vertex', id: vertexId }
    }

    const onWall = wallAt(floor, world, this.snapRadius)
    if (onWall) return { point: onWall.point, kind: 'wall', id: onWall.wallId }

    if (this.drawFrom && !this.freeAngle) {
      return { point: snapToAxis(this.drawFrom, world), kind: 'axis' }
    }

    return { point: snapToGrid(world, this.gridSize), kind: 'grid' }
  }

  // ---- Input ---------------------------------------------------------------

  private onPointerDown = (event: PointerEvent) => {
    this.canvas.setPointerCapture(event.pointerId)
    const screen = this.eventPoint(event)

    // Middle button, or space-drag, pans in every tool. A drawing tool that
    // hijacks all three buttons is one you have to exit to look at anything.
    if (event.button === 1 || event.button === 2) {
      this.panning = { from: screen, centre: { ...this.view.centre } }
      return
    }

    const resolved = this.resolve(screen)

    if (this.tool === 'wall') {
      if (!this.drawFrom) {
        this.drawFrom = resolved.point
        this.callbacks.onHint('Click the next corner. Esc to stop, Shift for any angle.')
      } else {
        this.callbacks.onDrawWall(this.drawFrom, resolved.point)
        // Chain: the end of one wall is the start of the next, which is how
        // anyone actually traces a room.
        this.drawFrom = resolved.point
      }
      this.invalidate()
      return
    }

    if (this.tool === 'delete') {
      const world = this.toWorld(screen)
      const hit = wallAt(this.floor, world, this.snapRadius * 1.5)
      if (hit) this.callbacks.onDeleteWall(hit.wallId)
      return
    }

    if (this.tool === 'place' && this.placing) {
      const world = this.toWorld(screen)
      const placement = resolvePlacement(this.floor, this.placing, world)

      // A refused placement reports why rather than dropping the object
      // somewhere it cannot be — a door in the middle of a room is not a door.
      if (placement.problem) {
        this.callbacks.onHint(placement.problem)
        return
      }

      this.callbacks.onPlaceObject(
        this.placing.id,
        placement.position,
        placement.rotation + this.placingSpin,
        placement.wallId,
      )
      return
    }

    if (this.tool === 'calibrate') {
      if (!this.calibrateFrom) {
        this.calibrateFrom = resolved.point
        this.callbacks.onHint('Now click the other end of that dimension.')
      } else {
        this.callbacks.onCalibrate(this.calibrateFrom, resolved.point)
        this.calibrateFrom = null
      }
      this.invalidate()
      return
    }

    if (this.tool === 'measure') {
      if (!this.measureFrom) {
        this.measureFrom = resolved.point
        this.callbacks.onHint('Click the second point.')
      } else {
        this.measureFrom = null
        this.callbacks.onHint(HINTS.measure)
      }
      this.invalidate()
      return
    }

    // Select tool. Objects are tested first: they are drawn over the walls, so
    // clicking one and getting the wall underneath would be wrong.
    const world0 = this.toWorld(screen)
    const hitObject = objectsNear(
      Object.values(this.floor.objects ?? {}),
      world0,
      Math.max(0.3, this.snapRadius * 2),
    ).find((object) => pointInPolygonLocal(world0, footprint(object)))

    if (hitObject) {
      this.draggingObject = hitObject.id
      this.select({ kind: 'object', id: hitObject.id })
      return
    }

    if (resolved.kind === 'vertex' && resolved.id) {
      this.draggingVertex = resolved.id
      this.select({ kind: 'vertex', id: resolved.id })
      return
    }
    if (resolved.kind === 'wall' && resolved.id) {
      this.select({ kind: 'wall', id: resolved.id })
      return
    }

    const world = this.toWorld(screen)
    const room = this.roomAt(world)
    this.select(room ? { kind: 'room', id: room.id } : null)
  }

  private onPointerMove = (event: PointerEvent) => {
    const screen = this.eventPoint(event)
    this.pointer = screen

    if (this.panning) {
      const delta = sub(screen, this.panning.from)
      this.view.centre = {
        x: this.panning.centre.x - delta.x / this.view.zoom,
        y: this.panning.centre.y + delta.y / this.view.zoom,
      }
      this.invalidate()
      return
    }

    if (this.draggingVertex) {
      const world = this.toWorld(screen)
      this.callbacks.onMoveVertex(this.draggingVertex, snapToGrid(world, this.gridSize))
      return
    }

    if (this.draggingObject) {
      const object = this.floor.objects?.[this.draggingObject]
      const item = object ? itemById(object.item) : undefined
      if (object && item) {
        // Re-resolved on every move, so dragging a door along a wall keeps it
        // in the wall, and dragging it to another wall re-attaches it.
        const placement = resolvePlacement(this.floor, item, this.toWorld(screen))
        if (!placement.problem) {
          this.callbacks.onMoveObject(
            this.draggingObject,
            placement.position,
            placement.rotation,
            placement.wallId,
          )
        }
      }
      return
    }

    this.invalidate()
  }

  private onPointerUp = (event: PointerEvent) => {
    this.canvas.releasePointerCapture(event.pointerId)

    // One history entry per drag, recorded on release. Committing per
    // pointermove would fill the undo stack with sixty intermediate positions
    // and make Ctrl+Z useless.
    if (this.draggingVertex || this.draggingObject) {
      this.draggingVertex = null
      this.draggingObject = null
      this.callbacks.onCommit()
    }
    this.panning = null
  }

  private onPointerLeave = () => {
    this.pointer = null
    this.invalidate()
  }

  private onContextMenu = (event: Event) => {
    // Right-drag pans, so the browser menu must not appear on release.
    event.preventDefault()
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const screen = this.eventPoint(event)

    // Zoom about the pointer, not the viewport centre: keep the world point
    // under the cursor exactly where it is. Anything else feels like the plan
    // is sliding away while you zoom.
    const before = this.toWorld(screen)
    const factor = Math.exp(-event.deltaY * 0.0015)
    this.view.zoom = Math.min(600, Math.max(2, this.view.zoom * factor))
    const after = this.toWorld(screen)

    this.view.centre = add(this.view.centre, sub(before, after))
    this.invalidate()
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      this.freeAngle = true
      this.invalidate()
    }
    if (event.key === 'Escape') this.cancel()
    if ((event.key === 'r' || event.key === 'R') && this.tool === 'place') {
      // 45-degree steps: enough freedom for a sofa on an angle, coarse enough
      // that everything else lands square.
      this.placingSpin += Math.PI / 4
      this.invalidate()
    }
  }

  private onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      this.freeAngle = false
      this.invalidate()
    }
  }

  private select(selection: Selection | null): void {
    this.selection = selection
    this.callbacks.onSelect(selection)
    this.invalidate()
  }

  private roomAt(world: Vec2): Room | null {
    // Smallest first, so clicking inside a room nested in another picks the
    // inner one — the one whose outline is closest to the pointer.
    const sorted = [...this.rooms].sort((a, b) => a.area - b.area)
    for (const room of sorted) {
      if (pointInPolygonLocal(world, room.polygon)) return room
    }
    return null
  }

  // ---- Rendering -----------------------------------------------------------

  invalidate(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
    })
  }

  private render(): void {
    const ctx = this.ctx
    const { width, height } = this.canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = COLOURS.background
    ctx.fillRect(0, 0, width, height)

    this.drawUnderlay()
    this.drawGrid(width, height)
    this.drawRooms()
    this.drawWalls()
    this.drawObjects()
    this.drawRoomLabels()
    this.drawDimensions()
    this.drawProposal()
    this.drawPlacingGhost()
    this.drawInProgress()
    this.drawSnapIndicator()

    ctx.restore()
  }

  /**
   * The traced drawing, beneath the grid.
   *
   * Drawn first so the grid and the walls sit on top of it — the underlay is a
   * reference, and anything that obscures the line you are tracing defeats the
   * point of having it there.
   */
  private drawUnderlay(): void {
    const underlay = this.floor.underlay
    const loaded = this.underlayImage
    if (!underlay || !loaded || !loaded.image.complete) return

    const topLeft = this.toScreen(underlay.origin)
    const width = underlay.width * underlay.scale * this.view.zoom
    const height = underlay.height * underlay.scale * this.view.zoom

    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = underlay.opacity
    // Canvas filters are applied by the compositor, so this costs nothing per
    // frame beyond what drawImage already does.
    if (underlay.invert) ctx.filter = 'invert(1)'
    // Smoothing off above 1:1: a scanned plan zoomed in should show its own
    // pixels rather than a guess at what is between them, so you can see
    // exactly which pixel a line sits on.
    ctx.imageSmoothingEnabled = width < underlay.width
    ctx.drawImage(loaded.image, topLeft.x, topLeft.y, width, height)
    ctx.restore()
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx

    // Choose a spacing that stays legible at any zoom: step up through
    // 0.1/0.5/1/5/10/50 m as you zoom out, so the grid never becomes a
    // solid fill or disappears entirely.
    const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50]
    const minPixels = 12
    const minor = candidates.find((c) => c * this.view.zoom >= minPixels) ?? 50
    const major = minor * 5

    const topLeft = this.toWorld({ x: 0, y: 0 })
    const bottomRight = this.toWorld({ x: width, y: height })

    const drawSet = (step: number, colour: string, lineWidth: number) => {
      ctx.beginPath()
      ctx.strokeStyle = colour
      ctx.lineWidth = lineWidth

      const startX = Math.floor(topLeft.x / step) * step
      for (let x = startX; x <= bottomRight.x; x += step) {
        const s = this.toScreen({ x, y: 0 })
        ctx.moveTo(Math.round(s.x) + 0.5, 0)
        ctx.lineTo(Math.round(s.x) + 0.5, height)
      }

      const startY = Math.floor(bottomRight.y / step) * step
      for (let y = startY; y <= topLeft.y; y += step) {
        const s = this.toScreen({ x: 0, y })
        ctx.moveTo(0, Math.round(s.y) + 0.5)
        ctx.lineTo(width, Math.round(s.y) + 0.5)
      }
      ctx.stroke()
    }

    drawSet(minor, COLOURS.gridMinor, 1)
    drawSet(major, COLOURS.gridMajor, 1)
  }

  private drawRooms(): void {
    const ctx = this.ctx
    for (const room of this.rooms) {
      ctx.beginPath()
      room.polygon.forEach((p, i) => {
        const s = this.toScreen(p)
        if (i === 0) ctx.moveTo(s.x, s.y)
        else ctx.lineTo(s.x, s.y)
      })
      ctx.closePath()

      const selected = this.selection?.kind === 'room' && this.selection.id === room.id
      ctx.fillStyle = selected ? COLOURS.roomSelected : COLOURS.roomFill
      ctx.fill()
    }
  }

  /**
   * Walls, drawn to their real thickness.
   *
   * Below a couple of pixels a thickness-accurate wall is invisible, so there
   * is a floor on the stroke width. Zoomed out, the plan reads as a line
   * drawing; zoomed in, the walls have their true 230 mm.
   */
  private drawWalls(): void {
    const ctx = this.ctx
    const floor = this.floor

    for (const wall of Object.values(floor.walls)) {
      const a = floor.vertices[wall.a]
      const b = floor.vertices[wall.b]
      if (!a || !b) continue

      const sa = this.toScreen(a)
      const sb = this.toScreen(b)
      const selected = this.selection?.kind === 'wall' && this.selection.id === wall.id

      ctx.beginPath()
      ctx.moveTo(sa.x, sa.y)
      ctx.lineTo(sb.x, sb.y)
      ctx.lineCap = 'butt'
      ctx.lineWidth = Math.max(2, wall.thickness * this.view.zoom)
      ctx.strokeStyle = selected ? COLOURS.accent : COLOURS.wall
      ctx.stroke()
    }

    // Corner dots, drawn on top so junctions read clearly.
    for (const vertex of Object.values(floor.vertices)) {
      const s = this.toScreen(vertex)
      const selected = this.selection?.kind === 'vertex' && this.selection.id === vertex.id
      ctx.beginPath()
      ctx.arc(s.x, s.y, selected ? 5 : 3, 0, Math.PI * 2)
      ctx.fillStyle = selected ? COLOURS.accent : COLOURS.vertex
      ctx.fill()
    }
  }

  /**
   * Furniture and fittings, in plan.
   *
   * Openings are drawn as architectural symbols rather than boxes — a door is
   * a leaf and a swing arc, a window is a break in the wall with a glazing
   * line. That is what makes a plan readable as a plan rather than as a
   * diagram of rectangles.
   */
  private drawObjects(): void {
    const ctx = this.ctx

    for (const object of Object.values(this.floor.objects ?? {})) {
      const item = itemById(object.item)
      if (!item) continue

      const selected = this.selection?.kind === 'object' && this.selection.id === object.id

      if (item.placement === 'in-wall') {
        this.drawOpening(object, item, selected)
        continue
      }

      const corners = footprint(object)
      ctx.beginPath()
      corners.forEach((corner, i) => {
        const s = this.toScreen(corner)
        if (i === 0) ctx.moveTo(s.x, s.y)
        else ctx.lineTo(s.x, s.y)
      })
      ctx.closePath()

      ctx.fillStyle = selected ? COLOURS.objectSelected : COLOURS.objectFill
      ctx.fill()
      ctx.strokeStyle = selected ? COLOURS.accent : COLOURS.objectLine
      ctx.lineWidth = selected ? 2 : 1.2
      ctx.stroke()

      // A tick on the front edge, so orientation is visible at a glance.
      const size = sizeOf(object)
      const front = this.toScreen({
        x: object.position.x + Math.sin(object.rotation) * size.depth * 0.42,
        y: object.position.y - Math.cos(object.rotation) * size.depth * 0.42,
      })
      const centre = this.toScreen(object.position)
      ctx.beginPath()
      ctx.moveTo(centre.x, centre.y)
      ctx.lineTo(front.x, front.y)
      ctx.strokeStyle = COLOURS.objectLine
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  /** A door or window, as the symbol an architect would draw. */
  private drawOpening(object: PlacedObject, item: CatalogueItem, selected: boolean): void {
    const ctx = this.ctx
    const size = sizeOf(object)
    const half = size.width / 2

    const along = { x: Math.cos(object.rotation), y: Math.sin(object.rotation) }
    const from = this.toScreen({
      x: object.position.x - along.x * half,
      y: object.position.y - along.y * half,
    })
    const to = this.toScreen({
      x: object.position.x + along.x * half,
      y: object.position.y + along.y * half,
    })

    // Clear the wall through the opening, so the gap reads as a gap.
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.lineCap = 'butt'
    ctx.lineWidth = Math.max(3, 0.3 * this.view.zoom)
    ctx.strokeStyle = COLOURS.background
    ctx.stroke()
    ctx.restore()

    ctx.strokeStyle = selected ? COLOURS.accent : COLOURS.opening
    ctx.lineWidth = selected ? 2.5 : 1.6

    if (item.shape === 'window') {
      // Two lines across the gap: the glazing.
      const normal = { x: -along.y, y: along.x }
      for (const offset of [-0.04, 0.04]) {
        const a = this.toScreen({
          x: object.position.x - along.x * half + normal.x * offset,
          y: object.position.y - along.y * half + normal.y * offset,
        })
        const b = this.toScreen({
          x: object.position.x + along.x * half + normal.x * offset,
          y: object.position.y + along.y * half + normal.y * offset,
        })
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      return
    }

    if (item.shape === 'opening') {
      // Nothing but the gap, plus jamb ticks so it is not mistaken for a hole
      // in the drawing.
      for (const end of [from, to]) {
        ctx.beginPath()
        ctx.arc(end.x, end.y, 2.5, 0, Math.PI * 2)
        ctx.fillStyle = COLOURS.opening
        ctx.fill()
      }
      return
    }

    // A door: the leaf, standing open, and the arc it sweeps.
    const radiusPx = half * 2 * this.view.zoom
    const hingeSide = (object as { hinge?: 'left' | 'right' }).hinge === 'right' ? -1 : 1
    const hinge = hingeSide > 0 ? from : to
    const baseAngle = Math.atan2(to.y - from.y, to.x - from.x) + (hingeSide > 0 ? 0 : Math.PI)
    const swing = ((object as { swing?: number }).swing ?? 90) * (Math.PI / 180)

    ctx.beginPath()
    ctx.moveTo(hinge.x, hinge.y)
    ctx.lineTo(
      hinge.x + Math.cos(baseAngle - swing) * radiusPx,
      hinge.y + Math.sin(baseAngle - swing) * radiusPx,
    )
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(hinge.x, hinge.y, radiusPx, baseAngle - swing, baseAngle)
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** The item being placed, following the pointer. */
  private drawPlacingGhost(): void {
    // Tool as well as item: the ghost must not linger after the tool changes,
    // and drawing it without this check hid a tool/state mismatch during
    // development — the ghost followed the pointer while clicks went to the
    // select tool.
    if (this.tool !== 'place' || !this.placing || !this.pointer) return

    const world = this.toWorld(this.pointer)
    const placement = resolvePlacement(this.floor, this.placing, world)
    const ghost: PlacedObject = {
      id: '__ghost',
      item: this.placing.id,
      position: placement.position,
      rotation: placement.rotation + this.placingSpin,
    }

    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = placement.problem ? 0.35 : 0.75

    const corners = footprint(ghost)
    ctx.beginPath()
    corners.forEach((corner, i) => {
      const s = this.toScreen(corner)
      if (i === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    ctx.closePath()

    ctx.fillStyle = placement.problem ? COLOURS.ghostBad : COLOURS.ghost
    ctx.fill()
    ctx.strokeStyle = placement.problem ? COLOURS.danger : COLOURS.accent
    ctx.setLineDash([5, 4])
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  private drawRoomLabels(): void {
    const ctx = this.ctx
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    this.rooms.forEach((room, index) => {
      const s = this.toScreen(room.label)
      const name = displayName(room, index, this.floor.roomNames)

      ctx.fillStyle = COLOURS.label
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(name, s.x, s.y - 8)

      ctx.fillStyle = COLOURS.labelSoft
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText(formatArea(room.area, this.units), s.x, s.y + 8)
    })
  }

  /**
   * Dimension lines along each room's edges.
   *
   * Only for the selected room, or for every room when nothing is selected and
   * the plan is small. Drawing a dimension on every edge of a twenty-room plan
   * produces an unreadable thicket — the reference does this too, and it is the
   * first thing that makes a plan look like a drawing rather than a diagram.
   */
  private drawDimensions(): void {
    const target =
      this.selection?.kind === 'room'
        ? this.rooms.filter((r) => r.id === this.selection?.id)
        : this.rooms.length <= 4
          ? this.rooms
          : []

    for (const room of target) {
      for (let i = 0; i < room.polygon.length; i++) {
        const a = room.polygon[i]
        const b = room.polygon[(i + 1) % room.polygon.length]
        this.drawDimension(a, b)
      }
    }
  }

  private drawDimension(a: Vec2, b: Vec2): void {
    const ctx = this.ctx
    const length = distance(a, b)
    if (length < 0.3) return

    const sa = this.toScreen(a)
    const sb = this.toScreen(b)
    if (distance(sa, sb) < 40) return // too short on screen to letter

    // Offset the dimension line into the room, along the inward normal. The
    // polygon is counter-clockwise, so the inward normal is the left-hand one.
    const dir = normalise(sub(b, a))
    const inward = perpendicular(dir)
    const OFFSET = 14 // screen px

    const offset = scale({ x: inward.x, y: -inward.y }, OFFSET)
    const p1 = add(sa, offset)
    const p2 = add(sb, offset)

    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.strokeStyle = COLOURS.dimension
    ctx.lineWidth = 1
    ctx.stroke()

    // End ticks
    const tick = scale({ x: inward.x, y: -inward.y }, 4)
    for (const [base] of [[p1], [p2]] as const) {
      ctx.beginPath()
      ctx.moveTo(base.x - tick.x, base.y - tick.y)
      ctx.lineTo(base.x + tick.x, base.y + tick.y)
      ctx.stroke()
    }

    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const text = formatLength(length, this.units)

    ctx.save()
    ctx.translate(mid.x, mid.y)

    // Keep the text upright: rotate with the edge, then flip if it would end up
    // upside down. Reading a plan should not require tilting your head.
    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI
    ctx.rotate(angle)

    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const width = ctx.measureText(text).width
    ctx.fillStyle = COLOURS.background
    ctx.fillRect(-width / 2 - 3, -7, width + 6, 14)

    ctx.fillStyle = COLOURS.dimensionText
    ctx.fillText(text, 0, 0)
    ctx.restore()
  }

  private drawInProgress(): void {
    if (!this.pointer) return
    const ctx = this.ctx
    const resolved = this.resolve(this.pointer)

    const rubberBand = (from: Vec2, colour: string) => {
      const sa = this.toScreen(from)
      const sb = this.toScreen(resolved.point)

      ctx.beginPath()
      ctx.moveTo(sa.x, sa.y)
      ctx.lineTo(sb.x, sb.y)
      ctx.strokeStyle = colour
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.stroke()
      ctx.setLineDash([])

      // Live length readout at the midpoint — the number people are actually
      // watching while they draw.
      const length = distance(from, resolved.point)
      const mid = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 }
      const text = formatLength(length, this.units)

      ctx.font = '600 11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const width = ctx.measureText(text).width

      ctx.fillStyle = COLOURS.accent
      ctx.fillRect(mid.x - width / 2 - 5, mid.y - 9, width + 10, 18)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, mid.x, mid.y)
    }

    if (this.tool === 'wall' && this.drawFrom) rubberBand(this.drawFrom, COLOURS.accent)
    if (this.tool === 'measure' && this.measureFrom) rubberBand(this.measureFrom, COLOURS.measure)
    if (this.tool === 'calibrate' && this.calibrateFrom) {
      rubberBand(this.calibrateFrom, COLOURS.warn)
    }
  }

  /**
   * The detector's proposal, drawn over the plan but visibly provisional.
   *
   * Dashed and tinted, at the real thickness, so what is being offered is
   * legible as geometry while never being mistaken for geometry that exists.
   */
  private drawProposal(): void {
    if (this.proposal.length === 0) return
    const ctx = this.ctx

    ctx.save()
    ctx.setLineDash([7, 5])
    for (const wall of this.proposal) {
      const a = this.toScreen(wall.a)
      const b = this.toScreen(wall.b)

      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineWidth = Math.max(2, wall.thickness * this.view.zoom)
      // Paired walls carry a measured thickness and are the confident ones;
      // unpaired are a single traced line at a default thickness. Colouring
      // them differently is the cheapest way to say which is which.
      ctx.strokeStyle = wall.paired ? COLOURS.proposal : COLOURS.proposalWeak
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawSnapIndicator(): void {
    if (!this.pointer) return
    if (this.tool === 'delete') return

    const ctx = this.ctx
    const resolved = this.resolve(this.pointer)
    const s = this.toScreen(resolved.point)

    ctx.strokeStyle = COLOURS.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()

    // A distinct shape per snap kind, so it is obvious *why* the point jumped:
    // circle on a corner, square on a wall, small cross otherwise.
    if (resolved.kind === 'vertex') {
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2)
    } else if (resolved.kind === 'wall') {
      ctx.rect(s.x - 5, s.y - 5, 10, 10)
    } else {
      ctx.moveTo(s.x - 5, s.y)
      ctx.lineTo(s.x + 5, s.y)
      ctx.moveTo(s.x, s.y - 5)
      ctx.lineTo(s.x, s.y + 5)
    }
    ctx.stroke()
  }
}

/** Local copy so the canvas does not import geometry just for a hit test. */
function pointInPolygonLocal(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}

const HINTS: Record<Tool, string> = {
  select: 'Click a wall, corner or room. Drag a corner to move it.',
  wall: 'Click to start a wall. Shift releases the angle snap.',
  delete: 'Click a wall to delete it.',
  measure: 'Click two points to measure between them.',
  calibrate:
    'Click the two ends of something whose real length you know — a room, a door, a scale bar.',
  place: 'Pick something from the catalogue, then click to place it.',
}

const COLOURS = {
  background: '#0f1319',
  gridMinor: '#171d26',
  gridMajor: '#1f2733',
  wall: '#c8d2e0',
  vertex: '#8b95a7',
  roomFill: 'rgba(47, 109, 246, 0.08)',
  roomSelected: 'rgba(47, 109, 246, 0.20)',
  label: '#e9edf5',
  labelSoft: '#8b95a7',
  dimension: '#3b465a',
  dimensionText: '#8b95a7',
  accent: '#2f6df6',
  measure: '#00c2a8',
  warn: '#f5a524',
  proposal: 'rgba(0, 194, 168, 0.85)',
  proposalWeak: 'rgba(245, 165, 36, 0.7)',
  objectFill: 'rgba(200, 210, 224, 0.16)',
  objectSelected: 'rgba(47, 109, 246, 0.32)',
  objectLine: 'rgba(200, 210, 224, 0.55)',
  opening: '#c8d2e0',
  ghost: 'rgba(47, 109, 246, 0.25)',
  ghostBad: 'rgba(229, 72, 77, 0.2)',
  danger: '#e5484d',
}
