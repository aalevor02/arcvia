import type { Floor, Room, Vec2, Vertex } from './types'
import { MIN_ROOM_AREA } from './types'
import { labelPoint, signedArea } from './geometry'

/**
 * Rooms, derived from the wall graph.
 *
 * ── The algorithm ───────────────────────────────────────────────────────────
 * The walls form a planar graph. Its bounded faces are the rooms. Finding them
 * is a standard traversal, and the whole trick is one rule:
 *
 *   From a directed half-edge u→v, the next half-edge is the one leaving v that
 *   is **the first clockwise** from the direction v→u.
 *
 * Always taking that turn traces one face and returns to where it started.
 * Doing it from every half-edge, skipping ones already visited, yields every
 * face exactly once.
 *
 * ── Telling rooms from the outside of the building ──────────────────────────
 * That rule traverses enclosed faces counter-clockwise and the outer boundary
 * clockwise. So the sign of the shoelace area separates them with no special
 * case and no "biggest polygon is the outside" heuristic — which is wrong the
 * moment a building has a courtyard, or the plan has two disconnected wings.
 *
 *   signedArea > 0  → a room
 *   signedArea < 0  → the outside of a connected component, discard
 *
 * ── Why rooms are recomputed rather than stored ─────────────────────────────
 * See the note in `types.ts`. The consequence worth stating here: a room has no
 * identity of its own, so anything a user attaches to one (its name) is keyed
 * by a hash of the cycle and lives on `Floor.roomNames`. Edit an unrelated wall
 * and the hash is unchanged, so the name stays put.
 */

export function detectRooms(floor: Floor): Room[] {
  const vertices = floor.vertices
  const walls = Object.values(floor.walls)

  // ---- Adjacency, sorted by angle ------------------------------------------
  // Sorting once here is what makes "next clockwise neighbour" an O(log n)
  // lookup per step instead of a scan of every neighbour.
  const neighbours = new Map<string, { id: string; angle: number }[]>()

  const push = (from: string, to: string) => {
    const a = vertices[from]
    const b = vertices[to]
    if (!a || !b) return
    const list = neighbours.get(from) ?? []
    list.push({ id: to, angle: Math.atan2(b.y - a.y, b.x - a.x) })
    neighbours.set(from, list)
  }

  for (const wall of walls) {
    // Skip degenerate self-loops: they cannot bound a face and they make the
    // traversal spin.
    if (wall.a === wall.b) continue
    push(wall.a, wall.b)
    push(wall.b, wall.a)
  }

  for (const list of neighbours.values()) list.sort((p, q) => p.angle - q.angle)

  // ---- Trace faces ---------------------------------------------------------
  const visited = new Set<string>()
  const key = (from: string, to: string) => `${from}>${to}`
  const rooms: Room[] = []

  for (const wall of walls) {
    for (const [from, to] of [
      [wall.a, wall.b],
      [wall.b, wall.a],
    ] as const) {
      if (wall.a === wall.b) continue
      if (visited.has(key(from, to))) continue

      const loop = traceFace(from, to, neighbours, visited, key)
      if (!loop || loop.length < 3) continue

      const polygon = loop.map((id) => ({ x: vertices[id].x, y: vertices[id].y }))
      const signed = signedArea(polygon)

      // Negative = the outside of this component. Positive but tiny = an
      // artefact of a dead-end wall, where the traversal walks out and back
      // along the same edge and encloses nothing.
      if (signed <= 0 || signed < MIN_ROOM_AREA) continue

      rooms.push({
        id: roomId(loop),
        loop,
        polygon,
        area: signed,
        label: labelPoint(polygon),
      })
    }
  }

  // Largest first, so the room list reads the way a person would order it.
  return rooms.sort((a, b) => b.area - a.area)
}

/**
 * Walk one face and return its vertex loop, or null if the walk did not close.
 *
 * The step cap is a safety net, not a correctness mechanism: a well-formed
 * planar graph always closes. It exists because a malformed one — produced by,
 * say, a floating-point coincidence in an imported plan — would otherwise hang
 * the editor rather than render a wrong room.
 */
function traceFace(
  startFrom: string,
  startTo: string,
  neighbours: Map<string, { id: string; angle: number }[]>,
  visited: Set<string>,
  key: (a: string, b: string) => string,
): string[] | null {
  const loop: string[] = []
  let from = startFrom
  let to = startTo

  const MAX_STEPS = 10000
  for (let step = 0; step < MAX_STEPS; step++) {
    visited.add(key(from, to))
    loop.push(from)

    const next = nextClockwise(to, from, neighbours)
    if (next === null) return null

    from = to
    to = next

    if (from === startFrom && to === startTo) return loop
  }

  return null
}

/**
 * At vertex `at`, arriving from `cameFrom`, pick the next edge for the face
 * walk: the first neighbour clockwise from the direction back down the edge we
 * arrived on.
 *
 * A dead end (degree 1) has only `cameFrom` as a neighbour, so the answer is to
 * turn around and come back — which is correct, and is what makes a spur wall
 * produce a zero-area face that the caller then discards.
 */
function nextClockwise(
  at: string,
  cameFrom: string,
  neighbours: Map<string, { id: string; angle: number }[]>,
): string | null {
  const list = neighbours.get(at)
  if (!list || list.length === 0) return null

  const backIndex = list.findIndex((n) => n.id === cameFrom)
  if (backIndex === -1) return null

  // The list is sorted counter-clockwise by angle, so stepping one index *down*
  // (wrapping) is one step clockwise.
  const nextIndex = (backIndex - 1 + list.length) % list.length
  return list[nextIndex].id
}

/**
 * A stable id for a cycle, independent of where the traversal happened to start
 * or which direction it ran.
 *
 * Both normalisations matter. Face extraction has no reason to begin at the
 * same vertex twice in a row, so without rotating to a canonical start the same
 * physical room gets a different id on every recompute — and its name is lost
 * every time a wall moves anywhere on the floor.
 */
export function roomId(loop: string[]): string {
  if (loop.length === 0) return 'room:empty'

  // Rotate so the lexicographically smallest vertex id leads.
  let min = 0
  for (let i = 1; i < loop.length; i++) if (loop[i] < loop[min]) min = i
  const rotated = [...loop.slice(min), ...loop.slice(0, min)]

  // Then fix the direction by comparing against the reversed form, so a loop
  // and its mirror hash identically.
  const reversed = [rotated[0], ...rotated.slice(1).reverse()]
  const canonical =
    rotated.join(',') <= reversed.join(',') ? rotated : reversed

  return `room:${canonical.join(',')}`
}

/**
 * Default room names.
 *
 * Numbered by area rank rather than creation order, because "Room 1" should be
 * a stable description of the plan rather than a record of which wall the user
 * happened to draw first.
 */
export function displayName(
  room: Room,
  index: number,
  names: Record<string, string>,
): string {
  return names[room.id] ?? `Room ${index + 1}`
}

/** Total enclosed area across every room on the floor, in square metres. */
export function totalArea(rooms: Room[]): number {
  return rooms.reduce((sum, r) => sum + r.area, 0)
}

/** Bounding box of everything drawn, for zoom-to-fit. */
export function planBounds(
  vertices: Record<string, Vertex>,
): { min: Vec2; max: Vec2 } | null {
  const list = Object.values(vertices)
  if (list.length === 0) return null

  const xs = list.map((v) => v.x)
  const ys = list.map((v) => v.y)
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  }
}
