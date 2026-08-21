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
  // Scene geometry on its way to the render worker, and baked results coming
  // back. Binary glTF only — the .gltf + separate-buffer form is several files
  // that have to stay together, and half an upload is worse than none.
  ['model/gltf-binary', '.glb'],
  // Presentation decks. Almost nobody sends a bare drawing — they send the PDF
  // they showed the client, with the floor plans on page three at a resolution
  // no screenshot would match. Served back as an attachment, never inline:
  // a PDF can carry script, and this origin hands out unauthenticated URLs.
  ['application/pdf', '.pdf'],
  // CAD drawings, for the reconstruction engine. DWG is what architects
  // actually send; DXF is what they send when asked nicely. Both are read
  // server-side and never served back inline.
  ['image/vnd.dwg', '.dwg'],
  ['image/vnd.dxf', '.dxf'],
  // Vector plans produced by the reconstruction engine. Served as an
  // ATTACHMENT, never inline — an SVG can carry script, and these URLs are
  // unauthenticated and same-origin with the API. See uploads.js's disposition.
  ['image/svg+xml', '.svg'],
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
 * Resolve a key to a local path, for a consumer that opens the file itself.
 *
 * `open()` hands back a read stream, which is right for serving bytes over HTTP
 * and wrong for handing a file to a subprocess — the CAD engine is a separate
 * Python process that opens the drawing itself, and giving it a stream would
 * mean buffering a 34 MB DXF through Node for no reason.
 *
 * The safety is identical to `open()`'s, and deliberately so: the check is on
 * the resolved path rather than the key text, the extension must be one we
 * accepted, and anything that is not a real file inside ROOT comes back null so
 * the caller answers 404 without confirming that a traversal was understood.
 */
export async function pathOf(key) {
  const path = pathFor(key)
  if (!path) return null

  try {
    const info = await stat(path)
    if (!info.isFile()) return null

    const contentType = [...ALLOWED.entries()].find(([, ext]) => extname(path) === ext)?.[0]
    if (!contentType) return null

    return { path, size: info.size, contentType }
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

/**
 * Turn a stored public URL back into something the render worker can open.
 *
 * The studio stores `/uploads/scenes/<user>/<hash>.glb` — a relative path,
 * deliberately. Storing the absolute URL instead would bake in whichever
 * hostname the browser happened to use, so a scene saved from `192.168.1.36`
 * would be unreachable from a worker resolving `localhost`, and vice versa.
 *
 * With a local worker the file is already on disk, so hand it the path and skip
 * the HTTP round trip entirely. Anything already absolute is somebody else's
 * URL and passes through untouched.
 *
 * Returns null for a path that is ours but escapes the storage root — the
 * caller should refuse the job rather than hand the worker a surprise.
 */
export function resolveUrl(url) {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (!url.startsWith(`${PUBLIC_PREFIX}/`)) return url

  return pathFor(url.slice(PUBLIC_PREFIX.length + 1))
}
