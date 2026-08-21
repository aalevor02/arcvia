/**
 * Generate the Python catalogue dimension table from the TypeScript catalogue.
 *
 * ── Why generate rather than hand-write ──────────────────────────────────────
 * The reconstruction engine classifies an unnamed footprint by matching its
 * measured size against the catalogue: a 1.8 x 0.9 m box in a bedroom is a bed
 * because `bed-queen` is 1.8 x 0.9 m. That only works while the two agree.
 *
 * Hand-copying 44 items into Python guarantees they drift — someone widens a
 * sofa in `items.ts`, nothing breaks, and the classifier quietly starts calling
 * it something else. Generating means a change to the catalogue either shows up
 * here as a reviewable diff or fails the parity test.
 *
 * esbuild is already a Vite dependency, and `apps/studio/test/run.mjs` uses the
 * same bundle-then-import trick, so this adds no new tooling.
 *
 *   node tools/cad-engine/gen-catalogue-dims.mjs
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = join(ROOT, 'apps/studio/src/catalogue/items.ts')
const OUT = join(ROOT, 'services/reconstruct/classify/catalogue_dims.py')

const dir = await mkdtemp(join(tmpdir(), 'arcvia-cat-'))
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

const rows = CATALOGUE.map((item) => ({
  id: item.id,
  category: item.category,
  placement: item.placement,
  w: item.size.width,
  d: item.size.depth,
  h: item.size.height,
  mount: item.mountHeight ?? null,
}))

const py = `# GENERATED — do not edit.
#
# Source: apps/studio/src/catalogue/items.ts
# Regenerate: node tools/cad-engine/gen-catalogue-dims.mjs
#
# The dimension table the footprint classifier matches against. Metres.
# \`w\` is width across the front, \`d\` is depth away from the wall, \`h\` is height.
# \`placement\` decides what a match even means: a 'wall' item hangs on a wall
# face and can never be a free-standing footprint, and an 'in-wall' item is an
# opening rather than an object.

CATALOGUE_DIMS: dict[str, dict] = {
${rows
  .map(
    (r) =>
      `    ${JSON.stringify(r.id)}: {"category": ${JSON.stringify(r.category)}, ` +
      `"placement": ${JSON.stringify(r.placement)}, ` +
      `"w": ${r.w}, "d": ${r.d}, "h": ${r.h}, "mount": ${r.mount === null ? 'None' : r.mount}},`,
  )
  .join('\n')}
}

#: Items that occupy a hole through a wall rather than standing in a room.
IN_WALL = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "in-wall"}

#: Items that hang on a wall face — a TV, a painting, a mirror. These have a
#: footprint on the drawing but no floor area, which is why they are separated:
#: matching one as a free-standing object puts a television on the carpet.
WALL_MOUNTED = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "wall"}

#: Everything that genuinely stands on the floor and can be matched by footprint.
FLOOR_STANDING = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "floor"}
`

await writeFile(OUT, py, 'utf8')
await rm(dir, { recursive: true, force: true })

const byPlacement = rows.reduce((acc, r) => ((acc[r.placement] = (acc[r.placement] ?? 0) + 1), acc), {})
console.log(`wrote ${OUT}`)
console.log(`  ${rows.length} items:`, byPlacement)
