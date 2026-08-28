import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BANDS,
  bandFor,
  inferScale,
  measureGltf,
  measureModel,
  resolve,
  scaleOf,
} from './scale.mjs'

/**
 * Scale inference.
 *
 * The failure this guards against has no error and no log line: an asset that
 * is simply the wrong size in a client's room. Nothing downstream can catch it
 * — the conditioner will happily scale a 100x model, the renderer will render
 * it, and the walkthrough will publish it. So it is caught here.
 *
 *   node tools/asset-ingest/scale.test.mjs
 */

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// ---------------------------------------------------------------------------
// Measuring: node transforms
// ---------------------------------------------------------------------------

/** A one-unit cube, optionally under a node that transforms it. */
const cubeDoc = (node = {}) => ({
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, ...node }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
})

{
  const m = measureGltf(cubeDoc())
  ok('unit cube measures 1x1x1', m.x === 1 && m.y === 1 && m.z === 1)
}

{
  // The case the module exists for: the exporter put the unit conversion on the
  // node, not in the vertices. Reading accessor bounds alone reports 1.
  const m = measureGltf(cubeDoc({ scale: [100, 100, 100] }))
  ok('node scale is applied', m.x === 100, `got ${m.x}`)
}

{
  // A 90 degree turn about Z. The box is symmetric so the extent is unchanged,
  // but transforming only min/max instead of all eight corners collapses it.
  const s = Math.SQRT1_2
  const m = measureGltf(cubeDoc({ rotation: [0, 0, s, s] }))
  const near = (a, b) => Math.abs(a - b) < 1e-9
  ok('rotation keeps extent positive', near(m.x, 1) && near(m.y, 1) && near(m.z, 1),
    `got ${m.x.toFixed(3)} x ${m.y.toFixed(3)} x ${m.z.toFixed(3)}`)
}

{
  // Nested scale must compound, not overwrite.
  const doc = {
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { children: [1], scale: [10, 10, 10] },
      { mesh: 0, scale: [10, 10, 10] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
  }
  ok('nested scales compound', measureGltf(doc).x === 100, `got ${measureGltf(doc).x}`)
}

{
  const doc = cubeDoc()
  delete doc.accessors[0].min
  delete doc.accessors[0].max
  ok('accessors without bounds measure null', measureGltf(doc) === null)
}

ok('empty document measures null', measureGltf({ scenes: [{ nodes: [] }] }) === null)

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

ok('sofa matches sofa', bandFor('Grey Sofa 3 Seat')?.category === 'sofa')
ok('name is case insensitive', bandFor('WARDROBE')?.category === 'wardrobe')
ok('hyphens separate words', bandFor('thebasemesh-deck-chair')?.category === 'chair')
ok('underscores separate words', bandFor('flower_pot_01')?.category === 'planter')
ok('unmatched name has no band', bandFor('gribble') === null)

// The word-boundary rule. Both of these would fire on a naive substring match.
ok('"unit" does not fire inside "united"', bandFor('united nations flag') === null)
ok('"tv" does not fire inside "tvorba"', bandFor('tvorba') === null)
ok('"tv" fires on its own', bandFor('tv stand')?.category === 'tv')
ok('hub naming calls washers "washing machine"',
  bandFor('Washing Machine')?.category === 'appliance')

{
  // Specific before general: an armchair must not be read as a chair, because
  // the chair band reaches down to 0.3 m and would accept a doll's armchair.
  ok('armchair beats chair', bandFor('leather armchair')?.category === 'armchair')
  const armchair = BANDS.findIndex((b) => b.category === 'armchair')
  const chair = BANDS.findIndex((b) => b.category === 'chair')
  ok('armchair band is ordered before chair', armchair < chair, `${armchair} < ${chair}`)
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

{
  // A sofa authored in centimetres: 210 units long. Metres would be a 210 m
  // sofa, millimetres a 21 cm one; only centimetres is a sofa.
  const r = inferScale('sofa', { x: 210, y: 90, z: 82 })
  ok('centimetre sofa reads as cm', r.ok && r.unit === 'cm', r.unit ?? r.reason)
  ok('centimetre sofa exposes the uniform factor',
    r.ok && r.factor === 0.01, String(r.factor))}

{
  const r = inferScale('sofa', { x: 2.1, y: 0.9, z: 0.82 })
  ok('metre sofa reads as m', r.ok && r.unit === 'm', r.unit ?? r.reason)
}

{
  const r = inferScale('sofa', { x: 2100, y: 900, z: 820 })
  ok('millimetre sofa reads as mm', r.ok && r.unit === 'mm', r.unit ?? r.reason)
}

{
  // Nothing plausible: a sofa a tenth of a millimetre across.
  const r = inferScale('sofa', { x: 0.0001, y: 0.0001, z: 0.0001 })
  ok('implausible size is refused', !r.ok && r.reason === 'no-plausible-unit', r.reason)
}

{
  // Two readings both land in the tree band (0.2–14 m): 100 cm and 100 in.
  const r = inferScale('tree', { x: 100, y: 100, z: 100 })
  ok('ambiguous size is refused', !r.ok && r.reason === 'ambiguous', r.reason)
  ok('ambiguity reports what competed', (r.considered ?? []).length === 2,
    (r.considered ?? []).join('/'))
}

{
  const r = inferScale('gribble', { x: 1, y: 1, z: 1 })
  ok('unknown kind is refused', !r.ok && r.reason === 'unknown-kind', r.reason)
}

ok('unmeasurable input is refused', inferScale('sofa', null).reason === 'unmeasurable')
ok('degenerate input is refused',
  inferScale('sofa', { x: 0, y: 0, z: 0 }).reason === 'degenerate')

{
  // The contract that matters most: a refusal must never carry metres, or a
  // caller reading `.metres` without checking `.ok` would place it anyway.
  const refusals = [
    inferScale('sofa', null),
    inferScale('sofa', { x: 0, y: 0, z: 0 }),
    inferScale('gribble', { x: 1, y: 1, z: 1 }),
    inferScale('tree', { x: 100, y: 100, z: 100 }),
    inferScale('sofa', { x: 0.0001, y: 0.0001, z: 0.0001 }),
  ]
  ok('no refusal carries a size', refusals.every((r) => r.metres === undefined))
  ok('no refusal claims ok', refusals.every((r) => r.ok === false))
}

// ---------------------------------------------------------------------------
// The policy hook
// ---------------------------------------------------------------------------

ok('resolve picks a lone candidate', resolve([{ unit: 'm' }]).pick.unit === 'm')
ok('resolve refuses none', resolve([]).pick === null)
ok('resolve refuses several', resolve([{ unit: 'm' }, { unit: 'in' }]).pick === null)

// ---------------------------------------------------------------------------
// Against real conditioned assets
// ---------------------------------------------------------------------------

{
  const dir = '../../services/api/.data/hub-conditioned'
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
  const real = join(here, dir)

  const files = await readdir(real).catch(() => [])
  const models = files.filter((f) => f.endsWith('.glb'))

  if (models.length === 0) {
    console.log('SKIP  no conditioned assets on disk to check')
  } else {
    for (const file of models) {
      const measured = await measureModel(join(real, file))
      // The ref carries the name: "thebasemesh-deck-chair--5000.glb".
      const name = file.replace(/--\d+\.glb$/, '').replace(/^[a-z]+-/, '')
      const r = await scaleOf(join(real, file), name)
      const extent = measured
        ? `${measured.x.toFixed(2)}x${measured.y.toFixed(2)}x${measured.z.toFixed(2)}`
        : 'unmeasurable'
      ok(
        `real asset ${name} resolves`,
        r.ok,
        `raw ${extent} -> ${r.ok ? `${r.unit}, factor ${r.factor}` : r.reason}`,
      )
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
