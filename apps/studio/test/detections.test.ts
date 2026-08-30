import {
  automaticScalePerPixel,
  convertDetections,
  namesFromDrawing,
  roomsCovered,
  summarise,
  toWorld,
  type DetectionResult,
} from '../src/plan/detections'
import { distance } from '../src/plan/geometry'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import { detectRooms } from '../src/plan/rooms'
import {
  placeRasterOpenings,
  proposeRasterOpenings,
} from '../src/plan/rasterOpenings'
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

// ---- Classified raster openings reach editable wall geometry ----------------
{
  const detected = result([])
  detected.objects = [
    {
      label: 'window',
      bbox: [0.4, 0.18, 0.2, 0.04],
      confidence: 0.88,
      attaches_to: 'wall',
    },
    // A nested lower-confidence box around the same symbol is one opening.
    {
      label: 'window',
      bbox: [0.405, 0.185, 0.19, 0.03],
      confidence: 0.61,
      attaches_to: 'wall',
    },
    // There is evidence of a gap but no evidence of its type. Never guess.
    {
      label: 'opening',
      bbox: [0.2, 0.18, 0.1, 0.04],
      confidence: 0.6,
      attaches_to: 'wall',
    },
    // A classified symbol away from every wall cannot safely make a hole.
    {
      label: 'door',
      bbox: [0.4, 0.76, 0.1, 0.08],
      confidence: 0.9,
      attaches_to: 'wall',
    },
  ]
  const proposedWalls = [{
    a: { x: 1, y: -1 },
    b: { x: 9, y: -1 },
    thickness: 0.2,
    paired: true,
    confidence: 0.9,
  }]
  const openings = proposeRasterOpenings(detected, UNDERLAY, proposedWalls)
  check('only the classified wall-attached raster opening is proposed',
    openings.length === 1 && openings[0].kind === 'window',
    JSON.stringify(openings))
  check('the detected box supplies its measured two-metre span',
    near(openings[0]?.width ?? 0, 2))
  check('the opening is projected onto the proposed wall centreline',
    near(openings[0]?.position.x ?? 0, 5) &&
      near(openings[0]?.position.y ?? 0, -1))

  let plan = addWall(emptyPlan(), { x: 1, y: -1 }, { x: 9, y: -1 }, {
    thickness: 0.2,
    snapRadius: 0.15,
  })
  plan = placeRasterOpenings(plan, openings)
  const placed = Object.values(activeFloor(plan).objects)
  check('acceptance creates one editable catalogue window attached to the wall',
    placed.length === 1 &&
      placed[0].item === 'window' &&
      Boolean(placed[0].wallId))
  check('the accepted window keeps detected width, wall depth, and standard sill',
    near(placed[0]?.size?.width ?? 0, 2) &&
      near(placed[0]?.size?.depth ?? 0, 0.2) &&
      near(placed[0]?.elevation ?? 0, 0.9))

  const twice = placeRasterOpenings(plan, openings)
  check('accepting the same detection again does not duplicate the opening',
    Object.keys(activeFloor(twice).objects).length === 1)
}

// ---- The drawing already says what its rooms are called ---------------------
// The CAD path names its rooms and the IFC path names its spaces. The raster
// path did not, so a plan that plainly reads SHOWER / TOILET / PATIO arrived as
// Room 1, Room 2, Room 3 — after the reader had OCRed those very labels and
// used them to choose which binarisation to trust.
{
  const square = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ]
  const region = (
    name: string | null,
    kind: 'room' | 'fitting',
    area: number,
    poly: Array<{ x: number; y: number }>,
  ) => ({ polygon: poly, area, name, kind, size: null, also: [] })

  // World metres for UNDERLAY: 1000x500 at 0.01 => 10 m x 5 m, y negative down.
  const rooms = [
    { id: 'big', polygon: [{ x: 1, y: -1 }, { x: 5, y: -1 }, { x: 5, y: -4 }, { x: 1, y: -4 }] },
    { id: 'small', polygon: [{ x: 6, y: -1 }, { x: 8, y: -1 }, { x: 8, y: -2 }, { x: 6, y: -2 }] },
  ]

  const names = namesFromDrawing(rooms, [
    region('Bedroom', 'room', 0.4, square(0.15, 0.25, 0.45, 0.7)),
    region('Shower', 'room', 0.1, square(0.62, 0.25, 0.78, 0.35)),
  ], UNDERLAY)

  check('a named region names the room it sits in', names.big === 'Bedroom', JSON.stringify(names))
  check('and a second region names the second room', names.small === 'Shower', JSON.stringify(names))

  // A fitting is joinery, not a space. Measured on the owner's own plan: the
  // Wardrobe outline claimed a 13 m2 room — the bedroom the wardrobe stands in.
  const withFitting = namesFromDrawing(rooms, [
    region('Wardrobe', 'fitting', 0.4, square(0.15, 0.25, 0.45, 0.7)),
  ], UNDERLAY)
  check('a FITTING never names a room, however well it fits',
    withFitting.big === undefined, JSON.stringify(withFitting))

  // Two regions inside one derived room: the dominant space wins, not whatever
  // happened to be first in the list.
  const contested = namesFromDrawing([rooms[0]], [
    region('Cupboard', 'room', 0.02, square(0.2, 0.3, 0.24, 0.36)),
    region('Living', 'room', 0.5, square(0.15, 0.25, 0.45, 0.7)),
  ], UNDERLAY)
  check('when two regions fall in one room the larger one names it',
    contested.big === 'Living', JSON.stringify(contested))

  // An unnamed region must not blank out a room that another region could name.
  const unnamed = namesFromDrawing([rooms[0]], [
    region(null, 'room', 0.6, square(0.15, 0.25, 0.45, 0.7)),
    region('Bedroom', 'room', 0.4, square(0.16, 0.26, 0.44, 0.69)),
  ], UNDERLAY)
  check('an unnamed region does not block a named one',
    unnamed.big === 'Bedroom', JSON.stringify(unnamed))
}

// ---- a concave region's centroid is not inside it ---------------------------
// Found on the owner's Avarana Basement: the reader named Patio, Shower and
// Toilet and only two arrived. Toilet is a twelve-point outline, and the
// centroid of a concave polygon can lie outside the polygon.
//
// That fixture does not settle it -- Toilet's outline never closed into a room
// at all, so nothing could have named it -- which is exactly why this case is
// constructed. Here the naive centroid does not merely MISS, it lands in the
// NEIGHBOURING room, so the old code would confidently name the wrong space.
{
  // An L in world metres: the top bar runs x 1..5 at y -1..-2, the left leg
  // runs x 1..2 down to y -4. Its vertex centroid is (2.67, -2.33), which sits
  // in the notch the L wraps around, not in the L.
  const ell = [
    { x: 1, y: -1 }, { x: 5, y: -1 }, { x: 5, y: -2 },
    { x: 2, y: -2 }, { x: 2, y: -4 }, { x: 1, y: -4 },
  ]
  const notch = [
    { x: 2, y: -2 }, { x: 5, y: -2 }, { x: 5, y: -4 }, { x: 2, y: -4 },
  ]
  const rooms = [
    { id: 'ell', polygon: ell },
    { id: 'notch', polygon: notch },
  ]

  // The same L in normalised image coordinates for UNDERLAY (1000x500 at 0.01,
  // so world x = nx*10 and world y = -ny*5).
  const region = {
    polygon: [
      { x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 },
      { x: 0.2, y: 0.4 }, { x: 0.2, y: 0.8 }, { x: 0.1, y: 0.8 },
    ],
    area: 0.3, name: 'Kitchen', kind: 'room' as const, size: null, also: [],
  }

  const names = namesFromDrawing(rooms, [region], UNDERLAY)

  check('a concave region names the room it is actually in',
    names.ell === 'Kitchen', JSON.stringify(names))
  check('and NOT the neighbour its centroid happens to fall in',
    names.notch === undefined, JSON.stringify(names))
}

// ---- one region's needle eats its NEIGHBOUR's wall ---------------------------
// The reader's outlines are traced contours, not drafted polygons, and one of
// them can run out to a point and come straight back along the same line. The
// damage is not local. These two polygons are lifted verbatim from the owner's
// Avarana Basement, in the order the reader returns them.
//
// Region [3] is unnamed and carries a single needle: it reaches y 0.8932 ->
// 0.678 -> 0.8932, a 2.69 m spike lying at x 0.345, which is 6 cm from the
// TOILET's right wall at x 0.3412. addWall snaps within 0.15 m, so the spike
// lands on top of the Toilet's wall and consumes it -- the two rooms collapse
// into ONE face, and the drawing's word TOILET has no room left to name.
//
// Measured, this is what the owner saw: the reader read TOILET and the plan
// showed neither the room nor the label. The Toilet's own two needles are
// harmless; removing them alone changes nothing. It is the NEIGHBOUR's needle
// that has to go, which is why needles are removed from every outline and not
// from the one that looks wrong.
//
// Removing a needle tip does not weaken the rule that every edge of an outline
// is kept. A tip is not an edge of the enclosed shape: the loop stays closed and
// gets shorter, where dropping a real edge would open it.
{
  const AVARANA = {
    url: 'x', width: 2400, height: 1826, origin: { x: 0, y: 0 },
    scale: 0.006848875, invert: true, locked: true, opacity: 0.85, calibrated: true,
  } as unknown as Underlay
  const region = (name: string | null, xy: number[][]) => ({
    polygon: xy.map(([x, y]) => ({ x, y })),
    area: 0, name, kind: 'room' as const, size: null, also: [],
  })
  const neighbourWithNeedle = region(null, [
    [0.3429, 0.6177], [0.3429, 0.8932],
    [0.3450, 0.6780], [0.3458, 0.8932], // <- out 2.69 m and straight back
    [0.5692, 0.8932], [0.5692, 0.6172],
  ])
  const toilet = region('Toilet', [
    [0.2117, 0.7722], [0.2117, 0.8209], [0.2462, 0.8215], [0.2150, 0.8220],
    [0.2158, 0.8510], [0.2462, 0.8521], [0.2117, 0.8532], [0.2117, 0.8932],
    [0.3304, 0.8932], [0.3308, 0.8434], [0.3412, 0.8423], [0.3412, 0.7722],
  ])
  const regions = [neighbourWithNeedle, toilet]

  const detected = result([face(1, -1, 3, -1)])
  detected.rooms = regions
  let plan = emptyPlan()
  for (const wall of convertDetections(detected, AVARANA, { useRoomPolygons: true })) {
    plan = addWall(plan, wall.a, wall.b, { thickness: wall.thickness, snapRadius: 0.15 })
  }
  const rooms = detectRooms(activeFloor(plan))

  check('a needle does not merge its neighbour away', rooms.length === 2,
    `${rooms.length} faces, expected 2`)

  // The user-visible half: the drawing says TOILET and the plan must show it.
  const names = namesFromDrawing(rooms, regions, AVARANA)
  check('so the room the drawing named still exists to be named',
    Object.values(names).includes('Toilet'), JSON.stringify(names))
}

// ---- counting what the drawing asked for ------------------------------------
// The number the studio was missing. Enclosure was judged by "did we get any
// rooms at all", so a nine-room drawing that produced two rooms totalling
// 3.9 m2 was reported to the user as a success.
{
  // UNDERLAY is 1000x500 at 0.01, so world x = nx*10 and world y = -ny*5.
  const region = (name: string, kind: 'room' | 'fitting', box: number[]) => ({
    polygon: [
      { x: box[0], y: box[1] }, { x: box[2], y: box[1] },
      { x: box[2], y: box[3] }, { x: box[0], y: box[3] },
    ],
    area: 0.04, name, kind, size: null, also: [],
  })
  const drawn = [
    region('Bedroom', 'room', [0.1, 0.1, 0.3, 0.3]),
    region('Kitchen', 'room', [0.5, 0.1, 0.7, 0.3]),
    region('Wardrobe', 'fitting', [0.12, 0.12, 0.16, 0.16]),
  ]
  const bedroom = {
    polygon: [{ x: 1, y: -0.5 }, { x: 3, y: -0.5 }, { x: 3, y: -1.5 }, { x: 1, y: -1.5 }],
  }

  const none = roomsCovered([], drawn, UNDERLAY)
  check('a drawing of two spaces asks for two, the joinery not counted',
    none.drawn === 2, String(none.drawn))
  check('and a plan with no rooms covers none of them', none.covered === 0)

  const half = roomsCovered([bedroom], drawn, UNDERLAY)
  check('one room covers the one space it contains',
    half.covered === 1 && half.drawn === 2, JSON.stringify(half))

  // The same concave trap as the naming path: a centroid can sit outside its
  // own room, so an L-shaped space would be counted as missing while the plan
  // holds it perfectly well.
  const ell = {
    polygon: [
      { x: 1, y: -1 }, { x: 5, y: -1 }, { x: 5, y: -2 },
      { x: 2, y: -2 }, { x: 2, y: -4 }, { x: 1, y: -4 },
    ],
  }
  const lShaped = [{
    polygon: [
      { x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 },
      { x: 0.2, y: 0.4 }, { x: 0.2, y: 0.8 }, { x: 0.1, y: 0.8 },
    ],
    area: 0.3, name: 'Kitchen', kind: 'room' as const, size: null, also: [],
  }]
  check('a concave space is counted as covered by the room that holds it',
    roomsCovered([ell], lShaped, UNDERLAY).covered === 1,
    JSON.stringify(roomsCovered([ell], lShaped, UNDERLAY)))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
