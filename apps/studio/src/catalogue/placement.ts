import type { Floor, Vec2 } from '../plan/types'
import { closestPointOnSegment, distance, sub } from '../plan/geometry'
import type { CatalogueItem, PlacedObject, Size } from './types'
import { itemById } from './items'

/**
 * Working out where a dropped object should actually go.
 *
 * Placement is not "put it where the pointer is". A door belongs *in* a wall,
 * aligned to it and centred in its thickness; a TV belongs *on* a wall face,
 * turned to look into the room. Getting that automatic is the difference
 * between a catalogue and a sticker book.
 */

/** How close to a wall an attachable object must be dropped, in metres. */
export const WALL_SNAP_DISTANCE = 1.2

export interface Placement {
  position: Vec2
  rotation: number
  wallId?: string
  /** Set when the drop cannot be honoured, so the UI can explain rather than guess. */
  problem?: string
}

interface WallHit {
  wallId: string
  point: Vec2
  distance: number
  /** Direction along the wall. */
  along: Vec2
  /** How far along the wall the hit is, 0..1. */
  t: number
  thickness: number
  length: number
}

/** Nearest wall to a point, with everything placement needs to know about it. */
export function nearestWall(floor: Floor, point: Vec2, within: number): WallHit | null {
  let best: WallHit | null = null

  for (const wall of Object.values(floor.walls)) {
    const a = floor.vertices[wall.a]
    const b = floor.vertices[wall.b]
    if (!a || !b) continue

    const hit = closestPointOnSegment(point, a, b)
    if (hit.distance > within) continue
    if (best && hit.distance >= best.distance) continue

    const span = sub(b, a)
    const length = Math.hypot(span.x, span.y)
    if (length < 1e-6) continue

    best = {
      wallId: wall.id,
      point: hit.point,
      distance: hit.distance,
      along: { x: span.x / length, y: span.y / length },
      t: hit.t,
      thickness: wall.thickness,
      length,
    }
  }

  return best
}

/**
 * Resolve a drop into a final position and rotation.
 *
 * Floor and ceiling objects land where they were dropped. Wall and in-wall
 * objects need a wall, and are refused if there is not one nearby — silently
 * dropping a door in the middle of a room would produce a door-shaped object
 * floating in space with no hole, which is worse than saying no.
 */
/**
 * The rotation that makes an object face a given direction in plan space.
 *
 * ── The convention, derived once ────────────────────────────────────────────
 * Every builder draws its subject facing local +Z: a sofa's backrest sits at
 * -Z, a bed's headboard at -Z, a wardrobe's doors at +Z. Geometry is placed
 * with `group.rotation.y = -object.rotation`, and plan (x, y) maps to world
 * (x, _, -y).
 *
 * Composing those, an object at rotation r faces plan direction
 * `(-sin r, -cos r)`. Inverting gives this. At r = 0 an object faces -y, which
 * is "south" on the plan and is why an unrotated sofa in an empty room has its
 * back to the top of the screen.
 */
export function rotationFacing(direction: Vec2): number {
  return Math.atan2(-direction.x, -direction.y)
}

/**
 * Put the back of a floor object against the nearest wall.
 *
 * ── Why this is worth doing automatically ───────────────────────────────────
 * Almost all floor furniture has a back that belongs against something: a sofa,
 * a bed's headboard, a wardrobe, a bookshelf, a TV unit. Dropping one at
 * rotation 0 regardless leaves it facing whichever way the builder happened to
 * draw it, which is a wall about half the time — and a chair facing a wall
 * reads as broken far more loudly than a chair at a slightly odd angle.
 *
 * Beyond `WALL_SNAP_DISTANCE` nothing is inferred. An object in the middle of
 * a room has no wall it is "against", and guessing an orientation there is
 * worse than leaving it square to the plan, which is at least predictable.
 *
 * Symmetric objects — a dining table, a rug, a coffee table — are unharmed by
 * this, so it is not worth a per-item flag to exclude them.
 */
export function facingIntoRoom(floor: Floor, point: Vec2): number {
  const hit = nearestWall(floor, point, WALL_SNAP_DISTANCE)
  if (!hit) return 0

  // From the wall towards the object: the way it should look.
  const away = { x: point.x - hit.point.x, y: point.y - hit.point.y }
  const length = Math.hypot(away.x, away.y)

  // Dropped exactly on the centreline, so there is no "away" to compute. The
  // wall's own direction is the best remaining guess and is at least parallel
  // to it rather than into it.
  if (length < 1e-6) return Math.atan2(hit.along.y, hit.along.x)

  return rotationFacing({ x: away.x / length, y: away.y / length })
}

export function resolvePlacement(
  floor: Floor,
  item: CatalogueItem,
  point: Vec2,
): Placement {
  // A ceiling object has no meaningful facing — a pendant looks the same from
  // every side — so only floor objects are oriented.
  if (item.placement === 'ceiling') {
    return { position: point, rotation: 0 }
  }

  if (item.placement === 'floor') {
    return { position: point, rotation: facingIntoRoom(floor, point) }
  }

  const hit = nearestWall(floor, point, WALL_SNAP_DISTANCE)
  if (!hit) {
    return {
      position: point,
      rotation: 0,
      problem:
        item.placement === 'in-wall'
          ? 'A door or window has to go in a wall. Drop it on one.'
          : 'This hangs on a wall. Drop it closer to one.',
    }
  }

  const size = item.size
  const rotation = Math.atan2(hit.along.y, hit.along.x)

  // An opening must fit within the wall's run, or it is not an opening, it is a
  // missing wall. Checked here rather than after insertion so the message can
  // name the actual constraint.
  if (item.placement === 'in-wall' && size.width > hit.length) {
    return {
      position: hit.point,
      rotation,
      wallId: hit.wallId,
      problem: `That wall is only ${hit.length.toFixed(2)} m long — too short for this.`,
    }
  }

  if (item.placement === 'in-wall') {
    // Centred *in* the wall: on its centreline, which is where the hit already
    // is, since walls are stored as centrelines.
    return { position: clampAlongWall(hit, size), rotation, wallId: hit.wallId }
  }

  // A wall-mounted object hangs on a face, so it sits half its depth off the
  // centreline — on the side the pointer was, which is the room the user is
  // looking at.
  const normal = { x: -hit.along.y, y: hit.along.x }
  const side = Math.sign(
    (point.x - hit.point.x) * normal.x + (point.y - hit.point.y) * normal.y,
  ) || 1
  const offset = hit.thickness / 2 + size.depth / 2

  const anchored = clampAlongWall(hit, size)
  return {
    position: {
      x: anchored.x + normal.x * offset * side,
      y: anchored.y + normal.y * offset * side,
    },
    // Turned to face into the room rather than along the wall.
    rotation,
    wallId: hit.wallId,
  }
}

/**
 * Keep the object's full width on the wall.
 *
 * Dropping a 2.1 m window 200 mm from the end of a wall would otherwise leave
 * most of it hanging past the corner. Sliding it back in is what a person would
 * do, so the tool does it.
 */
function clampAlongWall(hit: WallHit, size: Size): Vec2 {
  const half = size.width / 2
  const margin = Math.min(half, hit.length / 2)

  const centre = hit.t * hit.length
  const clamped = Math.max(margin, Math.min(hit.length - margin, centre))
  const shift = clamped - centre

  return {
    x: hit.point.x + hit.along.x * shift,
    y: hit.point.y + hit.along.y * shift,
  }
}

/** Resolved size for a placed object — its override, or the catalogue default. */
export function sizeOf(object: PlacedObject): Size {
  return object.size ?? itemById(object.item)?.size ?? { width: 1, depth: 1, height: 1 }
}

/** Resolved elevation above this floor's level. */
export function elevationOf(object: PlacedObject): number {
  if (object.elevation !== undefined) return object.elevation
  return itemById(object.item)?.mountHeight ?? 0
}

/**
 * The object's footprint as four corners, for hit-testing and 2D drawing.
 *
 * Returned counter-clockwise so the same polygon helpers that handle rooms
 * work on it without a special case.
 */
export function footprint(object: PlacedObject): Vec2[] {
  const size = sizeOf(object)
  const cos = Math.cos(object.rotation)
  const sin = Math.sin(object.rotation)

  const halfWidth = size.width / 2
  const halfDepth = size.depth / 2

  return [
    [-halfWidth, -halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
    [-halfWidth, halfDepth],
  ].map(([x, y]) => ({
    x: object.position.x + x * cos - y * sin,
    y: object.position.y + x * sin + y * cos,
  }))
}

/** Objects whose centre is within `radius` of a point, nearest first. */
export function objectsNear(
  objects: PlacedObject[],
  point: Vec2,
  radius: number,
): PlacedObject[] {
  return objects
    .map((object) => ({ object, d: distance(object.position, point) }))
    .filter((entry) => entry.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((entry) => entry.object)
}
