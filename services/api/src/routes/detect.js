import { open } from '../lib/storage.js'
import { requireAuth } from '../lib/auth.js'
import { spend, refund, InsufficientCredits } from '../lib/credits.js'

/**
 * Floor-plan detection.
 *
 * A thin proxy in front of `services/floorplan-ai`, and the thinness is the
 * point: the Python service has no auth, no credit metering and no knowledge of
 * who owns what. Exposing it to the browser directly would mean putting all
 * three into a second codebase, in a second language, and keeping them in step.
 *
 * ── Why this takes a stored key and not a URL ───────────────────────────────
 * The obvious API is "send me the image URL and I will fetch it". That is a
 * server-side request forgery hole with a friendly interface: the caller
 * chooses a URL and this server dutifully requests it, which on a cloud host
 * means the metadata endpoint and its credentials are one request away.
 *
 * So the input is a key into *our own* storage, resolved locally. Nothing here
 * makes an outbound request to an address a caller supplied.
 */

const DETECTOR = process.env.FLOORPLAN_URL ?? 'http://127.0.0.1:8090'

/** Detection is fast, but a wedged detector must not hold a connection open. */
const TIMEOUT_MS = 30_000

/** Public prefix that stored files are served under, mirrored from storage.js. */
const PUBLIC_PREFIX = process.env.UPLOAD_PUBLIC_PREFIX ?? '/uploads'

export async function registerDetectRoutes(app) {
  app.get('/health', async () => {
    // Reports the detector's own state rather than this route's, because "is
    // the AI reader available" is the only question anyone asks here, and the
    // answer usually depends on whether a separate Python process is running.
    try {
      const response = await fetch(`${DETECTOR}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      return { available: response.ok, detector: await response.json() }
    } catch {
      return { available: false, detector: null }
    }
  })

  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const key = storageKey(request.body?.url ?? request.body?.key)
    if (!key) {
      return reply
        .status(400)
        .send({ message: 'Provide the key of an uploaded floor plan.' })
    }

    const file = await open(key)
    if (!file) return reply.status(404).send({ message: 'That drawing is not stored here.' })

    // Charged before the work, not after. Charging on completion lets a
    // zero-credit account queue unlimited detections and get them all for free
    // — the same rule the render queue follows.
    //
    // Every failure path below refunds it. A charge for an operation that
    // produced nothing is exactly what the published refund policy says does
    // not happen, and "the detector was switched off" is not the user's error.
    try {
      await spend(request.auth.userId, 'floorplanDetect', { key })
    } catch (error) {
      if (error instanceof InsufficientCredits) {
        return reply.status(402).send({ message: error.message, code: 'NO_CREDITS' })
      }
      throw error
    }

    const form = new FormData()
    form.append('file', new Blob([await streamToBuffer(file.stream)], {
      type: file.contentType,
    }), 'plan')

    let response
    try {
      response = await fetch(`${DETECTOR}/detect`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      // The detector being down is an operational fact, not the user's mistake,
      // and it is the single most likely failure here because it is a separate
      // process someone has to remember to start.
      request.log.error({ err: error, detector: DETECTOR }, 'floor-plan detector unreachable')
      await refund(request.auth.userId, 'floorplanDetect', { key, reason: 'detector-down' })
      return reply.status(503).send({
        message:
          'The floor-plan reader is not running. Start services/floorplan-ai, or trace the plan by hand.',
        code: 'DETECTOR_DOWN',
      })
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))

      // A 4xx from the detector is a statement about *the image*, not about the
      // detector. Re-labelling it 502 tells the user our infrastructure broke
      // and gives them nothing to act on, when the actual answer is "that file
      // is not a readable drawing". Only a 5xx is a gateway failure.
      if (response.status >= 400 && response.status < 500) {
        request.log.info({ status: response.status }, 'detector rejected the image')
        await refund(request.auth.userId, 'floorplanDetect', { key, reason: 'unreadable' })
        return reply.status(422).send({
          message:
            typeof body.detail === 'string'
              ? body.detail
              : 'That image could not be read as a floor plan.',
          code: 'UNREADABLE',
        })
      }

      request.log.error({ status: response.status, body }, 'detector failed')
      await refund(request.auth.userId, 'floorplanDetect', { key, reason: 'detector-error' })
      return reply
        .status(502)
        .send({ message: 'The floor-plan reader failed while reading that image.' })
    }

    return response.json()
  })
}

/**
 * Reduce whatever the client sent to a key inside our storage, or null.
 *
 * Accepts a bare key or a full URL, because the client naturally holds the URL
 * — it is what the underlay stores. Anything not under our own public prefix is
 * refused outright rather than being "cleaned up", since a caller pointing this
 * at another host is not a formatting mistake.
 */
function storageKey(input) {
  if (!input) return null
  const value = String(input)

  // A bare key: no scheme, no leading slash.
  if (!value.includes('://') && !value.startsWith('/')) return value

  let path
  try {
    path = value.includes('://') ? new URL(value).pathname : value
  } catch {
    return null
  }

  const prefix = PUBLIC_PREFIX.endsWith('/') ? PUBLIC_PREFIX : PUBLIC_PREFIX + '/'
  if (!path.startsWith(prefix)) return null

  // `open()` does the traversal check on the resolved path; this only has to
  // get the key out.
  return decodeURIComponent(path.slice(prefix.length))
}

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
