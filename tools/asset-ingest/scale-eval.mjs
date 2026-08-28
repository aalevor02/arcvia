#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BANDS, UNITS, bandFor, inferScale, measureModel } from './scale.mjs'

/**
 * Is the inferred scale actually RIGHT?
 *
 *   node tools/asset-ingest/scale-eval.mjs [--limit 1200] [--all]
 *
 * ── The claim this exists to test ───────────────────────────────────────────
 * `scale.mjs` resolves a unit for about two thirds of the archviz-named hub.
 * That number is a RESOLVE rate: how often it reaches a decisive answer. It has
 * never been an ACCURACY rate, and the handoff has said so in as many words —
 * "decisive is not correct". This closes that gap.
 *
 * ── Why it cannot be scored with the bands ──────────────────────────────────
 * The obvious evaluation is to check that each resolved size lands in its
 * plausibility band. That measures nothing at all: landing in the band is the
 * literal criterion `inferScale` used to choose the unit, so every resolved
 * asset passes by construction and the score is always 100%.
 *
 * An evaluation has to use a DIFFERENT instrument from the thing it evaluates.
 * So the table below is deliberately much tighter than `BANDS`, and written
 * from what the object actually is rather than from what would separate a
 * metre reading from a centimetre one:
 *
 *     bathtub   BANDS 0.70 – 2.40 m      here 1.40 – 1.95 m
 *     wc        BANDS 0.25 – 1.40 m      here 0.60 – 0.90 m
 *
 * A bathtub resolved to 0.8 m satisfies the band and fails here, which is the
 * entire point: that is a real error the band was never shaped to catch.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * Not ground truth. Nobody has measured these models against the real objects
 * they depict; the expectations below are mine, written from standard furniture
 * dimensions. That makes this a strong smoke test and a weak certificate. It is
 * reported with the failing assets NAMED so the verdicts can be argued with,
 * which is the only honest way to publish a number whose labels one author
 * invented.
 *
 * Multi-object packs are excluded rather than scored: the largest extent of
 * "Leather armchair / Coffee table / Floorlamp" is the extent of the SET, and
 * no single-object expectation can be right about it.
 */

/**
 * What the largest dimension of this object really is, in metres.
 *
 * Tight, and about the object rather than about unit separation. Ordered
 * most-specific first, like BANDS, because the first match wins.
 */
const EXPECT = [
  { kind: 'bathtub', words: ['bathtub'], min: 1.40, max: 1.95 },
  { kind: 'wc', words: ['toilet', 'wc', 'commode'], min: 0.60, max: 0.90 },
  { kind: 'basin', words: ['basin', 'washbasin', 'sink'], min: 0.35, max: 0.95 },
  { kind: 'wardrobe', words: ['wardrobe', 'almirah'], min: 1.70, max: 2.45 },
  { kind: 'fridge', words: ['fridge', 'refrigerator'], min: 1.20, max: 1.95 },
  { kind: 'washer', words: ['washing', 'washer'], min: 0.55, max: 0.95 },
  { kind: 'ceiling-fan', words: ['fan'], min: 0.90, max: 1.45 },
  { kind: 'bed', words: ['bed', 'mattress'], min: 1.85, max: 2.25 },
  { kind: 'sofa', words: ['sofa', 'couch', 'settee'], min: 1.40, max: 2.70 },
  { kind: 'armchair', words: ['armchair', 'recliner'], min: 0.65, max: 1.15 },
  { kind: 'chair', words: ['chair', 'stool'], min: 0.40, max: 1.15 },
  { kind: 'desk', words: ['desk'], min: 1.00, max: 2.00 },
  { kind: 'table', words: ['table'], min: 0.45, max: 2.40 },
  { kind: 'bookshelf', words: ['bookshelf', 'bookcase'], min: 0.70, max: 2.30 },
  { kind: 'door', words: ['door'], min: 0.80, max: 2.30 },
  { kind: 'tv', words: ['tv', 'television'], min: 0.55, max: 1.75 },
  { kind: 'rug', words: ['rug', 'carpet'], min: 1.00, max: 3.20 },
  { kind: 'mirror', words: ['mirror'], min: 0.35, max: 1.90 },
  { kind: 'person', words: ['person', 'woman', 'man ', 'human'], min: 1.50, max: 1.95 },
  { kind: 'car', words: ['car', 'suv', 'sedan'], min: 3.60, max: 5.40 },
  { kind: 'planter', words: ['pot', 'planter', 'vase'], min: 0.10, max: 0.90 },
  { kind: 'lamp', words: ['lamp'], min: 0.20, max: 1.90 },
]

/** Names that describe a SET, which no single-object expectation can score. */
const PACK = /\b(pack|set|collection|kit|bundle|scene|room|assets?|interior|apartment|appartement|house|kitbash)\b|\/|\+|&/i

const word = (name, w) =>
  new RegExp(`(^|[^a-z0-9])${w.trim()}($|[^a-z0-9])`, 'i').test(name)

function expectationFor(name) {
  for (const e of EXPECT) if (e.words.some((w) => word(name, w))) return e
  return null
}

const args = process.argv.slice(2)
const limit = Number(args[args.indexOf('--limit') + 1]) || (args.includes('--all') ? Infinity : 1200)
const HUB = process.env.ASSET_HUB_DIR ?? 'A:/Assets/Hub'

const rows = []
let resolved = 0
let excludedPack = 0
let noExpectation = 0

for (const dir of (await readdir(join(HUB, 'models'))).slice(0, limit)) {
  let meta
  try {
    meta = JSON.parse(await readFile(join(HUB, 'models', dir, '.asset.json'), 'utf8'))
  } catch {
    continue
  }

  const files = await readdir(join(HUB, 'models', dir)).catch(() => [])
  const model = files.find((f) => f.endsWith('.gltf') || f.endsWith('.glb'))
  if (!model) continue

  let extents
  try {
    extents = await measureModel(join(HUB, 'models', dir, model))
  } catch {
    continue
  }

  const got = inferScale(meta.name, extents)
  if (!got.ok) continue
  resolved++

  if (PACK.test(meta.name)) { excludedPack++; continue }

  const expect = expectationFor(meta.name)
  if (!expect) { noExpectation++; continue }

  // The module's own decision, re-derived from the factor: `metres` was removed
  // from the API deliberately, and the largest extent is the rotation-stable
  // quantity anyway.
  const largest = Math.max(extents.x, extents.y, extents.z)
  const metres = largest * got.factor

  // ── Where in its own band did the winning reading land? ───────────────────
  // The hypothesis this tests: a reading that wins because every OTHER unit
  // fell outside the band — rather than because it looked right — should be
  // less trustworthy, and should show up sitting near a band EDGE rather than
  // comfortably inside. "Bread" resolved to 3 cm that way, and so did
  // "Single Bed 2" at 1.08 m read as inches.
  //
  // `position` is 0 at the band floor, 1 at its ceiling, 0.5 dead centre.
  // `rivals` counts how many other unit readings also fell inside the band; 0
  // means the winner was unopposed, i.e. it won by elimination.
  const band = bandFor(meta.name)
  let position = null
  let rivals = null
  if (band) {
    position = (metres - band.min) / (band.max - band.min)
    rivals = UNITS.filter((u) => {
      const m = largest * u.factor
      return u.unit !== got.unit && m >= band.min && m <= band.max
    }).length
  }

  rows.push({
    name: meta.name,
    kind: expect.kind,
    unit: got.unit,
    metres,
    correct: metres >= expect.min && metres <= expect.max,
    expect: `${expect.min}–${expect.max}`,
    position,
    rivals,
  })
}

const right = rows.filter((r) => r.correct)
const wrong = rows.filter((r) => !r.correct)

console.log(`\nresolved a unit          : ${resolved}`)
console.log(`  excluded, multi-object : ${excludedPack}`)
console.log(`  excluded, no expectation: ${noExpectation}`)
console.log(`  SCORED                 : ${rows.length}`)

if (rows.length) {
  console.log(`\nCORRECT: ${right.length}/${rows.length} = ${((100 * right.length) / rows.length).toFixed(1)}%\n`)
}

if (wrong.length) {
  console.log('WRONG — argue with these, the expectations are hand-written:')
  for (const r of wrong.sort((a, b) => a.kind.localeCompare(b.kind))) {
    console.log(
      `  ${r.kind.padEnd(12)} ${r.metres.toFixed(3).padStart(8)} m  (as ${r.unit.padEnd(2)}, expected ${r.expect})  ${r.name.slice(0, 44)}`,
    )
  }
}

// By kind, so a systematic failure is visible rather than averaged away.
const byKind = new Map()
for (const r of rows) {
  const k = byKind.get(r.kind) ?? { n: 0, ok: 0 }
  k.n++
  if (r.correct) k.ok++
  byKind.set(r.kind, k)
}
// ── Does band position predict correctness? ─────────────────────────────────
// If it does, `resolve()` gains a measured rule instead of a judgement call:
// refuse, or flag, a reading that only qualifies at the edge of its band.
const placed = rows.filter((r) => r.position !== null)
if (placed.length) {
  console.log('\nBAND POSITION vs CORRECTNESS  (0 = band floor, 1 = ceiling)')
  const buckets = [
    ['outer decile (<0.1 or >0.9)', (p) => p < 0.1 || p > 0.9],
    ['outer quintile (<0.2 or >0.8)', (p) => (p < 0.2 || p > 0.8) && !(p < 0.1 || p > 0.9)],
    ['middle 60% (0.2 – 0.8)', (p) => p >= 0.2 && p <= 0.8],
  ]
  for (const [label, test] of buckets) {
    const inBucket = placed.filter((r) => test(r.position))
    if (!inBucket.length) continue
    const ok = inBucket.filter((r) => r.correct).length
    console.log(
      `  ${label.padEnd(32)} ${String(ok).padStart(3)}/${String(inBucket.length).padEnd(3)} ` +
        `${((100 * ok) / inBucket.length).toFixed(0).padStart(3)}%`,
    )
  }

  const unopposed = placed.filter((r) => r.rivals === 0)
  const contested = placed.filter((r) => r.rivals > 0)
  console.log('\nWON BY ELIMINATION?  (rivals = other units also inside the band)')
  for (const [label, set] of [['unopposed (rivals 0)', unopposed], ['contested', contested]]) {
    if (!set.length) continue
    const ok = set.filter((r) => r.correct).length
    console.log(
      `  ${label.padEnd(32)} ${String(ok).padStart(3)}/${String(set.length).padEnd(3)} ` +
        `${((100 * ok) / set.length).toFixed(0).padStart(3)}%`,
    )
  }
}

console.log('\nBY KIND:')
for (const [kind, k] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const pct = ((100 * k.ok) / k.n).toFixed(0)
  console.log(`  ${kind.padEnd(12)} ${String(k.ok).padStart(3)}/${String(k.n).padEnd(3)} ${pct.padStart(3)}%`)
}
