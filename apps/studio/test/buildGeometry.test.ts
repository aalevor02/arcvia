import * as THREE from 'three'
import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
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

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol

/** A 4 x 3 m room with its bottom-left corner at the plan origin. */
function room(): Plan {
  let p = emptyPlan()
  p = addWall(p, { x: 0, y: 0 }, { x: 4, y: 0 })
  p = addWall(p, { x: 4, y: 0 }, { x: 4, y: 3 })
  p = addWall(p, { x: 4, y: 3 }, { x: 0, y: 3 })
  p = addWall(p, { x: 0, y: 3 }, { x: 0, y: 0 })
  return p
}

const floor = activeFloor(room())
const group = buildFloorGeometry(floor)

const walls = group.children.filter((c) => c.name.startsWith('wall:'))
const slabs = group.children.filter((c) => c.name.startsWith('slab:'))

// ---- Composition -----------------------------------------------------------
check('one mesh per wall', walls.length === 4, `${walls.length}`)
check('one slab per detected room', slabs.length === 1, `${slabs.length}`)
check('no ceilings unless asked', group.children.every((c) => !c.name.startsWith('ceiling:')))
check(
  'ceilings appear when asked',
  buildFloorGeometry(floor, { ceilings: true }).children.some((c) =>
    c.name.startsWith('ceiling:'),
  ),
)

// ---- Axis mapping ----------------------------------------------------------
// plan (x, y) -> world (x, elevation, -y). Getting this wrong mirrors the whole
// building, which is invisible until a door is on the wrong side.
{
  const bounds = new THREE.Box3().setFromObject(group)

  check('world X spans the plan width', near(bounds.min.x, 0, 0.2) && near(bounds.max.x, 4, 0.2),
    `${bounds.min.x.toFixed(2)}..${bounds.max.x.toFixed(2)}`)

  // Plan y runs 0..3, so world z must run -3..0 — negative, not positive.
  check('world Z is the negated plan Y',
    near(bounds.min.z, -3, 0.2) && near(bounds.max.z, 0, 0.2),
    `${bounds.min.z.toFixed(2)}..${bounds.max.z.toFixed(2)}`)

  check('walls stand up from the floor',
    near(bounds.max.y, 3, 0.2), `max y ${bounds.max.y.toFixed(2)}`)
}

// ---- Wall placement --------------------------------------------------------
{
  // The wall from (0,0) to (4,0) should be centred at world (2, 1.5, 0).
  const south = walls.find((w) => {
    const p = w.position
    return near(p.x, 2, 0.01) && near(p.z, 0, 0.01)
  })
  check('a wall sits at its midpoint', Boolean(south),
    walls.map((w) => `${w.position.x.toFixed(1)},${w.position.z.toFixed(1)}`).join(' '))
  check('wall is centred at half its height', south ? near(south.position.y, 1.5, 0.01) : false)
}

// ---- Slab orientation ------------------------------------------------------
// The bug this catches: ExtrudeGeometry builds in XY and is rotated flat. If the
// rotation flips the winding, the slab's top face normals point *down*, the
// floor is invisible from above with default front-side materials, and you see
// straight through it to the background.
{
  const slab = slabs[0] as THREE.Mesh
  const geometry = slab.geometry as THREE.BufferGeometry
  geometry.computeVertexNormals()

  const normal = geometry.getAttribute('normal')
  let up = 0
  let down = 0
  for (let i = 0; i < normal.count; i++) {
    const y = normal.getY(i)
    if (y > 0.9) up++
    if (y < -0.9) down++
  }

  check('slab has upward-facing vertices', up > 0, `up=${up} down=${down}`)
  check('slab has downward-facing vertices too (it is a solid)', down > 0, `up=${up} down=${down}`)

  const box = new THREE.Box3().setFromObject(slab)
  check('slab covers the room footprint',
    near(box.min.x, 0, 0.01) && near(box.max.x, 4, 0.01) &&
      near(box.min.z, -3, 0.01) && near(box.max.z, 0, 0.01),
    `x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}`)

  check('slab sits just below floor level',
    box.max.y <= 0.001 && box.min.y < 0,
    `y ${box.min.y.toFixed(3)}..${box.max.y.toFixed(3)}`)
}

// ---- Multi-storey ----------------------------------------------------------
{
  const upper = { ...floor, id: 'f9', elevation: 3 }
  const bounds = new THREE.Box3().setFromObject(buildFloorGeometry(upper))
  check('an upper floor is raised by its elevation',
    near(bounds.max.y, 6, 0.2), `max y ${bounds.max.y.toFixed(2)}`)
}

// ---- Empty plan ------------------------------------------------------------
{
  const blank = buildFloorGeometry(activeFloor(emptyPlan()))
  check('an empty floor builds an empty group', blank.children.length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
