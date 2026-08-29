import { build } from 'esbuild'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Generate the fixture MODEL table the offline renderer places furniture from.
 *
 * ?? The gap this closes ?????????????????????????????????????????????????????
 * `build/solidify.py:build_fixtures` says it plainly: "Boxes, not models ? a
 * correctly *dimensioned* stand-in is what makes clearances checkable, which is
 * the job at this stage. `Definition.meshUrl` is the seam where a real GLB
 * replaces one without anything else changing." The seam was designed and never
 * connected, and the same file notes the reconstruction path "never applies" a
 * GLB.
 *
 * So the reconstruction identifies a block as `bed-queen` at 0.74 confidence,
 * places it, rotates it ? and the render draws a ten-triangle box. Measured on
 * the villa: 21 fixtures resolved to real catalogue ids (bed-king x5,
 * bed-queen x2, wc, hob, sink-unit, plant x2) and `storey0_fixtures` is 120
 * triangles for the lot. Every one of those ids already has a conditioned GLB
 * sitting in `apps/studio/public/models/`.
 *
 * ?? Why a generated JSON and not a direct read of items.ts ??????????????????
 * The renderer is Python inside Blender and cannot import TypeScript, and
 * `classify/catalogue_dims.py` ? the existing generated table ? deliberately
 * carries only geometry, because the classifier matches on SIZE and has no use
 * for a mesh. Widening it would push render concerns into the classifier's
 * table.
 *
 * The same argument as `gen-catalogue-dims.mjs` applies to keeping it
 * generated: hand-copying model paths guarantees drift, and a yaw corrected in
 * `items.ts` that never reaches the renderer puts every bed in the building a
 * quarter turn out with nothing failing.
 *
 * ?? What travels, and why each field has to ?????????????????????????????????
 *   file      the conditioned GLB, relative to apps/studio/public
 *   yaw       degrees to turn the model so its front faces the stand-in's
 *             front. NOT derivable ? `items.ts` documents that one armchair is
 *             modelled facing -Z and the next facing +X, and nothing in a GLB
 *             distinguishes the front of a chair from its back.
 *   upAxis    'z' for models whose proportions only match the catalogue when Z
 *             is up. Also recorded per item and not inferable.
 *   size      the catalogue's own dimensions, so the renderer can verify what
 *             it loaded is the size it expected rather than trusting the file.
 *
 * Items with no `model` are emitted with `file: null` rather than omitted: the
 * renderer then knows the id is a real catalogue item that simply has no mesh,
 * which is a different thing from an id it does not recognise, and it can keep
 * the dimensioned box for the first case.
 *
 *   node tools/cad-engine/gen-catalogue-models.mjs
 */

const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = join(ROOT, 'apps/studio/src/catalogue/items.ts')
const PUBLIC = join(ROOT, 'apps/studio/public')
const OUT = join(ROOT, 'data/catalogue-models.json')

const dir = await mkdtemp(join(tmpdir(), 'arcvia-models-'))
const bundle = join(dir, 'items.mjs')

await build({
  entryPoints: [ENTRY],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})

const { CATALOGUE } = await import(pathToFileURL(bundle).href)

const items = {}
let withMesh = 0
const missing = []

for (const item of CATALOGUE) {
  const url = item.model?.url ?? null
  // `url` is a served path ("/models/bed-queen.glb"); the file lives under
  // apps/studio/public. Resolve it here so a catalogue entry pointing at a
  // file nobody shipped fails NOW, in a generator with a diff, rather than
  // silently at render time as a missing bed.
  let file = null
  if (url) {
    const onDisk = join(PUBLIC, url.replace(/^\//, ''))
    const found = await stat(onDisk).then((s) => s.isFile()).catch(() => false)
    if (found) {
      file = url
      withMesh++
    } else {
      missing.push(`${item.id} -> ${url}`)
    }
  }

  items[item.id] = {
    file,
    yaw: item.model?.yaw ?? 0,
    upAxis: item.model?.upAxis ?? null,
    // "This item's three dimensions all carry information", so each informed
    // axis meets its own target instead of sharing one uniform ratio. Set on
    // beds because a king already at the catalogue's 0.6 m height cannot grow
    // into a 1.83 m width under a uniform scale ? it drew as a single.
    fitFootprint: item.model?.fitFootprint ?? false,
    placement: item.placement,
    mountHeight: item.mountHeight ?? null,
    size: { w: item.size.width, d: item.size.depth, h: item.size.height },
  }
}

await mkdir(resolve(OUT, '..'), { recursive: true })
await writeFile(
  OUT,
  JSON.stringify(
    {
      _generated: 'node tools/cad-engine/gen-catalogue-models.mjs',
      _source: 'apps/studio/src/catalogue/items.ts',
      _note:
        'Fixture meshes for the offline renderer. `file` is null for a real ' +
        'catalogue item that has no GLB ? keep the dimensioned box for those.',
      items,
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
await rm(dir, { recursive: true, force: true })

console.log(`wrote ${OUT}`)
console.log(`  ${Object.keys(items).length} catalogue items, ${withMesh} with a mesh`)
if (missing.length) {
  // Loud, and non-zero exit: a catalogue entry naming a GLB that is not there
  // is a broken promise to the renderer, and the render's own symptom for it
  // is an object that is simply absent from the picture.
  console.error(`\n  ${missing.length} entr(y/ies) name a model that is NOT on disk:`)
  for (const m of missing) console.error(`    ${m}`)
  process.exit(1)
}
