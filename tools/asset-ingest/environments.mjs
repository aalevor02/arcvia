#!/usr/bin/env node
/**
 * Bind the studio's environment list to the shared asset hub.
 *
 *   node tools/asset-ingest/environments.mjs --report   # what is selected, and what is missing
 *   node tools/asset-ingest/environments.mjs            # condition and generate
 *
 * ── What this fixes ─────────────────────────────────────────────────────────
 * `hdriUrl` is a complete consumer with no producer. It is persisted on the
 * scene (scenes.js), forwarded by the API (render.js), fetched by the worker
 * and loaded into a real Blender world (render.py:apply_environment). It is
 * typed all the way through the studio client. Nothing anywhere writes it, so
 * apply_environment has taken its no-HDRI branch on every render this product
 * has ever done — while 301 licence-clean CC0 HDRIs sat in the hub.
 *
 * This is the missing producer: a curated set, conditioned to a web budget, and
 * a typed module the studio can offer in a picker.
 *
 * ── Why the list is hand-written ────────────────────────────────────────────
 * from-hub.mjs scores three hundred models against forty-six slots because at
 * that ratio no human is going to read them all. This is the opposite problem.
 * There are perhaps a dozen environments an architectural product actually
 * wants, the difference between them is entirely judgement — is this the light
 * you would photograph the flat in — and no tag on Poly Haven encodes it.
 *
 * So it is a table with a reason per row, in the same spirit as from-hub's
 * VOCABULARY: the one place where knowing what a thing is worth more than any
 * rule. What the script does is the mechanical half — check it is licence
 * clean, check it is in the hub, condition it, measure it, generate the module.
 *
 * ── The finding this table exists because of ────────────────────────────────
 * The hub holds 301 HDRIs and every single one is categorised `indoor`. It has
 * **zero** of Poly Haven's 297 `skies`. That is not an accident: the harvest
 * preset is `hdri: ['indoor']`, and its own comment says why —
 *
 *     "An outdoor HDRI is still useful for a window view, but 700 of them is
 *      not a furnishing library."
 *
 * Correct for a furnishing library, and exactly wrong for an architectural
 * renderer, where the single most valuable environment is the sky outside the
 * window. Lighting a client's villa with a photograph of somebody's derelict
 * bakery is a plausible-looking result and a wrong one — the failure mode this
 * repo has over and over.
 *
 * So most of this table is fetched deliberately, one asset at a time, rather
 * than by widening the harvest to 700 skies nobody will look at.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HUB = process.env.ASSET_HUB ?? 'A:/Assets/Hub'

/** Where the conditioned maps are served from, and the URL the scene stores. */
const OUT_DIR = join(ROOT, 'apps/studio/public/env')
const PUBLIC_PREFIX = '/env'

/** Generated module. Nothing in it is hand-edited, which is why generating it is safe. */
const MODULE = join(ROOT, 'apps/studio/src/catalogue/environments.ts')

/**
 * Equirectangular width to ship, in pixels.
 *
 * 1024x512 is 1.7 MB per map against 6.5 MB for the 2K master, and it costs
 * essentially nothing that matters — see condition_hdri.py. Below this the
 * *background* starts to show it, and the background is the half a client
 * actually looks at.
 */
const WIDTH = 1024

/**
 * Below this there is no key light, only the brightest patch of an even sky.
 *
 * Measured across this set: overcast maps land at 2-6x, clear ones at 80,000x
 * and above. Ten is comfortably inside the empty middle rather than a line
 * drawn through a cluster.
 */
const DIRECTIONAL = 10

// Not toLocaleString: this machine's locale is en-IN, which groups by lakh, so
// the same run printed "81,819x" and "1,07,362x" side by side. Tool output
// should not depend on where the machine thinks it is.
const formatDirectionality = (value) =>
  value >= DIRECTIONAL ? `${Math.round(value)}x` : 'diffuse'

/** A key light's direction, or a plain word when there is no key light. */
const formatKeyLight = (key) => {
  if (key.directionality < DIRECTIONAL) return `diffuse (${Math.round(key.directionality)}x)`
  const sign = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
  return `sun ${sign(key.elevation)} / ${sign(key.azimuth)}  ${formatDirectionality(key.directionality)}`
}

/**
 * The environments, and why each one is here.
 *
 * `kind` groups them in the picker. `note` is shown to the user — written for
 * someone choosing a light for a flat, not for someone browsing an HDRI
 * library, so it says what the light does rather than where the photograph was
 * taken.
 *
 * Poly Haven's `_puresky` variants are over-represented on purpose. They are
 * sky and ground only, with no trees, cars or fences near the horizon, which is
 * what you want behind a building that brings its own site: a photographed
 * meadow visible through a third-floor window in Pune is worse than a plain
 * one.
 */
const ENVIRONMENTS = [
  // ---- Daylight ----------------------------------------------------------
  {
    id: 'partly-cloudy',
    slug: 'kloofendal_48d_partly_cloudy_puresky',
    name: 'Partly cloudy midday',
    kind: 'daylight',
    note: 'Bright with soft-edged shadows. The safe default for most interiors.',
    // The most-downloaded HDRI on Poly Haven by a wide margin, which is not an
    // argument on its own — but it is the one most renders in the wild are lit
    // by, so it is the light a client has already seen and found unremarkable.
    default: true,
  },
  {
    id: 'midday',
    slug: 'kloofendal_43d_clear_puresky',
    name: 'Midday sun',
    kind: 'daylight',
    // Sun at +43 degrees: shadows about as long as the thing casting them.
    // Clear rather than partly cloudy, so the shadow edges are hard.
    note: 'Hard, high sun with short shadows. Shows off glazing and double-height space.',
  },
  {
    id: 'afternoon',
    slug: 'autumn_field_puresky',
    name: 'Afternoon sun',
    kind: 'daylight',
    // Sun at +29 degrees, so shadows run about 1.8x the height of what casts
    // them — visibly a different time of day from midday rather than a
    // differently-named copy of it.
    //
    // This slot originally held qwantani_puresky, chosen by eye and by
    // category. Measured, its sun sat 1.1 degrees from this one's in elevation
    // and 0.4 in azimuth: the same light under a second name, and no note or
    // tag would ever have said so. See condition_hdri.py:key_light.
    note: 'Low sun and long raking shadows across the floor.',
  },

  // ---- Overcast ----------------------------------------------------------
  {
    id: 'overcast',
    slug: 'overcast_soil_puresky',
    name: 'Overcast',
    kind: 'overcast',
    // The honest choice when a plan's orientation is unknown, which for a
    // reconstructed DXF it usually is. No sun means no wrong sun.
    note: 'Even, shadowless light. Use when the plan has no established orientation.',
  },
  {
    id: 'soft-grey',
    slug: 'mud_road_puresky',
    name: 'Soft grey',
    kind: 'overcast',
    // 6 EV — the flattest map in the library. Reads form and volume with almost
    // nothing to distract, which is what a work-in-progress review wants.
    note: 'The flattest light available. Reads shape and volume without drama.',
  },

  // ---- Evening -----------------------------------------------------------
  {
    id: 'golden-hour',
    slug: 'kloppenheim_06_puresky',
    name: 'Golden hour',
    kind: 'evening',
    note: 'Warm low sun. The usual choice for a hero shot.',
  },
  {
    id: 'sunset',
    slug: 'belfast_sunset_puresky',
    name: 'Sunset',
    kind: 'evening',
    note: 'Cooler dusk sky. Interior lighting reads as lit rather than washed out.',
  },

  // ---- Night -------------------------------------------------------------
  {
    id: 'moonlit',
    slug: 'dikhololo_night',
    name: 'Moonlit',
    kind: 'night',
    // No artificial light in the map at all, so every lit window in the render
    // is one the scene put there. That is the point of a night view.
    note: 'Dark and blue. Windows read as lit from within.',
  },
  {
    id: 'night-sky',
    slug: 'satara_night',
    name: 'Clear night',
    kind: 'night',
    note: 'Stars, with a warm lamp near the horizon.',
  },

  // ---- Urban context -----------------------------------------------------
  {
    id: 'city-overcast',
    slug: 'canary_wharf',
    name: 'City, overcast',
    kind: 'urban',
    // Not a puresky, deliberately: an apartment on the ninth floor should have
    // buildings outside the window, and this one has towers at the right scale.
    note: 'Towers and glass outside the window. For apartments, not villas.',
  },
  {
    id: 'city-sun',
    slug: 'wide_street_01',
    name: 'City, sunny',
    kind: 'urban',
    note: 'Street level, strong sun. For ground-floor and commercial frontage.',
  },

  // ---- Studio ------------------------------------------------------------
  {
    id: 'studio',
    slug: 'studio_small_09',
    name: 'Studio',
    kind: 'studio',
    // Already in the hub — the one row here that needs no fetch, because the
    // interior harvest was right about this half.
    note: 'Neutral softboxes on white. For a single object, not a room.',
  },
]

/** Order the picker shows the groups in, and what to call them. */
const KINDS = [
  ['daylight', 'Daylight'],
  ['overcast', 'Overcast'],
  ['evening', 'Evening'],
  ['night', 'Night'],
  ['urban', 'Urban'],
  ['studio', 'Studio'],
]

// ---- Arguments ---------------------------------------------------------------

const flags = {}
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) continue
  const next = process.argv[i + 1]
  flags[arg.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true
}

// ---- The hub -----------------------------------------------------------------

/**
 * What the hub holds, and where.
 *
 * The manifest is the record of provenance — licence, author, source URL — and
 * it is what makes the generated module able to credit anyone. The bytes on
 * disk are found separately, because a manifest entry whose file is missing is
 * a real state (an interrupted harvest) and has to be distinguishable from an
 * asset that was never taken.
 */
async function hubIndex() {
  const manifest = JSON.parse(await readFile(join(HUB, 'manifest.json'), 'utf8'))
  const byRef = new Map()

  for (const asset of manifest.assets) {
    if (asset.kind !== 'hdri') continue
    byRef.set(asset.ref.split(':')[1], asset)
  }
  return byRef
}

/** The .hdr inside a hub asset directory, largest first — the master. */
async function masterFile(assetPath) {
  const directory = join(HUB, assetPath)
  if (!existsSync(directory)) return null

  const files = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith('.hdr'))
  if (files.length === 0) return null

  // Prefer the highest resolution present. A hub that has both a 1k and a 2k
  // should condition from the 2k; picking by directory order would silently
  // pick whichever the filesystem happened to list first.
  const sized = files
    .map((name) => ({ name, res: Number(/_(\d+)k\./i.exec(name)?.[1] ?? 0) }))
    .sort((a, b) => b.res - a.res)

  return join(directory, sized[0].name)
}

/**
 * The asset-hub CLI, if this machine has it.
 *
 * Deliberately not a hard dependency. It lives in a user's skills directory,
 * not in this repo, and a tool that dies because a personal skill is not
 * installed is a tool nobody else can run. When it is missing the script says
 * exactly what to run instead and carries on with what is already local.
 */
function hubCli() {
  const candidates = [
    process.env.ASSET_HUB_CLI,
    join(homedir(), '.claude/skills/asset-hub/hub.mjs'),
  ].filter(Boolean)

  return candidates.find((path) => existsSync(path)) ?? null
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : reject(new Error(`${command} exited ${code}\n${stderr || stdout}`)),
    )
  })
}

// ---- Report ------------------------------------------------------------------

const hub = await hubIndex()

console.log(`\n  ${ENVIRONMENTS.length} environments selected`)
console.log(`  hub: ${hub.size} HDRIs at ${HUB}\n`)

const rows = []
for (const environment of ENVIRONMENTS) {
  const asset = hub.get(environment.slug)
  const master = asset ? await masterFile(asset.path) : null
  rows.push({ ...environment, asset, master })

  const state = !asset ? 'not in hub' : !master ? 'in manifest, no file on disk' : 'ready'
  console.log(
    `  ${environment.id.padEnd(15)} ${environment.kind.padEnd(9)} ${environment.slug.padEnd(38)} ${state}`,
  )
}

const missing = rows.filter((row) => !row.master)
console.log(`\n  ${rows.length - missing.length} of ${rows.length} present in the hub`)

if (missing.length > 0) {
  const cli = hubCli()
  console.log(`  ${missing.length} to fetch:\n`)
  for (const row of missing) {
    console.log(`    node hub.mjs fetch polyhaven:${row.slug} --out ${HUB} --res 2k`)
  }
  if (!cli) {
    console.log(
      '\n  The asset-hub CLI was not found. Set ASSET_HUB_CLI to its path, or run\n' +
        '  the commands above by hand, then re-run this script.\n',
    )
  }
  console.log()
}

if (flags.report) {
  console.log('  Report only. Re-run without --report to fetch, condition and generate.\n')
  process.exit(0)
}

// ---- Fetch what is missing ---------------------------------------------------

if (missing.length > 0) {
  const cli = hubCli()
  if (!cli) {
    console.error('  Cannot fetch without the asset-hub CLI. Nothing was written.\n')
    process.exit(1)
  }

  console.log(`  fetching ${missing.length} masters into the hub\n`)
  for (const row of missing) {
    process.stdout.write(`    ${row.slug.padEnd(38)} `)
    try {
      // The CLI runs the licence gate itself, before any bytes move. Deliberately
      // not reimplemented here: two copies of an allow-list is how one of them
      // ends up out of date, and the one that matters is the one nearest the
      // download.
      await run(process.execPath, [cli, 'fetch', `polyhaven:${row.slug}`, '--out', HUB, '--res', '2k'])
      console.log('fetched')
    } catch (error) {
      console.log('FAILED')
      console.error(`      ${error.message.split('\n')[0]}`)
    }
  }
  console.log()

  // Re-read rather than assume. A fetch that reported success and left no file
  // is exactly the class of failure this repo keeps finding.
  const refreshed = await hubIndex()
  for (const row of rows) {
    if (row.master) continue
    row.asset = refreshed.get(row.slug)
    row.master = row.asset ? await masterFile(row.asset.path) : null
  }
}

const ready = rows.filter((row) => row.master)
const unavailable = rows.filter((row) => !row.master)

if (unavailable.length > 0) {
  console.log(`  ${unavailable.length} still unavailable and NOT in the generated module:`)
  for (const row of unavailable) console.log(`    ${row.id} (${row.slug})`)
  console.log()
}

if (ready.length === 0) {
  console.error('  Nothing to condition. Module not written.\n')
  process.exit(1)
}

// ---- Condition ---------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true })

const python = process.env.PYTHON ?? 'python'
const conditioner = join(ROOT, 'tools/asset-ingest/condition_hdri.py')

console.log(`  conditioning ${ready.length} maps to ${WIDTH}px wide\n`)

const written = []
for (const row of ready) {
  const output = join(OUT_DIR, `${row.id}.hdr`)
  const thumb = join(OUT_DIR, `${row.id}.jpg`)
  process.stdout.write(`    ${row.id.padEnd(15)} `)

  let report
  try {
    const { stdout } = await run(python, [
      conditioner,
      '--input', row.master,
      '--output', output,
      '--width', String(WIDTH),
      '--thumb', thumb,
    ])

    for (const warning of stdout.split('\n').filter((l) => l.startsWith('ARCVIA_WARN:'))) {
      console.log(`\n      warning: ${warning.slice('ARCVIA_WARN:'.length)}`)
    }

    const line = stdout.split('\n').find((l) => l.startsWith('ARCVIA_HDRI:'))
    if (!line) throw new Error('conditioning produced no report')
    report = JSON.parse(line.slice('ARCVIA_HDRI:'.length))
  } catch (error) {
    // Named, not swallowed. A missing environment is a smaller list; a silently
    // missing one is a picker whose contents nobody can account for.
    console.log('FAILED')
    console.error(`      ${error.message.split('\n').slice(0, 2).join(' ')}`)
    continue
  }

  const kb = report.conditioned.bytes / 1024
  const saved = 1 - report.conditioned.bytes / report.source.bytes
  const key = report.keyLight
  console.log(
    `${String(Math.round(kb)).padStart(5)} KB  ` +
      `(${(saved * 100).toFixed(0)}% smaller, light ${report.light.driftPercent >= 0 ? '+' : ''}` +
      `${report.light.driftPercent.toFixed(2)}%)  ` +
      // Printed next to each other so two entries that are secretly the same
      // light are visible in the run that produced them, rather than after
      // someone renders both and wonders why they match.
      formatKeyLight(key),
  )

  written.push({ ...row, report })
}

console.log()

/**
 * Point out two environments whose key light is in the same place.
 *
 * ── What this can and cannot establish ──────────────────────────────────────
 * It catches the failure that actually happened: two skies picked by eye and by
 * category whose suns turned out to be 1.1 degrees apart in elevation and 0.4
 * in azimuth. Nothing but measurement would have found that.
 *
 * It does **not** establish redundancy on its own, and the first version of it
 * over-claimed. A clear midday sky and a partly cloudy one can hold the sun in
 * the same place and still be different light — one throws hard-edged shadows
 * and the other does not — and an urban map shares a sun with a puresky while
 * putting towers outside the window instead of a horizon. All three are
 * deliberately in this set.
 *
 * So the threshold is tight enough to mean "these are the same photograph of
 * the sun", and the wording asks rather than concludes. Only maps with a key
 * light are compared: two overcast skies have no sun, and would otherwise be
 * reported as identical to each other on every run.
 */
const SAME_LIGHT_DEGREES = 2.5

const directional = written.filter((row) => row.report.keyLight.directionality >= DIRECTIONAL)
for (let i = 0; i < directional.length; i++) {
  for (let j = i + 1; j < directional.length; j++) {
    const a = directional[i]
    const b = directional[j]
    const elevation = Math.abs(a.report.keyLight.elevation - b.report.keyLight.elevation)
    const azimuth = Math.abs(a.report.keyLight.azimuth - b.report.keyLight.azimuth)
    if (elevation < SAME_LIGHT_DEGREES && azimuth < SAME_LIGHT_DEGREES) {
      console.log(
        `  NOTE: ${a.id} and ${b.id} hold the sun in the same place ` +
          `(${elevation.toFixed(1)} deg elevation apart, ${azimuth.toFixed(1)} azimuth).\n` +
          '        Check they differ in cloud cover or horizon; if they do not, one is redundant.',
      )
    }
  }
}

// ---- Generate ----------------------------------------------------------------

/**
 * Emit the module.
 *
 * Generated in full and overwritten, unlike items.ts which from-hub.mjs
 * deliberately refuses to rewrite. The difference is that items.ts is
 * hand-curated source carrying comments that explain individual choices, and
 * this file has never been touched by a person — every judgement in it lives in
 * the table above, in this script, where it is version-controlled next to its
 * reason.
 */
const quote = (value) => JSON.stringify(value)

const entries = written.map((row) => {
  const asset = row.asset
  const authors = asset.authors?.join(', ') || 'Poly Haven'
  return `  {
    id: ${quote(row.id)},
    name: ${quote(row.name)},
    kind: ${quote(row.kind)},
    note: ${quote(row.note)},
    url: ${quote(`${PUBLIC_PREFIX}/${row.id}.hdr`)},
    thumbnail: ${quote(`${PUBLIC_PREFIX}/${row.id}.jpg`)},
    licence: ${quote(asset.licenceName)},
    author: ${quote(authors)},
    source: ${quote(asset.sourceUrl)},
    sun: ${
      row.report.keyLight.directionality >= DIRECTIONAL
        ? `{ elevation: ${row.report.keyLight.elevation}, azimuth: ${row.report.keyLight.azimuth} }`
        : 'null'
    },${row.default ? '\n    isDefault: true,' : ''}
  },`
})

const totalBytes = written.reduce(
  (sum, row) => sum + row.report.conditioned.bytes + (row.report.thumbnail?.bytes ?? 0),
  0,
)

const module = `// Generated by tools/asset-ingest/environments.mjs — do not edit by hand.
//
// Re-run that script to change this list. Every environment here, and the
// reason it was chosen, is in the ENVIRONMENTS table at the top of it.
//
// ${written.length} maps, ${(totalBytes / 1024 / 1024).toFixed(1)} MB including previews, all conditioned to ${WIDTH}px wide.

/**
 * A lighting environment a scene can be rendered under.
 *
 * ── Why the licence fields are on every one of these ────────────────────────
 * The set that ships today is entirely CC0, so nobody is owed a credit. That is
 * a fact about this list, not about the type — the moment one CC-BY sky is
 * added, an obligation exists and nothing about the render would reveal it.
 *
 * These four fields are deliberately the same shape as \`AssetModel\`, so an
 * environment can be handed to the credits path the moment that path learns to
 * ask about the scene's environment as well as its furniture. \`creditsFor\`
 * currently walks placed objects only, which means a credited HDRI would be
 * silently dropped today.
 */
export interface EnvironmentPreset {
  id: string
  name: string
  kind: EnvironmentKind
  /** Shown in the picker: what this light does, not where it was photographed. */
  note: string
  /** Equirectangular .hdr, conditioned to ${WIDTH}px. What \`scene.hdriUrl\` stores. */
  url: string
  /** Tone-mapped preview for the picker. */
  thumbnail: string
  licence: string
  author: string
  source: string
  /**
   * Where the key light sits, measured from the shipped file. Null when the sky
   * is diffuse enough to have no key light — an overcast map has no sun, and
   * offering a direction for one would be inventing it.
   *
   * \`elevation\` is degrees above the horizon, and it is shadow length: a sun at
   * 29 degrees throws a shadow 1.8x the height of what casts it, one at 43
   * throws 1.07x. \`azimuth\` is degrees off the model's -Z, positive clockwise
   * seen from above.
   *
   * Measured rather than declared because two environments picked by eye and by
   * category turned out to be the same light 1.1 degrees apart, and no tag,
   * name or note revealed it.
   */
  sun: { elevation: number; azimuth: number } | null
  /** The one offered when a scene has never had an environment chosen. */
  isDefault?: boolean
}

export type EnvironmentKind =
${KINDS.map(([id]) => `  | ${quote(id)}`).join('\n')}

/** Group labels, in the order a picker should show them. */
export const ENVIRONMENT_KINDS: ReadonlyArray<{ id: EnvironmentKind; label: string }> = [
${KINDS.map(([id, label]) => `  { id: ${quote(id)}, label: ${quote(label)} },`).join('\n')}
]

export const ENVIRONMENTS: readonly EnvironmentPreset[] = [
${entries.join('\n')}
]

export const environmentById = (id: string): EnvironmentPreset | undefined =>
  ENVIRONMENTS.find((environment) => environment.id === id)

/** The environment matching a stored \`scene.hdriUrl\`, if it is one of ours. */
export const environmentByUrl = (url: string | null): EnvironmentPreset | undefined =>
  url ? ENVIRONMENTS.find((environment) => environment.url === url) : undefined

export const defaultEnvironment = (): EnvironmentPreset =>
  ENVIRONMENTS.find((environment) => environment.isDefault) ?? ENVIRONMENTS[0]
`

await writeFile(MODULE, module, 'utf8')

/**
 * Remove maps for environments that are no longer in the table.
 *
 * ── Why this is not optional tidying ────────────────────────────────────────
 * Renaming one entry during development left `clear-sun.hdr` and its preview
 * behind — 1.1 MB of binary that the generated module no longer referenced,
 * that nothing would ever load, and that was one `git add` away from being in
 * this repository's history permanently. Binaries do not leave a git history
 * once they arrive.
 *
 * Nothing errored, and the directory looked correct: twelve environments in the
 * module, twenty-six files on disk, and the discrepancy visible only to someone
 * counting. The same shape as every other fault in this repo.
 *
 * Scoped deliberately: only the two extensions this script writes, only in its
 * own output directory, and every removal is named. A prune that silently
 * cleared a directory would be a worse bug than the one it fixes.
 */
const keep = new Set(written.flatMap((row) => [`${row.id}.hdr`, `${row.id}.jpg`]))
const orphans = (await readdir(OUT_DIR)).filter(
  (name) => /\.(hdr|jpg)$/i.test(name) && !keep.has(name),
)

if (orphans.length > 0) {
  console.log(`  removing ${orphans.length} file(s) no longer in the table:`)
  for (const name of orphans) {
    await rm(join(OUT_DIR, name))
    console.log(`    ${name}`)
  }
  console.log()
}

console.log(`  wrote ${MODULE}`)
console.log(`  wrote ${written.length} maps + previews to ${OUT_DIR}`)
console.log(`  total ${(totalBytes / 1024 / 1024).toFixed(1)} MB\n`)

if (unavailable.length > 0) {
  console.log(
    `  NOTE: ${unavailable.length} of ${rows.length} selected environments are not in the module.\n`,
  )
}
