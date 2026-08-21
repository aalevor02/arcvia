#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { LICENCES, licenceSlug } from './licence.mjs'

const run = promisify(execFile)

/**
 * Fill the catalogue from Sketchfab, unattended.
 *
 *   node tools/asset-ingest/batch.mjs                 # everything without a model
 *   node tools/asset-ingest/batch.mjs --only sofa-3,bed-queen
 *   node tools/asset-ingest/batch.mjs --dry-run       # pick, do not download
 *
 * ── Why picking is the hard part ────────────────────────────────────────────
 * Downloading is trivial. Choosing *which* of two thousand results to download
 * is the whole job, and a bad pick is expensive: it is a model somebody has to
 * notice is wrong, find, and replace, long after the person who ingested it has
 * forgotten why.
 *
 * So candidates are scored rather than taken in search order, and the score is
 * built out of what actually predicts a usable architectural prop:
 *
 *   - a licence we may ship (hard filter — never a tie-break)
 *   - a poly count in a sane band, penalised at both ends
 *   - a name that reads like the thing rather than a scene containing it
 *
 * That last one matters more than it sounds. Searching "sofa" returns a great
 * many *living rooms*, and importing a whole living room as the sofa entry is
 * the single most likely way for this to go wrong.
 */

// ---- Search terms ----------------------------------------------------------
//
// Per item, because the catalogue id is not a good search term: "wc" returns
// nothing useful, "counter" returns shop counters, and "opening" returns
// abstract art. Written out rather than derived from the name for the same
// reason — this is the one place where a human's knowledge of what the thing
// is called is worth more than any rule.
const TERMS = {
  'sofa-3': 'three seater sofa',
  'sofa-2': 'two seater sofa loveseat',
  armchair: 'armchair',
  'dining-chair': 'dining chair wooden',
  bench: 'wooden bench seat',
  'dining-table-6': 'dining table rectangular',
  'dining-table-4': 'small dining table',
  'coffee-table': 'coffee table living room',
  'side-table': 'side table small round',
  desk: 'writing desk office',
  'bed-king': 'king size bed',
  'bed-queen': 'double bed',
  'bed-single': 'single bed',
  bedside: 'bedside table nightstand',
  wardrobe: 'wardrobe closet',
  'wardrobe-small': 'small wardrobe',
  bookshelf: 'bookshelf shelving unit',
  'tv-unit': 'tv stand media unit',
  chest: 'chest of drawers dresser',
  counter: 'kitchen cabinet counter',
  island: 'kitchen island',
  'sink-unit': 'kitchen sink cabinet',
  fridge: 'refrigerator fridge',
  hob: 'kitchen stove oven',
  overhead: 'kitchen wall cabinet',
  wc: 'toilet wc bathroom',
  basin: 'bathroom sink basin',
  bathtub: 'bathtub',
  shower: 'shower enclosure cubicle',
  rug: 'carpet rug floor',
  plant: 'potted plant indoor',
  tv: 'flat screen television',
  painting: 'framed picture wall art',
  mirror: 'wall mirror framed',
  curtain: 'curtains drapes window',
  'ceiling-light': 'ceiling light fixture',
  pendant: 'pendant lamp hanging light',
  'wall-light': 'wall sconce light',
}

/**
 * Words that mean "this is a scene, not a prop".
 *
 * A result called "Modern Living Room Interior" may well contain a beautiful
 * sofa. It is also a whole room, and importing it as the sofa entry gives every
 * placed sofa a set of walls.
 */
const SCENE_WORDS = [
  'room', 'interior', 'scene', 'apartment', 'house', 'villa', 'office',
  'restaurant', 'cafe', 'shop', 'store', 'kitchen set', 'bundle', 'pack',
  'collection', 'set of', 'furniture set',
]

/**
 * The score a candidate must reach to be worth ingesting at all.
 *
 * Tuned against a real run: good picks scored 62-86, junk 27-52. Anything
 * below this keeps its parametric stand-in, which is plain but correct.
 */
const MINIMUM_SCORE = 60

/** Poly budget per item, in triangles after conditioning. */
const BUDGET = {
  default: 5000,
  rug: 800,
  painting: 600,
  mirror: 800,
  tv: 1500,
  curtain: 2000,
  'wall-light': 1500,
  'ceiling-light': 1500,
  pendant: 1500,
  plant: 4000,
  'dining-chair': 3000,
  bedside: 2000,
  'side-table': 2000,
}

function scoreCandidate(model, term) {
  const name = String(model.name ?? '').toLowerCase()
  const faces = Number(model.faceCount ?? 0)

  // Hard filters first. A licence we may not ship is not a low score, it is
  // not a candidate — scoring it risks it winning on a thin day.
  // Search results carry a label and no slug; licenceSlug handles both.
  const licence = LICENCES[licenceSlug(model.license) ?? '']
  if (!licence) return null
  if (!model.isDownloadable) return null
  if (faces <= 0) return null

  // Unusable at both ends. Under a few hundred faces is a placeholder; over
  // 400k is a scene or a scan, and decimating it that hard leaves mush.
  if (faces < 200 || faces > 400_000) return null

  let score = 0

  // The sweet spot is a few thousand faces: enough shape to survive
  // decimation, little enough that it was modelled as a prop.
  if (faces >= 1_000 && faces <= 60_000) score += 40
  else if (faces <= 150_000) score += 20
  else score += 5

  // CC0 needs no credit, which is worth a real preference.
  if (!licence.attribution) score += 15

  // Name overlap with the search term, which is a decent proxy for "this is
  // the thing" rather than "this contains the thing".
  const words = term.split(/\s+/).filter((w) => w.length > 3)
  score += words.filter((w) => name.includes(w)).length * 12

  // A short name is usually a prop. "Sofa" beats "Modern Scandinavian Living
  // Room Interior Scene With Sofa And Plants".
  if (name.length < 30) score += 10

  for (const word of SCENE_WORDS) {
    if (name.includes(word)) score -= 45
  }

  return { model, score, faces, licence }
}

async function search(term, token) {
  const url = new URL('https://api.sketchfab.com/v3/search')
  url.searchParams.set('type', 'models')
  url.searchParams.set('q', term)
  url.searchParams.set('downloadable', 'true')
  url.searchParams.set('count', '24')
  // Ask the API for the licences we can actually use rather than filtering a
  // page of results we were never allowed to ship.
  url.searchParams.set('licenses', 'cc0,by,by-sa')

  const response = await fetch(url, { headers: { Authorization: `Token ${token}` } })
  if (!response.ok) throw new Error(`Sketchfab search failed: ${response.status}`)

  const body = await response.json()
  return body.results ?? []
}

// ---- Arguments -------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? null : argv[at + 1]
}

const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '../..',
)

const token =
  process.env.SKETCHFAB_TOKEN ??
  (await readFile(join(root, '.env'), 'utf8').catch(() => ''))
    .split('\n')
    .find((l) => l.trim().startsWith('SKETCHFAB_TOKEN='))
    ?.split('=')
    .slice(1)
    .join('=')
    .trim()

if (!token) {
  console.error('No SKETCHFAB_TOKEN. See tools/asset-ingest/ingest.mjs.')
  process.exit(2)
}

// Which items still need a model. Read from the source so the catalogue stays
// the single definition of what exists.
const itemsSource = await readFile(join(root, 'apps/studio/src/catalogue/items.ts'), 'utf8')
const hasModel = (id) => {
  const at = itemsSource.indexOf(`id: '${id}',`)
  if (at === -1) return false
  const end = itemsSource.indexOf('\n  },', at)
  return itemsSource.slice(at, end).includes('model: {')
}

const only = value('only')?.split(',').map((s) => s.trim()).filter(Boolean)
const targets = (only ?? Object.keys(TERMS)).filter((id) => only || !hasModel(id))

console.log(`${targets.length} item(s) to fill\n`)

const chosen = []
const skipped = []

for (const id of targets) {
  const term = TERMS[id]
  if (!term) {
    skipped.push({ id, why: 'no search term defined' })
    continue
  }

  let results
  try {
    results = await search(term, token)
  } catch (error) {
    skipped.push({ id, why: error.message })
    continue
  }

  const ranked = results
    .map((model) => scoreCandidate(model, term))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) {
    skipped.push({ id, why: `no usable result for "${term}"` })
    continue
  }

  const best = ranked[0]

  // Below the floor, keep the stand-in.
  //
  // A dimensioned grey box is a *correct* piece of furniture that happens to
  // be plain. A confidently wrong model — the search for "side table" that
  // returns a cartoon character, the 255,000-face TV unit — is worse than
  // plain in every way: it looks broken to a client, it costs bake time, and
  // somebody has to notice and undo it later.
  //
  // The scores separate these cleanly enough to act on: the good picks land at
  // 62-86 and the junk at 27-52, so the threshold is doing real work rather
  // than splitting hairs.
  if (best.score < MINIMUM_SCORE) {
    skipped.push({
      id,
      why: `best candidate scored ${best.score} ("${best.model.name.slice(0, 40)}") — below ${MINIMUM_SCORE}`,
    })
    continue
  }

  console.log(
    `${id.padEnd(16)} ${best.model.name.slice(0, 44).padEnd(46)} ` +
      `${String(best.faces).padStart(7)}f  score ${best.score}`,
  )
  chosen.push({ id, best })
}

if (flag('dry-run')) {
  console.log(`\n${chosen.length} chosen, ${skipped.length} skipped (dry run — nothing downloaded)`)
  for (const s of skipped) console.log(`  skip ${s.id}: ${s.why}`)
  process.exit(0)
}

// ---- Ingest ---------------------------------------------------------------
// Sequentially, on purpose. Each one spawns Blender, and running several at
// once on a machine that is also the render worker turns a slow job into an
// unusable one.

const entries = []
const failed = []

for (const { id, best } of chosen) {
  process.stdout.write(`\n── ${id} `)
  try {
    const { stdout } = await run(
      process.execPath,
      [
        join(root, 'tools/asset-ingest/ingest.mjs'),
        '--uid', best.model.uid,
        '--item', id,
        '--budget', String(BUDGET[id] ?? BUDGET.default),
      ],
      { maxBuffer: 32 * 1024 * 1024, env: process.env },
    )

    // The machine-readable line, not the indented block below it. Scraping
    // pretty-print worked until the indentation changed, at which point every
    // one of 32 successful ingests was reported as a failure.
    const line = stdout.split('\n').find((l) => l.startsWith('ARCVIA_ENTRY:'))
    if (!line) throw new Error('ingest produced no entry line')
    entries.push({ id, json: JSON.parse(line.slice('ARCVIA_ENTRY:'.length)) })

    const facing = stdout.match(/facing\s+: (.+)/)?.[1] ?? ''
    console.log(`ok — ${facing}`)
  } catch (error) {
    const message = String(error.stdout ?? error.message ?? error).split('\n').slice(-4).join(' ')
    failed.push({ id, why: message.slice(0, 160) })
    console.log('failed')
  }
}

// Written to a file rather than spliced into items.ts. Editing a source file
// from a batch script is how a catalogue becomes unreviewable — this is a diff
// somebody reads, next to the licences they are accepting on the product's
// behalf.
const out = join(root, '.data/catalogue-additions.json')
await writeFile(out, JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e.json])), null, 2))

console.log(`\n${entries.length} ingested, ${failed.length} failed, ${skipped.length} skipped`)
for (const f of failed) console.log(`  fail ${f.id}: ${f.why}`)
for (const s of skipped) console.log(`  skip ${s.id}: ${s.why}`)
console.log(`\nEntries written to ${out}`)
console.log('Review them, then merge into apps/studio/src/catalogue/items.ts.')
