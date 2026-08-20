import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'

/**
 * Object storage.
 *
 * ── The shape this deliberately has ─────────────────────────────────────────
 * The reference product never sends a file through its API: the client asks for
 * a presigned S3 URL and PUTs straight to the bucket, so the bytes never touch
 * compute. That is the right design, and it is why their Lambda bill survives
 * 3 MB scenes.
 *
 * This driver does the opposite — it streams through the API onto local disk —
 * because there is no bucket on a laptop, and requiring an AWS account to draw
 * a floor plan would be a worse trade than the one it saves. The *interface* is
 * shaped for the presigned path so switching is mechanical:
 *
 *   put()      → becomes "presign, client uploads, confirm"
 *   urlFor()   → becomes the CDN URL
 *   remove()   → becomes DeleteObject
 *
 * Route handlers only ever call these three, so none of them changes.
 *
 * Anything genuinely large — models, HDRIs, baked lightmaps — should go
 * straight to the presigned path when it is written, not through here. This is
 * for floor-plan rasters, which are megabytes, not hundreds of megabytes.
 */

const ROOT = resolve(process.env.UPLOAD_DIR ?? './.data/uploads')

/** Public URL prefix. In production this is a CDN in front of the bucket. */
const PUBLIC_PREFIX = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads'

/**
 * What may be stored, and what extension each type gets.
 *
 * An allow-list, not a block-list. The stored extension is derived from the
 * *content type we accepted*, never from the filename the client sent —
 * otherwise an upload called `plan.png.html` gets written with an extension
 * that a browser will happily execute when it is served back.
 */
const ALLOWED = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
])

export const allowedTypes = () => [...ALLOWED.keys()]

export class UnsupportedType extends Error {
  constructor(type) {
    super(`Files of type ${type || 'unknown'} cannot be uploaded.`)
    this.name = 'UnsupportedType'
    this.status = 415
  }
}

/**
 * Store bytes and return a key plus a URL.
 *
 * The key embeds a content hash, which gives deduplication for free — the same
 * drawing uploaded to five projects is stored once — and makes the URL
 * immutable, so it can be cached forever without a cache-busting query.
 */
export async function put(buffer, contentType, { prefix = '' } = {}) {
  const extension = ALLOWED.get(contentType)
  if (!extension) throw new UnsupportedType(contentType)

  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  const key = join(prefix, `${digest}${extension}`).split(sep).join('/')
  const path = pathFor(key)

  await mkdir(dirname(path), { recursive: true })

  // Skip the write if the identical bytes are already there. Cheap, and it
  // keeps mtimes stable so a re-upload does not look like a change.
  try {
    await stat(path)
  } catch {
    await writeFile(path, buffer)
  }

  return { key, url: `${PUBLIC_PREFIX}/${key}`, bytes: buffer.length, contentType }
}

export function remove(key) {
  return unlink(pathFor(key)).catch(() => {
    /* already gone is the desired end state */
  })
}

/**
 * Open a stored object for reading.
 *
 * Returns null rather than throwing for anything that is not a real, safe key,
 * so the route can answer 404 without distinguishing "missing" from "you tried
 * to escape the directory" — which would confirm the traversal was understood.
 */
export async function open(key) {
  const path = pathFor(key)
  if (!path) return null

  try {
    const info = await stat(path)
    if (!info.isFile()) return null

    const type = [...ALLOWED.entries()].find(([, ext]) => extname(path) === ext)?.[0]
    if (!type) return null

    return { stream: createReadStream(path), size: info.size, contentType: type }
  } catch {
    return null
  }
}

/**
 * Resolve a key to a path inside ROOT, or null.
 *
 * The check is on the *resolved* path, not on the key text. Filtering for `..`
 * in the string is the classic mistake: it misses URL-encoded forms, backslash
 * separators on Windows, and symlinks. Resolving first and then confirming the
 * result is still under ROOT is the only version that holds.
 */
function pathFor(key) {
  const path = resolve(ROOT, key)
  const root = ROOT.endsWith(sep) ? ROOT : ROOT + sep
  return path === ROOT || path.startsWith(root) ? path : null
}

/** A short opaque id, for keys that should not be content-addressed. */
export const opaqueId = () => randomBytes(12).toString('hex')
