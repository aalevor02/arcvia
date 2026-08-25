/**
 * Floor derivation for the walkthrough's storey switcher.
 *
 * `deriveFloors` reads storeys out of a model's own node names, because the
 * published page receives no plan (publicPayload strips it) and a CAD import
 * never had one. Three producers, three conventions, one derivation:
 *
 *   storey0_walls…   the CAD engine, one mesh set per storey
 *   floor:<id>       the studio plan builder, one group per floor
 *   floor_<slug>     the hand-authored villa exports (dollhouse view)
 *
 * The load-bearing properties: fewer than two storeys yields [] (a
 * one-button switcher is furniture), buckets order bottom-up by geometry
 * rather than by name (sheet order and storey order disagree on real
 * drawings), and a human-written slug beats an invented ordinal.
 */
import { deriveFloors, isFloorNode } from '@arcvia/viewer'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}  ${detail}`)
  }
}

const box = (minY: number, maxY: number, minX = 0, maxX = 10) => ({
  min: { x: minX, y: minY, z: 0 },
  max: { x: maxX, y: maxY, z: 8 },
})

console.log('-- which names count --')
check('CAD storey meshes count', isFloorNode('storey0_walls') && isFloorNode('storey1_fixtures'))
check('CAD per-room floor meshes stay in their storey',
  isFloorNode('storey0_floor_room3_master-bedroom'))
check('plan floor groups count', isFloorNode('floor:f-abc'))
check('villa slug objects count', isFloorNode('floor_lower-ground'))
check('ordinary meshes do not', !isFloorNode('wall:w1') && !isFloorNode('slab:r2') && !isFloorNode('roof'))
check('floorPlan is not a floor', !isFloorNode('floorPlanUnderlay'))

console.log('\n-- the villa, as the CAD engine names it --')
// Today's real build: storey0 at y [-3, -0.3], storey1 at [0, 2.7], five mesh
// kinds per storey. The buckets must merge the kinds and order bottom-up.
const villa = deriveFloors([
  { name: 'storey1_walls', box: box(0, 2.7) },
  { name: 'storey1_floors', box: box(0, 0.1) },
  { name: 'storey0_walls', box: box(-3, -0.3) },
  { name: 'storey0_floors', box: box(-3, -2.9) },
  { name: 'storey0_fixtures', box: box(-2.9, -2.2) },
])
check('two storeys found', villa.length === 2, String(villa.length))
check('ordered bottom-up regardless of input order', villa[0].level === -3 && villa[1].level === 0)
check('kinds merged into one bucket per storey', villa[0].label === 'Floor 1' && villa[1].label === 'Floor 2')
check('centre is the storey centre', villa[0].centre.x === 5 && villa[0].centre.z === 4)

console.log('\n-- a single-storey model gets no switcher --')
check('one storey yields []', deriveFloors([
  { name: 'storey0_walls', box: box(0, 2.7) },
  { name: 'storey0_floors', box: box(0, 0.1) },
]).length === 0)
check('no named floors yields []', deriveFloors([
  { name: 'mesh0', box: box(0, 3) },
]).length === 0)

console.log('\n-- plan floors and villa slugs --')
const plan = deriveFloors([
  { name: 'floor:ground', box: box(0, 2.6) },
  { name: 'floor:first', box: box(3, 5.6) },
])
check('plan groups bucket by id', plan.length === 2 && plan[0].level === 0 && plan[1].level === 3)

const slugged = deriveFloors([
  { name: 'floor_stilt', box: box(0, 3) },
  { name: 'floor_lower-ground', box: box(-3, -0.2) },
])
check('a human slug becomes the label', slugged[0].label === 'Lower ground', slugged[0].label)
check('...and orders by height, not name', slugged[1].label === 'Stilt')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
