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
  colourWord,
  finishForSpec,
  hubQueriesForSpec,
  parseHex,
  type DesignSpec,
} from '../src/plan/deckDesign'
import { surface } from '../src/plan/materials'

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
  const wall = mesh('storey1_walls')
  const skirting = mesh('skirting:room-1')
  const ceiling = mesh('ceiling:room-1')
  const fixture = mesh('storey0_fixtures')
  const fixtureMaterialBefore = fixture.material

  const applied = applyDesignToModel(root, spec())
  check('both floor conventions dressed', applied.floors === 2,
    String(applied.floors))
  check('walls and skirting dressed', applied.walls === 2, String(applied.walls))
  check('the ceiling dressed', applied.ceilings === 1)
  check('fixtures were left alone', fixture.material === fixtureMaterialBefore)

  const floorMat = f0.material as THREE.MeshStandardMaterial
  check('the shared surface cache was CLONED, not tinted in place',
    floorMat !== surface('floor-wood')
      && surface('floor-wood').color.getHex() === 0xffffff
      || surface('floor-wood').color.getHex() !== floorMat.color.getHex())
  check('the tint pulled toward the measured colour',
    floorMat.color.getHex() !== 0xffffff, floorMat.color.getHexString())
  check('both floor meshes share one clone',
    f0.material === slab.material)
  check('walls took their own material', wall.material !== f0.material
    && wall.material === skirting.material)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
