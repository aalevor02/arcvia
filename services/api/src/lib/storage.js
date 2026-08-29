import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const STORAGE_PROVIDER = String(
  process.env.STORAGE_PROVIDER ??
    (process.env.NODE_ENV === 'production' ? 's3' : 'local'),
).toLowerCase()
if (!['local', 's3'].includes(STORAGE_PROVIDER)) {
  throw new Error(`STORAGE_PROVIDER=${STORAGE_PROVIDER} is unsupported; use local or s3`)
}

const S3_BUCKET = process.env.S3_BUCKET
const S3_REGION = process.env.S3_REGION
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID
const S3_SECRET_ACCESS_KEY =
  process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY

if (STORAGE_PROVIDER === 's3') {
  const missing = [
    !S3_BUCKET && 'S3_BUCKET',
    !S3_REGION && 'S3_REGION',
    !process.env.S3_PUBLIC_URL && 'S3_PUBLIC_URL',
  ].filter(Boolean)
  if (Boolean(S3_ACCESS_KEY_ID) !== Boolean(S3_SECRET_ACCESS_KEY)) {
    missing.push(
      'both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or neither for workload identity)',
    )
  }
  if (missing.length) {
    throw new Error(`S3 storage is missing: ${missing.join(', ')}`)
  }
}

let s3Client
function s3() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: S3_ACCESS_KEY_ID
        ? { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY }
        : undefined,
    })
  }
  return s3Client
}


/** Public URL prefix. In production this is a CDN in front of the bucket. */
const PUBLIC_PREFIX = String(
  process.env.S3_PUBLIC_URL ?? process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads',
).replace(/\/+$/, '')

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
  // The reconstruction engine's building.json — walls, rooms and fixture
  // placements the studio reads back to furnish the plan. Server-side puts
  // only in practice: user uploads are separately gated by magic-byte
  // sniffing, which recognises no JSON.
  ['application/json', '.json'],
])

function isSafeObjectKey(key) {
  if (typeof key !== 'string' || pathFor(key) === null) return false
  const extension = extname(key).toLowerCase()
  return [...ALLOWED.values()].includes(extension)
}


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
  if (STORAGE_PROVIDER === 's3') {
    let complete = false
    try {
      const existing = await s3().send(
        new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      )
      complete = Number(existing.ContentLength) === buffer.length
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound') {
        throw error
      }
    }
    if (!complete) {
      await s3().send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      )
    }
    return { key, url: `${PUBLIC_PREFIX}/${key}`, bytes: buffer.length, contentType }
  }

  const path = pathFor(key)

  await mkdir(dirname(path), { recursive: true })

  // ── Skip only a COMPLETE match, and write atomically ─────────────────────
  // The key is content-addressed, so an existing file of the RIGHT SIZE is the
  // identical bytes — skip it, cheap, and mtimes stay stable so a re-upload
  // does not look like a change. But `stat` succeeds for a HALF-written file
  // too: an earlier upload SIGKILLed mid-write (docker stop, OOM, ENOSPC) left
  // a truncated file, and this used to skip past it and answer 201 with the
  // full byte count. `uploads.js` then served those short bytes under
  // `Cache-Control: immutable`, and every re-upload of the same drawing hashed
  // to the same key and was skipped again — the architect re-uploads to fix it,
  // is told it worked, and gets the identical failure with no way to purge.
  //
  // So the skip is gated on size, and the write goes to a sibling `.tmp` then
  // renames over — atomic on one volume, so a crash mid-write leaves the tmp
  // file, never a torn key. `store.js` uses the same pattern for the database.
  let complete = false
  try {
    const info = await stat(path)
    complete = info.size === buffer.length
  } catch {
    complete = false
  }

  if (!complete) {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, buffer)
    await rename(tmp, path)
  }

  return { key, url: `${PUBLIC_PREFIX}/${key}`, bytes: buffer.length, contentType }
}

export function remove(key) {
  if (!isSafeObjectKey(key)) return Promise.resolve()
  if (STORAGE_PROVIDER === 's3') {
    return s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).then(() => {})
  }
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
  if (!isSafeObjectKey(key)) return null
  if (STORAGE_PROVIDER === 's3') {
    try {
      const object = await s3().send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      )
      if (!object.Body) return null
      return {
        stream: object.Body,
        size: Number(object.ContentLength ?? 0),
        contentType: object.ContentType ?? 'application/octet-stream',
      }
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') return null
      throw error
    }
  }
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
  if (!isSafeObjectKey(key)) return null
  if (STORAGE_PROVIDER === 's3') {
    const path = pathFor(key)
    if (!path) return null
    try {
      const object = await s3().send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      )
      if (!object.Body) return null
      const bytes = await object.Body.transformToByteArray()
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, path)
      return {
        path,
        size: bytes.length,
        contentType: object.ContentType ?? 'application/octet-stream',
      }
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') return null
      throw error
    }
  }
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
function within(base, key) {
  const path = resolve(base, key)
  const root = base.endsWith(sep) ? base : base + sep
  return path === base || path.startsWith(root) ? path : null
}

const pathFor = (key) => within(ROOT, key)

/**
 * Static assets that ship with the app instead of being uploaded.
 *
 * ── Why these need resolving at all ─────────────────────────────────────────
 * `/env/midday.hdr` is a real URL to the browser: the studio serves its own
 * `public/` directory, so the viewer loads it with no help from anybody. The
 * render worker is not a browser. It gets whatever `resolveUrl` returns and
 * hands it to `Path(...).resolve()`, and a root-relative URL is not a path.
 *
 * Without this entry `/env/midday.hdr` fell through unchanged, resolved against
 * the *current drive root*, and arrived at the worker as `A:\env\midday.hdr` —
 * which does not exist. The failure is split in a way that is genuinely hard to
 * read: the studio previews the sky correctly, because that half went through
 * the browser, and only the render fails.
 *
 * Resolved relative to this file rather than the working directory. The API is
 * started from at least three places (the repo root, services/api, and the test
 * harness) and a path built from `cwd` would be correct in some of them.
 */
const STATIC_ROOTS = new Map([
  ['/env/', resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/studio/public/env')],
])

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

  // Same containment rule as uploads: resolve first, then confirm the result is
  // still under the directory it claimed to be in. A caller getting null here
  // should refuse the job rather than pass the worker something unexpected.
  for (const [prefix, base] of STATIC_ROOTS) {
    if (!url.startsWith(prefix)) continue

    const path = within(base, url.slice(prefix.length))

    // ── Why a miss here has to be loud ──────────────────────────────────────
    // Returning null is correct — it is what a traversal attempt should get —
    // but null then flows to `render.js:216` as `hdriUrl: null`, and the worker
    // reads that as "no environment" and renders happily with its default sky.
    // So a rejected path, a typo, or a deployment where this directory simply
    // is not present all produce a successful render that is quietly missing
    // the thing the user picked.
    //
    // That is the same shape as the bug this branch was added to fix: the
    // studio previewed the sky, the render did not have it, and nothing said
    // so. Fixing it with a second silent failure would be a poor trade.
    //
    // A warning rather than a throw, because the render is still worth having.
    // The user chose an environment and should be told it did not arrive; they
    // should not lose the job over it.
    if (path === null) {
      console.warn(
        `[storage] "${url}" is under ${prefix} but does not resolve inside it. ` +
          'The render will proceed with no environment.',
      )
    }
    return path
  }

  if (!url.startsWith(`${PUBLIC_PREFIX}/`)) return url

  if (STORAGE_PROVIDER === 's3') {
    return url
  }

  return pathFor(url.slice(PUBLIC_PREFIX.length + 1))
}

/**
 * Is this one of OUR uploaded objects, and nothing else?
 *
 * `resolveUrl` is a resolver: its job is to turn a value the system produced
 * into a path, and its final branch deliberately passes through anything it
 * does not recognise. That is the wrong function to gate a CALLER-SUPPLIED
 * value with — an http(s) URL or a bare filesystem path sails through it and
 * on to `readFile`. This is the gate: it returns true only for a string of the
 * exact shape `uploadCapture` produces, `${PUBLIC_PREFIX}/<key>`, whose key
 * resolves to a real place inside ROOT.
 *
 * Containment is checked on the resolved path, not the text, for the same
 * reason `within` is — `../` filtering misses encodings, backslashes and
 * symlinks. `http://.../uploads/x` is rejected because it does not START with
 * the prefix (the scheme is in front of it), which is the point: an absolute
 * URL is never one of our keys.
 */
export function isOwnUpload(url) {
  if (typeof url !== 'string' || !url.startsWith(`${PUBLIC_PREFIX}/`)) return false
  return pathFor(url.slice(PUBLIC_PREFIX.length + 1)) !== null
}

/**
 * Is this a shipped environment asset (`/env/<name>.hdr`) that resolves inside
 * the env directory?
 *
 * The companion to isOwnUpload for the OTHER thing a render legitimately
 * references — a catalogue HDRI. Same discipline: prefix plus a resolved-path
 * containment check, so `/env/../../etc/passwd` and an absolute URL are both
 * rejected. Callers use `isOwnUpload(url) || isEnvAsset(url)` to gate a
 * caller-supplied hdriUrl before it reaches the worker.
 */
export function isEnvAsset(url) {
  if (typeof url !== 'string' || !url.startsWith('/env/')) return false
  const base = STATIC_ROOTS.get('/env/')
  return base ? within(base, url.slice('/env/'.length)) !== null : false
}
