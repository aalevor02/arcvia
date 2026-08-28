/**
 * The asset-hub bridge: search, containment, preview policy, refusal paths.
 *
 * No server and no Blender: everything here is the pure half of the module.
 * Conditioning's Blender run is exercised by using the feature; what a test
 * must pin is what gets REFUSED — the oversized scan, the non-model, the
 * path that escapes the hub — because each of those failing open is a 53 MB
 * download or a directory traversal, and both are silent until someone pays.
 *
 * Runs against the real hub when this machine has one, and reports rather
 * than fails when it does not: the hub is a development-machine resource and
 * CI has no A: drive.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NotConditionable,
  conditionedAssetModel,
  conditionModel,
  hubPathOf,
  manifest,
  pickPreview,
  requireTrustworthyScale,
  reusableConditioning,
  search,
} from '../src/lib/assetHub.js'

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

ok('only current, verified scale reports are reusable',
  reusableConditioning({ scale: { ok: true, version: 1 } }))
ok('legacy scale sidecars are regenerated',
  !reusableConditioning({ scale: { ok: true } }) && !reusableConditioning({}))
{
  let refusal = null
  try {
    requireTrustworthyScale({ ok: false, reason: 'ambiguous' }, 'Test sofa')
  } catch (error) {
    refusal = error
  }
  ok('ambiguous authored scale is refused, not silently preserved',
    refusal instanceof NotConditionable && /ambiguous/.test(refusal.message))
}
{
  let refusal = null
  try {
    requireTrustworthyScale({ ok: true, version: 1 }, 'Malformed asset')
  } catch (error) {
    refusal = error
  }
  ok('a success report without a positive factor is refused',
    refusal instanceof NotConditionable)
}

// ---- Containment ------------------------------------------------------------

{
  const model = conditionedAssetModel({
    licence: 'cc-by-4.0',
    licenceName: 'CC Attribution 4.0',
    authors: ['Hub Artist'],
    source: 'polyhaven',
    sourceUrl: 'https://example.com/asset',
  }, {
    triangles: 4800,
    report: { facing: { yaw: 90 }, decimate: { after: 4800 } },
  }, '/hub/conditioned/example--5000.glb')
  ok('conditioned metadata carries server-authored attribution',
    model.author === 'Hub Artist' && model.licence === 'CC Attribution 4.0')
  ok('conditioned metadata carries the facing and web triangle count',
    model.yaw === 90 && model.triangles === 4800 && model.upAxis === 'y')
}

ok('a hub path resolves inside the hub', hubPathOf('models/anything') !== null)
ok('traversal out of the hub is refused', hubPathOf('../secret') === null)
ok('an absolute path is refused', hubPathOf('C:/Windows/system32') === null)

// ---- Preview policy ---------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'hub-preview-'))
  try {
    // A directory holding only channel maps must yield NO preview — a normal
    // map as a thumbnail reads as corruption, which is worse than a blank.
    await writeFile(join(dir, 'Wood_NormalGL.png'), 'x')
    await writeFile(join(dir, 'Wood_Roughness.jpg'), 'x')
    ok('channel maps are never a preview', (await pickPreview(dir)) === null)

    // Add a colour map: acceptable stand-in.
    await writeFile(join(dir, 'Wood_Color.jpg'), 'x')
    ok('a colour map stands in', String(await pickPreview(dir)).includes('Color'))

    // A real preview beats it.
    await writeFile(join(dir, 'Preview.png'), 'x')
    ok('a preview beats a colour map', String(await pickPreview(dir)).includes('Preview'))

    // Nested one level, like Poly Haven's textures/ folder.
    const nested = await mkdtemp(join(tmpdir(), 'hub-nested-'))
    await mkdir(join(nested, 'textures'), { recursive: true })
    await writeFile(join(nested, 'textures', 'sofa_diff_2k.jpg'), 'x')
    ok('nested diffuse maps are found', String(await pickPreview(nested)).includes('diff'))
    await rm(nested, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- Against the real hub, when there is one --------------------------------

const data = await manifest()
if (!data) {
  console.log('SKIP  no hub on this machine — search and refusal paths not exercised')
} else {
  const page = await search({ q: 'chair', kind: 'model', limit: 5 })
  ok('search finds chairs', page.total > 0, `${page.total}`)
  ok('search caps the page', page.assets.length <= 5)
  ok('rows carry the licence', page.assets.every((a) => typeof a.licence === 'string'))
  ok('rows carry a path for previews', page.assets.every((a) => typeof a.path === 'string'))

  const cc0 = await search({ kind: 'model', licence: 'cc0', limit: 1 })
  ok('cc0 filter excludes attribution', cc0.assets.every((a) => !a.attribution))

  // Refusals. Each of these failing open has a real cost.
  const refuse = async (ref, options) => {
    try {
      await conditionModel(ref, options)
      return null
    } catch (error) {
      return error
    }
  }

  const missing = await refuse('polyhaven:this-does-not-exist')
  ok('a missing ref is refused 404', missing instanceof NotConditionable && missing.status === 404)

  const material = data.assets.find((a) => a.kind === 'material')
  if (material) {
    const wrong = await refuse(material.ref)
    ok('a non-model is refused', wrong instanceof NotConditionable, wrong?.message)
  }

  const giant = data.assets.find((a) => a.kind === 'model' && (a.polycount ?? 0) > 600_000)
  if (giant) {
    const heavy = await refuse(giant.ref)
    ok(
      'an unconditionable scan is refused up front',
      heavy instanceof NotConditionable && /triangles/.test(heavy.message),
      giant.ref,
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
