import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  ENVIRONMENTS,
  ENVIRONMENT_KINDS,
  environmentById,
  environmentByUrl,
  defaultEnvironment,
} from '../src/catalogue/environments'

/**
 * The environment catalogue, against the files it names.
 *
 * ── Why this needs testing ──────────────────────────────────────────────────
 * `hdriUrl` spent the whole life of this product as a field nothing wrote, and
 * the symptom was that renders came back lit by the worker's default sky —
 * which is a perfectly good picture. Nothing about a missing environment looks
 * broken.
 *
 * The same is true of a broken path now that something does write it: the
 * viewer keeps the previous environment, the renderer falls back to its default
 * world, and the only evidence is a console warning nobody reads. So the files
 * are checked here, where a rename in the ingest tool fails loudly.
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

// From cwd, not from import.meta.url: run.mjs bundles each test into a temp
// directory, so a path relative to this module lands beside the bundle and
// finds nothing. Checked separately and first, so the per-file results below
// only mean what they say once it passes.
const PUBLIC = join(process.cwd(), 'public')
check('the public directory is where this test expects it', existsSync(PUBLIC), PUBLIC)

// ---- The files exist ---------------------------------------------------------

for (const preset of ENVIRONMENTS) {
  check(`${preset.id} map exists`, existsSync(join(PUBLIC, preset.url.replace(/^\//, ''))), preset.url)
  check(
    `${preset.id} thumbnail exists`,
    existsSync(join(PUBLIC, preset.thumbnail.replace(/^\//, ''))),
    preset.thumbnail,
  )
}

// ---- Shape -------------------------------------------------------------------

const ids = ENVIRONMENTS.map((preset) => preset.id)
check('environment ids are unique', new Set(ids).size === ids.length)
check('there is at least one environment', ENVIRONMENTS.length > 0, `${ENVIRONMENTS.length}`)

const kinds = new Set(ENVIRONMENT_KINDS.map((kind) => kind.id))
for (const preset of ENVIRONMENTS) {
  // A preset whose kind is not in the group list renders in no group at all —
  // present in the catalogue, absent from the picker, and nothing errors.
  check(`${preset.id} has a kind the picker groups`, kinds.has(preset.kind), preset.kind)
}

check(
  'exactly one environment is the default',
  ENVIRONMENTS.filter((preset) => preset.isDefault).length === 1,
)
check('defaultEnvironment returns one', Boolean(defaultEnvironment()))

// ---- Lookups -----------------------------------------------------------------

const first = ENVIRONMENTS[0]
check('environmentById finds a known id', environmentById(first.id)?.id === first.id)
check('environmentById returns undefined for an unknown id', environmentById('nope') === undefined)
check('environmentByUrl finds a known url', environmentByUrl(first.url)?.id === first.id)
// Not an error: a scene may be lit by something that is not ours, and the
// panel treats that as "no catalogue selection" rather than a failure.
check('environmentByUrl returns undefined for a foreign url', environmentByUrl('/env/other.hdr') === undefined)
check('environmentByUrl tolerates null', environmentByUrl(null) === undefined)

// ---- Attribution -------------------------------------------------------------

for (const preset of ENVIRONMENTS) {
  check(
    `${preset.id} names a licence, author and source`,
    Boolean(preset.licence && preset.author && preset.source),
    preset.licence,
  )
}

// ---- The measured key light ---------------------------------------------------

for (const preset of ENVIRONMENTS) {
  // Null is a real answer — an overcast sky has no sun — but a present one must
  // be a plausible direction rather than a leftover default.
  const sun = preset.sun
  check(
    `${preset.id} sun is null or a real direction`,
    sun === null ||
      (sun.elevation >= -90 && sun.elevation <= 90 && sun.azimuth >= -180 && sun.azimuth <= 180),
    sun ? `${sun.elevation} / ${sun.azimuth}` : 'diffuse',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
