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
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  tree: { want: ['tree', 'jacaranda', 'island tree'], avoid: ['dead', 'trunk', 'palm', 'seating'] },
  'tree-small': { want: ['tree', 'pine', 'fir', 'sapling'], avoid: ['dead', 'trunk', 'jacaranda'] },
  shrub: { want: ['shrub', 'bush', 'fern', 'nettle', 'periwinkle', 'plant'], avoid: ['tree', 'potted', 'pot', 'dead', 'flower'] },
  'planter-outdoor': { want: ['planter', 'planter box'], avoid: ['plant', 'flower'] },
  tv: { want: ['television', 'tv', 'monitor'], avoid: ['stand', 'unit'] },
  painting: { want: ['painting', 'picture frame', 'framed', 'artwork'], avoid: [] },
  mirror: { want: ['mirror'], avoid: ['car'] },
}

/** Below this, nothing is ingested. An empty slot beats a confident wrong one. */
const MINIMUM_SCORE = 40

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

  const pattern =
    /\{\s*id: '([^']+)',\s*name: '([^']+)',\s*category: '([^']+)',\s*placement: '([^']+)',\s*size: \{ width: ([\d.]+), depth: ([\d.]+), height: ([\d.]+) \}/g

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
  const models = manifest.assets.filter((asset) => asset.kind === 'model')

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
  // real measurements rather than guessing from a name.
  if (model.dimensions) {
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
  if (model.polycount) {
    if (model.polycount > 150_000) points -= 25
    else if (model.polycount < 30_000) points += 10
  }

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
for (const id of wanted) {
  const item = items.find((i) => i.id === id)
  if (!item) {
    console.log(`  ${id.padEnd(16)} — not in the catalogue`)
    continue
  }

  const candidates = best(item, models)
  const top = candidates[0]

  if (!top || top.points < MINIMUM_SCORE) {
    console.log(
      `  ${id.padEnd(16)} — no match above ${MINIMUM_SCORE}` +
        (top ? ` (best: ${top.model.name} at ${top.points})` : ''),
    )
    continue
  }

  const size = top.model.dimensions
    ? top.model.dimensions.map((mm) => (mm / 1000).toFixed(2)).join(' x ')
    : '?'
  console.log(`  ${id.padEnd(16)} -> ${top.model.name}  (${top.points} pts, ${size} m)`)
  for (const runner of candidates.slice(1)) {
    console.log(`  ${''.padEnd(16)}    also: ${runner.model.name} (${runner.points})`)
  }
  picks.push({ item, model: top.model, points: top.points })
}

console.log(`\n  ${picks.length} of ${wanted.length} slots matched\n`)

if (flags.report) {
  console.log('  Report only. Re-run without --report to write the catalogue entries.\n')
  process.exit(0)
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
