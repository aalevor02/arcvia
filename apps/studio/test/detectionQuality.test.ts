import {
  assessDetection,
  countClusters,
  shouldTryOutlines,
  type ProposedWall,
} from '../src/plan/detectionQuality'

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

// ---- how much of the drawing did the walls account for? ---------------------
// The old trigger for the outline rescue was `rooms === 0`, and it let the
// worst results through. Measured on five of the owner's own plans the walls
// path covered 7 of the 41 spaces their drawings show and the outline path
// covered 40 — but only three of the five enclosed NOTHING, so only those three
// were rescued. A nine-room drawing that produced two rooms totalling 3.9 m2
// was reported as a success, because the single number being checked was not
// zero.
{
  check('nothing enclosed is still rescued, whatever the drawing shows',
    shouldTryOutlines({ rooms: 0, covered: 0, drawn: 1 }))

  // 3.png: nine spaces drawn, two rooms enclosed, one space covered.
  check('two rooms out of a nine-room drawing is a failure, not a success',
    shouldTryOutlines({ rooms: 2, covered: 1, drawn: 9 }))

  // 4.png: the case the zero test could never have caught — six real rooms.
  check('and so is six spaces out of fourteen',
    shouldTryOutlines({ rooms: 6, covered: 6, drawn: 14 }))

  // ---- but the walls must keep the benefit of the doubt ---------------------
  // The held-out villa markup draws ONE space: an open lift lobby the reader
  // reports as a room and the owner's markup says is open circulation. Coverage
  // is 0 of 1 for the walls and 1 of 1 for the outlines, and the outlines are
  // WRONG — they seal 9 m2 of circulation into a room with no fourth wall. So
  // one or two labelled spaces cannot overrule measured geometry.
  check('one drawn space does not overrule the walls that disagree with it',
    !shouldTryOutlines({ rooms: 1, covered: 0, drawn: 1 }))
  check('nor do two',
    !shouldTryOutlines({ rooms: 1, covered: 0, drawn: 2 }))

  check('a plan that covers most of its drawing is left alone',
    !shouldTryOutlines({ rooms: 9, covered: 8, drawn: 9 }))

  // Exactly half is not "thin". The line is drawn where the walls are covering
  // less than the drawing shows, not merely not all of it.
  check('half covered is not thin enough to replace',
    !shouldTryOutlines({ rooms: 7, covered: 7, drawn: 14 }))
  check('but one below half is', shouldTryOutlines({ rooms: 6, covered: 6, drawn: 14 }))

  // A drawing with no labelled spaces gives nothing to measure against, so
  // there is no evidence either way and the walls stand.
  check('a drawing that names no spaces is never rescued on coverage',
    !shouldTryOutlines({ rooms: 4, covered: 0, drawn: 0 }))
  check('...not even when it encloses nothing, since there is nothing to trace',
    !shouldTryOutlines({ rooms: 0, covered: 0, drawn: 0 }))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
