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
export function resolvePlacement(
  floor: Floor,
  item: CatalogueItem,
  point: Vec2,
): Placement {
  if (item.placement === 'floor' || item.placement === 'ceiling') {
    return { position: point, rotation: 0 }
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
