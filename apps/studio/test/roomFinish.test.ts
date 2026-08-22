import { emptyPlan, setRoomFinish } from '../src/plan/planStore'
import { FLOOR_FINISHES, type FloorFinish } from '../src/plan/types'
import { SURFACE_KINDS } from '../src/plan/materials'
import { activeFloor } from '../src/plan/planStore'

/**
 * Floor finish per room.
 *
 * ── Why the fallback is what gets tested ────────────────────────────────────
 * A room with no finish of its own takes the project's. That is the whole
 * design, and it is the part that fails silently: if clearing a finish stored
 * the default as a VALUE rather than removing the key, every room would look
 * right on the day and then stop following a project-wide change afterwards —
 * with no error, and no way to tell a room that was set to timber from one that
 * merely happens to be timber.
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

// ---- The options are real surfaces ------------------------------------------

for (const finish of FLOOR_FINISHES) {
  // A finish naming a kind that does not exist renders as the default with no
  // error — the tiled bathroom someone specified is quietly timber.
  check(
    `${finish.id} names a surface that exists`,
    (SURFACE_KINDS as readonly string[]).includes(finish.id),
    finish.id,
  )
  check(`${finish.id} has a name`, Boolean(finish.name))
}

const ids = FLOOR_FINISHES.map((f) => f.id)
check('finish ids are unique', new Set(ids).size === ids.length)
check('timber and tile are both offered', ids.includes('floor-wood') && ids.includes('floor-tile'))
// More than half a residential site is outdoors, so a finish list that cannot
// describe a terrace or a lawn cannot describe half the drawing.
check('an outdoor finish is offered', ids.includes('paving') || ids.includes('grass'))

// ---- Setting and clearing ---------------------------------------------------

{
  const plan = emptyPlan()
  const floor = activeFloor(plan)
  check('a new floor has no room finishes', floor.roomFinishes === undefined || Object.keys(floor.roomFinishes).length === 0)

  const set = setRoomFinish(plan, 'room-a', 'floor-tile')
  check('a finish can be set', activeFloor(set).roomFinishes?.['room-a'] === 'floor-tile')

  const changed = setRoomFinish(set, 'room-a', 'stone')
  check('and changed', activeFloor(changed).roomFinishes?.['room-a'] === 'stone')

  const other = setRoomFinish(changed, 'room-b', 'grass')
  check('rooms are independent', activeFloor(other).roomFinishes?.['room-a'] === 'stone')
  check('and both are kept', activeFloor(other).roomFinishes?.['room-b'] === 'grass')

  // ── The assertion the design rests on ─────────────────────────────────────
  // Clearing must REMOVE the key, not store the default. A stored default looks
  // identical until the project default changes, and then this room silently
  // stops following it.
  const cleared = setRoomFinish(other, 'room-a', null)
  check(
    'clearing removes the key rather than storing a default',
    !('room-a' in (activeFloor(cleared).roomFinishes ?? {})),
    JSON.stringify(activeFloor(cleared).roomFinishes),
  )
  check('and leaves other rooms alone', activeFloor(cleared).roomFinishes?.['room-b'] === 'grass')

  // Immutability: the editor's undo stack holds previous plans by reference, so
  // mutating in place would rewrite history as well as the present.
  check('the original plan is untouched', activeFloor(plan).roomFinishes === undefined)
  check('and the intermediate one too', activeFloor(set).roomFinishes?.['room-a'] === 'floor-tile')
}

// ---- Every finish round-trips -----------------------------------------------

{
  let plan = emptyPlan()
  for (const finish of FLOOR_FINISHES) {
    plan = setRoomFinish(plan, `r-${finish.id}`, finish.id as FloorFinish)
  }
  const stored = activeFloor(plan).roomFinishes ?? {}
  check(
    'every offered finish can be stored',
    FLOOR_FINISHES.every((f) => stored[`r-${f.id}`] === f.id),
    `${Object.keys(stored).length} stored`,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
