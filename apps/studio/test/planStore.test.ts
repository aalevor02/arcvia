import {
  activeFloor,
  addFloor,
  addWall,
  commit,
  duplicateFloor,
  emptyPlan,
  initialHistory,
  loadPlan,
  nameRoom,
  redo,
  removeFloor,
  removeWall,
  undo,
  updateAllWalls,
} from '../src/plan/planStore'
import { detectRooms } from '../src/plan/rooms'
import type { Plan } from '../src/plan/types'

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

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol
const rooms = (plan: Plan) => detectRooms(activeFloor(plan))
const wallCount = (plan: Plan) => Object.keys(activeFloor(plan).walls).length
const vertexCount = (plan: Plan) => Object.keys(activeFloor(plan).vertices).length

/** Draw a closed rectangle by its four corners. */
function drawRect(plan: Plan, x1: number, y1: number, x2: number, y2: number): Plan {
  let p = plan
  p = addWall(p, { x: x1, y: y1 }, { x: x2, y: y1 })
  p = addWall(p, { x: x2, y: y1 }, { x: x2, y: y2 })
  p = addWall(p, { x: x2, y: y2 }, { x: x1, y: y2 })
  p = addWall(p, { x: x1, y: y2 }, { x: x1, y: y1 })
  return p
}

// ---- 1. Drawing a closed loop creates a room --------------------------------
{
  const plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  check('closed rectangle: 4 walls', wallCount(plan) === 4, `${wallCount(plan)}`)
  check('closed rectangle: 4 vertices (loop welded shut)', vertexCount(plan) === 4,
    `${vertexCount(plan)}`)
  check('closed rectangle: one room of 12 m2',
    rooms(plan).length === 1 && near(rooms(plan)[0].area, 12),
    JSON.stringify(rooms(plan).map((r) => r.area)))
}

// ---- 2. Welding: a loop that ends *near* the start still closes -------------
// Drawn a centimetre off — well inside welding distance. If this does not weld,
// the plan looks shut and reports no rooms, which is the single most confusing
// failure a drawing tool can have.
{
  let plan = emptyPlan()
  plan = addWall(plan, { x: 0, y: 0 }, { x: 4, y: 0 })
  plan = addWall(plan, { x: 4, y: 0 }, { x: 4, y: 3 })
  plan = addWall(plan, { x: 4, y: 3 }, { x: 0, y: 3 })
  plan = addWall(plan, { x: 0, y: 3 }, { x: 0.008, y: 0.008 }) // 8mm off
  check('near-miss close welds to the original corner', vertexCount(plan) === 4,
    `${vertexCount(plan)} vertices`)
  check('near-miss close still detects the room', rooms(plan).length === 1)
}

// ---- 3. A wall drawn across a room splits both, and makes two rooms ---------
{
  let plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  // A partition from the middle of the bottom wall to the middle of the top.
  plan = addWall(plan, { x: 2, y: 0 }, { x: 2, y: 3 })

  const found = rooms(plan)
  check('partition: two rooms', found.length === 2, `${found.length}`)
  check('partition: each 6 m2', found.every((r) => near(r.area, 6)),
    found.map((r) => r.area.toFixed(3)).join(', '))
  // The two crossed walls were each split in two, plus the partition itself.
  check('partition: walls split at the junctions', wallCount(plan) === 7, `${wallCount(plan)}`)
  check('partition: two junction vertices added', vertexCount(plan) === 6, `${vertexCount(plan)}`)
}

// ---- 4. A wall crossing another mid-span splits it --------------------------
{
  let plan = emptyPlan()
  plan = addWall(plan, { x: 0, y: 0 }, { x: 4, y: 0 })
  plan = addWall(plan, { x: 2, y: -2 }, { x: 2, y: 2 })
  check('crossing: both walls split into halves', wallCount(plan) === 4, `${wallCount(plan)}`)
  check('crossing: junction vertex exists', vertexCount(plan) === 5, `${vertexCount(plan)}`)
}

// ---- 5. Zero-length walls are ignored ---------------------------------------
{
  const plan = addWall(emptyPlan(), { x: 1, y: 1 }, { x: 1, y: 1 })
  check('zero-length wall is not created', wallCount(plan) === 0)
}

// ---- 6. Deleting a wall opens the room and prunes orphans -------------------
{
  const plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  const wallId = Object.keys(activeFloor(plan).walls)[0]
  const after = removeWall(plan, wallId)
  check('delete: room disappears when the loop opens', rooms(after).length === 0)
  check('delete: corner vertices survive (still used)', vertexCount(after) === 4,
    `${vertexCount(after)}`)

  // Remove everything and confirm no orphan vertices are left behind.
  let stripped = plan
  for (const id of Object.keys(activeFloor(plan).walls)) stripped = removeWall(stripped, id)
  check('delete: removing all walls leaves no orphan vertices',
    vertexCount(stripped) === 0, `${vertexCount(stripped)}`)
}

// ---- 7. Room names survive edits elsewhere, via the derived id --------------
{
  let plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  const id = rooms(plan)[0].id
  plan = nameRoom(plan, id, 'Living room')
  check('naming: stored against the derived id', activeFloor(plan).roomNames[id] === 'Living room')

  // An unrelated wall far away must not disturb it.
  plan = addWall(plan, { x: 20, y: 20 }, { x: 24, y: 20 })
  check('naming: survives an unrelated wall being drawn',
    activeFloor(plan).roomNames[rooms(plan)[0].id] === 'Living room')

  plan = nameRoom(plan, id, '   ')
  check('naming: blanking restores the automatic name',
    activeFloor(plan).roomNames[id] === undefined)
}

// ---- 8. Edit-all-walls updates every wall ----------------------------------
{
  let plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  plan = updateAllWalls(plan, { thickness: 0.23, height: 3.6 })
  const all = Object.values(activeFloor(plan).walls)
  check('edit all: thickness applied everywhere', all.every((w) => near(w.thickness, 0.23)))
  check('edit all: height applied everywhere', all.every((w) => near(w.height, 3.6)))
}

// ---- 9. Floors ---------------------------------------------------------------
{
  let plan = drawRect(emptyPlan(), 0, 0, 4, 3)
  const groundId = plan.activeFloorId

  plan = addFloor(plan)
  check('floors: adding one switches to it', plan.activeFloorId !== groundId)
  check('floors: the new floor is empty', wallCount(plan) === 0)
  check('floors: it stacks 3 m above', near(plan.floors[1].elevation, 3))

  plan = duplicateFloor(plan, groundId, 'Second floor')
  check('duplicate: copies the walls', wallCount(plan) === 4, `${wallCount(plan)}`)
  check('duplicate: detects the same room', rooms(plan).length === 1)

  // Ids must not be shared with the source, or a name on one storey applies to
  // the other.
  const groundVertexIds = new Set(Object.keys(plan.floors[0].vertices))
  const copyVertexIds = Object.keys(activeFloor(plan).vertices)
  check('duplicate: vertex ids are independent',
    copyVertexIds.every((id) => !groundVertexIds.has(id)))

  const before = plan.floors.length
  plan = removeFloor(plan, plan.activeFloorId)
  check('floors: removing one drops it', plan.floors.length === before - 1)

  let single = emptyPlan()
  single = removeFloor(single, single.activeFloorId)
  check('floors: the last floor cannot be removed', single.floors.length === 1)
}

// ---- 10. Undo / redo ---------------------------------------------------------
{
  const start = emptyPlan()
  let history = initialHistory(start)

  const one = drawRect(start, 0, 0, 4, 3)
  history = commit(history, one)
  const two = addWall(one, { x: 2, y: 0 }, { x: 2, y: 3 })
  history = commit(history, two)

  check('history: present is the latest', rooms(history.present).length === 2)

  history = undo(history)
  check('history: undo goes back one step', rooms(history.present).length === 1)

  history = undo(history)
  check('history: undo again reaches the empty plan', rooms(history.present).length === 0)

  history = redo(history)
  check('history: redo moves forward', rooms(history.present).length === 1)

  // Committing after an undo discards the redo branch.
  history = commit(history, addWall(history.present, { x: 10, y: 10 }, { x: 12, y: 10 }))
  check('history: a new edit clears the redo stack', history.future.length === 0)

  const stuck = undo(initialHistory(start))
  check('history: undo at the beginning is a no-op', stuck.present === start)
}

// ---- 11. Reloading a saved plan does not reuse ids ---------------------------
// Without reserving the counter, the first wall drawn after a load mints an id
// that already exists and silently merges with an existing vertex.
{
  const saved = JSON.parse(JSON.stringify(drawRect(emptyPlan(), 0, 0, 4, 3)))
  const reloaded = loadPlan(saved)
  const grown = addWall(reloaded, { x: 10, y: 10 }, { x: 14, y: 10 })

  check('reload: existing walls intact', wallCount(grown) === 5, `${wallCount(grown)}`)
  check('reload: new geometry does not collide with loaded ids',
    vertexCount(grown) === 6, `${vertexCount(grown)}`)
  check('reload: the original room is still found', rooms(grown).length === 1)
  check('reload: junk falls back to an empty plan',
    loadPlan({ nonsense: true }).floors.length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
