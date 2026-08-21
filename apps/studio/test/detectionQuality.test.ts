import { assessDetection, countClusters, type ProposedWall } from '../src/plan/detectionQuality'

/**
 * Whether a detection worked.
 *
 * Written after a real failure: a sheet holding four villa floor plans came
 * back with hundreds of wall segments, zero enclosed rooms, and was accepted
 * without comment — leaving a cloud of floating slabs and no explanation. The
 * count of walls said "success"; nothing asked whether they enclosed anything.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const wall = (x1: number, y1: number, x2: number, y2: number): ProposedWall => ({
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
  thickness: 0.2,
})

/**
 * A small but plausible floor plan: an enclosing rectangle plus an internal
 * division, offset along x.
 *
 * Six segments rather than four, deliberately. A bare rectangle is below the
 * threshold at which a separated group counts as a plan of its own — which is
 * correct, since a four-line box on a drawing is far more likely to be a title
 * block than a storey, and a fixture that ignores that tests a rule nobody
 * has.
 */
const box = (offset: number, size = 4): ProposedWall[] => [
  wall(offset, 0, offset + size, 0),
  wall(offset + size, 0, offset + size, size),
  wall(offset + size, size, offset, size),
  wall(offset, size, offset, 0),
  // An internal partition, and the doorway pier beside it.
  wall(offset + size / 2, 0, offset + size / 2, size * 0.6),
  wall(offset + size / 2, size * 0.8, offset + size / 2, size),
]

// ---- Clustering ------------------------------------------------------------
{
  check('nothing has no clusters', countClusters([], 'x') === 0)
  check('one wall is one cluster', countClusters([wall(0, 0, 1, 0)], 'x') === 1)

  check('a single plan is one cluster', countClusters(box(0), 'x') === 1, String(countClusters(box(0), 'x')))

  // Four plans side by side, each 4 m wide with 30 m between them — the shape
  // of a presentation sheet.
  const sheet = [...box(0), ...box(30), ...box(60), ...box(90)]
  check('four plans on a sheet read as four clusters', countClusters(sheet, 'x') === 4,
    String(countClusters(sheet, 'x')))

  // A courtyard has a hole in the middle but is one building, and must not be
  // mistaken for two plans.
  const courtyard = [
    wall(0, 0, 12, 0), wall(12, 0, 12, 12), wall(12, 12, 0, 12), wall(0, 12, 0, 0),
    wall(4, 4, 8, 4), wall(8, 4, 8, 8), wall(8, 8, 4, 8), wall(4, 8, 4, 4),
  ]
  check('a courtyard is still one cluster', countClusters(courtyard, 'x') === 1,
    String(countClusters(courtyard, 'x')))
}

// ---- Verdicts --------------------------------------------------------------
{
  const empty = assessDetection([], 0)
  check('no walls is a failure', !empty.ok)
  check('and says what the reader looks for', !empty.ok && empty.detail.includes('straight lines'))

  const good = assessDetection(box(0), 1)
  check('walls that enclose a room pass', good.ok)
  check('and report the room count', good.ok && good.rooms === 1)

  // The case that prompted all of this.
  const sheet = [...box(0), ...box(30), ...box(60), ...box(90)]
  const verdict = assessDetection(sheet, 0)
  check('a multi-plan sheet is caught', !verdict.ok)
  check('and is named as such rather than blamed on the drawing',
    !verdict.ok && verdict.reason.includes('separate plans'),
    !verdict.ok ? verdict.reason : '')
  check('and counts them', !verdict.ok && verdict.clusters === 4)
  check('and says to crop to one floor', !verdict.ok && verdict.detail.includes('single floor'))

  // One mass of lines enclosing nothing: a styled brochure, not a sheet.
  const scribble = [wall(0, 0, 4, 0), wall(0, 1, 4, 1), wall(0, 2, 4, 2)]
  const open = assessDetection(scribble, 0)
  check('walls enclosing nothing are caught', !open.ok)
  check('and are not blamed on multiple plans',
    !open.ok && !open.reason.includes('separate plans'), !open.ok ? open.reason : '')
  check('and the advice mentions a CAD export',
    !open.ok && open.detail.includes('CAD export'))

  // Clusters alone are not a failure: a real detection that found rooms is
  // fine even if the building has separated wings.
  const wings = assessDetection([...box(0), ...box(30), ...box(60)], 3)
  check('separated wings that enclose rooms still pass', wings.ok, String(wings.ok))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
