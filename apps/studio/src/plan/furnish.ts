import type { DetectedRoom, DetectionResult } from './detections'
import type { Underlay, Vec2 } from './types'
import { CATALOGUE } from '../catalogue/items'
import { identify, roomItems, type Evidence } from '../catalogue/recognise'
import type { CatalogueItem, Size } from '../catalogue/types'

/**
 * Furnishing a plan from what the drawing already shows.
 *
 * ── Why this is not "add a bed to every bedroom" ────────────────────────────
 * The furniture is usually *already drawn*. An architect's plan shows the bed,
 * the wardrobe run, the sofa and the dining table, at their real sizes and in
 * their real positions, because that is how a client sees the space works. All
 * of that is information nobody has to guess at, and the earlier version of
 * this reader threw it away — first by extruding it into walls, then, once that
 * was fixed, by discarding it as "not a room".
 *
 * So the first and best source of furniture is the drawing's own outlines: each
 * one has a footprint, often a label, and always a room around it. Guessing
 * from the room type is the fallback for rooms that were drawn empty, and it is
 * marked as a guess so the two are never confused on screen.
 */

export interface Proposal {
  /** Catalogue item id. */
  item: string
  /** Plan coordinates in metres — the object's centre. */
  position: Vec2
  /** Radians, counter-clockwise from +X. */
  rotation: number
  /** Set only when measured off the drawing rather than taken from the catalogue. */
  size?: Size
  /** Which room this belongs to, for grouping in the review. */
  room: string | null
  evidence: Evidence
  confidence: number
  because: string
}

const BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]))

/**
 * Where a normalised detection lands in the plan's world.
 *
 * The same transform `convertDetections` applies to walls. Kept as one function
 * so furniture and walls cannot drift apart — a bed half a metre off its own
 * bedroom is the exact failure this prevents, and it would look like a
 * furnishing bug rather than a transform one.
 */
function toWorld(point: { x: number; y: number }, underlay: Underlay): Vec2 {
  return {
    x: underlay.origin.x + point.x * underlay.width * underlay.scale,
    y: underlay.origin.y + point.y * underlay.height * underlay.scale,
  }
}

/** Axis-aligned bounds of a normalised polygon, in world metres. */
function bounds(polygon: { x: number; y: number }[], underlay: Underlay) {
  const points = polygon.map((point) => toWorld(point, underlay))
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    depth: maxY - minY,
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }
}

/**
 * The rotation that puts an object's back against the nearest edge of its room.
 *
 * ── Why orientation is not optional ─────────────────────────────────────────
 * Every builder in the catalogue draws its subject facing local +Z: a sofa's
 * back at -Z, a bed's headboard at -Z, a wardrobe's doors at +Z. An object
 * dropped at rotation 0 therefore faces plan -y regardless of what is behind
 * it, and about half the time that is a wall. A sofa with its back to the room
 * and its face in the plaster reads as broken far more loudly than a sofa at a
 * slightly odd angle.
 *
 * The drawing does not say which way anything faces, so this infers it from the
 * one thing it does say: which wall the object is closest to. Objects near the
 * middle of a room get rotation 0, because there is nothing to be against and
 * guessing there is worse than being square to the plan.
 *
 * At rotation r an object faces (-sin r, -cos r), so facing +y is r = π.
 */
function facingAwayFromWall(
  centre: Vec2,
  room: ReturnType<typeof bounds>,
  clearance: number,
): number {
  const gaps = [
    { rotation: Math.PI, distance: centre.y - room.minY }, // against the top, facing down
    { rotation: 0, distance: room.maxY - centre.y }, // against the bottom, facing up
    { rotation: -Math.PI / 2, distance: centre.x - room.minX }, // against the left
    { rotation: Math.PI / 2, distance: room.maxX - centre.x }, // against the right
  ]

  const nearest = gaps.reduce((a, b) => (a.distance <= b.distance ? a : b))
  return nearest.distance <= clearance ? nearest.rotation : 0
}

/** Do two axis-aligned footprints overlap? */
function collides(
  a: { centre: Vec2; width: number; depth: number },
  b: { centre: Vec2; width: number; depth: number },
): boolean {
  return (
    Math.abs(a.centre.x - b.centre.x) < (a.width + b.width) / 2 &&
    Math.abs(a.centre.y - b.centre.y) < (a.depth + b.depth) / 2
  )
}

/**
 * Everything the drawing shows, plus what its rooms imply.
 *
 * `assume` controls the second half. Off by default, and the default is the
 * honest one: a plan that draws its furniture should be read, not overwritten
 * with a generic arrangement. Turn it on for a bare plan, where a bedroom with
 * nothing in it genuinely is better shown with a bed than empty.
 */
export function proposeFurniture(
  detection: DetectionResult,
  underlay: Underlay,
  { assume = false }: { assume?: boolean } = {},
): Proposal[] {
  const regions = detection.rooms ?? []
  const rooms = regions.filter((region) => region.kind === 'room')
  const fittings = regions.filter((region) => region.kind === 'fitting')

  const proposals: Proposal[] = []
  const taken: { centre: Vec2; width: number; depth: number }[] = []

  // ---- What was drawn ------------------------------------------------------
  for (const fitting of fittings) {
    const box = bounds(fitting.polygon, underlay)
    const room = enclosingRoom(fitting, rooms)

    const found = identify({
      label: fitting.name,
      width: box.width,
      depth: box.depth,
      room: room?.name ?? null,
    })
    if (!found) continue

    const roomBox = room ? bounds(room.polygon, underlay) : box
    proposals.push({
      item: found.item.id,
      position: box.centre,
      rotation: facingAwayFromWall(box.centre, roomBox, Math.max(box.width, box.depth)),
      // The drawing's own measurement beats the catalogue's default, because it
      // is the size of *this* wardrobe rather than of wardrobes in general.
      size: measured(found.item, box.width, box.depth),
      room: room?.name ?? null,
      evidence: found.evidence,
      confidence: found.confidence,
      because: found.because,
    })
    taken.push({ centre: box.centre, width: box.width, depth: box.depth })
  }

  if (!assume) return proposals

  // ---- What the rooms imply ------------------------------------------------
  for (const room of rooms) {
    if (!room.name) continue
    const recipe = roomItems(room.name)
    if (!recipe) continue

    const box = bounds(room.polygon, underlay)
    // Nothing is placed in a room that already has something drawn in it. The
    // architect furnished that room; adding a second bed beside theirs is not
    // help.
    if (taken.some((slot) => collides(slot, { centre: box.centre, width: box.width, depth: box.depth }))) {
      continue
    }

    for (const id of recipe) {
      const item = BY_ID.get(id)
      if (!item || item.placement !== 'floor') continue

      const spot = freeSpot(item, box, taken)
      if (!spot) continue

      proposals.push({
        item: id,
        position: spot,
        rotation: facingAwayFromWall(spot, box, Math.max(item.size.width, item.size.depth)),
        room: room.name,
        evidence: 'typical',
        confidence: 0.4,
        because: `a ${room.name.toLowerCase()} usually has one`,
      })
      taken.push({ centre: spot, width: item.size.width, depth: item.size.depth })
    }
  }

  return proposals
}

/**
 * The measured size, unless the drawing plainly disagrees with the catalogue.
 *
 * A footprint more than double or less than half the catalogue's is not this
 * object drawn a little differently — it is a region that swallowed its
 * neighbour, or a label sitting in the wrong outline. Taking the catalogue size
 * there produces a sensible object in roughly the right place, which is far
 * more useful than a two-metre-wide bedside table.
 */
function measured(item: CatalogueItem, width: number, depth: number): Size | undefined {
  const drawn = width * depth
  const expected = item.size.width * item.size.depth
  if (!expected || drawn / expected > 2 || drawn / expected < 0.5) return undefined

  return { width, depth, height: item.size.height }
}

/**
 * How far outside a room a fitting may sit and still belong to it.
 *
 * A fraction of the drawing, because region boundaries are approximations: the
 * flood stops at a wall's inner face, an alcove or a wardrobe recess often
 * falls a few pixels the wrong side of it, and a wardrobe two centimetres
 * outside a bedroom is in the bedroom. Small enough that it cannot reach across
 * a room to claim its neighbour's furniture.
 */
const ROOM_REACH = 0.02

/**
 * The room a fitting belongs to.
 *
 * Containment first, then nearest-within-reach. The second pass matters more
 * than it looks: on a real villa plan the walk-in wardrobe fell just outside
 * every room outline, so it had no room, and with no room the only evidence
 * left was its size — which identified a 1.31 x 1.17 m block as a two-seat
 * sofa. Attaching it to the foyer it opens off is both true and the thing that
 * stops the guess.
 */
function enclosingRoom(fitting: DetectedRoom, rooms: DetectedRoom[]): DetectedRoom | null {
  const centre = {
    x: fitting.polygon.reduce((sum, p) => sum + p.x, 0) / fitting.polygon.length,
    y: fitting.polygon.reduce((sum, p) => sum + p.y, 0) / fitting.polygon.length,
  }

  // Smallest containing room wins: an ensuite sits inside a bedroom's bounding
  // box, and a basin in the ensuite belongs to the ensuite.
  let best: DetectedRoom | null = null
  for (const room of rooms) {
    if (!contains(room.polygon, centre)) continue
    if (!best || room.area < best.area) best = room
  }
  if (best) return best

  // Nothing contained it. Take the nearest room it is almost inside, measured
  // against the bounding box rather than the outline — an outline is exactly
  // what has already proved unreliable here.
  let nearest: { room: DetectedRoom; distance: number } | null = null
  for (const room of rooms) {
    const xs = room.polygon.map((p) => p.x)
    const ys = room.polygon.map((p) => p.y)
    const dx = Math.max(Math.min(...xs) - centre.x, 0, centre.x - Math.max(...xs))
    const dy = Math.max(Math.min(...ys) - centre.y, 0, centre.y - Math.max(...ys))
    const distance = Math.hypot(dx, dy)

    if (distance <= ROOM_REACH && (!nearest || distance < nearest.distance)) {
      nearest = { room, distance }
    }
  }
  return nearest?.room ?? null
}

function contains(polygon: { x: number; y: number }[], point: { x: number; y: number }): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > point.y !== b.y > point.y) {
      const crossing = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)
      if (point.x < crossing) inside = !inside
    }
  }
  return inside
}

/**
 * Somewhere in the room this item fits without hitting anything already there.
 *
 * Tries the wall positions a person would: centred on each wall first, then the
 * corners, then the middle. Not an optimiser — the arrangement only has to be
 * plausible enough to drag into place, and a room laid out by an algorithm
 * nobody can predict is harder to correct than one laid out predictably.
 */
function freeSpot(
  item: CatalogueItem,
  room: ReturnType<typeof bounds>,
  taken: { centre: Vec2; width: number; depth: number }[],
): Vec2 | null {
  const halfWidth = item.size.width / 2
  const halfDepth = item.size.depth / 2
  const margin = 0.05 // a hand's width off the plaster

  if (item.size.width > room.width || item.size.depth > room.depth) return null

  const spots: Vec2[] = [
    { x: room.centre.x, y: room.minY + halfDepth + margin },
    { x: room.centre.x, y: room.maxY - halfDepth - margin },
    { x: room.minX + halfWidth + margin, y: room.centre.y },
    { x: room.maxX - halfWidth - margin, y: room.centre.y },
    { x: room.minX + halfWidth + margin, y: room.minY + halfDepth + margin },
    { x: room.maxX - halfWidth - margin, y: room.minY + halfDepth + margin },
    { x: room.minX + halfWidth + margin, y: room.maxY - halfDepth - margin },
    { x: room.maxX - halfWidth - margin, y: room.maxY - halfDepth - margin },
    room.centre,
  ]

  for (const spot of spots) {
    const footprint = { centre: spot, width: item.size.width, depth: item.size.depth }
    if (!taken.some((slot) => collides(slot, footprint))) return spot
  }
  return null
}

/** A one-line summary for the review panel. */
export function summariseFurniture(proposals: Proposal[]) {
  return {
    total: proposals.length,
    drawn: proposals.filter((p) => p.evidence !== 'typical').length,
    assumed: proposals.filter((p) => p.evidence === 'typical').length,
    rooms: new Set(proposals.map((p) => p.room).filter(Boolean)).size,
  }
}
