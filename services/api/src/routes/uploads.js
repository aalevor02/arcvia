import { requireAuth } from '../lib/auth.js'
import { allowedTypes, open, put, UnsupportedType } from '../lib/storage.js'

/**
 * File uploads, and serving them back.
 *
 * Two kinds, deliberately on separate routes rather than one endpoint that
 * sniffs and decides: they have different size limits, different prefixes and
 * different lifetimes, and a single route would have to grow a mode flag to
 * express that anyway.
 *
 *   /floorplan  drawings to trace over
 *   /scene      generated geometry on its way to the render worker
 *
 * HDRIs and anything else genuinely large should go to object storage through
 * a presigned URL when that path exists, rather than being added here because
 * it was convenient.
 */

/** Floor plans are photographs of drawings, not textures. 12 MB is generous. */
const MAX_BYTES = 12 * 1024 * 1024

/**
 * Generated scenes are bigger, and they are transient — they exist to be handed
 * to Blender and are content-addressed, so re-baking an unchanged scene reuses
 * the same file rather than adding another.
 */
const MAX_SCENE_BYTES = 64 * 1024 * 1024

export async function registerUploadRoutes(app) {
  app.post('/floorplan', { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file()
    if (!file) return reply.status(400).send({ message: 'No file was uploaded.' })

    const buffer = await file.toBuffer()

    // Checked after reading because the multipart limit aborts the stream
    // itself; this catches the case where the global limit is higher than the
    // one that makes sense for this particular route.
    if (buffer.length > MAX_BYTES) {
      return reply.status(413).send({
        message: `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`,
      })
    }

    // Trust the sniffed bytes over the declared mimetype. A client can claim
    // anything in the header, and the extension is attacker-chosen too.
    const sniffed = sniff(buffer)
    if (!sniffed) {
      return reply.status(415).send({
        message: `That does not look like an image. Supported: ${allowedTypes().join(', ')}.`,
      })
    }

    try {
      const stored = await put(buffer, sniffed, {
        // Scoped per user so one account cannot enumerate another's uploads by
        // guessing keys — the hash makes that impractical anyway, but the
        // prefix means a future "delete everything this user uploaded" is a
        // directory operation rather than a scan.
        prefix: `floorplans/${request.auth.userId}`,
      })
      return reply.status(201).send(stored)
    } catch (error) {
      if (error instanceof UnsupportedType) {
        return reply.status(415).send({ message: error.message })
      }
      throw error
    }
  })

  /**
   * Scene geometry, on its way to the render worker.
   *
   * The studio exports what it has generated and posts it here; the render job
   * then names the stored URL as its input. The worker fetches it over HTTP,
   * which is why this has to be servable and not just written to a temp path.
   */
  app.post('/scene', { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file()
    if (!file) return reply.status(400).send({ message: 'No file was uploaded.' })

    const buffer = await file.toBuffer()

    if (buffer.length > MAX_SCENE_BYTES) {
      return reply.status(413).send({
        message: `That scene is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_SCENE_BYTES / 1024 / 1024} MB.`,
      })
    }

    if (sniff(buffer) !== 'model/gltf-binary') {
      return reply
        .status(415)
        .send({ message: 'A scene must be a binary glTF (.glb).' })
    }

    const stored = await put(buffer, 'model/gltf-binary', {
      prefix: `scenes/${request.auth.userId}`,
    })
    return reply.status(201).send(stored)
  })

  /**
   * Serve a stored file.
   *
   * Unauthenticated on purpose: these URLs go into `<img src>` and into
   * published output, where no bearer token can be attached. The key contains a
   * 128-bit content hash, so it is unguessable — which is the same security
   * model as an S3 pre-signed GET or a CDN path, and the same one the reference
   * uses. Do not put anything here that must not be readable by link.
   *
   * In production this route should never be hit: the CDN serves the bucket
   * directly. It exists so local development needs no bucket at all.
   */
  app.get('/*', async (request, reply) => {
    const key = request.params['*']
    const file = await open(key)
    if (!file) return reply.status(404).send({ message: 'Not found.' })

    return reply
      .header('Content-Type', file.contentType)
      .header('Content-Length', file.size)
      // Content-addressed, so the bytes behind a URL can never change.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      // Belt and braces: even though only image types are stored, tell the
      // browser not to reinterpret the response as something executable.
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.stream)
  })
}

/**
 * Identify an image from its magic bytes.
 *
 * Returns null for anything not recognised, which the caller turns into a 415.
 * Deliberately tiny: three formats, checked by signature, no dependency and no
 * parsing of attacker-controlled structure beyond the first twelve bytes.
 */
function sniff(buffer) {
  if (buffer.length < 12) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // glTF binary: magic 'glTF' followed by a version word.
  if (buffer.toString('ascii', 0, 4) === 'glTF') return 'model/gltf-binary'

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}
