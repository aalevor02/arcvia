import { detectRooms, roomId, planBounds } from '../src/plan/rooms'
import { labelPoint, pointInPolygon, signedArea, snapToAxis } from '../src/plan/geometry'
import type { Floor, Vec2 } from '../src/plan/types'

/**
 * Tests for the floor-plan graph.
 *
 * Run with `npm test -w apps/studio` (see `test/run.mjs` for how).
 *
 * These cover the algorithm, not the UI, because the algorithm is where a bug
 * is both most likely and least visible: a wrong face traversal still draws
 * *something*, and you only notice when the area is nonsense or a room's name
 * moves to a different room.
 */

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

function near(a: number, b: number, tolerance = 1e-6) {
  return Math.abs(a - b) < tolerance
}

/** Build a floor from a list of points and the wall segments between them. */
function makeFloor(
  points: Record<string, Vec2>,
  segments: [string, string][],
): Floor {
  const vertices = Object.fromEntries(
    Object.entries(points).map(([id, p]) => [id, { id, x: p.x, y: p.y }]),
  )
  const walls = Object.fromEntries(
    segments.map(([a, b], i) => [
      `w${i}`,
      { id: `w${i}`, a, b, thickness: 0.115, height: 3 },
    ]),
  )
  return {
    id: 'f0',
    name: 'Floor 0',
    elevation: 0,
    vertices,
    walls,
    roomNames: {},
    underlay: null,
  }
}

// ---- 1. A single closed square is one room ---------------------------------
{
  const floor = makeFloor(
    { a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, c: { x: 4, y: 3 }, d: { x: 0, y: 3 } },
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'a'],
    ],
  )
  const rooms = detectRooms(floor)
  check('square: exactly one room', rooms.length === 1, `got ${rooms.length}`)
  check('square: area is 12 m2', near(rooms[0]?.area ?? 0, 12), `got ${rooms[0]?.area}`)
  check(
    'square: label sits inside',
    rooms[0] ? pointInPolygon(rooms[0].label, rooms[0].polygon) : false,
  )
}

// ---- 2. Two rooms sharing a wall -------------------------------------------
// This is the case a polygon-per-room model gets wrong. The shared wall is ONE
// edge belonging to two faces.
{
  const floor = makeFloor(
    {
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
      c: { x: 4, y: 3 },
      d: { x: 0, y: 3 },
      e: { x: 2, y: 0 },
      f: { x: 2, y: 3 },
    },
    [
      ['a', 'e'],
      ['e', 'b'],
      ['b', 'c'],
      ['c', 'f'],
      ['f', 'd'],
      ['d', 'a'],
      ['e', 'f'], // the shared wall
    ],
  )
  const rooms = detectRooms(floor)
  check('shared wall: two rooms', rooms.length === 2, `got ${rooms.length}`)
  check(
    'shared wall: each is 6 m2',
    rooms.every((r) => near(r.area, 6)),
    rooms.map((r) => r.area.toFixed(3)).join(', '),
  )
  check(
    'shared wall: outer face not counted as a room',
    !rooms.some((r) => near(r.area, 12)),
  )
}

// ---- 3. An open loop is not a room -----------------------------------------
{
  const floor = makeFloor(
    { a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, c: { x: 4, y: 3 }, d: { x: 0, y: 3 } },
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      // 'd' back to 'a' deliberately missing
    ],
  )
  check('open loop: no rooms', detectRooms(floor).length === 0)
}

// ---- 4. A dead-end spur does not invent a room -----------------------------
{
  const floor = makeFloor(
    {
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
      c: { x: 4, y: 3 },
      d: { x: 0, y: 3 },
      s: { x: 2, y: 5 }, // spur hanging off the top edge
      t: { x: 2, y: 3 },
    },
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 't'],
      ['t', 'd'],
      ['d', 'a'],
      ['t', 's'],
    ],
  )
  const rooms = detectRooms(floor)
  check('spur: still one room', rooms.length === 1, `got ${rooms.length}`)
  check('spur: area unchanged at 12 m2', near(rooms[0]?.area ?? 0, 12))
}

// ---- 5. Two disconnected wings -> two rooms, two outer faces ---------------
// The "biggest polygon is the outside" heuristic fails here. Sign does not.
{
  const floor = makeFloor(
    {
      a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, c: { x: 2, y: 2 }, d: { x: 0, y: 2 },
      e: { x: 10, y: 0 }, f: { x: 13, y: 0 }, g: { x: 13, y: 3 }, h: { x: 10, y: 3 },
    },
    [
      ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'],
      ['e', 'f'], ['f', 'g'], ['g', 'h'], ['h', 'e'],
    ],
  )
  const rooms = detectRooms(floor)
  check('disconnected: two rooms', rooms.length === 2, `got ${rooms.length}`)
  check(
    'disconnected: areas 9 and 4, largest first',
    near(rooms[0]?.area ?? 0, 9) && near(rooms[1]?.area ?? 0, 4),
    rooms.map((r) => r.area).join(', '),
  )
}

// ---- 6. An L-shaped room labels inside itself ------------------------------
// The centroid of an L falls in the notch, outside the room.
{
  const L: Vec2[] = [
    { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 },
    { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 },
  ]
  const point = labelPoint(L)
  check('L-shape: label is inside the polygon', pointInPolygon(point, L),
    `${point.x.toFixed(2)}, ${point.y.toFixed(2)}`)
}

// ---- 7. Room ids are stable across traversal order and direction -----------
{
  const forward = roomId(['a', 'b', 'c', 'd'])
  const rotated = roomId(['c', 'd', 'a', 'b'])
  const reversed = roomId(['d', 'c', 'b', 'a'])
  check('room id: stable under rotation', forward === rotated, `${forward} vs ${rotated}`)
  check('room id: stable under reversal', forward === reversed, `${forward} vs ${reversed}`)
  check('room id: differs for a different loop', forward !== roomId(['a', 'b', 'c', 'e']))
}

// ---- 8. A named room keeps its name when an unrelated wall is added --------
{
  const points = {
    a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, c: { x: 4, y: 3 }, d: { x: 0, y: 3 },
  }
  const segments: [string, string][] = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]

  const before = detectRooms(makeFloor(points, segments))

  // Add a spur somewhere else entirely.
  const after = detectRooms(
    makeFloor({ ...points, s: { x: 8, y: 8 }, t: { x: 9, y: 9 } }, [
      ...segments,
      ['s', 't'],
    ]),
  )

  check(
    'naming: room id survives an unrelated edit',
    before[0]?.id === after[0]?.id,
    `${before[0]?.id} vs ${after[0]?.id}`,
  )
}

// ---- 9. Winding sign is what separates inside from outside -----------------
{
  const ccw = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]
  const cw = [...ccw].reverse()
  check('winding: counter-clockwise is positive', signedArea(ccw) > 0)
  check('winding: clockwise is negative', signedArea(cw) < 0)
}

// ---- 10. Axis snapping ------------------------------------------------------
{
  const origin = { x: 0, y: 0 }
  const nearlyHorizontal = snapToAxis(origin, { x: 5, y: 0.2 })
  check('snap: a near-horizontal drag becomes exactly horizontal',
    near(nearlyHorizontal.y, 0, 1e-9), `y=${nearlyHorizontal.y}`)

  const clearlyDiagonal = snapToAxis(origin, { x: 5, y: 2.4 })
  check('snap: a clearly off-axis drag is left alone',
    !near(clearlyDiagonal.y, 0, 1e-9) && !near(clearlyDiagonal.x, clearlyDiagonal.y, 1e-9),
    `${clearlyDiagonal.x.toFixed(2)}, ${clearlyDiagonal.y.toFixed(2)}`)

  const nearly45 = snapToAxis(origin, { x: 5, y: 4.8 })
  check('snap: a near-45 drag snaps to exactly 45',
    near(nearly45.x, nearly45.y, 1e-9), `${nearly45.x}, ${nearly45.y}`)
}

// ---- 11. Bounds -------------------------------------------------------------
{
  const floor = makeFloor(
    { a: { x: -2, y: 1 }, b: { x: 6, y: 9 } },
    [['a', 'b']],
  )
  const bounds = planBounds(floor.vertices)
  check('bounds: min/max correct',
    bounds !== null && bounds.min.x === -2 && bounds.max.y === 9)
  check('bounds: empty plan returns null', planBounds({}) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
