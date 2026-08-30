import * as THREE from 'three'
import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { openingsFromDetection } from '../src/plan/detectedOpenings'
import { addObject, addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import type { Underlay, Vec2 } from '../src/plan/types'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

// A 10 m x 10 m sheet, so normalised 0.5 is world (5, -5) and 0.1 of the width
// is one metre. Every number below is readable in metres because of it.
const UNDERLAY = {
  url: 'x', width: 1000, height: 1000, origin: { x: 0, y: 0 },
  scale: 0.01, invert: true, locked: true, opacity: 0.85, calibrated: true,
} as unknown as Underlay

/** A gap `span` metres wide, centred on world (cx, cy), across a wall run. */
function gap(cx: number, cy: number, span: number, label = 'opening') {
  const w = span / 10
  return {
    label,
    bbox: [cx / 10 - w / 2, -cy / 10 - 0.01, w, 0.02],
    confidence: 0.9,
    attaches_to: 'wall' as const,
  }
}

/** A floor holding the given wall runs, in world metres. */
function floorWith(runs: [Vec2, Vec2][]) {
  let plan = emptyPlan()
  for (const [a, b] of runs) {
    plan = addWall(plan, a, b, { thickness: 0.15, snapRadius: 0.01 })
  }
  return activeFloor(plan)
}

const at = (x: number, y: number): Vec2 => ({ x, y })

// ---- a wall standing in a doorway gets cut ----------------------------------
// The outline-rescue path builds walls from room outlines, which are closed
// loops: they run straight across every doorway in the drawing. Those are the
// walls with something to cut.
{
  const floor = floorWith([[at(2, -5), at(8, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 1.0)], UNDERLAY, floor)

  check('a wall crossing a gap is cut', cut.length === 1, `${cut.length} openings`)
  if (cut.length === 1) {
    check('the hole is the measured gap', Math.abs(cut[0].size.width - 1.0) < 0.01,
      String(cut[0].size.width))
    check('and it is hosted on the wall it crosses',
      cut[0].wallId === Object.keys(floor.walls)[0], cut[0].wallId)
    check('and centred on the gap', Math.abs(cut[0].position.x - 5) < 0.01,
      JSON.stringify(cut[0].position))
  }
}

// ---- a gap that is ALREADY a hole is left alone ------------------------------
// This is the one that matters. `detect_openings` finds gaps BETWEEN collinear
// walls, so where the plan came from the reader's walls the doorway is already
// an absence and there is nothing to cut.
//
// A first version of this used `resolvePlacement`, the catalogue's pointer-drop
// call, which hosts on the NEAREST wall within 1.2 m. On the owner's deck it
// hosted a 0.91 m gap on the wall 0.456 m away — the wall that ENDS at the
// doorway — and would have punched a second hole beside an opening that was
// already there. Measured on three real sheets, three of four gaps had their
// nearest wall at exactly half their own span, which is what "the wall stops
// here" looks like in metres.
{
  const floor = floorWith([
    [at(2, -5), at(4.5, -5)],
    [at(5.5, -5), at(8, -5)],
  ])
  const cut = openingsFromDetection([gap(5, -5, 1.0)], UNDERLAY, floor)

  check('a gap between two walls that END at it is not cut again',
    cut.length === 0, `${cut.length} openings — a duplicate hole`)
}

// ---- windows are not converted ----------------------------------------------
// Deliberate, and not an oversight. The gap signal is geometric and repeats
// byte-identically across reads; the window signal is a vision pass that
// returned 5, 5, 5, 4 and 3 windows over five reads of one file, and reports a
// window on each Avarana sheet whose annotated ground truth is zero. A phantom
// window is a hole through an exterior wall that lights the render.
{
  const floor = floorWith([[at(2, -5), at(8, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 1.2, 'window')], UNDERLAY, floor)

  check('a window is not cut into the wall', cut.length === 0, `${cut.length} openings`)
}

// ---- a gap wider than its host leaves a pier --------------------------------
// A gap as wide as the wall it sits in says the whole fragment is doorway.
// Clamping beats refusing: a doorway 10 cm narrow is a better answer than a
// wall with no way through it.
{
  const floor = floorWith([[at(4.6, -5), at(5.4, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 1.0)], UNDERLAY, floor)

  check('an oversized gap is clamped rather than refused', cut.length === 1,
    `${cut.length} openings`)
  if (cut.length === 1) {
    check('and leaves a pier at each end', Math.abs(cut[0].size.width - 0.7) < 0.01,
      String(cut[0].size.width))
    check('and says so', /pier/.test(cut[0].because), cut[0].because)
  }
}

// ---- the leaf matches the hole, not the measurement -------------------------
// Measured on the owner's Avarana Ground: a 1.28 m gap on a 1.30 m wall clamps
// to 1.20 m. Naming the item from the raw 1.28 would hang a double door in a
// 1.20 m hole.
{
  const floor = floorWith([[at(4.35, -5), at(5.65, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 1.28)], UNDERLAY, floor)

  check('the item is chosen after clamping, not before',
    cut.length === 1 && cut[0].item === 'door',
    cut.map((o) => `${o.item} ${o.size.width.toFixed(2)}`).join())
}

// ---- a break too narrow to walk through is not a doorway --------------------
// A traced wall contains short breaks. The NBC's minimum leaf is 700 mm for a
// bathroom, so nothing under 600 mm is a way through.
{
  const floor = floorWith([[at(2, -5), at(8, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 0.4)], UNDERLAY, floor)

  check('a 0.4 m break is not treated as a doorway', cut.length === 0,
    `${cut.length} openings`)
}

// ---- a wide gap gets no leaf -------------------------------------------------
// The two crop-verified villa doors span 0.79 m and 0.91 m; an Avarana gap
// between the patio and the room beyond spans 3.69 m with no leaf and no swing
// arc. Above 1.9 m it is a cased opening.
{
  const floor = floorWith([[at(1, -5), at(9, -5)]])
  const cut = openingsFromDetection([gap(5, -5, 3.69)], UNDERLAY, floor)

  check('a 3.69 m threshold is an opening, not a door',
    cut.length === 1 && cut[0].item === 'opening',
    cut.map((o) => o.item).join())
  check('and it is not narrowed to a door width',
    cut.length === 1 && Math.abs(cut[0].size.width - 3.69) < 0.01,
    cut.map((o) => String(o.size.width)).join())
}

// ---- and the opening actually reaches the model ------------------------------
// The three links of this chain are converter -> addObject -> buildFloorGeometry,
// and the middle one is the whole point: `openingsIn` only cuts for an object
// that NAMES a wallId. An object placed at the same spot without one leaves the
// wall solid and hangs a door leaf against it, which looks almost right in plan
// and is a wall you walk into in 3D.
//
// Counting meshes separates them. A bare wall is one mesh; cut, it becomes
// three -- a pier each side and the lintel over.
{
  let plan = emptyPlan()
  plan = addWall(plan, at(2, -5), at(8, -5), { thickness: 0.15, snapRadius: 0.01 })
  const wallId = Object.keys(activeFloor(plan).walls)[0]
  const size = { width: 1, depth: 0.05, height: 2.1 }
  const place = (host?: string) =>
    addObject(plan, { item: 'door', position: at(5, -5), rotation: 0, wallId: host, size })

  const meshes = (floor: Parameters<typeof buildFloorGeometry>[0]) => {
    let n = 0
    buildFloorGeometry(floor, []).traverse((o) => { if ((o as THREE.Mesh).isMesh) n += 1 })
    return n
  }

  const bare = meshes(activeFloor(plan))
  const loose = meshes(activeFloor(place()))
  const hosted = meshes(activeFloor(place(wallId)))

  check('a door with no host leaves the wall solid', loose - bare === 4,
    `${bare} -> ${loose}: the leaf only`)
  check('a hosted opening cuts the wall into piers and a lintel',
    hosted - loose === 2, `${loose} -> ${hosted}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
