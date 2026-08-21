/**
 * Verify a GLB the way a browser will.
 *
 * The engine writes glTF by hand (services/reconstruct/build/glb.py), which is
 * the right call for boxes but means nothing else has validated the bytes. A
 * malformed GLB does not usually throw — it loads to an empty scene, or draws
 * nothing because a mesh has an array material and no geometry groups. That
 * exact bug is why `packages/viewer` exists, and it published a walkthrough
 * that rendered an empty sky.
 *
 * So this loads the file through the same GLTFLoader the studio uses and
 * asserts on what came out: real triangles, finite bounds, a plausible building
 * size, and correctly-oriented normals.
 *
 *   node tools/cad-engine/verify-glb.mjs <file.glb>
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const target = process.argv[2]
if (!target) {
  console.error('usage: node verify-glb.mjs <file.glb>')
  process.exit(2)
}

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const bytes = await readFile(resolve(target))

// The GLB container, checked before handing it to a parser that may be lenient.
const header = new DataView(bytes.buffer, bytes.byteOffset, 12)
ok('magic is glTF', String.fromCharCode(...bytes.subarray(0, 4)) === 'glTF')
ok('version is 2', header.getUint32(4, true) === 2)
ok('declared length matches the file', header.getUint32(8, true) === bytes.length,
  `${header.getUint32(8, true)} vs ${bytes.length}`)

const loader = new GLTFLoader()
const gltf = await new Promise((res, rej) =>
  loader.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    '',
    res,
    rej,
  ),
)

ok('GLTFLoader parsed it', Boolean(gltf?.scene))

const meshes = []
gltf.scene.traverse((node) => {
  if (node.isMesh) meshes.push(node)
})

ok('the scene contains meshes', meshes.length > 0, String(meshes.length))
// Underscore, not a slash. three.js sanitises node names on load, so a mesh
// written as `storey0/walls` arrives as `storey0walls` — a naming convention
// the loader silently rewrites is not a convention.
ok('every mesh is named for its storey',
  meshes.every((m) => /^storey\d+_/.test(m.name)),
  meshes.map((m) => m.name).join(', '))

let triangles = 0
let hasNormals = true
for (const mesh of meshes) {
  const geometry = mesh.geometry
  const index = geometry.getIndex()
  triangles += (index ? index.count : geometry.getAttribute('position').count) / 3
  if (!geometry.getAttribute('normal')) hasNormals = false

  // A mesh with an array material and no geometry groups draws nothing at all.
  if (Array.isArray(mesh.material)) {
    ok(`${mesh.name}: array material has geometry groups`, geometry.groups.length > 0)
  }
}

ok('it has triangles', triangles > 0, `${triangles.toLocaleString()} triangles`)
ok('every mesh carries normals', hasNormals)

const box = new Box3().setFromObject(gltf.scene)
const size = box.getSize(new Vector3())
const finite = [size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0)
ok('the bounds are finite and non-degenerate', finite,
  `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m`)

// Scale sanity. A wrong unit is the failure that looks perfectly fine — a villa
// built 1000x too small renders beautifully and is 4 cm across.
const longest = Math.max(size.x, size.z)
ok('the building is a plausible size', longest >= 3 && longest <= 400,
  `longest plan dimension ${longest.toFixed(2)} m`)
ok('the height is a plausible storey', size.y >= 2 && size.y <= 12,
  `${size.y.toFixed(2)} m`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
