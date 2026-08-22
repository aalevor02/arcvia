import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { spend, InsufficientCredits, creditCost } from '../lib/credits.js'
import { checkSubmission } from '../lib/idempotency.js'
import { settleRefund } from '../lib/refunds.js'
import { enqueue } from '../lib/renderQueue.js'
import * as engine from '../lib/cadEngine.js'
import { pathOf } from '../lib/storage.js'

/**
 * CAD reconstruction.
 *
 * ── Read first, build second ─────────────────────────────────────────────────
 * Two of these three endpoints are free and synchronous, and that split is the
 * design rather than a pricing accident. A drawing arrives with two questions
 * that only a human can settle — what unit is it in, and which of its layers
 * are walls — and both are cheap to answer and expensive to get wrong.
 *
 * `$INSUNITS` routinely lies. On one real sheet the header says millimetres,
 * which makes the building 3.79 m across; centimetres makes it 37.9 m. Read at
 * the wrong scale, every wall segment falls below the minimum length and the
 * engine produces a valid, well-formed, *empty* building. Charging for the
 * survey would make people guess instead of check, so the survey is free.
 *
 * ── Keys, never URLs ────────────────────────────────────────────────────────
 * Every endpoint takes a key into our own storage, exactly as `detect.js` does
 * and for the same reason: "send me the URL and I will fetch it" is server-side
 * request forgery with a friendly interface. Nothing here makes an outbound
 * request to an address a caller supplied.
 */

const WORK_ROOT = process.env.RECONSTRUCT_WORK ?? resolve(process.cwd(), '.data/cad')

/** DWG and DXF. Anything else is not a drawing this engine reads. */
/**
 * What the engine can read.
 *
 * DWG and DXF go through the CAD path, where every line is exact. The raster
 * types go through `ingest/raster.py`, which asks services/floorplan-ai to
 * find the walls and — the part that makes a photograph usable at all — to
 * recover the scale from the room dimensions the architect printed on the
 * sheet. A picture has no scale, and without one a reconstruction is a
 * plausible building of unknown size.
 *
 * PDF is deliberately absent. A CAD print-to-PDF is exact vector geometry and
 * deserves the vector path, not a rasterise-and-detect round trip that throws
 * that away — see ingest/pdf_vector.py when it exists.
 */
const READABLE = new Set([
  'image/vnd.dwg',
  'image/vnd.dxf',
  'application/dxf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

async function resolveInput(key, reply) {
  if (typeof key !== 'string' || !key.length) {
    reply.status(400).send({ message: 'A stored file key is required.' })
    return null
  }

  const file = await pathOf(key)
  if (!file) {
    reply.status(404).send({ message: 'No such file.' })
    return null
  }
  return file
}

export async function registerCadRoutes(app) {
  app.get('/health', async () => {
    // Reports the engine's own state, because "can this read my DWG" is the
    // only question anyone asks here and the answer depends on a separate
    // Python process being installed rather than on this route being up.
    try {
      await engine.runEngine('--help', [])
      return { ok: true, python: engine.enginePaths.PYTHON }
    } catch (error) {
      return { ok: false, reason: error.message, python: engine.enginePaths.PYTHON }
    }
  })

  // ---- Free, synchronous reads --------------------------------------------

  app.post('/survey', { preHandler: requireAuth }, async (request, reply) => {
    const file = await resolveInput(request.body?.key, reply)
    if (!file) return reply

    const work = resolve(WORK_ROOT, request.auth.userId, 'survey')
    await mkdir(work, { recursive: true })

    await spend(request.auth.userId, 'cadSurvey', { key: request.body.key })

    try {
      return await engine.survey({
        inputPath: file.path,
        workDir: work,
        unit: request.body?.unit,
      })
    } catch (error) {
      return reply.status(422).send({ message: error.message })
    }
  })

  app.post('/layers', { preHandler: requireAuth }, async (request, reply) => {
    const file = await resolveInput(request.body?.key, reply)
    if (!file) return reply

    const work = resolve(WORK_ROOT, request.auth.userId, 'layers')
    await mkdir(work, { recursive: true })

    try {
      return await engine.layers({
        inputPath: file.path,
        workDir: work,
        unit: request.body?.unit,
      })
    } catch (error) {
      return reply.status(422).send({ message: error.message })
    }
  })

  // ---- The job ------------------------------------------------------------

  app.post('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const file = await resolveInput(request.body?.key, reply)
    if (!file) return reply

    if (file.contentType && !READABLE.has(file.contentType)) {
      return reply.status(415).send({
        message: `This engine reads DWG and DXF. Got ${file.contentType}.`,
      })
    }

    const out = resolve(WORK_ROOT, request.auth.userId, 'build')
    await mkdir(out, { recursive: true })

    // ── The same double-charge hole as /render/jobs, and worse here ─────────
    // A reconstruct costs 3 credits against a preview render's 1, and it takes
    // tens of seconds during which the button gives no feedback. So this is the
    // submission a user is MORE likely to click twice, and the one where doing
    // so costs most.
    //
    // Shared with the render route rather than copied. Two implementations of an
    // idempotency rule that must agree is the defect this repo spent a day
    // cataloguing — they agree until one is edited.
    //
    // The fingerprint covers every input that changes the OUTPUT. Omitting one
    // would merge two genuinely different reconstructions, which loses the
    // user's work rather than their credits, and that is the worse direction.
    const { existing, fields: idempotency } = await checkSubmission(request, [
      'cad',
      request.body?.key ?? null,
      request.body?.sceneId ?? null,
      request.body?.unit ?? null,
      Array.isArray(request.body?.layers) ? request.body.layers : null,
      request.body?.autoLayers !== false,
      request.body?.height ?? null,
      request.body?.frame ?? null,
    ])

    if (existing) {
      return reply.status(200).send({
        jobId: existing.id,
        status: existing.status,
        creditsCharged: 0,
        deduplicated: true,
        message:
          'This looks like the same drawing and settings as an existing job, ' +
          'so it was not charged or queued again.',
      })
    }

    let charge
    try {
      charge = await spend(request.auth.userId, 'cadReconstruct', { key: request.body.key })
    } catch (error) {
      if (error instanceof InsufficientCredits) {
        return reply.status(402).send({
          message: 'Not enough credits.',
          needed: error.needed,
          available: error.available,
        })
      }
      throw error
    }

    const job = await db.insert('renderJobs', {
      sceneId: request.body?.sceneId ?? null,
      ownerId: request.auth.userId,
      preset: 'cad',
      action: 'cadReconstruct',
      status: 'queued',
      progress: 0,
      creditsCharged: charge.charged,
      // Persisted with the job so the guard survives a restart — which is when
      // a user is most likely to click twice, the first click having appeared
      // to do nothing.
      ...idempotency,
      spec: {
        inputPath: file.path,
        outDir: out,
        // Every one of these is a decision the survey exists to inform. They
        // are passed through rather than guessed, and `autoLayers` is only the
        // fallback for a caller that has not chosen.
        unit: request.body?.unit ?? null,
        layers: Array.isArray(request.body?.layers) ? request.body.layers : null,
        autoLayers: request.body?.autoLayers !== false,
        height: request.body?.height ?? null,
        frame: request.body?.frame ?? null,
      },
      outputUrl: null,
      error: null,
    })

    await enqueue(job)

    return reply.status(201).send({
      jobId: job.id,
      status: 'queued',
      creditsCharged: charge.charged,
      creditsRemaining: charge.remaining,
    })
  })

  app.get('/jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const job = await db.findOne('renderJobs', (j) => j.id === request.params.id)
    if (!job) return reply.status(404).send({ message: 'Job not found.' })
    if (job.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That job is not yours.' })
    }

    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.outputUrl,
      planUrl: job.planUrl ?? null,
      error: job.error,
      // The markers carry what the engine found — rooms, named rooms, walls,
      // openings, the unit it settled on and the layers it used. That is what a
      // reviewer needs to decide whether to accept the import, and it is far
      // more useful than a percentage that has already reached 100.
      summary: job.markers ?? null,
      refunded: job.refund?.settled ? job.refund.amount : 0,
    }
  })

  app.delete('/jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const job = await db.findOne('renderJobs', (j) => j.id === request.params.id)
    if (!job) return reply.status(404).send({ message: 'Job not found.' })
    if (job.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That job is not yours.' })
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return { jobId: job.id, status: job.status }
    }

    await db.update('renderJobs', job.id, { status: 'cancelled' })
    // Unlike a Blender render, a cancelled reconstruction has usually consumed
    // seconds rather than minutes — but the rule is the same one the render
    // queue applies, and it lives in one place so it cannot diverge.
    const given = job.status === 'queued'
      ? await settleRefund(job.id, 'cancelled-before-start', 'cadReconstruct')
      : 0

    return { jobId: job.id, status: 'cancelled', refunded: given }
  })

  app.get('/pricing', async () => ({
    survey: creditCost.cadSurvey,
    layers: creditCost.cadSurvey,
    reconstruct: creditCost.cadReconstruct,
  }))
}
