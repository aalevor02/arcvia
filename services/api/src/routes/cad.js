import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { spend, InsufficientCredits, creditCost } from '../lib/credits.js'
import { checkSubmission } from '../lib/idempotency.js'
import { settleRefund, declineRefund } from '../lib/refunds.js'
import { enqueue, cancelJob } from '../lib/renderQueue.js'
import * as engine from '../lib/cadEngine.js'
import { applyCadPatch, cadPatchWasOffered, CadPatchError } from '../lib/cadPatches.js'
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

  // ---- Presentation decks: survey, then one build --------------------------
  // A rendered deck PDF is neither a drawing (no vectors worth reading) nor a
  // single raster (27 pages, two of which are plans). The flow is two-phase
  // BY DESIGN: the survey is cheap and finds the plan sheets plus the printed
  // dimensions; the user confirms ONE dimension; the build runs once at that
  // settled scale. Build-then-rebuild would charge the user twice for our own
  // scale uncertainty, which is why this shape exists.

  app.post('/deck/survey', { preHandler: requireAuth }, async (request, reply) => {
    const file = await resolveInput(request.body?.key, reply)
    if (!file) return reply
    if (file.contentType && file.contentType !== 'application/pdf') {
      return reply.status(415).send({
        message: `A deck survey reads a PDF. Got ${file.contentType}.`,
      })
    }

    const out = resolve(WORK_ROOT, request.auth.userId, 'deck-survey')
    await mkdir(out, { recursive: true })

    // Detection is the real work here (one detector pass per candidate
    // sheet), so it rides the detect tariff — not the free cadSurvey one.
    try {
      await spend(request.auth.userId, 'floorplanDetect', { key: request.body.key, deck: true })
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

    let result
    try {
      result = await engine.deckSurvey({ inputPath: file.path, outDir: out })
    } catch (error) {
      return reply.status(422).send({ message: error.message })
    }

    // Preview paths are files on this machine's disk; a browser needs URLs.
    // Stored content-addressed, so re-surveying the same deck costs no disk.
    const { readFile } = await import('node:fs/promises')
    const { put } = await import('../lib/storage.js')
    for (const sheet of result.sheets ?? []) {
      try {
        const stored = await put(await readFile(sheet.preview), 'image/png', {
          prefix: `decks/${request.auth.userId}`,
        })
        sheet.preview = stored.url
      } catch {
        sheet.preview = null
      }
    }
    return result
  })

  app.post('/deck/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const file = await resolveInput(request.body?.key, reply)
    if (!file) return reply
    if (file.contentType && file.contentType !== 'application/pdf') {
      return reply.status(415).send({
        message: `A deck build reads a PDF. Got ${file.contentType}.`,
      })
    }
    const page = Number(request.body?.page)
    if (!Number.isInteger(page) || page < 1) {
      return reply.status(400).send({ message: 'Which page? The survey reports it.' })
    }
    const index = Number.isInteger(Number(request.body?.index)) ? Number(request.body.index) : 0
    const scale = Number(request.body?.scale) > 0 ? Number(request.body.scale) : null

    // The scale is in the fingerprint on purpose: rebuilding the same sheet at
    // a corrected scale is a genuinely different reconstruction, and merging
    // the two would hand the user the wrongly-scaled model back.
    const { existing, fields: idempotency } = await checkSubmission(request, [
      'deck', request.body?.key ?? null, page, index, scale,
      request.body?.height ?? null,
    ])
    if (existing) {
      return reply.status(200).send({
        jobId: existing.id,
        status: existing.status,
        creditsCharged: 0,
        deduplicated: true,
        message:
          'This looks like the same sheet and scale as an existing job, so it ' +
          'was not charged or queued again.',
      })
    }

    // Holdable: reconstruction is queued work, so an empty balance HOLDS the
    // job until credits arrive instead of refusing it — see credits.js.
    const charge = await spend(
      request.auth.userId,
      'cadReconstruct',
      { key: request.body.key, deck: true, page, index },
      { holdable: true },
    )

    // A fresh directory per job: the sheet's stem is derived from its caption
    // engine-side, so "the one model in this directory" is only deterministic
    // if the directory is this job's own.
    const { nanoid } = await import('../store.js')
    const out = resolve(WORK_ROOT, request.auth.userId, 'deck', nanoid(8))
    await mkdir(out, { recursive: true })

    const job = await db.insert('renderJobs', {
      sceneId: request.body?.sceneId ?? null,
      ownerId: request.auth.userId,
      preset: 'cad',
      action: 'cadReconstruct',
      status: charge.held ? 'held' : 'queued',
      progress: 0,
      creditsCharged: charge.charged,
      ...idempotency,
      spec: {
        kind: 'deck',
        inputPath: file.path,
        outDir: out,
        page,
        index,
        scale,
        height: request.body?.height ?? null,
      },
      outputUrl: null,
      error: null,
    })

    if (charge.held) {
      return reply.status(202).send({
        jobId: job.id,
        status: 'held',
        creditsCharged: 0,
        creditsNeeded: charge.cost,
        creditsRemaining: charge.remaining,
        message:
          `Held: this needs ${charge.cost} credits and you have ${charge.remaining}. ` +
          'It will run automatically when credits arrive; cancelling it costs nothing.',
      })
    }

    await enqueue(job)

    return reply.status(201).send({
      jobId: job.id,
      status: 'queued',
      creditsCharged: charge.charged,
      creditsRemaining: charge.remaining,
    })
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
      // In the fingerprint because it changes the OUTPUT, which is the stated
      // rule above and not a formality here: building 0 and building 1 of one
      // site plan are the same drawing, the same layers, the same frame and
      // the same height. Left out, the second request would be deduplicated
      // against the first and the reviewer would be handed the wrong villa
      // with a cheerful "not charged again".
      request.body?.building ?? null,
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

    // Holdable, exactly as /deck/jobs above: queued work is held when the
    // balance is short, never refused.
    const charge = await spend(
      request.auth.userId,
      'cadReconstruct',
      { key: request.body.key },
      { holdable: true },
    )

    const job = await db.insert('renderJobs', {
      sceneId: request.body?.sceneId ?? null,
      ownerId: request.auth.userId,
      preset: 'cad',
      action: 'cadReconstruct',
      status: charge.held ? 'held' : 'queued',
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
        // Which building within the frame, when the engine reported the scope
        // as a site. Absent on every ordinary job, and the engine then builds
        // the whole scope exactly as before.
        building: request.body?.building ?? null,
      },
      outputUrl: null,
      error: null,
    })

    if (charge.held) {
      return reply.status(202).send({
        jobId: job.id,
        status: 'held',
        creditsCharged: 0,
        creditsNeeded: charge.cost,
        creditsRemaining: charge.remaining,
        message:
          `Held: this needs ${charge.cost} credits and you have ${charge.remaining}. ` +
          'It will run automatically when credits arrive; cancelling it costs nothing.',
      })
    }

    await enqueue(job)

    return reply.status(201).send({
      jobId: job.id,
      status: 'queued',
      creditsCharged: charge.charged,
      creditsRemaining: charge.remaining,
    })
  })

  /**
   * Replay one solver-offered decision.
   *
   * Blocking models remain unpublished. This endpoint only accepts a patch
   * carried by that job's own review payload, so it cannot be used as a free
   * arbitrary reconstruction surface. Corrective re-solves add no charge and
   * are capped; every accepted decision remains in spec.
   */
  app.post('/jobs/:id/resolve', { preHandler: requireAuth }, async (request, reply) => {
    const source = await db.findOne('renderJobs', (job) => job.id === request.params.id)
    if (!source) return reply.status(404).send({ message: 'Job not found.' })
    if (source.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That job is not yours.' })
    }
    if (source.action !== 'cadReconstruct' || !['done', 'failed'].includes(source.status)) {
      return reply.status(409).send({ message: 'Only a finished CAD job can be re-solved.' })
    }

    const requested = request.body?.patch
    const wasOffered = cadPatchWasOffered(source.markers, requested)
    if (!wasOffered) {
      return reply.status(409).send({
        message: 'That correction was not offered by this reconstruction.',
      })
    }

    const previous = Array.isArray(source.spec?.patches) ? source.spec.patches : []
    if (previous.length >= 12) {
      return reply.status(409).send({
        message: 'This reconstruction has reached its 12-decision review limit.',
      })
    }

    let spec
    try {
      spec = applyCadPatch({
        ...source.spec,
        layers: source.spec?.layers ?? source.markers?.layers ?? null,
      }, requested)
    } catch (error) {
      if (error instanceof CadPatchError) {
        return reply.status(422).send({ message: error.message })
      }
      throw error
    }

    const duplicate = await db.findOne('renderJobs', (job) =>
      job.revisionOf === (source.revisionOf ?? source.id) &&
      JSON.stringify(job.spec?.patches) === JSON.stringify(spec.patches))
    if (duplicate) {
      return reply.status(200).send({
        jobId: duplicate.id,
        status: duplicate.status,
        creditsCharged: 0,
        deduplicated: true,
      })
    }

    const { nanoid } = await import('../store.js')
    const outDir = resolve(WORK_ROOT, request.auth.userId, 'resolve', nanoid(8))
    await mkdir(outDir, { recursive: true })
    spec.outDir = outDir

    const revision = await db.insert('renderJobs', {
      sceneId: source.sceneId ?? null,
      ownerId: source.ownerId,
      preset: 'cad',
      action: 'cadReconstruct',
      status: 'queued',
      progress: 0,
      creditsCharged: 0,
      revisionOf: source.revisionOf ?? source.id,
      spec,
      outputUrl: null,
      error: null,
    })
    await enqueue(revision)

    return reply.status(201).send({
      jobId: revision.id,
      status: 'queued',
      creditsCharged: 0,
      includedResolve: true,
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
      // The building.json behind the GLB — fixture placements included, which
      // is what the studio furnishes from. Null on jobs from before it was
      // published, and the studio treats that as "nothing to propose".
      modelJsonUrl: job.modelJsonUrl ?? null,
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

    // ── Actually stop the work, then record the decision ─────────────────────
    // This used to write 'cancelled' and refund without ever telling the queue.
    // A queued job stayed in `pending` and ran seconds later — free CPU, and a
    // job the user cancelled reappearing as a completed import; a running job
    // kept going and its finish('done') raced the cancel. cancelJob() splices a
    // queued job out of pending and aborts a running one's engine, and the
    // queue's finish() now refuses to move a row already marked 'cancelled'.
    await cancelJob(job.id)
    await db.update('renderJobs', job.id, { status: 'cancelled' })

    // A HELD job was never charged: nothing to refund, nothing to decline —
    // either settlement would be a record of money that never moved.
    if (job.status === 'held') {
      return { jobId: job.id, status: 'cancelled', refunded: 0 }
    }

    // A reconstruction cancelled before it started refunds; one cancelled while
    // running has already spent the CPU, so the charge stands and the refund is
    // DECLINED — mirroring render.js exactly, and stamping the job so a later
    // failure path cannot then refund work that was actually performed.
    let given = 0
    if (job.status === 'queued') {
      given = await settleRefund(job.id, 'cancelled-before-start', 'cadReconstruct')
    } else {
      await declineRefund(job.id, 'cancelled-while-rendering')
    }

    return { jobId: job.id, status: 'cancelled', refunded: given }
  })

  app.get('/pricing', async () => ({
    survey: creditCost.cadSurvey,
    layers: creditCost.cadSurvey,
    reconstruct: creditCost.cadReconstruct,
  }))
}
