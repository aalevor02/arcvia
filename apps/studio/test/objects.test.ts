import * as THREE from 'three'
import {
  activeFloor,
  addObject,
  addWall,
  emptyPlan,
  loadPlan,
  objectsOn,
  removeObject,
  removeWall,
  updateObject,
} from '../src/plan/planStore'
import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { resolvePlacement, footprint, sizeOf, elevationOf } from '../src/catalogue/placement'
import { itemById, searchCatalogue, CATALOGUE, CATEGORIES } from '../src/catalogue/items'
import type { Plan } from '../src/plan/types'

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
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol

/** A single 6 m wall running east along y = 0. */
function oneWall(): Plan {
  return addWall(emptyPlan(), { x: 0, y: 0 }, { x: 6, y: 0 }, { thickness: 0.23, height: 3 })
}

const wallIdOf = (plan: Plan) => Object.keys(activeFloor(plan).walls)[0]
const wallMeshes = (plan: Plan) =>
  buildFloorGeometry(activeFloor(plan)).children.filter((c) => c.name.startsWith('wall:'))

// ---- Catalogue integrity ----------------------------------------------------
{
  check('catalogue has items', CATALOGUE.length > 30, String(CATALOGUE.length))
  check('every item has a unique id',
    new Set(CATALOGUE.map((i) => i.id)).size === CATALOGUE.length)
  check('every item names a known category',
    CATALOGUE.every((i) => (CATEGORIES as readonly string[]).includes(i.category)),
    CATALOGUE.filter((i) => !(CATEGORIES as readonly string[]).includes(i.category)).map((i) => i.category).join(','))
  check('every item has positive dimensions',
    CATALOGUE.every((i) => i.size.width > 0 && i.size.depth > 0 && i.size.height > 0))

  // Real sizes, not round ones. A standard internal door leaf is 900 x 2100.
  const door = itemById('door')!
  check('a door is a real door', near(door.size.width, 0.9) && near(door.size.height, 2.1))

  const appliances = ['ceiling-fan', 'ac-split', 'washing-machine'].map((id) => itemById(id)!)
  check('the core appliance types are present',
    appliances.every((item) => item.category === 'Appliances'))
  check('standard appliance dimensions are fitted exactly at runtime',
    appliances.every((item) => item.model?.fitFootprint === true))

  check('search finds by name', searchCatalogue('sofa').length >= 2)
  check('search filters by category',
    searchCatalogue('', 'Bathroom').every((i) => i.category === 'Bathroom'))
  check('search on nonsense finds nothing', searchCatalogue('zzzznope').length === 0)

  // A name match must outrank a category match. Without this, searching
  // "window" returns Door first — its category is "Doors & windows" — and
  // anyone clicking the top result places the wrong thing.
  check('a name match beats a category match',
    searchCatalogue('window')[0]?.id.startsWith('window'),
    searchCatalogue('window')[0]?.id)
  check('an exact name wins outright',
    searchCatalogue('door')[0]?.id === 'door', searchCatalogue('door')[0]?.id)
  check('a prefix match beats a mid-word one',
    searchCatalogue('bed')[0]?.name.toLowerCase().startsWith('bed'),
    searchCatalogue('bed')[0]?.name)
  check('category matches are still findable',
    searchCatalogue('bathroom').length > 0, String(searchCatalogue('bathroom').length))
}

// ---- Placement --------------------------------------------------------------
{
  const plan = oneWall()
  const floor = activeFloor(plan)

  // A floor object lands where it was dropped.
  const sofa = resolvePlacement(floor, itemById('sofa-3')!, { x: 3, y: 2 })
  check('a floor object keeps its drop point',
    near(sofa.position.x, 3) && near(sofa.position.y, 2))
  check('a floor object needs no wall', sofa.wallId === undefined && !sofa.problem)

  // A door dropped near the wall snaps onto it and aligns.
  const door = resolvePlacement(floor, itemById('door')!, { x: 3, y: 0.1 })
  check('a door snaps to the wall', door.wallId === wallIdOf(plan))
  check('a door lands on the wall centreline', near(door.position.y, 0))
  check('a door aligns with the wall', near(door.rotation, 0) || near(Math.abs(door.rotation), Math.PI))

  // A door dropped in open space is refused rather than left floating.
  const stray = resolvePlacement(floor, itemById('door')!, { x: 3, y: 8 })
  check('a door with no wall nearby is refused', Boolean(stray.problem), stray.problem)

  // A wall-mounted object stands off the wall face, on the side it was dropped.
  const tv = resolvePlacement(floor, itemById('tv')!, { x: 3, y: 0.4 })
  check('a wall object stands off the face', tv.position.y > 0.1,
    `y=${tv.position.y.toFixed(3)}`)
  const tvOther = resolvePlacement(floor, itemById('tv')!, { x: 3, y: -0.4 })
  check('and on the side it was dropped', tvOther.position.y < -0.1,
    `y=${tvOther.position.y.toFixed(3)}`)

  // An opening wider than its wall cannot fit.
  const short = addWall(emptyPlan(), { x: 0, y: 0 }, { x: 0.8, y: 0 })
  const tooWide = resolvePlacement(activeFloor(short), itemById('window-wide')!, { x: 0.4, y: 0 })
  check('an opening wider than the wall is refused', Boolean(tooWide.problem), tooWide.problem)

  // Dropped at the very end of a wall, it slides back to fit.
  const atEnd = resolvePlacement(floor, itemById('window-wide')!, { x: 5.95, y: 0 })
  check('an opening near a corner slides in to fit',
    atEnd.position.x <= 6 - 2.1 / 2 + 1e-6, `x=${atEnd.position.x.toFixed(3)}`)
}

// ---- Store operations -------------------------------------------------------
{
  let plan = oneWall()
  plan = addObject(plan, {
    item: 'sofa-3',
    position: { x: 2, y: 2 },
    rotation: 0,
  })

  check('the object is stored', objectsOn(activeFloor(plan)).length === 1)

  const id = objectsOn(activeFloor(plan))[0].id
  plan = updateObject(plan, id, { rotation: Math.PI / 2 })
  check('it can be rotated', near(objectsOn(activeFloor(plan))[0].rotation, Math.PI / 2))

  // Identity must not be patchable.
  plan = updateObject(plan, id, { id: 'hacked' } as never)
  check('the id cannot be rewritten by a patch', objectsOn(activeFloor(plan))[0].id === id)

  plan = removeObject(plan, id)
  check('it can be removed', objectsOn(activeFloor(plan)).length === 0)
}

// ---- Deleting a wall takes its openings with it ----------------------------
// A door whose wall is gone is a door-shaped hole in nothing: it would still
// render, still be listed, and never be findable in the plan.
{
  let plan = oneWall()
  const wallId = wallIdOf(plan)

  plan = addObject(plan, {
    item: 'door', position: { x: 3, y: 0 }, rotation: 0, wallId,
  })
  plan = addObject(plan, {
    item: 'sofa-3', position: { x: 3, y: 2 }, rotation: 0,
  })
  check('two objects placed', objectsOn(activeFloor(plan)).length === 2)

  plan = removeWall(plan, wallId)
  const left = objectsOn(activeFloor(plan))
  check('the door went with the wall', left.length === 1, `${left.length} left`)
  check('the free-standing sofa survived', left[0]?.item === 'sofa-3')
}

// ---- Openings cut the wall in 3D -------------------------------------------
{
  const plain = oneWall()
  check('a plain wall is one piece', wallMeshes(plain).length === 1,
    `${wallMeshes(plain).length}`)

  // A door reaches the floor: pier, pier, lintel. No sill.
  const withDoor = addObject(plain, {
    item: 'door', position: { x: 3, y: 0 }, rotation: 0, wallId: wallIdOf(plain),
  })
  check('a door splits the wall into three pieces', wallMeshes(withDoor).length === 3,
    `${wallMeshes(withDoor).length}`)

  // A window has a sill too: pier, sill, lintel, pier.
  const withWindow = addObject(plain, {
    item: 'window', position: { x: 3, y: 0 }, rotation: 0, wallId: wallIdOf(plain),
  })
  check('a window splits it into four (it has a sill)',
    wallMeshes(withWindow).length === 4, `${wallMeshes(withWindow).length}`)

  // The hole must actually be a hole: nothing solid in the doorway at 1 m up.
  const built = buildFloorGeometry(activeFloor(withDoor))
  const doorway = new THREE.Vector3(3, 1.0, 0)
  const blocking = built.children
    .filter((c) => c.name.startsWith('wall:'))
    .filter((mesh) => {
      const box = new THREE.Box3().setFromObject(mesh)
      return box.containsPoint(doorway)
    })
  check('the doorway is actually empty', blocking.length === 0, `${blocking.length} meshes`)

  // And there IS wall above it.
  const overhead = built.children
    .filter((c) => c.name.startsWith('wall:'))
    .filter((mesh) => new THREE.Box3().setFromObject(mesh).containsPoint(new THREE.Vector3(3, 2.6, 0)))
  check('there is a lintel over the door', overhead.length === 1, `${overhead.length}`)
}

// ---- Furniture appears in the 3D build -------------------------------------
{
  const plan = addObject(oneWall(), {
    item: 'bed-king', position: { x: 3, y: 2 }, rotation: 0,
  })
  const group = buildFloorGeometry(activeFloor(plan))
  const objects = group.children.find((c) => c.name === 'objects')

  check('objects group is built', Boolean(objects))
  check('the bed has geometry', (objects?.children.length ?? 0) === 1)

  const box = new THREE.Box3().setFromObject(objects!)
  const size = new THREE.Vector3()
  box.getSize(size)
  // 1.83 wide, 2.03 deep. Headboard adds a little depth.
  check('the bed is king-sized in the model',
    near(size.x, 1.83, 0.05) && size.z > 2.0 && size.z < 2.2,
    `${size.x.toFixed(2)} x ${size.z.toFixed(2)}`)
}

// ---- Footprint --------------------------------------------------------------
{
  const object = {
    id: 'o1', item: 'sofa-3', position: { x: 0, y: 0 }, rotation: 0,
  }
  const corners = footprint(object)
  check('footprint has four corners', corners.length === 4)
  check('footprint matches the catalogue size',
    near(Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x)), 2.1))

  const turned = footprint({ ...object, rotation: Math.PI / 2 })
  check('rotating swaps the footprint axes',
    near(Math.max(...turned.map((c) => c.y)) - Math.min(...turned.map((c) => c.y)), 2.1))
}

// ---- Sizes and elevations ---------------------------------------------------
{
  const window = { id: 'o1', item: 'window', position: { x: 0, y: 0 }, rotation: 0 }
  check('a window sits at its sill height', near(elevationOf(window), 0.9))

  const door = { id: 'o2', item: 'door', position: { x: 0, y: 0 }, rotation: 0 }
  check('a door sits on the floor', near(elevationOf(door), 0))

  const resized = { ...door, size: { width: 1.2, depth: 0.05, height: 2.4 } }
  check('an override beats the catalogue size', near(sizeOf(resized).width, 1.2))
}

// ---- Migration --------------------------------------------------------------
{
  const saved = JSON.parse(JSON.stringify(oneWall()))
  delete saved.floors[0].objects
  check('a plan saved before objects existed still loads',
    objectsOn(activeFloor(loadPlan(saved))).length === 0)
}

// ---- Reopening a plan must not recycle object ids ---------------------------
// All the id namespaces share one counter. If `reserveIds` misses one, the
// counter restarts low after a reload and the next id collides with an
// existing record — which does not throw, it overwrites it. The only symptom
// is a count that refuses to go up.
{
  let plan = oneWall()
  for (const item of ['sofa-3', 'coffee-table', 'plant']) {
    plan = addObject(plan, { item, position: { x: 1, y: 1 }, rotation: 0 })
  }
  check('three objects placed', objectsOn(activeFloor(plan)).length === 3)

  // Round-trip through JSON, exactly as a save and reopen would.
  const reopened = loadPlan(JSON.parse(JSON.stringify(plan)))
  const grown = addObject(reopened, {
    item: 'armchair', position: { x: 2, y: 2 }, rotation: 0,
  })

  check('adding after a reload does not overwrite an existing object',
    objectsOn(activeFloor(grown)).length === 4,
    `${objectsOn(activeFloor(grown)).length} objects`)

  const ids = objectsOn(activeFloor(grown)).map((o) => o.id)
  check('all object ids are distinct', new Set(ids).size === ids.length, ids.join(','))

  // The same must hold for walls drawn after a reload.
  const withWall = addWall(reopened, { x: 9, y: 9 }, { x: 12, y: 9 })
  check('walls added after a reload are also safe',
    Object.keys(activeFloor(withWall).walls).length === 2,
    String(Object.keys(activeFloor(withWall).walls).length))
}


// ---- Facing ----------------------------------------------------------------
// A chair facing a wall reads as broken far more loudly than a chair at a
// slightly odd angle, so a floor object puts its back to the nearest wall.
//
// The convention under test: an object at rotation r faces plan direction
// (-sin r, -cos r), so r = 0 faces -y. Get a sign wrong anywhere in that chain
// and every piece of furniture in every project turns around at once, with
// nothing else noticing.
{
  const floor = activeFloor(oneWall()) // a 6 m wall along y = 0
  const facing = (r: number) => ({ x: -Math.sin(r), y: -Math.cos(r) })

  const beside = resolvePlacement(floor, itemById('sofa-3')!, { x: 3, y: 0.4 })
  const f1 = facing(beside.rotation)
  check(
    'a floor object by a wall turns its back to it',
    near(f1.y, 1, 0.02) && near(f1.x, 0, 0.02),
    `(${f1.x.toFixed(2)}, ${f1.y.toFixed(2)})`,
  )

  // The other side of the same wall must face the other way, or the rule is
  // "always north" rather than "away from the wall".
  const other = resolvePlacement(floor, itemById('sofa-3')!, { x: 3, y: -0.4 })
  const f2 = facing(other.rotation)
  check(
    'and the far side of that wall faces the opposite way',
    near(f2.y, -1, 0.02),
    `(${f2.x.toFixed(2)}, ${f2.y.toFixed(2)})`,
  )

  const middle = resolvePlacement(floor, itemById('sofa-3')!, { x: 3, y: 4 })
  check(
    'an object with no wall near it is left square to the plan',
    middle.rotation === 0,
    String(middle.rotation),
  )

  // A pendant looks the same from every side; spinning it is noise.
  const pendant = resolvePlacement(floor, itemById('pendant')!, { x: 3, y: 0.4 })
  check('a ceiling object is not oriented', pendant.rotation === 0)
}

console.log(`
${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
