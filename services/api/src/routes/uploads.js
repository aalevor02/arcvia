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
const CAD_TYPES = new Set(['image/vnd.dwg', 'image/vnd.dxf'])

/**
 * Types that must never render inline in this origin.
 *
 * A PDF can carry script and so can an SVG — and unlike a PNG, a browser will
 * happily execute both. These URLs are unauthenticated and same-origin with the
 * API, so an inline SVG would be stored XSS with a friendly interface.
 */
const INLINE_UNSAFE = new Set(['application/pdf', 'image/svg+xml'])

const MAX_BYTES = 12 * 1024 * 1024

/**
 * Presentation decks are a different animal: twenty-odd 4K renders bound into
 * one file, routinely forty megabytes and occasionally more. Refusing them at
 * the image limit would refuse the format most clients actually have.
 */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

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

    // Trust the sniffed bytes over the declared mimetype. A client can claim
    // anything in the header, and the extension is attacker-chosen too. Done
    // before the size check because the limit depends on what this turns out to
    // be — a deck is allowed to be much larger than a drawing.
    const sniffed = sniff(buffer)
    if (!sniffed) {
      return reply.status(415).send({
        message: `That is not a drawing, a CAD file or a PDF. Supported: ${allowedTypes().join(', ')}.`,
      })
    }

    // Checked after reading because the multipart limit aborts the stream
    // itself; this catches the case where the global limit is higher than the
    // one that makes sense for this particular route.
    // A CAD drawing is sized like a deck, not like a photograph. Real ones from
    // one project run to 34 MB of DXF, so holding them to the 12 MB image limit
    // refuses the files this route exists to accept.
    const LARGE = new Set(['application/pdf', 'image/vnd.dwg', 'image/vnd.dxf'])
    const limit = LARGE.has(sniffed) ? MAX_DOCUMENT_BYTES : MAX_BYTES
    if (buffer.length > limit) {
      return reply.status(413).send({
        message: `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${limit / 1024 / 1024} MB.`,
      })
    }

    try {
      const stored = await put(buffer, sniffed, {
        // Scoped per user so one account cannot enumerate another's uploads by
        // guessing keys — the hash makes that impractical anyway, but the
        // prefix means a future "delete everything this user uploaded" is a
        // directory operation rather than a scan.
        // CAD goes in its own prefix: it is read by a different engine, it is
        // never served back to a browser, and keeping it separate means a
        // retention rule can treat drawings differently from images.
        prefix: `${CAD_TYPES.has(sniffed) ? 'cad' : 'floorplans'}/${request.auth.userId}`,
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
      // A PDF is the one stored type that can carry script, and these URLs are
      // unauthenticated and same-origin with the API. Forcing a download means
      // a hostile deck cannot run in this origin no matter who opens the link.
      .header(
        'Content-Disposition',
        INLINE_UNSAFE.has(file.contentType) ? 'attachment' : 'inline',
      )
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

  // PDF: "%PDF-"
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf'

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  // DWG: the version string is the first six bytes — AC1015, AC1021, AC1032.
  // Checked as a shape rather than a list, because new releases add new codes
  // and LibreDWG reads more of them than any list here would stay current with.
  if (
    buffer.toString('ascii', 0, 2) === 'AC' &&
    /^\d{4}$/.test(buffer.toString('ascii', 2, 6))
  ) {
    return 'image/vnd.dwg'
  }

  // Binary DXF announces itself.
  if (buffer.toString('ascii', 0, 18) === 'AutoCAD Binary DXF') {
    return 'image/vnd.dxf'
  }

  // ASCII DXF has no magic number — it is a group-code text file. The opening
  // is a 0 group whose value is SECTION, followed by a 2 group naming it.
  // Requiring both, near the start, keeps this from matching arbitrary text.
  const head = buffer.toString('ascii', 0, Math.min(buffer.length, 1024))
  const firstLine = head.split('\n').shift().trim()
  if ((firstLine === '0' || firstLine === '999') && head.includes('SECTION')) {
    return 'image/vnd.dxf'
  }

  return null
}
