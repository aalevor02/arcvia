import { itemById } from '../catalogue/items'
import type { Size } from '../catalogue/types'
import { toWorld, type DetectedObject } from './detections'
import type { Floor, Underlay, Vec2 } from './types'

/**
 * Turn the reader's door gaps into openings the wall builder will cut.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `buildGeometry` cuts a hole for any placed object whose item is `in-wall` and
 * which names a `wallId`. Until this existed, the ONLY thing that ever created
 * one was a person dragging a door out of the catalogue. So a drawing uploaded
 * as a PDF or an image produced walls, rooms and names — and then a solid box
 * with no way through it. The reader had found the doorways, reported them, and
 * every one was dropped on the floor between the reader and the model.
 *
 * ── A detected gap is usually ALREADY a hole. This is the whole subtlety ─────
 * `detect_openings` finds gaps BETWEEN COLLINEAR WALLS. Where the plan was
 * built from the reader's walls, those walls stop either side of the doorway,
 * so the doorway is already an absence and there is nothing to cut. Measured on
 * the owner's three sheets, the distance from each gap's centre to the nearest
 * wall came back as 1.845, 0.456, 0.394 and 0.046 m against spans of 3.69,
 * 0.91, 0.79 and 1.28 m — and the first three are EXACTLY half their own span,
 * which is what "the wall ends at the edge of this gap" looks like in metres.
 *
 * A first version of this used `resolvePlacement`, the same call the catalogue
 * uses for a pointer drop. It hosted the 0.91 m gap on the wall 0.456 m away —
 * the wall that ENDS at the doorway — and would have punched a second 0.91 m
 * hole through solid wall beside an opening that was already there. The three
 * refusals it gave were right and its one success was wrong.
 *
 * So the test here is whether wall MATERIAL is present at the gap centre, which
 * is distance to the SEGMENT, not to its line and not to its ends. Only the
 * 0.046 m case is a wall genuinely crossing a doorway — which happens in the
 * outline-rescue path, where room outlines are closed loops that run straight
 * across every doorway. Those are the ones worth cutting; the rest are already
 * open, and reporting nothing for them is the correct answer rather than a
 * missed one.
 *
 * ── Why doors and not windows ───────────────────────────────────────────────
 * Both arrive in `objects`, and it is tempting to take both. The evidence says
 * take one:
 *
 *   - Openings come from `detect_openings`, which measures gaps geometrically.
 *     It is deterministic — byte-identical positions across five reads of one
 *     file.
 *   - Windows come from a vision pass. Five reads of one file returned 5, 5, 5,
 *     4 and 3 windows. On the owner's Avarana drawings, whose annotated ground
 *     truth is ZERO windows, it reports one per sheet.
 *
 * A phantom window is not cosmetic here. It is a hole cut through an exterior
 * wall, and it will light the render through a wall that is not there. A
 * missing window is one the user can add; a hole in the wrong place is one they
 * have to find first. Windows stay out until that signal is worth trusting, and
 * this paragraph is the reason rather than an oversight.
 *
 * ── Why a wide gap is not a wide door ───────────────────────────────────────
 * `detect_openings` finds gaps, and its own tests say so: the two crop-verified
 * villa doors span 0.79 m and 0.91 m, while an Avarana gap between the patio
 * and the room beyond spans 3.69 m with no leaf and no swing arc. A gap that
 * wide is a cased opening, so it gets one — a hole with nothing hung in it —
 * rather than a door stretched to a size no door is made in.
 */

/** A doorway the reader found, resolved onto the wall that crosses it. */
export interface DetectedOpening {
  item: string
  position: Vec2
  rotation: number
  wallId: string
  size: Size
  /** Plain-language provenance, for the review list. */
  because: string
}

/**
 * Below this, a gap is not a doorway. The NBC's minimum leaf is 750 mm for a
 * room and 700 mm for a bathroom, so 600 mm leaves room for measurement error
 * while still excluding the short breaks a traced wall naturally contains.
 */
const NARROWEST_DOORWAY = 0.6

/** Above this a gap has no leaf in it — see the header. */
const WIDEST_DOOR = 1.9

/**
 * How close to the gap's centre a wall must actually BE for that wall to be
 * standing in the doorway. This is a distance to the segment, so it is really
 * asking "is there wall material here". Half of the thickest wall the reader
 * reports is around 0.12 m; 0.25 m keeps that with slack for the centre of a
 * traced gap sitting slightly off the centreline, while staying far below the
 * half-span distances (0.39 m and up) that mean the wall merely ends here.
 */
const CROSSES = 0.25

/**
 * A pier this thin either side is not a wall, it is a sliver. The opening is
 * clamped to leave one rather than being refused: a gap as wide as its host
 * says the whole fragment is doorway, and a doorway 10 cm narrow is a better
 * answer than a wall with no way through it.
 */
const SMALLEST_PIER = 0.05

function itemFor(width: number): string {
  if (width <= 1.25) return 'door'
  if (width <= WIDEST_DOOR) return 'door-double'
  return 'opening'
}

/** The longer side of the box: a doorway is measured across the wall it breaks. */
function spanOf(object: DetectedObject, underlay: Underlay): number {
  const [, , w = 0, h = 0] = object.bbox
  return Math.max(w * underlay.width, h * underlay.height) * underlay.scale
}

function centreOf(object: DetectedObject, underlay: Underlay): Vec2 {
  const [x = 0, y = 0, w = 0, h = 0] = object.bbox
  return toWorld({ x: x + w / 2, y: y + h / 2 }, underlay)
}

interface Host {
  wallId: string
  /** Nearest point on the wall's centreline, where the opening is centred. */
  point: Vec2
  rotation: number
  length: number
  distance: number
}

/**
 * The wall standing in this doorway, if one is.
 *
 * Distance to the segment, deliberately: a wall that merely ends at the gap is
 * not in it, and hosting on one duplicates an opening that already exists.
 */
function wallAcross(floor: Floor, centre: Vec2): Host | null {
  let best: Host | null = null

  for (const wall of Object.values(floor.walls)) {
    const a = floor.vertices[wall.a]
    const b = floor.vertices[wall.b]
    if (!a || !b) continue

    const span = { x: b.x - a.x, y: b.y - a.y }
    const length = Math.hypot(span.x, span.y)
    if (length < 1e-6) continue

    const t = Math.max(0, Math.min(1,
      ((centre.x - a.x) * span.x + (centre.y - a.y) * span.y) / (length * length)))
    const point = { x: a.x + span.x * t, y: a.y + span.y * t }
    const distance = Math.hypot(centre.x - point.x, centre.y - point.y)
    if (distance > CROSSES) continue
    if (best && distance >= best.distance) continue

    best = {
      wallId: wall.id,
      point,
      rotation: Math.atan2(span.y, span.x),
      length,
      distance,
    }
  }

  return best
}

/**
 * Openings for one floor of a detection, ready to be added as placed objects.
 *
 * A gap with no wall across it yields nothing, because there is nothing to cut.
 * That is a correct empty answer, not a failure, and the count returned is
 * therefore always smaller than the count of gaps the reader reported.
 */
export function openingsFromDetection(
  objects: DetectedObject[],
  underlay: Underlay,
  floor: Floor,
): DetectedOpening[] {
  const found: DetectedOpening[] = []

  for (const object of objects ?? []) {
    const label = (object.label ?? '').toLowerCase()
    if (label !== 'opening' && label !== 'door') continue

    const span = spanOf(object, underlay)
    if (!(span >= NARROWEST_DOORWAY)) continue

    const host = wallAcross(floor, centreOf(object, underlay))
    if (!host) continue

    // The gap is measured and the catalogue width is only a default, so the
    // measurement wins — up to what the host can carry with a pier left at
    // each end.
    const room = host.length - 2 * SMALLEST_PIER
    if (!(room > NARROWEST_DOORWAY)) continue
    const width = Math.min(span, room)

    // Sized first, named second: a 1.28 m gap clamped to 1.20 m by its host is
    // a door, not a double door, and the leaf should match the hole.
    const itemId = itemFor(width)
    const item = itemById(itemId)
    if (!item) continue

    found.push({
      item: itemId,
      position: host.point,
      rotation: host.rotation,
      wallId: host.wallId,
      size: { width, depth: item.size.depth, height: item.size.height },
      because:
        `a ${span.toFixed(2)} m gap between two walls in line` +
        (width < span ? `, cut to ${width.toFixed(2)} m to leave a pier` : '') +
        (itemId === 'opening' ? ', too wide for a leaf' : ''),
    })
  }

  return found
}
