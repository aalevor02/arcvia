#!/usr/bin/env node
/**
 * Bind the catalogue to the shared asset hub.
 *
 *   node tools/asset-ingest/from-hub.mjs --report          # what would match
 *   node tools/asset-ingest/from-hub.mjs --only rug,shower # ingest those
 *   node tools/asset-ingest/from-hub.mjs                   # everything missing
 *
 * ── Why matching is the hard part ──────────────────────────────────────────
 * The hub holds three hundred CC0 models and the catalogue has forty-six slots.
 * Filling a slot is trivial; filling it with the *right* model is the entire
 * job, and a wrong pick is expensive in a way a missing one is not — a missing
 * model falls back to the parametric shape, which is honest, while a wrong one
 * silently puts a barber's chair in a dining room and nobody notices until a
 * client does.
 *
 * So candidates are scored rather than taken in name order, on the two things
 * that actually predict a good fit:
 *
 *   what it is    the words in its name and tags, against words that mean this
 *                 slot — and against words that mean it is something else
 *   what size     the catalogue knows the real dimensions; a model whose own
 *                 dimensions are three times that is a different object with a
 *                 similar name
 *
 * Nothing is ingested below a minimum score. An empty slot is a better outcome
 * than a confident wrong one.
 */

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LICENCES } from './licence.mjs'

const execFileAsync = promisify(execFile)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HUB = process.env.ASSET_HUB ?? 'A:/Assets/Hub'

/**
 * What each catalogue slot means, in words a model's name might use.
 *
 * `want` are the words that identify it. `avoid` are the words that mean a
 * model is a different thing wearing a similar name, and they matter more than
 * `want` does: searching "table" without excluding "coffee" and "console"
 * returns three kinds of table for every dining table, and the top result is a
 * coin toss.
 *
 * Written by hand rather than derived from the catalogue name, because this is
 * the one place where knowing what a thing is called is worth more than any
 * rule. "wc" matches nothing; "commode toilet" matches the fixture.
 */
const VOCABULARY = {
  'sofa-3': { want: ['sofa', 'couch', 'settee'], avoid: ['chair', 'arm chair', 'bed'] },
  'sofa-2': { want: ['loveseat', 'sofa', 'couch'], avoid: ['chair', 'bed'] },
  armchair: { want: ['armchair', 'arm chair', 'lounge chair'], avoid: ['sofa', 'office', 'barber'] },
  'dining-chair': { want: ['chair', 'dining chair'], avoid: ['arm', 'sofa', 'office', 'barber', 'wheel'] },
  bench: { want: ['bench'], avoid: ['work bench', 'workbench'] },
  'dining-table-6': { want: ['dining table', 'table'], avoid: ['coffee', 'side', 'bedside', 'console', 'pool', 'work'] },
  'dining-table-4': { want: ['dining table', 'table'], avoid: ['coffee', 'side', 'bedside', 'console', 'pool', 'work'] },
  'coffee-table': { want: ['coffee table'], avoid: ['dining', 'side'] },
  'side-table': { want: ['side table', 'end table', 'nightstand', 'console'], avoid: ['dining', 'coffee'] },
  desk: { want: ['desk', 'writing table'], avoid: ['reception'] },
  'bed-king': { want: ['bed'], avoid: ['bedside', 'nightstand', 'dog', 'flower'] },
  'bed-queen': { want: ['bed'], avoid: ['bedside', 'nightstand', 'dog', 'flower'] },
  'bed-single': { want: ['bed', 'single bed'], avoid: ['bedside', 'nightstand', 'dog'] },
  bedside: { want: ['nightstand', 'bedside'], avoid: [] },
  wardrobe: { want: ['wardrobe', 'armoire', 'closet', 'cabinet'], avoid: ['kitchen', 'file'] },
  'wardrobe-small': { want: ['wardrobe', 'armoire', 'cabinet'], avoid: ['kitchen'] },
  bookshelf: { want: ['bookshelf', 'book shelf', 'shelf', 'shelving', 'bookcase'], avoid: ['wall shelf'] },
  'tv-unit': { want: ['tv stand', 'media console', 'sideboard', 'credenza', 'console'], avoid: ['gaming', 'game'] },
  chest: { want: ['chest of drawers', 'dresser', 'drawers', 'chest'], avoid: ['tool', 'ice'] },
  counter: { want: ['kitchen counter', 'counter', 'cabinet'], avoid: ['shop', 'reception'] },
  island: { want: ['kitchen island', 'island'], avoid: [] },
  'sink-unit': { want: ['kitchen sink', 'sink'], avoid: ['bathroom', 'basin'] },
  fridge: { want: ['fridge', 'refrigerator'], avoid: ['display'] },
  hob: { want: ['stove', 'cooker', 'hob', 'cooktop'], avoid: ['wood stove'] },
  overhead: { want: ['wall cabinet', 'cupboard', 'cabinet'], avoid: [] },
  wc: { want: ['toilet', 'commode', 'wc'], avoid: ['paper', 'brush'] },
  basin: { want: ['washbasin', 'basin', 'sink'], avoid: ['kitchen'] },
  bathtub: { want: ['bathtub', 'bath tub', 'tub'], avoid: [] },
  shower: { want: ['shower'], avoid: ['curtain'] },
  'ceiling-light': { want: ['ceiling light', 'chandelier', 'lamp'], avoid: ['floor lamp', 'table lamp', 'street'] },
  pendant: { want: ['pendant', 'hanging lamp', 'chandelier'], avoid: ['street'] },
  'wall-light': { want: ['wall lamp', 'sconce', 'wall light'], avoid: [] },
  rug: { want: ['rug', 'carpet'], avoid: [] },
  plant: { want: ['potted plant', 'houseplant', 'plant', 'pot plant'], avoid: ['outdoor', 'tree', 'dead'] },
  // ── Outdoor greenery ──────────────────────────────────────────────────────
  // The garden slots were never in this map, so they never matched and every
  // one fell back to a parametric block — a green box for a tree. The hub is
  // full of real CC0 vegetation (jacaranda, island and pine trees, ferns,
  // planters), it was simply never pointed at these slots. Trees are
  // photogrammetry-scanned and enormous (300k–17M triangles), so conditioning
  // to the catalogue's budget is not optional here; from-hub only matches, the
  // decimation is condition_asset.py's job.
  // Matching is substring-based, and "tree" is a substring of "STREEt" — so
  // street furniture competed for the garden-tree slots, and a cast-iron tree
  // grate once won one outright. Hence avoid 'street'/'grate'/'swirl'/'cart',
  // and multi-word wants like 'fir tree' (the bare want 'fir' is a substring
  // of "fire", which put a fire alarm bell on a shortlist).
  //
  // `anySize` because the size check exists to catch a different object
  // wearing the name — a 2.4 m "side table" is shelving — and for vegetation
  // it cannot do that job: a photogrammetry jacaranda arrives at canopy scale,
  // gets resized to the slot by the conditioner, and is still a correct tree.
  // Every real tree in the hub was losing to junk on exactly this penalty.
  // 'trunk' must NOT be an avoid word here, tempting as it looks for keeping
  // "Dead Tree Trunk" out: avoid runs over tags too, and Poly Haven tags every
  // LIVING tree with "trunk" and "bark" — it is botany, not damage. 'dead'
  // already catches the dead ones by name.
  tree: { want: ['tree', 'jacaranda', 'island tree', 'fir tree', 'pine tree'], avoid: ['dead', 'palm', 'seating', 'street', 'grate', 'swirl', 'cart', 'stump', 'log'], anySize: true },
  'tree-small': { want: ['tree', 'pine tree', 'fir tree', 'sapling'], avoid: ['dead', 'jacaranda', 'street', 'grate', 'swirl', 'cart', 'stump', 'log'], anySize: true },
  shrub: { want: ['shrub', 'bush', 'fern', 'nettle', 'periwinkle', 'plant'], avoid: ['tree', 'potted', 'pot', 'dead', 'flower'] },
  // avoid used to say 'plant' — and 'planter' CONTAINS 'plant', so the word
  // meant to keep potted plants out disqualified every planter it was
  // shopping for. Substring avoid-words must not be substrings of want-words.
  'planter-outdoor': { want: ['planter', 'planter box'], avoid: ['potted plant', 'houseplant', 'flower'] },
  tv: { want: ['television', 'tv', 'monitor'], avoid: ['stand', 'unit'] },
  painting: { want: ['painting', 'picture frame', 'framed', 'artwork'], avoid: [] },
  mirror: { want: ['mirror'], avoid: ['car'] },
  // ── Outdoor living ────────────────────────────────────────────────────────
  // Added when the hub grew from ~300 models to 3,400+ (Poly Pizza and The
  // Base Mesh harvests) — before that, none of these had a plausible candidate
  // and the slots were left out of the map entirely.
  //
  // `outdoor-table` deliberately does NOT want the bare word "table": at 1.8 m
  // it is dining-sized, and a generic want lets every indoor dining table
  // compete for the garden slot on name length alone.
  lounger: { want: ['lounger', 'sun lounger', 'deck chair', 'sunbed', 'chaise', 'pool chair'], avoid: ['sofa', 'office'] },
  parasol: { want: ['parasol', 'umbrella', 'sunshade'], avoid: ['drink', 'cocktail', 'hat'] },
  pergola: { want: ['pergola', 'gazebo', 'arbor', 'arbour'], avoid: ['swing'] },
  fence: { want: ['fence', 'railing', 'picket'], avoid: ['electric', 'defence', 'chain'] },
  'outdoor-table': { want: ['garden table', 'patio table', 'picnic table', 'outdoor table'], avoid: ['coffee', 'side'] },
  'outdoor-chair': { want: ['garden chair', 'patio chair', 'outdoor chair', 'folding chair', 'camping chair'], avoid: ['office', 'lounge'] },
  // NOT mapped, each for a reason rather than an oversight:
  //   hedge            a hedge is a 3 m RUN; every hub "bush" is one plant, and
  //                    stretching a bush to 5:1 looks worse than the parametric
  //                    green volume it would replace
  //   pool, deck,      floor surfaces — their upgrade path is materials.mjs
  //   paving, lawn     (real PBR maps on the parametric geometry), not a model
}

/** Below this, nothing is ingested. An empty slot beats a confident wrong one. */
const MINIMUM_SCORE = 40

/**
 * Slots where the pick is a human decision, not a score.
 *
 * The scorer failed on trees twice, in a way no weight fixes: want-word
 * stacking ('tree' + 'fir tree' + the exact-name bonus = 115 points) buries
 * any polycount penalty, and the winners were scans the conditioner cannot
 * land — 7.8M triangles refused to decimate below 349k (a 53 MB entry) and
 * the 17.4M pine crashed the export. Measured, not predicted.
 *
 * The jacaranda is the one full tree in the hub at an order of magnitude
 * fewer triangles (312k), and it is the right tree for this product's market
 * besides. `tree-small` is pinned to nothing on purpose: every candidate is
 * either a 400k+ scan or stylised low-poly, so the parametric stand-in is the
 * honest option until a better source exists.
 */
const PINNED = {
  tree: 'polyhaven:jacaranda_tree',
  'tree-small': null,
}

// ---- Arguments --------------------------------------------------------------

const flags = {}
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) continue
  const next = process.argv[i + 1]
  flags[arg.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true
}

// ---- Reading both sides ------------------------------------------------------

/**
 * The catalogue, parsed from the TypeScript source.
 *
 * Parsed rather than imported because importing means compiling TypeScript in a
 * script whose whole point is to have no build step. The shape it reads is
 * stable and the failure mode is loud — zero items — rather than subtly wrong.
 */
async function catalogue() {
  const source = await readFile(join(ROOT, 'apps/studio/src/catalogue/items.ts'), 'utf8')
  const items = []

  // `(?:\s*\/\/[^\n]*)*` between fields: entries carry explanatory comments
  // ("A semi-mature garden tree: …") and a pattern that only accepts
  // whitespace silently drops every commented entry. That is how `tree` and
  // `pool` — the two slots somebody cared enough about to annotate — were the
  // two slots this script could not see.
  const pattern =
    /\{\s*id: '([^']+)',\s*name: '([^']+)',\s*category: '([^']+)',\s*placement: '([^']+)',(?:\s*\/\/[^\n]*)*\s*size: \{ width: ([\d.]+), depth: ([\d.]+), height: ([\d.]+) \}/g

  for (const match of source.matchAll(pattern)) {
    const [, id, name, category, placement, width, depth, height] = match
    const start = source.indexOf(`id: '${id}'`)
    const next = source.indexOf('\n  {', start)
    const block = source.slice(start, next < 0 ? source.length : next)

    items.push({
      id,
      name,
      category,
      placement,
      size: { width: +width, depth: +depth, height: +height },
      hasModel: /model:\s*\{/.test(block),
    })
  }
  return items
}

/** What the hub holds, joined to Poly Haven's index for tags and dimensions. */
async function library() {
  const manifest = JSON.parse(await readFile(join(HUB, 'manifest.json'), 'utf8'))
  // Kenney is excluded not for quality but for granularity: a Kenney manifest
  // entry is a whole PACK — one slug unzips to a themed kit of dozens of
  // models — and conditioning a kit into a single .glb produces every fence
  // post, gate and planter in the set fused into one prop. Everything else in
  // the hub is one slug = one object.
  const models = manifest.assets.filter(
    (asset) => asset.kind === 'model' && asset.source !== 'kenney',
  )

  // The manifest records provenance, not description. Tags and real-world
  // dimensions come from the source index, which is one request for all of it.
  let index = []
  try {
    const response = await fetch('https://api.polyhaven.com/assets?t=models')
    const all = await response.json()
    index = Object.entries(all).map(([slug, asset]) => ({
      slug,
      tags: asset.tags ?? [],
      categories: asset.categories ?? [],
      dimensions: asset.dimensions ?? null, // millimetres
    }))
  } catch {
    console.error('  (Poly Haven index unreachable — matching on names only)')
  }

  const bySlug = new Map(index.map((entry) => [entry.slug, entry]))
  return models.map((model) => ({
    ...model,
    slug: model.ref.split(':')[1],
    ...(bySlug.get(model.ref.split(':')[1]) ?? { tags: [], categories: [], dimensions: null }),
  }))
}

// ---- Matching ----------------------------------------------------------------

/**
 * How well one hub model fills one catalogue slot.
 *
 * Returns null when the model is disqualified rather than a low score, because
 * "this is a barber's chair" is not a weak dining chair — it is a different
 * object, and letting it compete on other merits is how it wins.
 */
function score(item, model) {
  const vocabulary = VOCABULARY[item.id]
  if (!vocabulary) return null

  const haystack = [model.name, ...model.tags, ...model.categories].join(' ').toLowerCase()

  for (const word of vocabulary.avoid) {
    if (haystack.includes(word)) return null
  }

  let points = 0
  let matched = false
  for (const word of vocabulary.want) {
    if (!haystack.includes(word)) continue
    matched = true
    // A word in the name is worth far more than the same word in the tags:
    // every seat on the site is tagged "furniture", and only a sofa is *called*
    // one.
    const name = model.name.toLowerCase()
    points += name.includes(word) ? 45 : 12

    // And a model whose name is *only* the thing, give or take a number, beats
    // one that merely contains the word. "Side Table 01" and "Classic
    // Nightstand 01" both match a side table; the first is the plain example of
    // it and the second is a period piece that happens to serve.
    if (name.replace(/[0-9]+/g, '').trim() === word) points += 25
  }
  if (!matched) return null

  // Size. The catalogue knows what the thing really measures, and Poly Haven
  // publishes each model's own dimensions in millimetres — so this compares two
  // real measurements rather than guessing from a name. Slots marked `anySize`
  // opt out — see the vegetation note in VOCABULARY.
  if (model.dimensions && !vocabulary.anySize) {
    // Poly Haven is Z-up, so `dimensions` is [width, depth, height] in
    // millimetres — the vertical is the *third* value.
    //
    // Reading the second as height is the same axis mix-up this codebase
    // already documents for Blender, and it fails the same way: quietly and
    // plausibly. A bookshelf measuring 1.37 x 0.58 x 2.06 read wrongly is 0.58 m
    // tall and 2.8 m² on the floor, so it lost 85 points for being both too
    // short and far too large, and the only genuine bookshelf in the library
    // scored 27 against a threshold of 40. Nothing errored; the slot just came
    // back empty.
    const [width, depth, height] = model.dimensions.map((mm) => mm / 1000)
    const modelFootprint = width * depth
    const slotFootprint = item.size.width * item.size.depth

    if (slotFootprint > 0 && modelFootprint > 0) {
      const ratio = modelFootprint / slotFootprint
      // Within a factor of two either way is the same object drawn a little
      // differently; beyond that it is a different object.
      if (ratio > 4 || ratio < 0.25) points -= 45
      else if (ratio > 2 || ratio < 0.5) points -= 15
      else points += 20
    }

    // Height is the cheapest sanity check there is. A 2.4 m "side table" is a
    // shelving unit, whatever it is called.
    const heightRatio = height / item.size.height
    if (heightRatio > 2.5 || heightRatio < 0.4) points -= 40
  }

  // Triangle budget. A 400,000-triangle sofa loads fine on the machine of the
  // person who ingested it and nowhere else.
  //
  // Graded, not flat. A flat -25 above 150k cannot tell a 312k jacaranda from
  // a 17.4M pine, so the pine won a slot on name points and the conditioner
  // then proved the point the hard way: 7.8M tris refused to decimate below
  // 349k "without destroying the model" — a 53 MB catalogue entry — and the
  // 17.4M one crashed the export outright. Extreme scans are not weak
  // candidates; they are candidates the pipeline cannot land.
  if (model.polycount) {
    if (model.polycount > 5_000_000) points -= 70
    else if (model.polycount > 1_000_000) points -= 45
    else if (model.polycount > 150_000) points -= 25
    else if (model.polycount < 30_000) points += 10
  }

  // Source style. The scorer reads names and sizes; it cannot see that Poly
  // Haven is photogrammetry, The Base Mesh is clean untextured geometry, and
  // Poly Pizza is flat-colour stylised low-poly. In a photoreal walkthrough a
  // shaped grey mesh reads as an unfinished model; a cartoon sofa reads as a
  // broken product. A prior, not a filter — a Poly Pizza sun lounger still
  // wins a slot nothing else matches.
  points += { polyhaven: 15, thebasemesh: 8, sketchfab: 0, polypizza: -10 }[model.source] ?? 0

  return points
}

function best(item, models) {
  const scored = models
    .map((model) => ({ model, points: score(item, model) }))
    .filter((candidate) => candidate.points !== null)
    .sort((a, b) => b.points - a.points)

  return scored.slice(0, 3)
}

// ---- Report ------------------------------------------------------------------

const items = await catalogue()
const models = await library()

console.log(`\n  catalogue: ${items.length} items, ${items.filter((i) => !i.hasModel).length} without a model`)
console.log(`  hub: ${models.length} models at ${HUB}\n`)

const wanted = flags.only
  ? String(flags.only).split(',').map((s) => s.trim())
  : items.filter((item) => !item.hasModel && item.placement !== 'in-wall').map((item) => item.id)

const picks = []
// One model, one slot. Without this, "Fir Tree 01" won `tree` AND
// `tree-small` in the same run — two catalogue entries pointing at the same
// prop, which reads as a bug in the editor even though each pick was
// individually the best. The earlier slot keeps it; the later one falls to
// its runner-up or stays empty, which is what runners-up are for.
const taken = new Set()
for (const id of wanted) {
  const item = items.find((i) => i.id === id)
  if (!item) {
    console.log(`  ${id.padEnd(16)} — not in the catalogue`)
    continue
  }

  if (id in PINNED) {
    const model = models.find((m) => m.ref === PINNED[id])
    if (!model) {
      console.log(`  ${id.padEnd(16)} — pinned ${PINNED[id] ?? 'empty (see PINNED)'}${PINNED[id] ? ', NOT in the hub' : ''}`)
      continue
    }
    taken.add(model.ref)
    console.log(`  ${id.padEnd(16)} -> ${model.name}  (pinned)`)
    picks.push({ item, model, points: null })
    continue
  }

  const candidates = best(item, models)
  const top = candidates.find(
    (candidate) => candidate.points >= MINIMUM_SCORE && !taken.has(candidate.model.ref),
  )

  if (!top) {
    const closest = candidates[0]
    console.log(
      `  ${id.padEnd(16)} — no match above ${MINIMUM_SCORE}` +
        (closest ? ` (best: ${closest.model.name} at ${closest.points}${taken.has(closest.model.ref) ? ', taken' : ''})` : ''),
    )
    continue
  }
  taken.add(top.model.ref)

  const size = top.model.dimensions
    ? top.model.dimensions.map((mm) => (mm / 1000).toFixed(2)).join(' x ')
    : '?'
  console.log(`  ${id.padEnd(16)} -> ${top.model.name}  (${top.points} pts, ${size} m)`)
  for (const runner of candidates.filter((c) => c !== top).slice(0, 2)) {
    console.log(`  ${''.padEnd(16)}    also: ${runner.model.name} (${runner.points})`)
  }
  picks.push({ item, model: top.model, points: top.points })
}

console.log(`\n  ${picks.length} of ${wanted.length} slots matched\n`)

if (flags.report) {
  console.log('  Report only. --ingest conditions the picks and writes catalogue additions;')
  console.log('  the default writes a paste file only.\n')
  process.exit(0)
}

// ---- Ingest -------------------------------------------------------------------

/**
 * Condition the picks and emit catalogue additions, exactly as batch.mjs does
 * for Sketchfab — same conditioner, same additions file, same `apply.mjs` as
 * the reviewed final step. Before this mode existed the hub path ended at a
 * paste file, which is why the interior slots got filled (Sketchfab, automated)
 * while every outdoor slot the hub could serve stayed a parametric block.
 */
if (flags.ingest) {
  // Per item, in triangles after conditioning, matching batch.mjs's scale.
  // Trees are the exception worth naming: photogrammetry scans arrive at
  // 300k-17M triangles, and crushing one to 5,000 leaves mush where the
  // canopy was — they get room, everything else gets the default.
  const BUDGET = { default: 5000, tree: 9000, 'tree-small': 7000, shrub: 3000, plant: 4000 }

  /**
   * The file to condition, from an asset directory that was never told to
   * keep one format. Poly Haven writes `<slug>_2k.gltf` beside its buffers,
   * Poly Pizza and The Base Mesh write a top-level `.glb` — and Base Mesh
   * also ships `.fbx`/`.obj` siblings, so the order is a preference, not a
   * search: binary glTF first, since it is one self-contained file.
   */
  async function modelFile(dir) {
    const entries = await readdir(dir).catch(() => [])
    for (const wanted of ['.glb', '.gltf', '.fbx', '.obj', '.dae']) {
      const found = entries.find((name) => extname(name).toLowerCase() === wanted)
      if (found) return join(dir, found)
    }
    return null
  }

  const blender = process.env.BLENDER_PATH ?? 'blender'
  const outDir = join(ROOT, 'apps/studio/public/models')
  await mkdir(outDir, { recursive: true })

  const entries = []
  const failed = []

  // Sequentially, on purpose — each one spawns Blender, and this machine is
  // also the render worker.
  for (const { item, model } of picks) {
    process.stdout.write(`\n── ${item.id} ← ${model.name} `)

    const source = await modelFile(join(HUB, model.path))
    if (!source) {
      failed.push({ id: item.id, why: `no importable file in ${model.path}` })
      console.log('failed (no model file)')
      continue
    }

    try {
      const { stdout } = await execFileAsync(blender, [
        '-b',
        '--python', join(ROOT, 'services/render-worker/condition_asset.py'),
        '--',
        '--input', source,
        '--output', join(outDir, `${item.id}.glb`),
        '--budget', String(BUDGET[item.id] ?? BUDGET.default),
        '--width', String(item.size.width),
        '--depth', String(item.size.depth),
        '--height', String(item.size.height),
      ], { maxBuffer: 64 * 1024 * 1024 })

      const report = stdout.split('\n').find((l) => l.startsWith('ARCVIA_ASSET:'))
      if (!report) throw new Error('conditioning produced no report')
      const conditioned = JSON.parse(report.slice('ARCVIA_ASSET:'.length))

      for (const warning of stdout.split('\n').filter((l) => l.startsWith('ARCVIA_WARN:'))) {
        console.warn(`\n   warning: ${warning.slice('ARCVIA_WARN:'.length)}`)
      }

      const facing = conditioned.facing ?? { yaw: 0 }
      entries.push([
        item.id,
        {
          model: {
            url: `/models/${item.id}.glb`,
            licence: LICENCES[model.licence]?.name ?? model.licenceName,
            author: model.authors.join(', ') || model.source,
            source: model.sourceUrl,
            triangles: conditioned.decimate.after,
            ...(facing.yaw ? { yaw: facing.yaw } : {}),
          },
        },
      ])
      console.log(
        `ok — ${conditioned.decimate.before.toLocaleString()} → ` +
          `${conditioned.decimate.after.toLocaleString()} tris`,
      )
    } catch (error) {
      const why = String(error.stdout ?? error.message ?? error).split('\n').slice(-4).join(' ')
      failed.push({ id: item.id, why: why.slice(0, 160) })
      console.log('failed')
    }
  }

  // Merged rather than overwritten: a Sketchfab batch and a hub ingest may both
  // be pending, and the additions file is the meeting point apply.mjs reads.
  const additionsPath = join(ROOT, '.data/catalogue-additions.json')
  await mkdir(join(ROOT, '.data'), { recursive: true })
  const existing = JSON.parse(await readFile(additionsPath, 'utf8').catch(() => '{}'))
  await writeFile(
    additionsPath,
    JSON.stringify({ ...existing, ...Object.fromEntries(entries) }, null, 2),
  )

  console.log(`\n\n  ${entries.length} conditioned, ${failed.length} failed`)
  for (const f of failed) console.log(`  fail ${f.id}: ${f.why}`)
  console.log(`  Additions written to ${additionsPath}`)
  console.log('  Review, then: node tools/asset-ingest/apply.mjs\n')
  process.exit(failed.length && !entries.length ? 1 : 0)
}

// ---- Writing ------------------------------------------------------------------

/**
 * Emit the picks as catalogue entries.
 *
 * Written to a file for a person to paste rather than spliced into items.ts
 * automatically. The catalogue is hand-curated source with comments explaining
 * individual choices, and a script that rewrites it would eventually eat one of
 * those comments — a bad trade for saving a paste.
 */
const lines = picks.map(({ item, model, points }) => {
  const relative = `${HUB}/${model.path.replace(/^\.\//, '')}`
  return `  // ${item.id}: matched "${model.name}" from the hub at ${points} points.
  //   ${model.sourceUrl}  ${model.licenceName}
  //   source: ${relative}
  {
    id: '${item.id}',
    model: {
      url: '/models/${item.id}.glb',
      credit: { author: ${JSON.stringify(model.authors.join(', ') || 'Poly Haven')}, licence: 'CC0', url: '${model.sourceUrl}' },
    },
  },`
})

await mkdir(join(ROOT, '.data'), { recursive: true })
await writeFile(join(ROOT, '.data/hub-matches.txt'), lines.join('\n\n') + '\n')
console.log(`  wrote ${join(ROOT, '.data/hub-matches.txt')}`)
console.log('  Condition each source with services/render-worker/condition_asset.py, then paste.\n')
