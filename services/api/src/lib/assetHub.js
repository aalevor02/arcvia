import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The shared asset hub, read live.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 * `A:\Assets\Hub` is the machine's licence-gated asset warehouse — thousands of
 * CC0/CC-BY models, materials and HDRIs with provenance recorded beside the
 * bytes. The *catalogue* (`apps/studio/src/catalogue/items.ts`) remains the
 * product: curated, conditioned, shipped with the repo. This module is the
 * window onto the warehouse — browse it, preview it, and condition one asset
 * on demand — so finding the next catalogue model does not require leaving the
 * editor.
 *
 * It deliberately does NOT place hub assets into scenes. A raw hub model is
 * 300k–17M triangles with 2–4K textures; serving those to viewers is the
 * failure the conditioning pipeline exists to prevent.
 *
 * The hub is a development-machine resource. On a deployment with no hub the
 * routes answer 503 with a plain reason, and nothing else changes.
 */

const HUB_DIR = resolve(process.env.ASSET_HUB_DIR ?? 'A:/Assets/Hub')

/** Where conditioned one-off GLBs are cached. Content-keyed by ref + budget. */
export const CONDITIONED_DIR = resolve(
  process.env.HUB_CONDITIONED_DIR ?? './.data/hub-conditioned',
)

/**
 * Same containment rule as storage.js: resolve first, then confirm the result
 * is still inside the root. Filtering the key text for `..` misses encodings,
 * backslashes and symlinks.
 */
function within(base, key) {
  const path = resolve(base, key)
  const root = base.endsWith(sep) ? base : base + sep
  return path === base || path.startsWith(root) ? path : null
}

export const hubPathOf = (rel) => within(HUB_DIR, rel)

// ---- The manifest, cached on its mtime --------------------------------------

let cache = { mtimeMs: 0, manifest: null }

/**
 * Read the hub manifest, re-parsing only when the file has actually changed.
 *
 * A harvest can append thousands of rows; a 2.7 MB JSON parse per request
 * would be the sort of self-inflicted load this API otherwise avoids. The
 * mtime check is one stat.
 */
export async function manifest() {
  const path = join(HUB_DIR, 'manifest.json')
  const info = await stat(path).catch(() => null)
  if (!info) return null

  if (info.mtimeMs !== cache.mtimeMs) {
    cache = {
      mtimeMs: info.mtimeMs,
      manifest: JSON.parse(await readFile(path, 'utf8')),
    }
  }
  return cache.manifest
}

/** Search the hub. Filters are conjunctive; text matches ref, name, authors. */
export async function search({ q, kind, source, licence, limit = 40, offset = 0 } = {}) {
  const data = await manifest()
  if (!data) return null

  let assets = data.assets
  if (kind) assets = assets.filter((a) => a.kind === kind)
  if (source) assets = assets.filter((a) => a.source === source)
  if (licence === 'cc0') assets = assets.filter((a) => a.licence === 'cc0')
  if (licence === 'credit') assets = assets.filter((a) => a.attribution)
  if (q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean)
    assets = assets.filter((a) => {
      const hay = [a.ref, a.name, ...(a.authors ?? [])].join(' ').toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }

  const size = Math.min(Number(limit) || 40, 100)
  const start = Math.max(Number(offset) || 0, 0)

  return {
    total: assets.length,
    updated: data.updated,
    assets: assets.slice(start, start + size).map((a) => ({
      ref: a.ref,
      name: a.name,
      kind: a.kind,
      source: a.source,
      sourceUrl: a.sourceUrl,
      licence: a.licence,
      licenceName: a.licenceName,
      attribution: !!a.attribution,
      authors: a.authors ?? [],
      polycount: a.polycount ?? null,
      path: a.path,
    })),
  }
}

export async function stats() {
  const data = await manifest()
  if (!data) return null

  const byKind = {}
  const bySource = {}
  let bytes = 0
  for (const a of data.assets) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
    bySource[a.source] = (bySource[a.source] ?? 0) + 1
    bytes += a.bytes ?? 0
  }
  return { total: data.assets.length, updated: data.updated, byKind, bySource, bytes }
}

// ---- Previews ---------------------------------------------------------------

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/**
 * The image that best represents an asset directory — identical policy to the
 * hub's own catalog site: a rendered preview or sample first, the asset's
 * namesake render next, a colour map as a stand-in, and never a normal or
 * roughness map, which look like corruption rather than like the asset.
 */
const NOT_A_PICTURE =
  /(normal|nor_?(gl|dx)?|rough|displace|disp\b|height|metal|_ao\b|ambientocclusion|opacity|_arm_|_spec)/i

export async function pickPreview(assetDir) {
  const found = []
  const walk = async (dir, depth) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < 2) await walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (IMAGE.has(extname(entry.name).toLowerCase())) found.push(join(dir, entry.name))
    }
  }
  await walk(assetDir, 0)

  const slug = assetDir.split(sep).pop().toLowerCase()
  const score = (file) => {
    const name = file.split(sep).pop().toLowerCase()
    if (NOT_A_PICTURE.test(name)) return -1
    if (name.includes('preview')) return 100
    if (name.replace(/\.(png|jpe?g|webp|gif)$/, '') === slug) return 95
    if (name.includes('sample')) return 90
    if (name.includes('thumb') || name.includes('render')) return 85
    if (/(_color|_colour|albedo|diffuse|_diff_|basecolor)/.test(name)) return 70
    return 10
  }

  let best = null
  let bestScore = 0
  for (const file of found) {
    const points = score(file)
    if (points > bestScore) {
      best = file
      bestScore = points
    }
  }
  return best
}

// ---- On-demand conditioning -------------------------------------------------

const BLENDER = process.env.BLENDER_PATH ?? 'blender'

/**
 * Above this, refuse rather than try. Measured, not chosen: a 7.8M-triangle
 * scan refused to decimate below 349k "without destroying the model" (53 MB
 * out), and a 17.4M one crashed Blender's exporter. The conditioner is honest
 * about what it cannot do; this makes the API honest about it up front.
 */
const CONDITIONABLE_TRIANGLES = 600_000

/**
 * One Blender at a time. This machine is also the render worker, and the
 * ingest tooling already learned that parallel Blender turns a slow job into
 * an unusable machine. Requests queue behind the chain and time out at the
 * route layer if someone stacks a crowd.
 */
let chain = Promise.resolve()

export function conditionQueued(task) {
  const next = chain.then(task, task)
  // The chain must survive a failed task or every later request inherits the
  // rejection.
  chain = next.catch(() => {})
  return next
}

/** The model file inside an asset directory: glb > gltf > fbx > obj > dae. */
export async function modelFileIn(dir) {
  const entries = await readdir(dir).catch(() => [])
  for (const wanted of ['.glb', '.gltf', '.fbx', '.obj', '.dae']) {
    const found = entries.find((name) => extname(name).toLowerCase() === wanted)
    if (found) return join(dir, found)
  }
  return null
}

export class NotConditionable extends Error {
  constructor(message, status = 422) {
    super(message)
    this.status = status
  }
}

/**
 * Condition one hub model to a web budget, cached.
 *
 * Returns { file, name, triangles, bytes, cached }. The output name is derived
 * from the ref and budget, so a repeat request is a stat, not a Blender run.
 */
export async function conditionModel(ref, { budget = 5000, conditionScript } = {}) {
  const data = await manifest()
  if (!data) throw new NotConditionable('The asset hub is not present on this machine.', 503)

  const asset = data.assets.find((a) => a.ref === ref)
  if (!asset) throw new NotConditionable(`No hub asset "${ref}".`, 404)
  if (asset.kind !== 'model') {
    throw new NotConditionable(`"${ref}" is a ${asset.kind} — only models can be conditioned.`)
  }
  if (asset.polycount && asset.polycount > CONDITIONABLE_TRIANGLES) {
    throw new NotConditionable(
      `"${asset.name}" is ${asset.polycount.toLocaleString()} triangles — beyond what ` +
        'on-demand conditioning can land. Ingest it through tools/asset-ingest instead.',
    )
  }

  const dir = hubPathOf(asset.path)
  if (!dir) throw new NotConditionable(`"${ref}" resolves outside the hub.`, 400)

  const source = await modelFileIn(dir)
  if (!source) throw new NotConditionable(`"${ref}" has no importable model file.`)

  const capped = Math.min(Math.max(Number(budget) || 5000, 500), 20000)
  const name = `${ref.replace(/[^a-z0-9]+/gi, '-')}--${capped}.glb`
  await mkdir(CONDITIONED_DIR, { recursive: true })
  const output = join(CONDITIONED_DIR, name)

  const existing = await stat(output).catch(() => null)
  if (existing && existing.size > 0) {
    return { file: output, name, triangles: null, bytes: existing.size, cached: true }
  }

  const script =
    conditionScript ?? resolve(process.cwd(), '../render-worker/condition_asset.py')

  const { stdout } = await conditionQueued(() =>
    run(
      BLENDER,
      ['-b', '--python', script, '--', '--input', source, '--output', output,
        '--budget', String(capped)],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 },
    ),
  )

  const report = stdout.split('\n').find((line) => line.startsWith('ARCVIA_ASSET:'))
  if (!report) throw new NotConditionable('Conditioning produced no report.', 500)
  const conditioned = JSON.parse(report.slice('ARCVIA_ASSET:'.length))

  const written = await stat(output).catch(() => null)
  if (!written) throw new NotConditionable('Conditioning wrote no file.', 500)

  return {
    file: output,
    name,
    triangles: conditioned.decimate?.after ?? null,
    bytes: written.size,
    cached: false,
  }
}
