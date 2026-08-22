#!/usr/bin/env node
/**
 * Bind the studio's surfaces to the shared asset hub.
 *
 *   node tools/asset-ingest/materials.mjs --report   # what is selected
 *   node tools/asset-ingest/materials.mjs            # condition and generate
 *   node tools/asset-ingest/materials.mjs --checks   # also write the scale sheet
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * `plan/materials.ts` draws every surface with a canvas. That was the right
 * call when it was written and its reasoning still holds — the maps cost
 * nothing, need no network, and a generated floor beats a grey one by a mile.
 * What it cannot do is look photographed, and 856 CC0 PBR materials have been
 * sitting in the hub unused the whole time.
 *
 * ── Why this ADDS to the procedural maps rather than replacing them ─────────
 * Three tiers, exactly as `catalogue/models.ts` does it:
 *
 *   1. no DOM (the Node test suite)   flat colours
 *   2. DOM, nothing loaded yet        procedural canvas maps, instantly
 *   3. real maps arrive               swapped in
 *
 * The procedural tier is not a placeholder to be deleted. It is what the
 * headless geometry tests run against, what renders on the first frame, and
 * what a surface falls back to when a download fails. Deleting it would make
 * the geometry untestable without a browser, which is a bad trade for some
 * bytes.
 *
 * `surface(kind)` already returns ONE cached material per kind, shared by every
 * mesh. So the upgrade is: load three maps, assign them to that same instance,
 * set needsUpdate. Every wall in the scene upgrades at once and no caller
 * changes.
 *
 * ── Eight keys, not 856 materials ───────────────────────────────────────────
 * The studio has eleven surface kinds. `glass`, `plant` and `white` are
 * deliberately not here: glass is a shader property rather than a photograph,
 * and the other two are flat tints doing a job a texture would only get in the
 * way of. Eight real materials at 512 is about 1 MB, against 11 MB for the
 * furniture already committed.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HUB = process.env.ASSET_HUB ?? 'A:/Assets/Hub'

const OUT_DIR = join(ROOT, 'apps/studio/public/surfaces')
const PUBLIC_PREFIX = '/surfaces'
const MODULE = join(ROOT, 'apps/studio/src/catalogue/surfaces.ts')

/** Where the scale proofs go. Not shipped — evidence for `tileMetres`. */
const CHECK_DIR = join(ROOT, '.data/surface-scale')

/**
 * Map resolution. Matches `plan/materials.ts`'s own `SIZE = 512`, so a real map
 * arrives at the resolution the sampling was designed around.
 */
const SIZE = 512

/**
 * The surfaces, the material behind each, and how big one tile really is.
 *
 * ── Why `tileMetres` is hand-set, and cannot not be ─────────────────────────
 * ambientCG's API declares `dimensionX/Y/Z` and leaves them at zero. Sampled
 * across fifteen materials spanning every family used here — Planks, WoodFloor,
 * Tiles, Concrete, Carpet, Marble, Bricks, Plaster, Metal, Fabric, Rock,
 * Ground, Terrazzo, Wood, PaintedPlaster — **none** had a non-zero size. The
 * field exists and is never written, which is the same shape as `hdriUrl`
 * before it was given a producer.
 *
 * Two attempts to derive it from the image are recorded in
 * condition_material.py and both failed. So it is one number per material, set
 * by eye against a metre rule, exactly as `AssetModel.yaw` is and for exactly
 * the same reason: guessing badly is worse than asking once.
 *
 * `--checks` writes the proof. Every number below was set from it, and the
 * reasoning is on the row.
 */
const SURFACES = [
  {
    id: 'floor-wood',
    slug: 'WoodFloor007',
    name: 'Oak boards',
    // At 2 m a metre spans about six and a half boards, so a board is roughly
    // 150 mm — standard laminate width. At 1.2 m they come out at 91 mm, which
    // is narrow strip flooring and reads wrong under furniture sized in metres.
    tileMetres: 2.0,
    note: 'Warm mid-oak, running bond.',
  },
  {
    id: 'floor-tile',
    slug: 'Tiles010',
    name: 'Grey floor tile',
    // Two tiles across and three down, so 2 m gives roughly 1000 x 660 mm units
    // — large-format porcelain, which is what is actually laid in new build.
    //
    // This slot first held Tiles045, picked from ambientCG's lit sphere
    // preview, where it read as clean mid-grey. Its albedo is nearly black and
    // its units are 100 mm mosaic. The preview is a render with its own
    // lighting; the albedo is what the studio actually samples. Screen on the
    // albedo, not the preview.
    tileMetres: 2.0,
    note: 'Large-format grey porcelain, running bond.',
  },
  {
    id: 'wall',
    slug: 'Plaster001',
    name: 'Plaster',
    // No features to scale against, so the number only controls how fine the
    // stipple reads. Two metres keeps it below the eye's notice at room
    // distance, which is what plaster does.
    tileMetres: 2.0,
    note: 'Clean off-white plaster.',
  },
  {
    id: 'ceiling',
    slug: 'Plaster001',
    name: 'Plaster ceiling',
    // Deliberately the same material as `wall`: a ceiling is the same stuff,
    // and the studio already tints them differently. One download, two surfaces.
    tileMetres: 2.0,
    note: 'The same plaster, tinted lighter.',
  },
  {
    id: 'fabric',
    slug: 'Fabric030',
    name: 'Woven upholstery',
    // A weave is a few millimetres. Half a metre per tile puts the thread at
    // about 1 mm, which is at the edge of visible and correct.
    tileMetres: 0.5,
    note: 'Grey woven upholstery.',
  },
  {
    id: 'wood',
    slug: 'Wood005',
    name: 'Oak',
    // Furniture timber, seen at arm's length rather than across a room, so the
    // grain wants to be finer than the floor's.
    //
    // Wood023 was here first and came out strongly orange with grain stretched
    // to the width of a wardrobe door. Both only visible against a metre rule.
    tileMetres: 1.0,
    note: 'Warm timber for furniture bodies.',
  },
  {
    id: 'stone',
    slug: 'Marble016',
    name: 'Marble',
    // Veining is metres-scale in reality; a small tile turns it into noise and
    // gives away the repeat immediately.
    //
    // Marble006 was here first and is speckled granite wearing the name. The
    // hub's names come from its source and describe a family, not a look.
    tileMetres: 2.0,
    note: 'Dark marble with white veining, for counters and sills.',
  },
  {
    id: 'paving',
    slug: 'PavingStones126A',
    name: 'Paving',
    // Linear plank pavers, roughly three units across and four courses down the
    // map. At 2 m that is about 660 x 500 mm — large-format paving, which is
    // what is actually laid on a terrace.
    tileMetres: 2.0,
    note: 'Grey linear pavers for a terrace or a pool surround.',
  },
  {
    id: 'metal',
    slug: 'Metal010',
    name: 'Brushed steel',
    // Brush lines are sub-millimetre. This is as coarse as it can go before
    // they read as scratches.
    tileMetres: 0.5,
    note: 'Brushed steel for appliances and fixtures.',
  },
]

/**
 * Surface kinds that stay procedural, and why.
 *
 * Written down rather than left as an absence, because "there is no marble
 * texture for glass" and "nobody got round to glass" look identical in a
 * generated file, and only one of them is a decision.
 */
const PROCEDURAL = {
  water: 'What makes water read as water is seeing THROUGH it to a floor that is the wrong colour and the wrong distance away. A photograph of water is a photograph of whatever was under it, pinned flat.',
  grass: 'The hub has no grass — its texture harvest was filtered to interiors, the same decision that left it with 301 indoor HDRIs and no skies. A photographed lawn is the better answer and is one `hub.mjs fetch ambientcg:Grass###` away; the procedural turf is the honest stand-in until someone takes it.',
  glass: 'Transparency, IOR and near-zero roughness are shader properties. A photograph of glass is a photograph of whatever was behind it.',
  plant: 'Foliage colour varies per placement and the model carries its own leaves.',
  white: 'A flat tint, deliberately. A texture here would only add noise to the one surface meant to have none.',
}

// ---- Arguments ---------------------------------------------------------------

const flags = {}
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) continue
  const next = process.argv[i + 1]
  flags[arg.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || stdout)),
    )
  })
}

// ---- The hub -----------------------------------------------------------------

const manifest = JSON.parse(await readFile(join(HUB, 'manifest.json'), 'utf8'))
const byName = new Map(
  manifest.assets.filter((a) => a.kind === 'material').map((a) => [a.name, a]),
)

console.log(`\n  ${SURFACES.length} surfaces selected`)
console.log(`  hub: ${byName.size} materials at ${HUB}\n`)

const rows = []
for (const surface of SURFACES) {
  const asset = byName.get(surface.slug)
  const directory = asset ? join(HUB, asset.path) : null
  const ready = Boolean(directory && existsSync(directory))
  rows.push({ ...surface, asset, directory, ready })
  console.log(
    `  ${surface.id.padEnd(12)} ${surface.slug.padEnd(16)} ${String(surface.tileMetres).padStart(4)} m  ` +
      (ready ? 'ready' : 'NOT IN HUB'),
  )
}

const missing = rows.filter((row) => !row.ready)
if (missing.length > 0) {
  console.log(`\n  ${missing.length} missing. Fetch with:\n`)
  for (const row of missing) {
    console.log(`    node hub.mjs fetch ambientcg:${row.slug} --out ${HUB} --res 1K`)
  }
}

if (flags.report) {
  console.log('\n  Report only. Re-run without --report to condition and generate.\n')
  process.exit(0)
}

const ready = rows.filter((row) => row.ready)
if (ready.length === 0) {
  console.error('\n  Nothing to condition. Module not written.\n')
  process.exit(1)
}

// ---- Condition ---------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true })
if (flags.checks) await mkdir(CHECK_DIR, { recursive: true })

const python = process.env.PYTHON ?? 'python'
const conditioner = join(ROOT, 'tools/asset-ingest/condition_material.py')

console.log(`\n  conditioning ${ready.length} materials at ${SIZE}px\n`)

const written = []
for (const row of ready) {
  process.stdout.write(`    ${row.id.padEnd(12)} `)
  try {
    const stdout = await run(python, [
      conditioner,
      '--input', row.directory,
      '--out', OUT_DIR,
      '--id', row.id,
      '--size', String(SIZE),
      '--tile-metres', String(row.tileMetres),
      ...(flags.checks ? ['--check-dir', CHECK_DIR] : []),
    ])

    const line = stdout.split('\n').find((l) => l.startsWith('ARCVIA_MATERIAL:'))
    if (!line) throw new Error('conditioning produced no report')
    const report = JSON.parse(line.slice('ARCVIA_MATERIAL:'.length))

    const saved = 1 - report.bytes / report.sourceBytes
    console.log(
      `${String(Math.round(report.bytes / 1024)).padStart(4)} KB  ` +
        `(${(saved * 100).toFixed(0)}% smaller)  normals ${report.normalConvention}`,
    )
    written.push({ ...row, report })
  } catch (error) {
    // Named, never swallowed. A surface that failed to condition falls back to
    // its procedural map, which is correct and also invisible — so the run has
    // to say so or the list silently shrinks.
    console.log('FAILED')
    console.error(`      ${String(error.message).split('\n').slice(0, 3).join('\n      ')}`)
  }
}

if (written.length === 0) {
  console.error('\n  Every material failed. Module not written.\n')
  process.exit(1)
}

// ---- Generate ----------------------------------------------------------------

const quote = (value) => JSON.stringify(value)

const entries = written.map((row) => {
  const authors = row.asset.authors?.join(', ') || 'ambientCG'
  return `  {
    id: ${quote(row.id)},
    name: ${quote(row.name)},
    note: ${quote(row.note)},
    tileMetres: ${row.tileMetres},
    map: ${quote(`${PUBLIC_PREFIX}/${row.id}-color.jpg`)},
    roughnessMap: ${quote(`${PUBLIC_PREFIX}/${row.id}-roughness.jpg`)},
    normalMap: ${quote(`${PUBLIC_PREFIX}/${row.id}-normal.jpg`)},
    licence: ${quote(row.asset.licenceName)},
    author: ${quote(authors)},
    source: ${quote(row.asset.sourceUrl)},
  },`
})

const totalBytes = written.reduce((sum, row) => sum + row.report.bytes, 0)

const module = `// Generated by tools/asset-ingest/materials.mjs — do not edit by hand.
//
// Re-run that script to change this list. Every surface here, the material
// behind it and the reason for its tile size are in the SURFACES table at the
// top of it.
//
// ${written.length} surfaces, ${(totalBytes / 1024).toFixed(0)} KB total, all ${SIZE}px.

import type { SurfaceKind } from '../plan/materials'

/**
 * Real photographed maps for one surface kind.
 *
 * ── These do not replace the procedural maps ────────────────────────────────
 * \`plan/materials.ts\` keeps drawing every surface on a canvas, and should. That
 * tier is what the headless geometry tests run against, what renders on the
 * first frame before anything has downloaded, and what a surface falls back to
 * when a map fails to load. This is a fourth tier layered on top, exactly as
 * \`catalogue/models.ts\` layers real GLBs over the parametric shapes.
 *
 * \`surface(kind)\` returns one cached material per kind, shared by every mesh
 * using it, so an upgrade assigns these three maps to that single instance and
 * every wall in the scene changes at once.
 *
 * ── All three maps must share one repeat ────────────────────────────────────
 * They describe the same surface. If the colour tiles at a different rate from
 * the normal, the grain and the relief drift apart across a wall — which looks
 * like nothing in particular and is very hard to trace back. \`materials.ts\`
 * already says this about its own maps; it is no less true of these.
 */
export interface SurfaceMaps {
  id: SurfaceKind
  name: string
  note: string
  /**
   * How much of the world one tile covers, in metres.
   *
   * ── Why this is a stored number and not a property of the image ──────────
   * ambientCG declares \`dimensionX/Y/Z\` in its API and leaves them at zero —
   * none of fifteen sampled materials had a real size — and two attempts to
   * recover the scale from the pixels are recorded as failures in
   * condition_material.py. So it is set by eye against a metre rule, once per
   * material.
   *
   * Set the repeat from this and the surface's real extent, never from a
   * constant: a floor whose planks change size between rooms is instantly
   * wrong, and that is what a fixed repeat produces.
   */
  tileMetres: number
  /** Albedo. sRGB — it is colour and must be decoded. */
  map: string
  /** Linear. Roughness is data; decoding it makes every surface too smooth. */
  roughnessMap: string
  /**
   * Linear, OpenGL convention.
   *
   * ambientCG ships NormalGL and NormalDX, identical but for an inverted green
   * channel. glTF and three.js are OpenGL, so DX is silently wrong: every bump
   * becomes a dent lit from the wrong side, and no summary statistic
   * distinguishes them — measured on one material, the two differ by 58 mean
   * levels in green while their green MEANS are 127.4 and 127.6. The ingest
   * tool refuses to substitute one for the other.
   */
  normalMap: string
  licence: string
  author: string
  source: string
}

export const SURFACE_MAPS: readonly SurfaceMaps[] = [
${entries.join('\n')}
]

export const surfaceMapsFor = (kind: SurfaceKind): SurfaceMaps | undefined =>
  SURFACE_MAPS.find((surface) => surface.id === kind)

/**
 * Surface kinds that stay procedural, and why.
 *
 * Recorded because an absence and a decision look identical in a generated
 * file, and only one of them should survive review.
 */
export const PROCEDURAL_SURFACES: Readonly<Record<string, string>> = {
${Object.entries(PROCEDURAL)
  .map(([id, why]) => `  ${id}: ${quote(why)},`)
  .join('\n')}
}
`

await writeFile(MODULE, module, 'utf8')

// Prune maps for surfaces no longer in the table — the same fault the
// environment generator hit, where renaming one entry left 1.1 MB of orphaned
// binary that nothing referenced and `git add` would have kept forever.
const keep = new Set(
  written.flatMap((row) => ['color', 'roughness', 'normal'].map((m) => `${row.id}-${m}.jpg`)),
)
const orphans = (await readdir(OUT_DIR)).filter((n) => n.endsWith('.jpg') && !keep.has(n))
if (orphans.length > 0) {
  console.log(`\n  removing ${orphans.length} file(s) no longer in the table:`)
  for (const name of orphans) {
    await rm(join(OUT_DIR, name))
    console.log(`    ${name}`)
  }
}

console.log(`\n  wrote ${MODULE}`)
console.log(`  wrote ${written.length * 3} maps to ${OUT_DIR}`)
console.log(`  total ${(totalBytes / 1024).toFixed(0)} KB`)
if (flags.checks) console.log(`  scale proofs in ${CHECK_DIR}`)

const skipped = rows.length - written.length
if (skipped > 0) console.log(`\n  NOTE: ${skipped} of ${rows.length} selected surfaces are NOT in the module.`)
console.log()
