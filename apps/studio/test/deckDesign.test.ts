/**
 * From a render's DesignSpec to the studio's own vocabulary and meshes.
 *
 * The reader's half is a network service; this tests everything after the
 * spec arrives: the finish mapping (with its honest refusals — carpet maps to
 * NO plan finish rather than pretending), the hub queries, the colour words,
 * and the model application — which must clone the shared surface materials,
 * because tinting the cached instance would recolour every scene the session
 * opens after this one.
 */
import * as THREE from 'three'
import {
  applyDesignToModel,
  applyDesignsToModel,
  colourWord,
  designsOf,
  finishForSpec,
  hubQueriesForSpec,
  parseHex,
  upsertDesign,
  type DesignSpec,
} from '../src/plan/deckDesign'
import { surface } from '../src/plan/materials'
import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import { detectRooms } from '../src/plan/rooms'

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

const spec = (over: Partial<DesignSpec> = {}): DesignSpec => ({
  room: 'bedroom',
  floor: { material: 'wood', colour: '#b5824a', pattern: 'plank' },
  walls: { finish: 'paint', colour: '#e8e2d8', accent: null },
  ceiling: { kind: 'flat', colour: '#f2efe9' },
  furniture: [
    { item: 'bed', colour: '#7a6a55', style: 'upholstered' },
    { item: 'wardrobe', colour: '#74777a', style: 'modern' },
  ],
  style: 'japandi',
  palette: ['#b5824a', '#e8e2d8'],
  ...over,
})

console.log('-- finish mapping --')
check('wood maps to the timber finish', finishForSpec(spec()) === 'floor-wood')
check('marble maps to tile', finishForSpec(spec({ floor: { material: 'marble' } })) === 'floor-tile')
check('carpet refuses honestly', finishForSpec(spec({ floor: { material: 'carpet' } })) === null)
check('a spec with no floor refuses', finishForSpec(spec({ floor: undefined })) === null)

console.log('\n-- colour words --')
check('a warm brown reads as brown', colourWord('#8a5a2a') === 'brown')
check('near-greys read as grey', colourWord('#74777a').includes('grey'))
check('greens read as green', colourWord('#4a7a55') === 'green')
check('an invalid hex reads as nothing', colourWord('mahogany') === '')
check('parseHex round-trips', String(parseHex('#8a5a2a')) === '138,90,42')

console.log('\n-- hub queries --')
{
  const queries = hubQueriesForSpec(spec())
  const floor = queries.find((q) => q.label.startsWith('Floor'))
  check('the floor query carries material, pattern and colour',
    !!floor && floor.q.includes('wood') && floor.q.includes('plank'),
    floor?.q)
  check('painted walls need no hub material',
    !queries.some((q) => q.label.startsWith('Walls')))
  const bed = queries.find((q) => q.label.startsWith('bed'))
  check('furniture queries carry style and room style',
    !!bed && bed.q.includes('upholstered') && bed.q.includes('japandi'),
    bed?.q)
}

console.log('\n-- dressing the model --')
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    m.name = name
    root.add(m)
    return m
  }
  const f0 = mesh('storey0_floors')
  const slab = mesh('slab:room-1')
  const roomFloor = mesh('storey0_floor_room3_master-bedroom')
  const lawn = mesh('storey0_lawn_room7_garden')
  const wall = mesh('storey1_walls')
  const skirting = mesh('skirting:room-1')
  const ceiling = mesh('ceiling:room-1')
  const fixture = mesh('storey0_fixtures')
  const fixtureMaterialBefore = fixture.material
  const lawnMaterialBefore = lawn.material

  const applied = applyDesignToModel(root, spec())
  check('aggregate, plan and per-room floor conventions dressed', applied.floors === 3,
    String(applied.floors))
  check('walls and skirting dressed', applied.walls === 2, String(applied.walls))
  check('the ceiling dressed', applied.ceilings === 1)
  check('fixtures were left alone', fixture.material === fixtureMaterialBefore)
  check('a lawn is not mistaken for an interior floor', lawn.material === lawnMaterialBefore)

  const floorMat = f0.material as THREE.MeshStandardMaterial
  check('the shared surface cache was CLONED, not tinted in place',
    floorMat !== surface('floor-wood')
      && surface('floor-wood').color.getHex() === 0xffffff
      || surface('floor-wood').color.getHex() !== floorMat.color.getHex())
  check('the tint pulled toward the measured colour',
    floorMat.color.getHex() !== 0xffffff, floorMat.color.getHexString())
  check('both floor meshes share one clone',
    f0.material === slab.material && slab.material === roomFloor.material)
  check('walls took their own material', wall.material !== f0.material
    && wall.material === skirting.material)
}

console.log('\n-- storing room designs --')
{
  const legacy = spec({ source: { page: 2, index: 0, room: 'BED ROOM' } })
  check('a legacy single design normalises without migration', designsOf(legacy)[0] === legacy)

  const living = spec({
    room: 'living room',
    source: { page: 3, index: 0, room: 'Living Room' },
  })
  const two = upsertDesign(legacy, living)
  check('a different room is retained beside the first', two.length === 2)

  const replacement = spec({
    room: 'living room',
    floor: { material: 'tile', colour: '#445566' },
    source: { page: 8, index: 1, room: 'living-room' },
  })
  const replaced = upsertDesign(two, replacement)
  check('the same normalised room is replaced, not duplicated',
    replaced.length === 2 && replaced[1] === replacement)
  check('replacing a later room keeps the first fallback stable', replaced[0] === legacy)
}

console.log('\n-- room-specific dressing --')
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const value = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    value.name = name
    root.add(value)
    return value
  }
  const bedroom = mesh('storey0_floor_room3_bedroom')
  const living = mesh('storey0_floor_room4_living-room')
  const master = mesh('storey1_floor_room8_master-bedroom')
  const bathroom = mesh('storey0_floor_room7_bathroom')
  const unknown = mesh('storey0_floor_room9_corridor')
  const bedroomWall = mesh('storey0_wall_room3_bedroom')
  const livingWall = mesh('storey0_wall_room4_living-room')
  const bedroomCeiling = mesh('storey0_ceiling_room3_bedroom')
  const livingCeiling = mesh('storey0_ceiling_room4_living-room')
  const lawn = mesh('storey0_lawn_room10_garden')
  const wall = mesh('storey0_walls')
  const lawnBefore = lawn.material

  const fallback = spec({ room: 'bed room', source: { page: 2, index: 0, room: 'BED ROOM' } })
  const livingLook = spec({
    room: 'living room',
    floor: { material: 'tile', colour: '#334455' },
    walls: { finish: 'wallpaper', colour: '#496070', accent: null },
    ceiling: { kind: 'coffered', colour: '#ccddee' },
    source: { page: 3, index: 0, room: 'Living Room' },
  })
  const masterLook = spec({
    room: 'master bedroom',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 4, index: 0, room: 'Master Bedroom Interior' },
  })
  const uncertainBathroom = spec({
    room: 'bathroom',
    floor: undefined,
    source: { page: 5, index: 0, room: 'Bathroom' },
  })
  applyDesignsToModel(root, [fallback, livingLook, masterLook, uncertainBathroom])

  check('the first render remains the fallback for unlabelled rooms',
    unknown.material === bedroom.material)
  check('a matching living-room mesh gets its own floor finish',
    living.material !== bedroom.material)
  check('caption noise and hyphens still match the master bedroom',
    master.material !== bedroom.material && master.material !== living.material)
  check('a matching room wall gets its own finish without repainting its neighbour',
    livingWall.material !== bedroomWall.material)
  check('a matching room ceiling gets its own finish without repainting its neighbour',
    livingCeiling.material !== bedroomCeiling.material)
  check('additional room looks do not repaint the aggregate structural wall',
    wall.material === bedroomWall.material && wall.material !== livingWall.material)
  check('a render with no identified floor keeps the fallback',
    bathroom.material === bedroom.material)
  check('site meshes remain outside interior room dressing', lawn.material === lawnBefore)
}

// -- a bare caption must not spread across every room it fits ----------------
// roomTokens splits 'master-bedroom' into ['master','bedroom'], so a render
// captioned merely "Bedroom" satisfied the old subset test against BOTH the
// guest bedroom and the master. The guest's finish landed on the master
// silently; the only symptom was a client saying the walkthrough looked wrong.
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const value = new THREE.Mesh(new THREE.BoxGeometry(), surface('floor'))
    value.name = name
    root.add(value)
    return value
  }
  const opening = mesh('storey0_floor_room1_kitchen')
  const guest = mesh('storey0_floor_room3_bedroom')
  const master = mesh('storey0_floor_room8_master-bedroom')

  const fallback = spec({ room: 'kitchen', source: { page: 1, index: 0, room: 'Kitchen' } })
  const guestLook = spec({
    room: 'bedroom',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 2, index: 0, room: 'Bedroom' },
  })
  const applied = applyDesignsToModel(root, [fallback, guestLook])

  check('a bare "Bedroom" caption dresses the guest bedroom',
    guest.material !== opening.material)
  check('and leaves the MASTER bedroom alone', master.material === opening.material,
    'the guest render repainted the master')
  check('the assignment is reported as automatic, with its room',
    applied.assignments?.[0].status === 'auto' && applied.assignments?.[0].room === 'bedroom',
    JSON.stringify(applied.assignments))
}

// -- a genuinely ambiguous caption paints nothing and asks --------------------
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const value = new THREE.Mesh(new THREE.BoxGeometry(), surface('floor'))
    value.name = name
    root.add(value)
    return value
  }
  const opening = mesh('storey0_floor_room1_kitchen')
  const first = mesh('storey0_floor_room3_bed-1-room')
  const second = mesh('storey0_floor_room4_bed-2-room')

  const fallback = spec({ room: 'kitchen', source: { page: 1, index: 0, room: 'Kitchen' } })
  const vague = spec({
    room: 'bed',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 2, index: 0, room: 'Bed' },
  })
  const applied = applyDesignsToModel(root, [fallback, vague])

  check('an ambiguous caption paints NEITHER candidate',
    first.material === opening.material && second.material === opening.material)
  check('and comes back as a question naming both rooms',
    applied.assignments?.[0].status === 'confirm' &&
      applied.assignments?.[0].candidates.length === 2,
    JSON.stringify(applied.assignments))
}


// -- a confirmed room index outranks every caption heuristic ------------------
// The case a caption can NEVER solve: three rooms all labelled BEDROOM, or a
// room the drawing never labelled at all. solidify.py numbers the meshes for
// exactly this reason, and a confirmation addresses that number.
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const value = new THREE.Mesh(new THREE.BoxGeometry(), surface('floor'))
    value.name = name
    root.add(value)
    return value
  }
  const opening = mesh('storey0_floor_room1_kitchen')
  const first = mesh('storey0_floor_room3_bedroom')
  const second = mesh('storey0_floor_room4_bedroom')
  const third = mesh('storey0_floor_room5_bedroom')

  const fallback = spec({ room: 'kitchen', source: { page: 1, index: 0, room: 'Kitchen' } })
  const confirmed = spec({
    room: 'bedroom',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 2, index: 0, room: 'Bedroom', roomIndex: 4 },
  })
  const applied = applyDesignsToModel(root, [fallback, confirmed])

  check('a confirmed index dresses exactly the room that was confirmed',
    second.material !== opening.material)
  check('and leaves the two identically-named bedrooms alone',
    first.material === opening.material && third.material === opening.material,
    'a confirmation leaked onto a same-named room')
  check('the confirmation is reported as resolved, not as a question',
    applied.assignments?.[0].status === 'auto' &&
      applied.assignments?.[0].reason.includes('room 4'),
    JSON.stringify(applied.assignments))
}

// -- a confirmation answers a caption the matcher had refused ----------------
{
  const root = new THREE.Group()
  const mesh = (name: string) => {
    const value = new THREE.Mesh(new THREE.BoxGeometry(), surface('floor'))
    value.name = name
    root.add(value)
    return value
  }
  const opening = mesh('storey0_floor_room1_kitchen')
  const target = mesh('storey0_floor_room6_unlabelled')

  const fallback = spec({ room: 'kitchen', source: { page: 1, index: 0, room: 'Kitchen' } })
  // "Guest Suite" matches nothing in this plan; unconfirmed it stays a question.
  const unmatched = spec({
    room: 'guest suite',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 2, index: 0, room: 'Guest Suite' },
  })
  const before = applyDesignsToModel(root, [fallback, unmatched])
  check('an unmatched caption paints nothing on its own',
    target.material === opening.material &&
      before.assignments?.[0].status === 'unmatched',
    JSON.stringify(before.assignments))

  const answered = spec({
    ...unmatched,
    source: { page: 2, index: 0, room: 'Guest Suite', roomIndex: 6 },
  })
  applyDesignsToModel(root, [fallback, answered])
  check('and the same render lands once a person says which room it is',
    target.material !== opening.material)
}


// -- per-room dressing must reach STUDIO-drawn geometry, not just a CAD import --
// The studio named its meshes `slab:<room.id>` while the deck matcher reads
// `{kind}_room{n}_{slug}`, so every render past the first silently did nothing
// on a plan drawn here and the whole model wore the first render's look. Two
// naming schemes for one idea; this asserts they have converged.
{
  // A single closed room.
  let plan = emptyPlan()
  plan = addWall(plan, { x: 0, y: 0 }, { x: 4, y: 0 })
  plan = addWall(plan, { x: 4, y: 0 }, { x: 4, y: 3 })
  plan = addWall(plan, { x: 4, y: 3 }, { x: 0, y: 3 })
  plan = addWall(plan, { x: 0, y: 3 }, { x: 0, y: 0 })

  const floor = activeFloor(plan)
  const detected = detectRooms(floor)
  check('the fixture encloses one room', detected.length === 1, `${detected.length}`)

  // Name it the way a drawing would.
  floor.roomNames[detected[0].id] = 'Master Bedroom'

  const built = buildFloorGeometry(floor, { ceilings: true })
  const slab = built.children.find((c) => c.name.startsWith('floor_room'))
  check('a studio slab is named like a reconstruction floor',
    slab?.name === 'floor_room1_master-bedroom', String(slab?.name))
  check('and keeps the derived room id where a name cannot carry it',
    slab?.userData.roomId === detected[0].id, JSON.stringify(slab?.userData))

  const ceiling = built.children.find((c) => c.name.startsWith('ceiling_room'))
  check('the ceiling is named to match', ceiling?.name === 'ceiling_room1_master-bedroom',
    String(ceiling?.name))

  // The point of all of it: a caption now addresses a studio-drawn room.
  const opening = new THREE.Mesh(new THREE.BoxGeometry(), surface('floor'))
  opening.name = 'floor_room2_kitchen'
  built.add(opening)

  const fallback = spec({ room: 'kitchen', source: { page: 1, index: 0, room: 'Kitchen' } })
  const bedroomLook = spec({
    room: 'master bedroom',
    floor: { material: 'marble', colour: '#ddeeff' },
    source: { page: 2, index: 0, room: 'Master Bedroom' },
  })
  const applied = applyDesignsToModel(built, [fallback, bedroomLook])

  check('a render now dresses the studio-drawn room it names',
    (slab as THREE.Mesh).material !== (opening as THREE.Mesh).material)
  check('and the assignment resolves rather than reporting no such room',
    applied.assignments?.[0].status === 'auto' &&
      applied.assignments?.[0].room === 'master-bedroom',
    JSON.stringify(applied.assignments))
}


console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
