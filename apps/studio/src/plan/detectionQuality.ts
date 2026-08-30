import type { Vec2 } from './types'

/**
 * Judging whether a floor-plan detection actually worked.
 *
 * ── Why "we found some walls" is not success ────────────────────────────────
 * The detector is classical computer vision — morphological line extraction —
 * and it will find lines in anything. Point it at a marketing brochure and it
 * returns furniture edges, hatching, dimension leaders and page borders, all
 * perfectly good line segments and none of them a wall.
 *
 * Counting them tells you nothing. What separates a real plan from a page of
 * lines is that a real plan's walls *enclose* something: rooms are the minimal
 * cycles of the wall graph, so a detection that closes no cycles has not found
 * a building, whatever its wall count.
 *
 * This is the check that was missing. A sheet of four villa plans came back
 * with hundreds of segments, zero enclosed rooms, and was accepted silently —
 * leaving the user with a cloud of floating slabs and no idea why.
 */

export interface ProposedWall {
  a: Vec2
  b: Vec2
  thickness: number
}

export type Verdict =
  | { ok: true; rooms: number }
  | { ok: false; reason: string; detail: string; clusters?: number }

/**
 * Groups of walls separated by empty space, along one axis.
 *
 * A sheet holding four floor plans side by side is the single commonest way
 * this goes wrong, because it is how architects actually present a scheme —
 * and it is unmistakable once you look for it: four dense clusters of linework
 * with wide empty gutters between them, where a single plan is one connected
 * mass.
 *
 * Projecting wall midpoints onto an axis and looking for gaps finds it without
 * any geometry cleverness. The gap has to be large relative to the whole
 * drawing, or a courtyard house splits into two.
 */
export function countClusters(walls: ProposedWall[], axis: 'x' | 'y'): number {
  if (walls.length < 2) return walls.length

  // Each wall's *extent* on the axis, merged where they overlap — not its
  // midpoint.
  //
  // Midpoints were the obvious approach and they are badly wrong. Three
  // parallel walls a metre apart have three distinct midpoints on the
  // perpendicular axis and read as three plans, and every real floor plan is
  // full of parallel walls. Extents do not have that failure: the walls of one
  // building overlap each other in projection and collapse to a single
  // interval however many there are, while a genuine gutter between two
  // printed plans is empty and survives as a gap.
  const spans = walls
    .map((wall) => ({
      low: Math.min(wall.a[axis], wall.b[axis]),
      high: Math.max(wall.a[axis], wall.b[axis]),
    }))
    .sort((left, right) => left.low - right.low)

  const total = spans[spans.length - 1].high - spans[0].low
  if (total <= 0) return 1

  // A twentieth of the drawing of pure emptiness. Printed sheets leave far
  // more than that between plans; rooms within a building leave none, because
  // something always spans the gap.
  const threshold = total * 0.05

  const sizes: number[] = [1]
  let reach = spans[0].high

  for (const span of spans.slice(1)) {
    if (span.low - reach > threshold) sizes.push(1)
    else sizes[sizes.length - 1]++
    reach = Math.max(reach, span.high)
  }
  return sizes.length
}

/**
 * The size of each separated group, largest first.
 *
 * Separation alone does not make something a floor plan. Three stray lines a
 * metre apart are three groups by any spatial measure and are obviously not
 * three plans — so the decision needs to know how much linework each group
 * holds, not merely how many groups there are.
 */
export function clusterSizes(walls: ProposedWall[], axis: 'x' | 'y'): number[] {
  if (walls.length === 0) return []

  const spans = walls
    .map((wall) => ({
      low: Math.min(wall.a[axis], wall.b[axis]),
      high: Math.max(wall.a[axis], wall.b[axis]),
    }))
    .sort((left, right) => left.low - right.low)

  const total = spans[spans.length - 1].high - spans[0].low
  const threshold = total * 0.05

  const sizes = [1]
  let reach = spans[0].high

  for (const span of spans.slice(1)) {
    if (total > 0 && span.low - reach > threshold) sizes.push(1)
    else sizes[sizes.length - 1]++
    reach = Math.max(reach, span.high)
  }

  return sizes.sort((a, b) => b - a)
}

/**
 * How much linework a group needs before it counts as a plan of its own.
 *
 * A floor plan is at minimum an enclosing boundary and an internal division —
 * call it six segments. Below that, a separated group is a stray dimension
 * line or a title block, not a storey.
 */
const PLAN_MIN_WALLS = 6

/**
 * Is this detection worth showing to a user?
 *
 * `rooms` is the count of enclosed rooms the proposed walls would produce —
 * computed by the caller, which already owns the room-finding code.
 *
 * Deliberately advisory rather than blocking. A detection that closes no rooms
 * is *usually* a failure and occasionally a genuine partial import somebody
 * intends to finish by hand, and refusing outright would make that impossible.
 * What it must not do is stay silent, which is what it did before.
 */
/**
 * Should the outline rescue be tried at all?
 *
 * The old test was `rooms === 0`, and it let the worst results through.
 * Measured on five of the owner's own plans, the walls path covered 7 of the 41
 * spaces their drawings show and the outline path covered 40 — but only THREE
 * of the five enclosed nothing at all, so only those three were ever rescued.
 * One drawing of nine rooms produced two rooms totalling 3.9 m2 and was
 * reported to the user as a success. That is the "it isn't doing anything" the
 * owner described, and it was invisible from inside because the one number
 * being checked was not zero.
 *
 * So the question is how much of the drawing the walls account for, not whether
 * they account for any of it.
 *
 * ── Why three spaces, and why half ──────────────────────────────────────────
 * The held-out villa markup draws ONE space: an open lift lobby the reader
 * reports as a room and the owner's markup says is open circulation. Coverage
 * there is 0 of 1 for the walls and 1 of 1 for the outlines, and the OUTLINES
 * ARE WRONG — they seal 9 m2 of circulation into a room that has no fourth
 * wall. One or two labelled spaces is not enough evidence to overrule measured
 * geometry, and a plan that genuinely encloses nothing always has more than
 * two. Half is the line between disagreeing with the walls and replacing them:
 * the five real plans sit at 0, 0, 0, 11% and 43%, and the villa fixture — the
 * one case where the walls are right — is excluded by the count, not the ratio.
 *
 * `rooms === 0` is kept as its own trigger regardless of how many spaces the
 * drawing names, because nothing enclosed is unusable whatever the drawing says.
 */
export function shouldTryOutlines(
  { rooms, covered, drawn }: { rooms: number; covered: number; drawn: number },
): boolean {
  if (drawn <= 0) return false
  if (rooms === 0) return true
  return drawn >= 3 && covered * 2 < drawn
}

export function assessDetection(walls: ProposedWall[], rooms: number): Verdict {
  if (walls.length === 0) {
    return {
      ok: false,
      reason: 'Nothing recognisable was found in that drawing.',
      detail:
        'The reader looks for long straight lines. A photograph, a very low ' +
        'resolution scan, or a plan drawn in thin grey lines can all come back empty.',
    }
  }

  // Several separated masses of linework almost always means several plans on
  // one sheet, which is the failure that produces the most baffling result:
  // every floor of the building flattened on top of one another.
  // Only groups big enough to *be* a plan count. Separation on its own is not
  // evidence: a title block and a north arrow are separated from the drawing
  // and are not storeys.
  const substantial = (axis: 'x' | 'y') =>
    clusterSizes(walls, axis).filter((size) => size >= PLAN_MIN_WALLS).length

  const across = Math.max(substantial('x'), substantial('y'))
  if (across >= 3 && rooms === 0) {
    return {
      ok: false,
      clusters: across,
      reason: `This sheet looks like ${across} separate plans side by side.`,
      detail:
        'Each floor has to be imported on its own, or every storey ends up ' +
        'flattened into one. Crop the image to a single floor plan and upload ' +
        'that, then repeat for each floor.',
    }
  }

  if (rooms === 0) {
    return {
      ok: false,
      reason: 'The walls that were found do not enclose any rooms.',
      detail:
        'Usually this means the drawing is a styled presentation plan rather ' +
        'than a line drawing — furniture, shading and dimension text get read ' +
        'as walls. A plain CAD export works far better. You can still accept ' +
        'these and close the gaps by hand.',
    }
  }

  return { ok: true, rooms }
}
