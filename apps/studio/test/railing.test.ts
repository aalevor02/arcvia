import * as THREE from 'three'

import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import { WALL_TYPES, wallTypeById } from '../src/plan/types'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${label}`) }
  else { failed++; console.log(`FAIL  ${label}  ${detail}`) }
}

// A balcony parapet and an interior partition are the same two lines on a
// drawing. Nothing downstream could tell them apart, so a railing was built to
// the ceiling and a client walked onto a balcony boxed in by masonry. The
// adjudicator could already SEE it -- "looks like railing" -- but the verdict
// lived in a note no consumer could branch on.

{
  const railing = wallTypeById('railing')
  check('a railing is a wall type', railing !== undefined)
  check('and it is shorter than a storey', (railing?.height ?? 99) < 2, String(railing?.height))
  check('specifically guard height', railing?.height === 1.1, String(railing?.height))
  check('and thinner than masonry', (railing?.thickness ?? 9) <= 0.115, String(railing?.thickness))
}

// Every other type must stay full height, or this change silently shortens
// every wall in the product.
{
  const others = WALL_TYPES.filter((t) => t.id !== 'railing')
  check('no masonry type carries an inherent height',
    others.every((t) => t.height === undefined),
    others.filter((t) => t.height !== undefined).map((t) => t.id).join(', '))
}

// The geometry is what the client actually sees, so assert on the mesh.
{
  let plan = emptyPlan()
  plan = addWall(plan, { x: 0, y: 0 }, { x: 4, y: 0 })
  plan = addWall(plan, { x: 4, y: 0 }, { x: 4, y: 3 })
  plan = addWall(plan, { x: 4, y: 3 }, { x: 0, y: 3 })
  plan = addWall(plan, { x: 0, y: 3 }, { x: 0, y: 0 })

  const floor = activeFloor(plan)
  const ids = Object.keys(floor.walls)
  const parapet = floor.walls[ids[0]]
  const partition = floor.walls[ids[1]]

  const tallBefore = parapet.height
  parapet.type = 'railing'
  parapet.height = wallTypeById('railing')!.height!

  const built = buildFloorGeometry(floor, { skirting: false })
  const heightOf = (wallId: string) => {
    const mesh = built.children.find((c) => c.name === `wall:${wallId}`) as THREE.Mesh
    if (!mesh) return -1
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!
    return box.max.y - box.min.y
  }

  const parapetHeight = heightOf(parapet.id)
  const partitionHeight = heightOf(partition.id)

  check('the parapet is built, not skipped', parapetHeight > 0, String(parapetHeight))
  check('and it is built to guard height', Math.abs(parapetHeight - 1.1) < 0.01,
    String(parapetHeight))
  check('while the partition beside it stays full height',
    Math.abs(partitionHeight - tallBefore) < 0.01,
    `${partitionHeight} vs ${tallBefore}`)
  check('so the two are visibly different',
    partitionHeight - parapetHeight > 1.5,
    `${partitionHeight} vs ${parapetHeight}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
