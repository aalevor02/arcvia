import { planFromCad } from '../src/plan/cadPlan'
import { detectRooms } from '../src/plan/rooms'
import type { CadModel, CadWall } from '../src/plan/cadFurnish'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.error(`FAIL  ${label}${detail ? ` - ${detail}` : ''}`)
  }
}

const box = (x: number, y: number, w: number, h: number): CadWall[] => [
  { a: { x, y }, b: { x: x + w, y }, thickness: 0.23 },
  { a: { x: x + w, y }, b: { x: x + w, y: y + h }, thickness: 0.23 },
  { a: { x: x + w, y: y + h }, b: { x, y: y + h }, thickness: 0.23 },
  { a: { x, y: y + h }, b: { x, y }, thickness: 0.23 },
]

const model: CadModel = {
  wallHeight: 2.7,
  storeys: { primary: 0 },
  elements: {
    fixtures: [],
    storeys: [
      {
        storey: 0,
        title: 'Ground floor',
        shift: [0, 0],
        walls: box(0, 0, 5, 4),
        spaces: [{ index: 0, name: 'Living', loop: [[0, 0], [5, 0], [5, 4], [0, 4]] }],
        openings: [{ kind: 'door', wall: 0, along: 2, width: 0.9, height: 2.1, sill: 0 }],
      },
      {
        storey: 1,
        title: 'First floor',
        shift: [-10, 0],
        walls: box(10, 0, 5, 4),
        spaces: [{ index: 0, name: 'Bedroom', loop: [[10, 0], [15, 0], [15, 4], [10, 4]] }],
        openings: [{ kind: 'window', wall: 2, along: 2.5, width: 1.2, height: 1.2, sill: 0.9 }],
      },
    ],
  },
}

const plan = planFromCad(model)
check('CAD model becomes a plan', plan !== null)
check('both storeys become 2D floors', plan?.floors.length === 2)
check('each floor retains its four walls',
  plan?.floors.every((floor) => Object.keys(floor.walls).length === 4) ?? false)
check('door and window become hosted 2D openings',
  plan?.floors.every((floor) => Object.values(floor.objects).length === 1) ?? false)
check('storey registration shift aligns both plans',
  plan?.floors.every((floor) => Math.max(...Object.values(floor.vertices).map((v) => v.x)) === 5) ?? false)
check('room names survive import',
  plan?.floors.map((floor) => Object.values(floor.roomNames)[0]).join(',') === 'Living,Bedroom',
  JSON.stringify(plan?.floors.map((floor) => ({
    rooms: detectRooms(floor).length,
    names: floor.roomNames,
  }))))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
