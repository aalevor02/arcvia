#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { checkLicence } from './licence.mjs'

const run = promisify(execFile)

/**
 * Bring a Sketchfab model into the catalogue.
 *
 *   node tools/asset-ingest/ingest.mjs \
 *     --uid f42568b66d42414791faf83b23bce799 \
 *     --item sofa-3 --budget 6000
 *
 * Needs SKETCHFAB_TOKEN in the environment or in the repo's .env. Get one from
 * https://sketchfab.com/settings/password (the "API Token" field).
 *
 * ── What this is really for ────────────────────────────────────────────────
 * Downloading is the easy part and not the point. This exists to make two
 * things impossible to skip:
 *
 *   1. shipping a model nobody is allowed to ship
 *   2. shipping a model nobody has conditioned
 *
 * Both are silent failures. A non-commercial model renders exactly as well as a
 * CC-BY one right up until somebody notices, and a 700,000-triangle sofa loads
 * fine on the machine of the person who added it. So the licence is checked
 * before the bytes are fetched, and the conditioning step is not optional.
 */

// ---- Arguments and configuration -------------------------------------------

function args() {
  const out = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

/** Token from the environment, falling back to the repo .env. */
async function token(root) {
  if (process.env.SKETCHFAB_TOKEN) return process.env.SKETCHFAB_TOKEN
  try {
    const env = await readFile(join(root, '.env'), 'utf8')
    const line = env.split('\n').find((l) => l.trim().startsWith('SKETCHFAB_TOKEN='))
    if (line) return line.split('=').slice(1).join('=').trim()
  } catch {
    /* no .env is fine; the message below covers it */
  }
  throw new Error(
    'No SKETCHFAB_TOKEN. Get one from https://sketchfab.com/settings/password\n' +
      'and add it to .env as  SKETCHFAB_TOKEN=…',
  )
}

// ---- Sketchfab --------------------------------------------------------------

async function modelInfo(uid, auth) {
  const response = await fetch(`https://api.sketchfab.com/v3/models/${uid}`, {
    headers: { Authorization: `Token ${auth}` },
  })
  if (!response.ok) {
    throw new Error(`Sketchfab returned ${response.status} for model ${uid}`)
  }
  return response.json()
}

/**
 * Ask for a download and pick the best format on offer.
 *
 * These URLs are short-lived — minutes — so they are fetched immediately rather
 * than stored. GLB is preferred where it exists because it needs no unpacking;
 * the gltf archive is the common case.
 */
async function downloadUrls(uid, auth) {
  const response = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, {
    headers: { Authorization: `Token ${auth}` },
  })
  if (response.status === 403) {
    throw new Error(
      'Sketchfab refused the download (403). The model may not be downloadable, ' +
        'or the token may lack permission.',
    )
  }
  if (!response.ok) throw new Error(`Sketchfab download request failed: ${response.status}`)

  const body = await response.json()
  if (body.glb?.url) return { url: body.glb.url, kind: 'glb' }
  if (body.gltf?.url) return { url: body.gltf.url, kind: 'zip' }
  throw new Error('Sketchfab offered no glb or gltf download for this model')
}

/**
 * Fetch the payload and leave a single importable file on disk.
 *
 * The gltf archive is a directory of .gltf, .bin and textures that only work
 * together, so the whole thing is expanded and the .gltf handed to Blender —
 * which resolves the siblings itself.
 */
async function fetchModel({ url, kind }, workDir) {
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())

  if (kind === 'glb') {
    const path = join(workDir, 'source.glb')
    await writeFile(path, bytes)
    return path
  }

  const files = unzipSync(new Uint8Array(bytes))
  let entry = null

  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue
    const path = join(workDir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(data))
    // `.gltf` wins over `.bin`/textures; there is normally exactly one.
    if (extname(name).toLowerCase() === '.gltf') entry = path
  }

  if (!entry) throw new Error('The archive contained no .gltf file')
  return entry
}

// ---- Main -------------------------------------------------------------------

const options = args()
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../..')

if (!options.uid || !options.item) {
  console.error(
    'usage: node ingest.mjs --uid <sketchfab-uid> --item <catalogue-item-id> [--budget 6000]',
  )
  process.exit(2)
}

const auth = await token(root)

// Licence first, before a single byte of model is fetched. Checking after
// downloading would mean the refused model is already on disk, which is the
// state this is meant to avoid.
const info = await modelInfo(options.uid, auth)
const licence = checkLicence(info.license)

console.log(`model    : ${info.name}`)
console.log(`author   : ${info.user?.displayName ?? info.user?.username}`)
console.log(`licence  : ${licence.name}${licence.attribution ? ' (credit required)' : ''}`)
console.log(`faces    : ${info.faceCount?.toLocaleString() ?? 'unknown'}`)

// Catalogue dimensions are the target. The asset does not get a vote: a sofa is
// the size the catalogue says a sofa is, or every clearance in the plan is a
// lie. Read from the built catalogue so there is one definition, not two.
const itemsSource = await readFile(join(root, 'apps/studio/src/catalogue/items.ts'), 'utf8')
const entry = itemsSource.match(
  new RegExp(`id: '${options.item}',[\\s\\S]*?size: \\{([^}]+)\\}`),
)
if (!entry) throw new Error(`No catalogue item "${options.item}" with a size`)

const size = Object.fromEntries(
  entry[1].split(',').map((pair) => {
    const [key, value] = pair.split(':').map((s) => s.trim())
    return [key, Number(value)]
  }),
)

const workDir = join(root, '.data/asset-ingest', options.uid)
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })

const source = await fetchModel(await downloadUrls(options.uid, auth), workDir)

const outDir = join(root, 'apps/studio/public/models')
await mkdir(outDir, { recursive: true })
const output = join(outDir, `${options.item}.glb`)

const blender = process.env.BLENDER_PATH ?? 'blender'
const { stdout } = await run(blender, [
  '-b',
  '--python',
  join(root, 'services/render-worker/condition_asset.py'),
  '--',
  '--input', source,
  '--output', output,
  '--budget', String(options.budget ?? 6000),
  '--width', String(size.width),
  '--depth', String(size.depth),
  '--height', String(size.height),
], { maxBuffer: 32 * 1024 * 1024 })

const report = stdout.split('\n').find((l) => l.startsWith('ARCVIA_ASSET:'))
if (!report) {
  console.error(stdout.split('\n').filter((l) => l.includes('ARCVIA_')).join('\n'))
  throw new Error('Conditioning produced no report; the model was not written')
}
const conditioned = JSON.parse(report.slice('ARCVIA_ASSET:'.length))

for (const warning of stdout.split('\n').filter((l) => l.startsWith('ARCVIA_WARN:'))) {
  console.warn(`warning  : ${warning.slice('ARCVIA_WARN:'.length)}`)
}

console.log(
  `triangles: ${conditioned.decimate.before.toLocaleString()} → ` +
    `${conditioned.decimate.after.toLocaleString()}`,
)
console.log(`size     : ${conditioned.placement.size.join(' × ')} m` +
  (conditioned.placement.rotated ? ' (stood upright)' : ''))

const facing = conditioned.facing ?? { yaw: 0, confidence: 0, back: 'unknown' }
console.log(
  `facing   : back is ${facing.back}, yaw ${facing.yaw}° ` +
    `(confidence ${(facing.confidence * 100).toFixed(0)}%)`,
)
if (facing.back === 'ambiguous') {
  console.warn(
    '           too symmetric to call — left unrotated. If it faces the wrong',
  )
  console.warn(
    '           way in the editor, set yaw by hand in the catalogue entry.',
  )
}
console.log(`written  : ${output} (${(conditioned.bytes / 1024).toFixed(0)} KB)`)

// Printed rather than written into items.ts. Editing source from a script is
// how a catalogue file ends up unreviewable — this is a paste that a person
// sees, next to the licence they are agreeing to on the product's behalf.
console.log('\nAdd to the catalogue entry:\n')
console.log(
  '    ' +
    JSON.stringify(
      {
        model: {
          url: `/models/${options.item}.glb`,
          licence: licence.name,
          author: info.user?.displayName ?? info.user?.username ?? 'Unknown',
          source: info.viewerUrl ?? `https://sketchfab.com/3d-models/${options.uid}`,
          triangles: conditioned.decimate.after,
          ...(facing.yaw ? { yaw: facing.yaw } : {}),
        },
      },
      null,
      2,
    ).replace(/\n/g, '\n    '),
)
