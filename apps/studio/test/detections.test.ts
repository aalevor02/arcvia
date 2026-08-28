import {
  automaticScalePerPixel,
  convertDetections,
  summarise,
  toWorld,
  type DetectionResult,
} from '../src/plan/detections'
import { distance } from '../src/plan/geometry'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import { detectRooms } from '../src/plan/rooms'
import type { Underlay } from '../src/plan/types'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

{
  const measured = { metres_per_unit: 12, samples: 2, spread: 0.01, method: 'measured' as const }
  const legacy = { metres_per_unit: 12, samples: 2, spread: 0.01 }
  const inferred = { ...measured, method: 'inferred' as const, agreed: ['door', 'brick'] }

  check('measured scale may calibrate automatically',
    automaticScalePerPixel(measured, 1200) === 0.01)
  check('legacy measured scale remains compatible',
    automaticScalePerPixel(legacy, 1200) === 0.01)
  check('inferred scale never marks an underlay calibrated',
    automaticScalePerPixel(inferred, 1200) === null)
  check('implausible measured scale is still refused',
    automaticScalePerPixel({ ...measured, metres_per_unit: 120 }, 1200) === null)
}

/**
 * An underlay where the arithmetic is easy to check by hand: a 1000x500 image
 * at 0.01 m per pixel is 10 m x 5 m, with its top-left corner at the origin.
 */
const UNDERLAY: Underlay = {
  url: '/uploads/plan.png',
  width: 1000,
  height: 500,
  origin: { x: 0, y: 0 },
  scale: 0.01,
  opacity: 0.85,
  invert: true,
  locked: true,
}

const result = (walls: DetectionResult['walls']): DetectionResult => ({
  backend: 'heuristic',
  width: 1000,
  height: 500,
  walls,
  objects: [],
  low_confidence: false,
})

/** A wall face, given in metres and converted back to normalised coordinates. */
function face(x1: number, y1: number, x2: number, y2: number, confidence = 0.9) {
  return {
    start: { x: x1 / 10, y: -y1 / 5 },
    end: { x: x2 / 10, y: -y2 / 5 },
    thickness: 0.002,
    confidence,
  }
}

// ---- Coordinate mapping -----------------------------------------------------
{
  check('top-left maps to the underlay origin',
    near(toWorld({ x: 0, y: 0 }, UNDERLAY).x, 0) && near(toWorld({ x: 0, y: 0 }, UNDERLAY).y, 0))

  const bottomRight = toWorld({ x: 1, y: 1 }, UNDERLAY)
  check('bottom-right maps to (10, -5)',
    near(bottomRight.x, 10) && near(bottomRight.y, -5),
    `${bottomRight.x}, ${bottomRight.y}`)

  // Image y runs down and world y runs up. Getting this wrong flips the plan.
  check('image Y is inverted into world Y', toWorld({ x: 0, y: 0.5 }, UNDERLAY).y < 0)
}

// ---- Face pairing: the core behaviour ---------------------------------------
{
  // Two parallel faces 0.23 m apart — a nine-inch brick wall drawn properly.
  const walls = convertDetections(
    result([face(1, -1, 6, -1), face(1, -1.23, 6, -1.23)]),
    UNDERLAY,
  )

  check('two faces collapse to one wall', walls.length === 1, `${walls.length}`)
  check('it is marked as paired', walls[0]?.paired === true)
  check('thickness is measured from the drawing, not defaulted',
    near(walls[0]?.thickness ?? 0, 0.23, 1e-3), `${walls[0]?.thickness}`)

  // The centreline sits between the faces.
  check('centreline is midway between the faces',
    near(walls[0].a.y, -1.115, 1e-3), `${walls[0].a.y}`)
  check('centreline keeps the run length', near(distance(walls[0].a, walls[0].b), 5, 1e-3))
}

// ---- Two faces that are too far apart are two walls -------------------------
{
  const walls = convertDetections(
    result([face(0, 0, 6, 0), face(0, -3, 6, -3)]),
    UNDERLAY,
  )
  check('faces 3 m apart are two separate walls', walls.length === 2, `${walls.length}`)
  check('neither is marked paired', walls.every((w) => !w.paired))
  check('both fall back to a default thickness',
    walls.every((w) => near(w.thickness, 0.115)))
}

// ---- Parallel but not alongside each other ----------------------------------
// Two segments can be parallel and close in the perpendicular sense while
// sitting at opposite ends of the building. Overlap is what separates them.
{
  const walls = convertDetections(
    result([face(0, 0, 2, 0), face(7, -0.2, 9, -0.2)]),
    UNDERLAY,
  )
  check('parallel segments that do not overlap are not paired',
    walls.length === 2 && walls.every((w) => !w.paired),
    `${walls.length} walls, paired=${walls.filter((w) => w.paired).length}`)
}

// ---- Perpendicular segments never pair --------------------------------------
{
  const walls = convertDetections(
    result([face(0, 0, 6, 0), face(0, 0, 0, -4)]),
    UNDERLAY,
  )
  check('perpendicular segments stay separate', walls.length === 2, `${walls.length}`)
}

// ---- Faces of unequal length are trimmed to the overlap ---------------------
// One face runs past a doorway the other stops at. Averaging raw endpoints
// would invent wall where the drawing shows none.
{
  const walls = convertDetections(
    result([face(0, 0, 10, 0), face(2, -0.2, 6, -0.2)]),
    UNDERLAY,
  )
  check('one wall from mismatched faces', walls.length === 1, `${walls.length}`)
  check('trimmed to the overlapping span',
    near(distance(walls[0].a, walls[0].b), 4, 1e-3),
    `${distance(walls[0].a, walls[0].b).toFixed(3)} m`)
}

// ---- Direction of tracing must not matter -----------------------------------
{
  const sameWay = convertDetections(
    result([face(1, 0, 6, 0), face(1, -0.2, 6, -0.2)]),
    UNDERLAY,
  )
  const opposed = convertDetections(
    result([face(1, 0, 6, 0), face(6, -0.2, 1, -0.2)]),
    UNDERLAY,
  )
  check('a face traced backwards still pairs',
    sameWay.length === 1 && opposed.length === 1,
    `${sameWay.length} vs ${opposed.length}`)
  check('and gives the same thickness',
    near(sameWay[0].thickness, opposed[0].thickness, 1e-6))
}

// ---- Short strokes are dropped ----------------------------------------------
// Dimension ticks and lettering come through as tiny segments.
{
  const walls = convertDetections(
    result([face(0, 0, 6, 0), face(0, -0.2, 6, -0.2), face(3, -2, 3.1, -2)]),
    UNDERLAY,
  )
  check('a 0.1 m tick is discarded', walls.length === 1, `${walls.length}`)
}

// ---- Nothing in, nothing out ------------------------------------------------
{
  check('an empty detection yields no walls', convertDetections(result([]), UNDERLAY).length === 0)
}

// ---- Scale flows through from the underlay ----------------------------------
// The same detection against a differently calibrated underlay must produce a
// proportionally different building. This is the whole reason detection needed
// calibration first.
{
  const doubled: Underlay = { ...UNDERLAY, scale: 0.02 }
  const walls = convertDetections(result([face(1, 0, 6, 0)]), doubled)
  check('a doubled scale doubles the wall length',
    near(distance(walls[0].a, walls[0].b), 10, 1e-3),
    `${distance(walls[0].a, walls[0].b).toFixed(3)} m`)
}

// ---- Summary ----------------------------------------------------------------
{
  const walls = convertDetections(
    result([
      face(0, 0, 6, 0),
      face(0, -0.23, 6, -0.23),
      face(0, -4, 6, -4),
    ]),
    UNDERLAY,
  )
  const summary = summarise(walls)
  check('summary counts walls and pairs', summary.total === 2 && summary.paired === 1,
    `${summary.total}/${summary.paired}`)
  check('summary reports the measured thickness',
    near(summary.medianThickness, 0.23, 1e-3), `${summary.medianThickness}`)
  check('summary totals the run length', summary.totalLength > 11 && summary.totalLength < 13,
    `${summary.totalLength.toFixed(2)}`)
}

// ---- Corner joining: the difference between "looks right" and "is a room" ---
// Pairing trims each centreline to its faces' overlap, so at a corner both
// walls stop about half a thickness short. The plan then renders perfectly and
// encloses nothing. This is the step that closes it.
{
  // A room drawn as four walls, each pair of faces 0.2 m apart.
  const faces: DetectionResult['walls'] = []
  const push = (x1: number, y1: number, x2: number, y2: number) =>
    faces.push(face(x1, y1, x2, y2))

  // South wall, two faces
  push(0.5, -0.5, 8, -0.5)
  push(0.5, -0.7, 8, -0.7)
  // North wall
  push(0.5, -4.5, 8, -4.5)
  push(0.5, -4.7, 8, -4.7)
  // West wall
  push(0.6, -0.5, 0.6, -4.7)
  push(0.8, -0.5, 0.8, -4.7)
  // East wall
  push(7.6, -0.5, 7.6, -4.7)
  push(7.8, -0.5, 7.8, -4.7)

  const walls = convertDetections(result(faces), UNDERLAY)
  check('four walls from eight faces', walls.length === 4, `${walls.length}`)

  // Every endpoint should now coincide with another wall's endpoint.
  const ends = walls.flatMap((w) => [w.a, w.b])
  const orphans = ends.filter(
    (e) => !ends.some((other) => other !== e && distance(e, other) < 0.02),
  )
  check('every wall end meets another wall', orphans.length === 0,
    `${orphans.length} unjoined of ${ends.length}`)
}

// ---- Joining must not drag distant walls together ---------------------------
{
  // Two perpendicular walls whose lines cross far outside either of them.
  const walls = convertDetections(
    result([face(0, 0, 3, 0), face(9, -4, 9, -1)]),
    UNDERLAY,
  )
  const moved = walls.some(
    (w) => distance(w.a, { x: 9, y: 0 }) < 0.5 || distance(w.b, { x: 9, y: 0 }) < 0.5,
  )
  check('a crossing far outside both walls is ignored', !moved)
}

// ---- Parallel walls are never "joined" --------------------------------------
// Their lines meet at infinity, or somewhere absurd through rounding.
{
  const walls = convertDetections(
    result([face(0, 0, 4, 0), face(0, -3, 4, -3)]),
    UNDERLAY,
  )
  const sane = walls.every(
    (w) => Number.isFinite(w.a.x) && Number.isFinite(w.b.x) && Math.abs(w.a.x) < 100,
  )
  check('parallel walls are left alone and stay finite', sane)
}

// ---- The join is what makes a closed loop -----------------------------------
// The real assertion: after joining, the detector's output actually forms a
// room when handed to the plan.
{
  const faces: DetectionResult['walls'] = [
    face(0.5, -0.5, 8, -0.5), face(0.5, -0.7, 8, -0.7),
    face(0.5, -4.5, 8, -4.5), face(0.5, -4.7, 8, -4.7),
    face(0.6, -0.5, 0.6, -4.7), face(0.8, -0.5, 0.8, -4.7),
    face(7.6, -0.5, 7.6, -4.7), face(7.8, -0.5, 7.8, -4.7),
  ]

  let plan = emptyPlan()
  for (const wall of convertDetections(result(faces), UNDERLAY)) {
    plan = addWall(plan, wall.a, wall.b, {
      thickness: wall.thickness,
      snapRadius: 0.15,
    })
  }

  const rooms = detectRooms(activeFloor(plan))
  check('the imported walls enclose a room', rooms.length === 1, `${rooms.length} rooms`)
  check('with a plausible area', (rooms[0]?.area ?? 0) > 20 && (rooms[0]?.area ?? 0) < 32,
    `${rooms[0]?.area?.toFixed(1)} m2`)
}

// ---- Markup 2: a lift closes; its open lobby must not -----------------------
// The held-out owner markup names an open lift lobby that the raster reader's
// contour pass reports as a room. Those reported room polygons are evidence for
// naming and scale, not geometry: Studio must derive enclosure from converted
// walls. Trusting the contour here seals circulation that is visibly open.
{
  const detected = result([
    // The real lift shaft: one closed 2 m square.
    face(6, -1, 8, -1),
    face(8, -1, 8, -3),
    face(8, -3, 6, -3),
    face(6, -3, 6, -1),
    // The foyer: three sides only, with a 3 m opening towards the stair.
    face(2, -1, 5, -1),
    face(2, -1, 2, -4),
    face(2, -4, 5, -4),
  ])
  detected.rooms = [
    {
      polygon: [
        { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.8 }, { x: 0.2, y: 0.8 },
      ],
      area: 0.18,
      name: 'Foyer',
      kind: 'room',
      size: [1.93, 2.51],
      also: [],
    },
  ]

  let plan = emptyPlan()
  for (const wall of convertDetections(detected, UNDERLAY)) {
    plan = addWall(plan, wall.a, wall.b, {
      thickness: wall.thickness,
      snapRadius: 0.15,
    })
  }
  const rooms = detectRooms(activeFloor(plan))

  check('markup 2 closes the real lift shaft only', rooms.length === 1,
    `${rooms.length} downstream rooms`)
  check('markup 2 keeps the foyer open to circulation',
    near(rooms[0]?.area ?? 0, 4, 0.05),
    `closed area=${rooms[0]?.area?.toFixed(2)} m2`)

  // The default is load-bearing, so prove it costs something. Turning the
  // outlines on here seals the foyer — 9 m2 of circulation the owner marked as
  // open. This assertion exists so anyone tempted to flip `useRoomPolygons` on
  // by default sees the price, on ground truth, in the same run.
  let sealed = emptyPlan()
  for (const wall of convertDetections(detected, UNDERLAY, { useRoomPolygons: true })) {
    sealed = addWall(sealed, wall.a, wall.b, { thickness: wall.thickness, snapRadius: 0.15 })
  }
  const sealedRooms = detectRooms(activeFloor(sealed))
  check('and the outlines are NOT trusted here, because they would seal it',
    sealedRooms.length > rooms.length,
    `outlines gave ${sealedRooms.length} rooms against ${rooms.length} from walls`)
}

// ---- Zero enclosure: the outlines are the last resort, not the default ------
// A styled presentation sheet hides most of its walls under furniture and
// shading, so the face pass can return strokes that enclose nothing whatever.
// Measured on a real upload: 12 walls, 13 of 17 vertices dangling, a median gap
// of 1.71 m between them and only 2 of 13 gaps inside the 0.6 m corner
// tolerance. No corner tolerance closes metres. Zero rooms over a drawing with
// nine is not a cautious answer, it is an unusable one.
{
  const detected = result([
    // Three strokes, metres apart. Whatever they are, they enclose nothing.
    face(1, -1, 3, -1),
    face(6, -2, 8, -2),
    face(2, -4, 4, -4),
  ])
  detected.rooms = [
    {
      polygon: [
        { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 },
        { x: 0.4, y: 0.6 }, { x: 0.1, y: 0.6 },
      ],
      area: 0.12,
      name: 'Bedroom',
      kind: 'room',
      size: [3, 2],
      also: [],
    },
  ]

  const enclosedBy = (options?: { useRoomPolygons: boolean }) => {
    let plan = emptyPlan()
    for (const wall of convertDetections(detected, UNDERLAY, options)) {
      plan = addWall(plan, wall.a, wall.b, { thickness: wall.thickness, snapRadius: 0.15 })
    }
    return detectRooms(activeFloor(plan))
  }

  const fromWalls = enclosedBy()
  check('by default the walls decide, and here they enclose nothing',
    fromWalls.length === 0, `${fromWalls.length} rooms`)

  const fromOutlines = enclosedBy({ useRoomPolygons: true })
  check('the reader outlines close the plan when the walls cannot',
    fromOutlines.length === 1, `${fromOutlines.length} rooms`)

  // Not merely "a room appeared". It has to be the room the reader described:
  // a closure that encloses the wrong 6 m2 is not a fix, it is a coincidence.
  check('and it measures the area the outline described',
    near(fromOutlines[0]?.area ?? 0, 6, 0.05),
    `area=${fromOutlines[0]?.area?.toFixed(2)} m2`)

  // Short edges are kept on purpose. A polygon is only useful while it is
  // closed, so discarding one edge as a dimension tick — correct for a loose
  // segment — opens the loop and loses the whole room.
  const withTick = result([face(1, -1, 3, -1)])
  withTick.rooms = [{
    polygon: [
      { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.22 },
      { x: 0.4, y: 0.6 }, { x: 0.1, y: 0.6 },
    ],
    area: 0.12, name: 'Bedroom', kind: 'room', size: [3, 2], also: [],
  }]
  let ticked = emptyPlan()
  for (const wall of convertDetections(withTick, UNDERLAY, { useRoomPolygons: true })) {
    ticked = addWall(ticked, wall.a, wall.b, { thickness: wall.thickness, snapRadius: 0.15 })
  }
  check('a 0.1 m edge in an outline is kept, because a loop needs all of them',
    detectRooms(activeFloor(ticked)).length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
