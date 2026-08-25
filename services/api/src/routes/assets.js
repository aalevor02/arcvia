import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { requireAuth } from '../lib/auth.js'
import {
  CONDITIONED_DIR,
  NotConditionable,
  conditionedAssetModel,
  conditionModel,
  hubPathOf,
  pickPreview,
  search,
  stats,
} from '../lib/assetHub.js'

/**
 * The asset hub, browsable from the editor.
 *
 * ── What is authenticated and what is not ───────────────────────────────────
 * Search and conditioning require a session — they are editor features, and
 * conditioning spends this machine's CPU. The file and preview routes are
 * unauthenticated, exactly as `/uploads` is: the same "gate the manifest, not
 * the files" posture the rest of the product takes, and the studio's <img>
 * tags cannot send an Authorization header anyway.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * No route serves a raw hub MODEL to a browser. The browsable surface is
 * metadata and preview images; the only GLB that leaves this API is one the
 * conditioner has already brought inside web budgets. Serving raw scans would
 * quietly reintroduce the 53 MB furniture this pipeline exists to prevent.
 */

/** Types a preview or hub file may be served as, inline. Everything else 404s. */
const SERVABLE = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ogg', 'audio/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
])

async function sendFile(reply, file, contentType) {
  const info = await stat(file).catch(() => null)
  if (!info || !info.isFile()) return reply.status(404).send({ message: 'Not found.' })

  return reply
    .header('Content-Type', contentType)
    .header('Content-Length', info.size)
    .header('Cache-Control', 'public, max-age=86400')
    .header('X-Content-Type-Options', 'nosniff')
    .send(createReadStream(file))
}

/** JSON API under /assets/hub. */
export async function registerAssetRoutes(app) {
  app.get('/hub', { preHandler: requireAuth }, async (request, reply) => {
    const result = await search(request.query)
    if (!result) {
      return reply
        .status(503)
        .send({ message: 'The asset hub is not present on this machine.' })
    }
    // The preview URL is derived here rather than client-side so the studio
    // never learns the hub's on-disk layout beyond the manifest's own paths.
    for (const asset of result.assets) {
      asset.previewUrl = `/hub/preview/${asset.path}`
    }
    return result
  })

  app.get('/hub/stats', { preHandler: requireAuth }, async (request, reply) => {
    const result = await stats()
    if (!result) {
      return reply
        .status(503)
        .send({ message: 'The asset hub is not present on this machine.' })
    }
    return result
  })

  /**
   * Condition one hub model to a web budget and hand back a URL.
   *
   * Synchronous by design: a cache hit answers instantly, a small model takes
   * Blender ~20-60 s, and anything the conditioner cannot land is refused
   * before a byte of work. Requests queue behind one another — this machine
   * is also the render worker, and two Blenders are slower than one twice.
   */
  app.post('/hub/condition', { preHandler: requireAuth }, async (request, reply) => {
    const { ref, budget } = request.body ?? {}
    if (typeof ref !== 'string' || !ref.includes(':')) {
      return reply.status(400).send({ message: 'Which asset? Pass its ref, e.g. "polyhaven:ArmChair_01".' })
    }

    try {
      const result = await conditionModel(ref, { budget })
      const url = `/hub/conditioned/${result.name}`
      return {
        url,
        triangles: result.triangles,
        bytes: result.bytes,
        cached: result.cached,
        model: conditionedAssetModel(result.asset, result, url),
      }
    } catch (error) {
      if (error instanceof NotConditionable) {
        return reply.status(error.status).send({ message: error.message })
      }
      throw error
    }
  })
}

/** File routes at the root — /hub/preview/*, /hub/conditioned/*. */
export async function registerHubFileRoutes(app) {
  app.get('/hub/preview/*', async (request, reply) => {
    const dir = hubPathOf(request.params['*'])
    if (!dir) return reply.status(404).send({ message: 'Not found.' })

    const file = await pickPreview(dir)
    if (!file) return reply.status(404).send({ message: 'No preview for this asset.' })

    const type = SERVABLE.get(extname(file).toLowerCase())
    if (!type) return reply.status(404).send({ message: 'No preview for this asset.' })
    return sendFile(reply, file, type)
  })

  app.get('/hub/conditioned/:name', async (request, reply) => {
    const name = request.params.name
    // Names are minted by conditionModel from [ref]--[budget].glb; anything
    // outside that alphabet is not one of ours.
    if (!/^[A-Za-z0-9-]+--\d+\.glb$/.test(name)) {
      return reply.status(404).send({ message: 'Not found.' })
    }
    return sendFile(reply, join(CONDITIONED_DIR, name), 'model/gltf-binary')
  })
}
