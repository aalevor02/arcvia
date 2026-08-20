import * as THREE from 'three'
import { assignLightmapUVs, applyLightmap } from '../src/plan/lightmapUV'
import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { activeFloor, addObject, addWall, emptyPlan } from '../src/plan/planStore'

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

function group(count: number): THREE.Group {
  const g = new THREE.Group()
  for (let i = 0; i < count; i++) {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1 + i * 0.3, 2, 0.2)))
  }
  return g
}

const meshesOf = (root: THREE.Object3D) => {
  const list: THREE.Mesh[] = []
  root.traverse((c) => { if (c instanceof THREE.Mesh) list.push(c) })
  return list
}

/** The axis-aligned UV bounds of one mesh. */
function uvBounds(mesh: THREE.Mesh) {
  const uv = mesh.geometry.getAttribute('uv1')
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (let i = 0; i < uv.count; i++) {
    minU = Math.min(minU, uv.getX(i)); maxU = Math.max(maxU, uv.getX(i))
    minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i))
  }
  return { minU, maxU, minV, maxV }
}

// ---- Basic assignment -------------------------------------------------------
{
  const g = group(9)
  const result = assignLightmapUVs(g)

  check('grid is ceil(sqrt(n))', result.grid === 3, String(result.grid))
  check('every mesh counted', result.meshes === 9, String(result.meshes))
  check('every mesh got uv1', meshesOf(g).every((m) => Boolean(m.geometry.getAttribute('uv1'))))
  check('every mesh got uv2 as well', meshesOf(g).every((m) => Boolean(m.geometry.getAttribute('uv2'))))

  // 10 meshes needs a 4x4 grid, not 3x3.
  check('grid grows with mesh count', assignLightmapUVs(group(10)).grid === 4)
  check('a single mesh needs one cell', assignLightmapUVs(group(1)).grid === 1)
  check('an empty group is handled', assignLightmapUVs(new THREE.Group()).meshes === 0)
}

// ---- Everything stays inside the atlas --------------------------------------
{
  const g = group(7)
  assignLightmapUVs(g)

  const outside = meshesOf(g).filter((m) => {
    const b = uvBounds(m)
    return b.minU < 0 || b.maxU > 1 || b.minV < 0 || b.maxV > 1
  })
  check('no UV escapes the 0-1 atlas', outside.length === 0, `${outside.length} meshes`)
}

// ---- The property that matters: cells do not overlap ------------------------
// Overlapping cells means two objects bake on top of each other, and the result
// is light from one room appearing in another. It renders perfectly and is
// deeply confusing to diagnose, so it is worth an explicit test.
{
  const g = group(12)
  assignLightmapUVs(g)
  const boxes = meshesOf(g).map(uvBounds)

  let overlaps = 0
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      const separated =
        a.maxU <= b.minU || b.maxU <= a.minU || a.maxV <= b.minV || b.maxV <= a.minV
      if (!separated) overlaps++
    }
  }
  check('no two meshes share atlas space', overlaps === 0, `${overlaps} overlapping pairs`)
}

// ---- Gutters ----------------------------------------------------------------
// The bake margin bleeds a few pixels outward. Without a gutter that bleed
// lands on the neighbouring cell.
{
  const g = group(4)
  const { grid } = assignLightmapUVs(g)
  const step = 1 / grid
  const b = uvBounds(meshesOf(g)[0])

  check('each cell is inset from its edges',
    b.minU > 0 && b.maxU < step - 1e-6,
    `cell 0 spans ${b.minU.toFixed(4)}..${b.maxU.toFixed(4)} of ${step}`)
}

// ---- Degenerate geometry ----------------------------------------------------
// A floor slab has zero extent on one axis. Dividing by it yields NaN UVs,
// which bake as a black object — a failure that looks like a lighting bug.
{
  const flat = new THREE.Group()
  flat.add(new THREE.Mesh(new THREE.PlaneGeometry(4, 3)))
  assignLightmapUVs(flat)

  const uv = meshesOf(flat)[0].geometry.getAttribute('uv1')
  let finite = true
  for (let i = 0; i < uv.count; i++) {
    if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) finite = false
  }
  check('flat geometry produces finite UVs', finite)
}

// ---- Against a real generated floor -----------------------------------------
{
  let plan = addWall(emptyPlan(), { x: 0, y: 0 }, { x: 5, y: 0 })
  plan = addWall(plan, { x: 5, y: 0 }, { x: 5, y: 4 })
  plan = addWall(plan, { x: 5, y: 4 }, { x: 0, y: 4 })
  plan = addWall(plan, { x: 0, y: 4 }, { x: 0, y: 0 })
  plan = addObject(plan, { item: 'sofa-3', position: { x: 2, y: 2 }, rotation: 0 })

  const built = buildFloorGeometry(activeFloor(plan))
  const result = assignLightmapUVs(built)

  check('a real floor unwraps', result.meshes > 4, `${result.meshes} meshes`)

  const bad = meshesOf(built).filter((m) => {
    const uv = m.geometry.getAttribute('uv1')
    if (!uv) return true
    for (let i = 0; i < uv.count; i++) {
      if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) return true
    }
    return false
  })
  check('every generated mesh has finite UVs', bad.length === 0, `${bad.length} bad`)
}

// ---- Applying the atlas back ------------------------------------------------
{
  const g = group(4)
  assignLightmapUVs(g)
  for (const m of meshesOf(g)) m.material = new THREE.MeshStandardMaterial()

  const texture = new THREE.Texture()
  const applied = applyLightmap(g, texture, 0.9)

  check('the lightmap reaches every mesh', applied === 4, String(applied))

  const first = meshesOf(g)[0].material as THREE.MeshStandardMaterial
  check('attached as lightMap, not map', first.lightMap === texture && first.map === null)
  check('intensity is honoured', first.lightMapIntensity === 0.9)

  // The atlas must be sampled with the packed coordinates in uv1, not the
  // albedo UVs in uv0. `channel` defaults to 0, and getting this wrong is
  // invisible to every other assertion here: the UVs are packed correctly, the
  // texture is attached correctly, the right number of meshes are lit — and
  // every surface renders the whole atlas smeared across it.
  check('the atlas samples uv1, not the albedo UVs', texture.channel === 1, String(texture.channel))

  // Materials are shared across a scene; a shared one carrying a lightmap
  // would light every other mesh with it.
  const second = meshesOf(g)[1].material as THREE.MeshStandardMaterial
  check('each mesh gets its own material instance', first !== second)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
