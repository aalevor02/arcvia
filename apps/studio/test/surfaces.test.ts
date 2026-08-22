import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { SURFACE_MAPS, PROCEDURAL_SURFACES, surfaceMapsFor } from '../src/catalogue/surfaces'
import { SURFACE_KINDS } from '../src/plan/materials'

/**
 * The surface catalogue, against the files it names.
 *
 * ── Why this needs testing ──────────────────────────────────────────────────
 * A missing surface map has no runtime symptom. `surfaceUpgrade` keeps the
 * procedural map when a load fails, which is the correct behaviour and also
 * completely invisible: the room still renders, still tiles, and simply looks
 * like the canvas drew it — which it did, before any of this existed. So a
 * broken path here regresses the product silently and permanently.
 *
 * Same reasoning as credits.test.ts: the things worth testing hardest are the
 * ones nothing else in the system will ever notice.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

/**
 * Where the served files are, from the working directory.
 *
 * NOT from `import.meta.url`: run.mjs bundles each test with esbuild into a
 * temporary directory and imports it from there, so a path relative to this
 * module resolves next to the bundle and finds nothing. The first version of
 * this file did exactly that and reported all twenty-four maps missing — a
 * failure that reads as "the assets are gone" when the assets were fine.
 *
 * So the root is checked separately and loudly, and the per-file checks only
 * mean what they say once it passes.
 */
const PUBLIC = join(process.cwd(), 'public')

check(
  'the public directory is where this test expects it',
  existsSync(PUBLIC),
  `${PUBLIC} — run the suite from apps/studio`,
)

/**
 * Every surface kind, from the module that defines them.
 *
 * This list used to be written out here, because `SurfaceKind` was a bare union
 * with no run-time form. That defeated the whole check: three kinds were added
 * to materials.ts and this still passed, against a copy nobody had updated.
 * `SURFACE_KINDS` is now the single declaration, so a kind cannot exist without
 * appearing here.
 */
const ALL_KINDS = SURFACE_KINDS

// ---- The files exist ---------------------------------------------------------

for (const spec of SURFACE_MAPS) {
  for (const [role, url] of [
    ['colour', spec.map],
    ['roughness', spec.roughnessMap],
    ['normal', spec.normalMap],
  ] as const) {
    // The URL is served from public/, so it maps onto disk by stripping the
    // leading slash. Checked rather than assumed, because a rename in the
    // ingest tool would leave the module naming files nobody wrote.
    check(
      `${spec.id} ${role} map exists`,
      existsSync(join(PUBLIC, url.replace(/^\//, ''))),
      url,
    )
  }
}

// ---- Every kind is accounted for ---------------------------------------------

for (const kind of ALL_KINDS) {
  const mapped = Boolean(surfaceMapsFor(kind))
  const procedural = kind in PROCEDURAL_SURFACES
  check(
    `${kind} is either mapped or explicitly procedural`,
    mapped !== procedural,
    mapped ? 'mapped' : procedural ? 'procedural, with a reason' : 'NEITHER',
  )
}

check(
  'nothing claims to be both mapped and procedural',
  !SURFACE_MAPS.some((spec) => spec.id in PROCEDURAL_SURFACES),
)

// ---- Tile scale is plausible -------------------------------------------------

/**
 * Bounds, not values.
 *
 * `tileMetres` is hand-set — ambientCG declares a physical size and leaves it
 * at zero for every material sampled — and two attempts to recover it from the
 * pixels are recorded as failures in the ingest tool. So this cannot check the
 * number is right. What it can catch is the mistake that actually happens: a
 * factor-of-ten slip, which turns a floorboard into a runway and errors nowhere.
 */
for (const spec of SURFACE_MAPS) {
  check(
    `${spec.id} tile is between 0.1 m and 4 m`,
    spec.tileMetres >= 0.1 && spec.tileMetres <= 4,
    `${spec.tileMetres} m`,
  )
}

// ---- Attribution -------------------------------------------------------------

for (const spec of SURFACE_MAPS) {
  // Same obligation credits.ts exists to meet. Everything shipped today is CC0
  // and owes nobody, which is a fact about this list rather than about the type
  // — one CC-BY material makes it a legal requirement with no runtime symptom.
  check(
    `${spec.id} names a licence, author and source`,
    Boolean(spec.licence && spec.author && spec.source),
    spec.licence,
  )
}

const ids = SURFACE_MAPS.map((spec) => spec.id)
check('surface ids are unique', new Set(ids).size === ids.length)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
