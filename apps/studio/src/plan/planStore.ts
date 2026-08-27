import type { Floor, FloorFinish, Plan, Underlay, Vec2, Wall } from './types'
import { WALL_DEFAULTS } from './types'
import { closestPointOnSegment, distance, segmentIntersection } from './geometry'
import type { PlacedObject, Size } from '../catalogue/types'

/**
 * Mutating operations on a plan.
 *
 * ── Pure functions over a plain object, not a class ─────────────────────────
 * Every function here takes a Plan and returns a *new* Plan. That is what makes
 * undo/redo a stack of references rather than a system of inverse commands —
 * the reference product implements `DeleteObjectCommand.undo()` by hand for
 * every operation, and every new tool is another chance to write an inverse
 * that is subtly not the inverse.
 *
 * Plans are small (a few hundred vertices), so copying one is cheap and the
 * memory cost of a 50-deep history is trivial. If plans ever get large enough
 * for that to hurt, the fix is structural sharing, not hand-written inverses.
 */

let counter = 0

/**
 * Ids are sequential, not random.
 *
 * Room ids are derived from sorted vertex ids (see `rooms.ts`), so vertex ids
 * end up in a user-visible key. Sequential ids keep that key stable and short;
 * they also make a saved plan diffable, which matters the first time you have
 * to work out what a bug did to someone's file.
 */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}${counter}`
}

/**
 * Reset the id counter to just past whatever a loaded plan already uses.
 *
 * Without this, opening a saved plan and drawing one more wall mints `v1` for
 * the second time in that document, and the new vertex silently merges with an
 * existing one. Called by `loadPlan`.
 */
function reserveIds(plan: Plan): void {
  let max = 0
  for (const floor of plan.floors) {
    // EVERY id namespace has to be listed here. They share one counter, so a
    // namespace left out restarts low after a reload and the next id minted in
    // it collides with an existing record — which does not error, it silently
    // *overwrites* it. Objects were missed when they were added: placing
    // furniture in a reopened plan replaced an existing piece instead of adding
    // one, and the only visible symptom was a count that would not go up.
    for (const id of [
      ...Object.keys(floor.vertices),
      ...Object.keys(floor.walls),
      ...Object.keys(floor.objects ?? {}),
      ...Object.keys(floor.bimComponents ?? {}),
      floor.id,
    ]) {
      const n = Number(String(id).replace(/^\D+/, ''))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  counter = Math.max(counter, max)
}

// ---- Construction ----------------------------------------------------------

export function emptyFloor(name: string, elevation = 0): Floor {
  return {
    id: nextId('f'),
    name,
    elevation,
    vertices: {},
    walls: {},
    roomNames: {},
    objects: {},
    bimComponents: {},
    underlay: null,
  }
}

export function emptyPlan(): Plan {
  const floor = emptyFloor('Ground floor', 0)
  return { version: 1, floors: [floor], activeFloorId: floor.id }
}

export function loadPlan(raw: unknown): Plan {
  const plan = raw as Plan
  if (!plan || plan.version !== 1 || !Array.isArray(plan.floors) || !plan.floors.length) {
    return emptyPlan()
  }
  reserveIds(plan)
  return migrate(plan)
}

/**
 * Fill in fields added after a plan was saved.
 *
 * Not version-gated, and deliberately so. Bumping `version` for an *additive*
 * field would mean every plan saved before it fails the check above and is
 * silently replaced with an empty one — losing the user's drawing to a schema
 * tweak. A field that has a sensible default needs a default, not a new version.
 *
 * `version` is reserved for changes that genuinely cannot be read by this code,
 * at which point this function grows a real upgrade path.
 */
function migrate(plan: Plan): Plan {
  return {
    ...plan,
    floors: plan.floors.map((floor) => ({
      ...floor,
      roomNames: floor.roomNames ?? {},
      objects: floor.objects ?? {},
      underlay: floor.underlay ? migrateUnderlay(floor.underlay) : null,
    })),
  }
}

/**
 * Note the parameter type.
 *
 * A plan coming off the wire is JSON, not an `Underlay` — declaring it as one
 * tells the compiler every field is present, which makes filling in defaults
 * look like dead code (it warned, correctly). Typing it as partial states the
 * actual situation: these fields may or may not be there, and each one that is
 * missing gets a default.
 */
function migrateUnderlay(stored: Partial<Underlay>): Underlay {
  return {
    url: stored.url ?? '',
    width: stored.width ?? 1,
    height: stored.height ?? 1,
    origin: stored.origin ?? { x: 0, y: 0 },
    scale: stored.scale ?? 0.01,
    // `invert` was added once the editor's dark canvas made an un-inverted scan
    // almost unreadable. Records saved before it would otherwise load as a grey
    // wash. `??` and not `||`, so a deliberate `false` survives.
    invert: stored.invert ?? true,
    locked: stored.locked ?? true,
    opacity: stored.opacity ?? 0.85,
  }
}

// ---- Lookup ----------------------------------------------------------------

export const activeFloor = (plan: Plan): Floor =>
  plan.floors.find((f) => f.id === plan.activeFloorId) ?? plan.floors[0]

/** Apply `fn` to the active floor and return a new plan. */
function withFloor(plan: Plan, fn: (floor: Floor) => Floor): Plan {
  return {
    ...plan,
    floors: plan.floors.map((f) => (f.id === plan.activeFloorId ? fn(f) : f)),
  }
}

// ---- Vertices --------------------------------------------------------------

/** Two vertices closer than this are the same corner. Metres. */
export const WELD_DISTANCE = 0.02

export function vertexAt(floor: Floor, point: Vec2, radius = WELD_DISTANCE): string | null {
  let best: { id: string; d: number } | null = null
  for (const v of Object.values(floor.vertices)) {
    const d = distance(v, point)
    if (d <= radius && (!best || d < best.d)) best = { id: v.id, d }
  }
  return best?.id ?? null
}

export function wallAt(
  floor: Floor,
  point: Vec2,
  radius: number,
): { wallId: string; point: Vec2; t: number } | null {
  let best: { wallId: string; point: Vec2; t: number; d: number } | null = null

  for (const wall of Object.values(floor.walls)) {
    const a = floor.vertices[wall.a]
    const b = floor.vertices[wall.b]
    if (!a || !b) continue

    const hit = closestPointOnSegment(point, a, b)
    if (hit.distance <= radius && (!best || hit.distance < best.d)) {
      best = { wallId: wall.id, point: hit.point, t: hit.t, d: hit.distance }
    }
  }

  if (!best) return null
  return { wallId: best.wallId, point: best.point, t: best.t }
}

/**
 * Get the vertex at `point`, creating one if there is none.
 *
 * Three cases, in priority order, and the order is the whole design:
 *
 *   1. An existing vertex within welding distance — reuse it. This is what
 *      makes a loop *close* rather than ending a hair away from where it
 *      started, which would leave the room undetected and the user staring at a
 *      plan that looks shut.
 *   2. A point lying on an existing wall — split that wall in two and reuse the
 *      new midpoint, so a T-junction is a real graph junction rather than two
 *      walls that merely cross visually. Room detection sees only the graph;
 *      walls that overlap without sharing a vertex bound nothing.
 *   3. Otherwise, a new free-standing vertex.
 */
function ensureVertex(
  floor: Floor,
  point: Vec2,
  snapRadius: number,
): { floor: Floor; id: string } {
  const existing = vertexAt(floor, point, Math.max(WELD_DISTANCE, snapRadius))
  if (existing) return { floor, id: existing }

  const onWall = wallAt(floor, point, snapRadius)
  if (onWall && onWall.t > 0.001 && onWall.t < 0.999) {
    return splitWall(floor, onWall.wallId, onWall.point)
  }

  const id = nextId('v')
  return {
    floor: {
      ...floor,
      vertices: { ...floor.vertices, [id]: { id, x: point.x, y: point.y } },
    },
    id,
  }
}

/** Cut a wall at `point`, replacing it with two walls that share a new vertex. */
function splitWall(floor: Floor, wallId: string, point: Vec2): { floor: Floor; id: string } {
  const wall = floor.walls[wallId]
  const id = nextId('v')

  const { [wallId]: _removed, ...rest } = floor.walls
  const first = nextId('w')
  const second = nextId('w')

  return {
    floor: {
      ...floor,
      vertices: { ...floor.vertices, [id]: { id, x: point.x, y: point.y } },
      walls: {
        ...rest,
        // Both halves inherit the original's thickness and height: splitting a
        // wall is a topological act, not a change to the wall itself.
        [first]: { ...wall, id: first, a: wall.a, b: id },
        [second]: { ...wall, id: second, a: id, b: wall.b },
      },
    },
    id,
  }
}

// ---- Walls -----------------------------------------------------------------

export interface AddWallOptions {
  thickness?: number
  height?: number
  /** How close a click has to be to weld to a vertex or split a wall, in metres. */
  snapRadius?: number
  /** Native BIM element this wall was derived from. */
  bimSource?: Wall['bimSource']
  /** Semantic source snapshot to copy onto every segment created for this wall. */
  bimData?: Wall['bimData']
}

/**
 * Draw a wall between two points.
 *
 * Also splits any wall the new one crosses. Without that, drawing a corridor
 * across a room produces two walls that visually intersect but share no vertex,
 * so the graph still sees one big room and the areas are wrong — the failure is
 * invisible in 2D and only shows up when the 3D model has no partition in it.
 */
export function addWall(plan: Plan, from: Vec2, to: Vec2, options: AddWallOptions = {}): Plan {
  const { thickness = WALL_DEFAULTS.interior.thickness, height = WALL_DEFAULTS.interior.height } =
    options
  const snapRadius = options.snapRadius ?? WELD_DISTANCE

  // A zero-length wall is a stray double-click, not an instruction.
  if (distance(from, to) < WELD_DISTANCE) return plan

  return withFloor(plan, (floor) => {
    let working = floor

    const startResult = ensureVertex(working, from, snapRadius)
    working = startResult.floor
    const endResult = ensureVertex(working, to, snapRadius)
    working = endResult.floor

    if (startResult.id === endResult.id) return floor

    // Find crossings against every existing wall before adding the new one.
    const a = working.vertices[startResult.id]
    const b = working.vertices[endResult.id]

    const crossings: { point: Vec2; wallId: string }[] = []
    for (const wall of Object.values(working.walls)) {
      const p = working.vertices[wall.a]
      const q = working.vertices[wall.b]
      if (!p || !q) continue
      // Walls already sharing an endpoint meet at a corner, not a crossing.
      if ([wall.a, wall.b].includes(startResult.id) || [wall.a, wall.b].includes(endResult.id)) {
        continue
      }
      const hit = segmentIntersection(a, b, p, q)
      if (hit) crossings.push({ point: hit, wallId: wall.id })
    }

    // Split each crossed wall, collecting the junction vertices.
    const junctions: string[] = []
    for (const crossing of crossings) {
      // The wall id may have changed if an earlier split replaced it, so look
      // the crossing up again by position rather than trusting the stale id.
      const target = wallAt(working, crossing.point, WELD_DISTANCE)
      if (!target) continue
      const split = splitWall(working, target.wallId, crossing.point)
      working = split.floor
      junctions.push(split.id)
    }

    // Chain the new wall through its junctions in order along the run, so each
    // segment is its own wall and the graph has a vertex at every crossing.
    const ordered = [startResult.id, ...junctions, endResult.id].sort((p, q) => {
      const vp = working.vertices[p]
      const vq = working.vertices[q]
      return distance(a, vp) - distance(a, vq)
    })

    const walls = { ...working.walls }
    for (let i = 0; i + 1 < ordered.length; i++) {
      if (ordered[i] === ordered[i + 1]) continue
      const id = nextId('w')
      walls[id] = {
        id,
        a: ordered[i],
        b: ordered[i + 1],
        thickness,
        height,
        bimSource: options.bimSource,
        bimData: options.bimData,
      }
    }

    return { ...working, walls }
  })
}

export function removeWall(plan: Plan, wallId: string): Plan {
  return withFloor(plan, (floor) => {
    const { [wallId]: removed, ...walls } = floor.walls
    if (!removed) return floor

    // Anything cut *into* this wall goes with it. A door whose wall has been
    // deleted is a door-shaped hole in nothing — it would still render, still
    // appear in the object list, and never be findable in the plan.
    const objects = Object.fromEntries(
      Object.entries(floor.objects ?? {}).filter(
        ([, object]) => object.wallId !== wallId,
      ),
    )

    return pruneOrphans({ ...floor, walls, objects })
  })
}

export function updateWall(plan: Plan, wallId: string, patch: Partial<Wall>): Plan {
  return withFloor(plan, (floor) => {
    const wall = floor.walls[wallId]
    if (!wall) return floor
    // a/b are graph structure, not properties. Changing them here would let a
    // property edit silently rewire the plan.
    const { a: _a, b: _b, id: _id, bimSource: _bimSource, bimData: _bimData, ...safe } = patch
    return { ...floor, walls: { ...floor.walls, [wallId]: { ...wall, ...safe } } }
  })
}

/** Apply a patch to every wall on the floor — the "Edit All Walls" action. */
export function updateAllWalls(plan: Plan, patch: Partial<Wall>): Plan {
  return withFloor(plan, (floor) => {
    const { a: _a, b: _b, id: _id, bimSource: _bimSource, bimData: _bimData, ...safe } = patch
    const walls = Object.fromEntries(
      Object.entries(floor.walls).map(([id, wall]) => [id, { ...wall, ...safe }]),
    )
    return { ...floor, walls }
  })
}

export function moveVertex(plan: Plan, vertexId: string, to: Vec2): Plan {
  return withFloor(plan, (floor) => {
    const vertex = floor.vertices[vertexId]
    if (!vertex) return floor
    return {
      ...floor,
      vertices: { ...floor.vertices, [vertexId]: { ...vertex, x: to.x, y: to.y } },
    }
  })
}

export function removeVertex(plan: Plan, vertexId: string): Plan {
  return withFloor(plan, (floor) => {
    const walls = Object.fromEntries(
      Object.entries(floor.walls).filter(([, w]) => w.a !== vertexId && w.b !== vertexId),
    )
    const { [vertexId]: _gone, ...vertices } = floor.vertices
    return pruneOrphans({ ...floor, vertices, walls })
  })
}

/**
 * Drop vertices no wall references any more.
 *
 * Leaving them behind is not cosmetic: an orphan is still a snap target, so
 * later drawing welds to a corner of a wall that was deleted ten minutes ago
 * and nobody can see why the new wall bends.
 */
function pruneOrphans(floor: Floor): Floor {
  const used = new Set<string>()
  for (const wall of Object.values(floor.walls)) {
    used.add(wall.a)
    used.add(wall.b)
  }
  const vertices = Object.fromEntries(
    Object.entries(floor.vertices).filter(([id]) => used.has(id)),
  )
  return { ...floor, vertices }
}

// ---- Rooms -----------------------------------------------------------------

export function nameRoom(plan: Plan, roomId: string, name: string): Plan {
  return withFloor(plan, (floor) => {
    const roomNames = { ...floor.roomNames }
    const trimmed = name.trim()
    // Clearing the name restores the automatic "Room n" rather than storing an
    // empty string that would render as a nameless room.
    if (trimmed) roomNames[roomId] = trimmed
    else delete roomNames[roomId]
    return { ...floor, roomNames }
  })
}

/**
 * Set or clear a room's floor finish.
 *
 * Clearing restores the floor's default rather than storing the default as a
 * value, so a project-wide change still reaches every room that was never given
 * one of its own — the same reasoning as clearing a room's name.
 */
export function setRoomFinish(plan: Plan, roomId: string, finish: FloorFinish | null): Plan {
  return withFloor(plan, (floor) => {
    const roomFinishes = { ...(floor.roomFinishes ?? {}) }
    if (finish) roomFinishes[roomId] = finish
    else delete roomFinishes[roomId]
    return { ...floor, roomFinishes }
  })
}

// ---- Floors ----------------------------------------------------------------

/** Storey height used when stacking a new floor above the last one. */
const DEFAULT_STOREY = 3.0

export function addFloor(plan: Plan, name?: string): Plan {
  const last = plan.floors[plan.floors.length - 1]
  const floor = emptyFloor(name ?? `Floor ${plan.floors.length}`, last.elevation + DEFAULT_STOREY)
  return { ...plan, floors: [...plan.floors, floor], activeFloorId: floor.id }
}

/**
 * Copy an existing floor's walls onto a new one.
 *
 * This is the common case in a multi-storey building — floors two through
 * fourteen are the same plan — and doing it by re-tracing is both slow and a
 * guarantee that the storeys do not line up.
 */
export function duplicateFloor(plan: Plan, sourceId: string, name?: string): Plan {
  const source = plan.floors.find((f) => f.id === sourceId)
  if (!source) return plan

  const last = plan.floors[plan.floors.length - 1]

  // Remap ids so the copy is independent: sharing vertex ids across floors
  // would make a room name on one storey apply to the other.
  const vertexMap = new Map<string, string>()
  const vertices: Floor['vertices'] = {}
  for (const v of Object.values(source.vertices)) {
    const id = nextId('v')
    vertexMap.set(v.id, id)
    vertices[id] = { id, x: v.x, y: v.y }
  }

  const walls: Floor['walls'] = {}
  const wallMap = new Map<string, string>()
  for (const w of Object.values(source.walls)) {
    const id = nextId('w')
    wallMap.set(w.id, id)
    walls[id] = {
      ...w,
      id,
      a: vertexMap.get(w.a)!,
      b: vertexMap.get(w.b)!,
    }
  }

  const floor: Floor = {
    id: nextId('f'),
    name: name ?? `Floor ${plan.floors.length}`,
    elevation: last.elevation + DEFAULT_STOREY,
    vertices,
    walls,
    // Room names are deliberately not copied: the ids they are keyed by belong
    // to the source floor's vertices and would never match here.
    roomNames: {},
    // Objects *are* copied — duplicating a storey in a block of flats is
    // supposed to bring the fit-out with it, which is most of the work.
    objects: Object.fromEntries(
      Object.values(source.objects ?? {}).map((object) => {
        const id = nextId('o')
        return [
          id,
          {
            ...object,
            id,
            // Wall references point at the source floor's walls; remap them so
            // a door still knows which wall it is cut into.
            wallId: object.wallId ? wallMap.get(object.wallId) : undefined,
          },
        ]
      }),
    ),
    underlay: source.underlay,
  }

  return { ...plan, floors: [...plan.floors, floor], activeFloorId: floor.id }
}

export function removeFloor(plan: Plan, floorId: string): Plan {
  // A plan always has at least one floor; removing the last one would leave the
  // editor with nothing to draw on and no way back.
  if (plan.floors.length <= 1) return plan

  const floors = plan.floors.filter((f) => f.id !== floorId)
  const activeFloorId = plan.activeFloorId === floorId ? floors[0].id : plan.activeFloorId
  return { ...plan, floors, activeFloorId }
}

export function setActiveFloor(plan: Plan, floorId: string): Plan {
  return plan.floors.some((f) => f.id === floorId) ? { ...plan, activeFloorId: floorId } : plan
}

export function renameFloor(plan: Plan, floorId: string, name: string): Plan {
  return {
    ...plan,
    floors: plan.floors.map((f) => (f.id === floorId ? { ...f, name: name.trim() || f.name } : f)),
  }
}

export function setUnderlay(plan: Plan, underlay: Underlay | null): Plan {
  return withFloor(plan, (floor) => ({ ...floor, underlay }))
}

/**
 * Place a freshly uploaded drawing.
 *
 * The initial scale is a guess — deliberately one that makes the image a
 * plausible building rather than one that is honest about being unknown. A
 * drawing dropped in at 1 metre per pixel is four hundred metres across and
 * invisible at any sane zoom, and the user's first impression is that the
 * upload failed. Assuming a typical plan is about 12 m wide puts it on screen
 * at roughly the right size, and calibration corrects it.
 */
const ASSUMED_PLAN_WIDTH_M = 12

export function placeUnderlay(
  plan: Plan,
  input: { url: string; width: number; height: number },
): Plan {
  const scale = ASSUMED_PLAN_WIDTH_M / Math.max(1, input.width)

  return setUnderlay(plan, {
    url: input.url,
    width: input.width,
    height: input.height,
    // Centred on the world origin, so it lands where the camera already is.
    origin: {
      x: -(input.width * scale) / 2,
      y: (input.height * scale) / 2,
    },
    scale,
    // Higher than it looks like it should be: inverted, the paper reads as
    // near-black, so most of this opacity is spent on the lines.
    opacity: 0.85,
    invert: true,
    locked: true,
  })
}

/**
 * Rescale the underlay so that two points on it are a known distance apart.
 *
 * ── What stays fixed ────────────────────────────────────────────────────────
 * Rescaling has to pivot about *something*, and the choice is visible: the
 * pivot is the only point that does not move on screen. Three candidates:
 *
 *   the image origin  — the corner is usually off-screen, so the drawing
 *                       appears to fly away from wherever you were looking
 *   the image centre  — better, but still shifts the part you were measuring
 *   the first click   — the point you just touched stays exactly put
 *
 * The third is used here. You click one end of a known dimension, click the
 * other, type the length, and the end you started from does not budge — which
 * makes it obvious the scale changed and nothing else did.
 */
export function calibrateUnderlay(
  plan: Plan,
  from: Vec2,
  to: Vec2,
  actualMetres: number,
): Plan {
  return withFloor(plan, (floor) => {
    const underlay = floor.underlay
    if (!underlay) return floor

    const measured = distance(from, to)
    // A zero-length or nonsensical calibration would divide by zero or invert
    // the drawing. Refusing leaves the old scale, which is at least usable.
    if (measured < 1e-6 || !(actualMetres > 0)) return floor

    const factor = actualMetres / measured

    return {
      ...floor,
      underlay: {
        ...underlay,
        scale: underlay.scale * factor,
        calibrated: true,
        // Pivot about `from`: everything moves away from it by `factor`.
        origin: {
          x: from.x + (underlay.origin.x - from.x) * factor,
          y: from.y + (underlay.origin.y - from.y) * factor,
        },
      },
    }
  })
}

/**
 * Set the scale from the drawing's own printed dimensions.
 *
 * Pivots about the top-left corner rather than a clicked point, because there
 * is no clicked point — this comes from reading the sizes an architect wrote on
 * the plan, not from anyone measuring anything. The corner is the one part of
 * the underlay whose position was never a judgement.
 */
export function rescaleUnderlay(plan: Plan, metresPerPixel: number): Plan {
  return withFloor(plan, (floor) => {
    const underlay = floor.underlay
    if (!underlay || !(metresPerPixel > 0)) return floor
    return { ...floor, underlay: { ...underlay, scale: metresPerPixel, calibrated: true } }
  })
}

// ---- History ---------------------------------------------------------------

export interface History {
  past: Plan[]
  present: Plan
  future: Plan[]
}

/** Deep enough to cover a work session, shallow enough not to grow unbounded. */
const HISTORY_LIMIT = 60

export const initialHistory = (plan: Plan): History => ({
  past: [],
  present: plan,
  future: [],
})

/**
 * Record a new state.
 *
 * `future` is cleared, which is the standard and correct behaviour: once you
 * undo and then do something else, the branch you undid is gone. Keeping it
 * would require a tree, and a redo that jumps to a state the user cannot see
 * the path to is worse than no redo.
 */
export function commit(history: History, plan: Plan): History {
  if (plan === history.present) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: plan,
    future: [],
  }
}

/**
 * Record a state that was reached through live, uncommitted edits.
 *
 * ── Why `commit` cannot do this job ─────────────────────────────────────────
 * A drag applies its frames through `applyLive`, which replaces `present`
 * sixty times a second without touching `past`. When the gesture ends, the
 * pre-gesture state exists nowhere but in whatever the caller saved — so
 * `commit(history, history.present)` at gesture end compares present with
 * itself and is a GUARANTEED no-op. Both gesture-end call sites did exactly
 * that, which meant no drag ever created an undo entry: one Ctrl+Z after
 * moving a wall deleted the action BEFORE the move, and the move survived.
 *
 * This takes the state the gesture started from and pushes THAT. If the
 * gesture ended where it began, nothing is recorded — releasing a wall where
 * it was is not an action a user expects Ctrl+Z to revisit.
 */
export function commitFrom(history: History, before: Plan | null): History {
  if (!before || before === history.present) return history
  return {
    past: [...history.past, before].slice(-HISTORY_LIMIT),
    present: history.present,
    future: [],
  }
}

export function undo(history: History): History {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redo(history: History): History {
  if (history.future.length === 0) return history
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  }
}

// ---- Objects ---------------------------------------------------------------

/** Place a new object. The caller has already resolved position and rotation. */
export function addObject(plan: Plan, object: Omit<PlacedObject, 'id'>): Plan {
  const id = nextId('o')
  return withFloor(plan, (floor) => ({
    ...floor,
    objects: { ...floor.objects, [id]: { ...object, id } },
  }))
}

export function updateObject(
  plan: Plan,
  objectId: string,
  patch: Partial<PlacedObject>,
): Plan {
  return withFloor(plan, (floor) => {
    const object = floor.objects[objectId]
    if (!object) return floor
    // `id` is identity, not a property: letting a patch rewrite it would
    // detach the object from every reference to it.
    const { id: _id, bimSource: _bimSource, bimData: _bimData, ...safe } = patch
    return { ...floor, objects: { ...floor.objects, [objectId]: { ...object, ...safe } } }
  })
}

export function removeObject(plan: Plan, objectId: string): Plan {
  return withFloor(plan, (floor) => {
    const { [objectId]: gone, ...objects } = floor.objects
    return gone ? { ...floor, objects } : floor
  })
}

/** Resize an object, keeping it centred where it is. */
export function resizeObject(plan: Plan, objectId: string, size: Size): Plan {
  return updateObject(plan, objectId, { size })
}

/** Every object on the active floor, in insertion order. */
export function objectsOn(floor: Floor): PlacedObject[] {
  return Object.values(floor.objects ?? {})
}
