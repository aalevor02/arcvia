import {
  activeFloor,
  loadPlan,
  calibrateUnderlay,
  emptyPlan,
  placeUnderlay,
  setUnderlay,
} from '../src/plan/planStore'
import { distance } from '../src/plan/geometry'
import type { Plan, Vec2 } from '../src/plan/types'

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

const IMAGE = { url: '/uploads/plan.png', width: 2000, height: 1500 }
const under = (p: Plan) => activeFloor(p).underlay!

/** Where an image pixel lands in world space, given the current placement. */
function pixelToWorld(p: Plan, px: number, py: number): Vec2 {
  const u = under(p)
  return { x: u.origin.x + px * u.scale, y: u.origin.y - py * u.scale }
}

// ---- Placement -------------------------------------------------------------
{
  const plan = placeUnderlay(emptyPlan(), IMAGE)
  const u = under(plan)

  check('placed with the image dimensions', u.width === 2000 && u.height === 1500)
  check('starts locked', u.locked === true)
  check('starts inverted for the dark canvas', u.invert === true)
  check('starts semi-transparent', u.opacity > 0 && u.opacity < 1)

  // The assumed width keeps a fresh upload on screen instead of 2 km wide.
  check('initial width is a plausible building', near(u.width * u.scale, 12),
    `${(u.width * u.scale).toFixed(2)} m`)

  // Centred on the origin, so it appears where the camera already is.
  check('centred on the world origin',
    near(u.origin.x, -6) && near(u.origin.y, 4.5),
    `${u.origin.x.toFixed(2)}, ${u.origin.y.toFixed(2)}`)
}

// ---- Calibration -----------------------------------------------------------
{
  let plan = placeUnderlay(emptyPlan(), IMAGE)

  // Two points 4 m apart as currently placed; say they are really 8 m.
  const from = { x: 0, y: 0 }
  const to = { x: 4, y: 0 }
  const scaleBefore = under(plan).scale

  plan = calibrateUnderlay(plan, from, to, 8)

  check('scale doubles when the real length is double', near(under(plan).scale, scaleBefore * 2),
    `${scaleBefore} -> ${under(plan).scale}`)

  check('drawing width doubles too',
    near(under(plan).width * under(plan).scale, 24),
    `${(under(plan).width * under(plan).scale).toFixed(2)} m`)
}

// ---- The pivot: the first clicked point must not move -----------------------
// This is the visible property. If the pivot were the image origin or centre,
// the drawing would jump away from the point the user just touched.
{
  let plan = placeUnderlay(emptyPlan(), IMAGE)

  // Pick a point that is somewhere on the image, and remember which pixel it is.
  const from = { x: -2, y: 1 }
  const u0 = under(plan)
  const pixelX = (from.x - u0.origin.x) / u0.scale
  const pixelY = (u0.origin.y - from.y) / u0.scale

  plan = calibrateUnderlay(plan, from, { x: 1, y: 1 }, 9)

  const after = pixelToWorld(plan, pixelX, pixelY)
  check('the pivot pixel stays exactly where it was',
    near(after.x, from.x, 1e-9) && near(after.y, from.y, 1e-9),
    `${after.x.toFixed(6)}, ${after.y.toFixed(6)} vs ${from.x}, ${from.y}`)
}

// ---- Calibration is idempotent in effect ------------------------------------
// Calibrating to the length it already is must change nothing.
{
  let plan = placeUnderlay(emptyPlan(), IMAGE)
  const from = { x: -1, y: 2 }
  const to = { x: 3, y: 2 }
  const actual = distance(from, to)

  const before = { ...under(plan) }
  plan = calibrateUnderlay(plan, from, to, actual)
  const after = under(plan)

  check('calibrating to the current length is a no-op',
    near(after.scale, before.scale, 1e-12) &&
      near(after.origin.x, before.origin.x, 1e-9) &&
      near(after.origin.y, before.origin.y, 1e-9))
}

// ---- Refusals ---------------------------------------------------------------
{
  const plan = placeUnderlay(emptyPlan(), IMAGE)
  const scale = under(plan).scale

  const zeroLength = calibrateUnderlay(plan, { x: 1, y: 1 }, { x: 1, y: 1 }, 5)
  check('a zero-length pick is refused', near(under(zeroLength).scale, scale))

  const zeroActual = calibrateUnderlay(plan, { x: 0, y: 0 }, { x: 4, y: 0 }, 0)
  check('a zero real length is refused', near(under(zeroActual).scale, scale))

  const negative = calibrateUnderlay(plan, { x: 0, y: 0 }, { x: 4, y: 0 }, -3)
  check('a negative real length is refused', near(under(negative).scale, scale))

  // With no underlay at all it must not throw.
  const bare = calibrateUnderlay(emptyPlan(), { x: 0, y: 0 }, { x: 1, y: 0 }, 2)
  check('calibrating without an underlay is harmless', activeFloor(bare).underlay === null)
}

// ---- Removal ----------------------------------------------------------------
{
  let plan = placeUnderlay(emptyPlan(), IMAGE)
  plan = setUnderlay(plan, null)
  check('the underlay can be removed', activeFloor(plan).underlay === null)
}

// ---- Underlays are per floor ------------------------------------------------
// Each storey is traced from its own drawing; sharing one would be wrong.
{
  const plan = placeUnderlay(emptyPlan(), IMAGE)
  const floors = plan.floors
  check('placed on the active floor only',
    floors.filter((f) => f.underlay !== null).length === 1)
}

// ---- Migrating a plan saved before `invert` existed -------------------------
// The field has to be filled in on load. Bumping the plan version instead would
// have failed the version check and thrown the whole drawing away over an added
// boolean.
{
  const saved = JSON.parse(JSON.stringify(placeUnderlay(emptyPlan(), IMAGE)))
  // The older shape: no invert, and the lower opacity that went with it.
  delete saved.floors[0].underlay.invert
  saved.floors[0].underlay.opacity = 0.6

  const u = activeFloor(loadPlan(saved)).underlay!

  check('missing invert defaults to true on load', u.invert === true)
  check('an explicitly stored opacity is preserved', near(u.opacity, 0.6), String(u.opacity))
  check('the drawing survives the migration', u.url === IMAGE.url && u.width === 2000)
}

{
  // Someone who deliberately turned inversion off must keep it off.
  const saved = JSON.parse(JSON.stringify(placeUnderlay(emptyPlan(), IMAGE)))
  saved.floors[0].underlay.invert = false
  check(
    'an explicit false is not overwritten by the default',
    activeFloor(loadPlan(saved)).underlay!.invert === false,
  )
}

{
  // A plan with no underlay must not gain one.
  const saved = JSON.parse(JSON.stringify(emptyPlan()))
  check('migration does not invent an underlay',
    activeFloor(loadPlan(saved)).underlay === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
