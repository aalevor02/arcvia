/**
 * Measure what fit() actually does to every catalogue model.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * models.ts records an experiment where per-axis fitting was argued for,
 * implemented, and made the catalogue WORSE — and closes with "worth
 * revisiting, but on measurement rather than on the argument alone". This is
 * that measurement, and it must be re-run whenever `fitFootprint` is added to
 * an asset: the flag is a claim about data, and claims about data get checked
 * against the data.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * Bundles the REAL fit() and the REAL catalogue with esbuild (a re-typed copy
 * would measure the copy), loads every catalogue GLB, runs fit() twice — as
 * shipped, and with fitFootprint forced off — and reports the fitted plan
 * extents against the slot each run targeted. Two properties are asserted:
 *
 *   1. Assets WITHOUT the flag behave identically to the forced-off run —
 *      the revisit touches nothing it did not name.
 *   2. Assets WITH the flag fill their plan footprint (>= 99% both axes),
 *      which is the entire point of flagging them.
 *
 * Textures are stripped from each GLB before parsing (extents come from
 * geometry; Node has no image decoder and does not need one).
 *
 * Run: node tools/measure-fit.mjs   (from apps/studio)
 */

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const studio = resolve(here, '..')

// ---- Bundle the real code -------------------------------------------------
const bundle = await build({
  stdin: {
    contents: `
      export { fit } from './src/catalogue/models'
      export { CATALOGUE } from './src/catalogue/items'
      export * as THREE from 'three'
      export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
    `,
    resolveDir: studio,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
})
const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
const { fit, CATALOGUE, THREE, GLTFLoader } = await import(moduleUrl)

// ---- GLB texture stripping --------------------------------------------------
// A GLB is: 12-byte header, then chunks (length, type, payload). Chunk 0 is
// JSON, chunk 1 the binary buffer. Removing materials/textures/images from the
// JSON leaves pure geometry, which is all an extent measurement needs.
function stripTextures(glb) {
  const jsonLength = glb.readUInt32LE(12)
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'))

  delete json.materials
  delete json.textures
  delete json.images
  delete json.samplers
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) delete primitive.material
  }

  let text = JSON.stringify(json)
  while (Buffer.byteLength(text) % 4 !== 0) text += ' '
  const jsonBuf = Buffer.from(text, 'utf8')

  const rest = glb.subarray(20 + jsonLength) // remaining chunks, verbatim
  const out = Buffer.alloc(12 + 8 + jsonBuf.length + rest.length)
  glb.copy(out, 0, 0, 12)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  jsonBuf.copy(out, 20)
  rest.copy(out, 20 + jsonBuf.length)
  return out
}

const loader = new GLTFLoader()
const parse = (buffer) =>
  new Promise((resolveParse, rejectParse) =>
    loader.parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      '',
      (gltf) => resolveParse(gltf.scene),
      rejectParse,
    ),
  )

/** The plan-and-height extents fit() produced, in world axes. */
function fitted(prototype, item, footprint) {
  const instance = prototype.clone(true)
  fit(
    instance,
    item.size,
    item.model.upAxis === 'z' ? 'z' : 'y',
    item.model.yaw ?? 0,
    footprint,
  )
  const box = new THREE.Box3().setFromObject(instance)
  const size = box.getSize(new THREE.Vector3())
  return { w: size.x, h: size.y, d: size.z }
}

/** What fit() targets before the later yaw is applied (quarter turns swap). */
function target(item) {
  const quarter = Math.abs(Math.round((item.model.yaw ?? 0) / 90)) % 2 === 1
  return quarter
    ? { w: item.size.depth, d: item.size.width, h: item.size.height }
    : { w: item.size.width, d: item.size.depth, h: item.size.height }
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 100)

let failures = 0
let checkedUnflagged = 0
const rows = []

for (const item of CATALOGUE) {
  if (!item.model?.url) continue
  let raw
  try {
    raw = await readFile(resolve(studio, 'public', '.' + item.model.url))
  } catch {
    rows.push(`  ?  ${item.id}: no local file for ${item.model.url}`)
    continue
  }
  let prototype
  try {
    prototype = await parse(stripTextures(raw))
  } catch (error) {
    rows.push(`  ?  ${item.id}: could not parse (${String(error).slice(0, 60)})`)
    continue
  }

  const want = target(item)
  const shipped = fitted(prototype, item, Boolean(item.model.fitFootprint))
  const uniform = fitted(prototype, item, false)

  if (item.model.fitFootprint) {
    const fillW = pct(shipped.w, want.w)
    const fillD = pct(shipped.d, want.d)
    const beforeW = pct(uniform.w, want.w)
    const beforeD = pct(uniform.d, want.d)
    const okNow = fillW >= 99 && fillD >= 99
    if (!okNow) failures += 1
    rows.push(
      `  ${okNow ? 'OK ' : 'BAD'} ${item.id.padEnd(14)} plan ${beforeW}%x${beforeD}% -> ${fillW}%x${fillD}%  ` +
        `(${uniform.w.toFixed(2)}x${uniform.d.toFixed(2)} -> ${shipped.w.toFixed(2)}x${shipped.d.toFixed(2)} m, ` +
        `slot ${want.w}x${want.d})`,
    )
  } else {
    const same =
      Math.abs(shipped.w - uniform.w) < 1e-9 &&
      Math.abs(shipped.h - uniform.h) < 1e-9 &&
      Math.abs(shipped.d - uniform.d) < 1e-9
    if (!same) {
      failures += 1
      rows.push(`  BAD ${item.id}: unflagged behaviour CHANGED`)
    } else {
      checkedUnflagged += 1
    }
  }
}

console.log('fit() measurement — flagged assets fill their slots, unflagged untouched\n')
for (const row of rows) console.log(row)
console.log(`\n${checkedUnflagged} unflagged assets byte-identical to the uniform fit`)
console.log(failures === 0 ? 'MEASUREMENT CLEAN' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
