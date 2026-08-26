import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { spend, balanceFor } from '../lib/credits.js'
import { settleRefund, declineRefund } from '../lib/refunds.js'
import {
  enqueue,
  jobStatus,
  cancelJob,
  queueDepth,
  timeoutFor,
  isRemoteOwned,
} from '../lib/renderQueue.js'
import { resolveUrl, isOwnUpload, isEnvAsset } from '../lib/storage.js'
import { checkSubmission } from '../lib/idempotency.js'
import { AI_STYLES, isStyle } from '../lib/aiRender.js'

/**
 * Render jobs.
 *
 * Mirrors the reference pipeline: the browser exports the scene to a .glb, the
 * lights to a JSON sidecar and an .hdr environment map, then asks the server to
 * render it. A GPU worker picks the job up, runs Blender Cycles headless, and
 * writes a PNG back. The client polls for status.
 *
 * The three presets below exist because the cost gap between them is enormous —
 * a 240px preview at 4 samples is roughly a second of GPU time, a full still at
 * 128 samples can be minutes. Letting callers pass arbitrary sample counts is
 * how you get a surprise GPU bill.
 */

const PRESETS = {
  preview: {
    action: 'previewRender',
    width: 240,
    height: 240,
    samples: 4,
    maxBounces: 3,
    diffuseBounces: 3,
  },
  isometric: {
    action: 'isometricRender',
    width: 1920,
    height: 1080,
    samples: 32,
    maxBounces: 4,
    diffuseBounces: 3,
  },
  full: {
    action: 'fullRender',
    width: 2560,
    height: 1440,
    samples: 128,
    maxBounces: 8,
    diffuseBounces: 4,
  },
  // Bounded equirectangular deliverable for interactive 360 viewers.
  panorama: {
    action: 'panoramaRender',
    width: 4096,
    height: 2048,
    samples: 64,
    maxBounces: 6,
    diffuseBounces: 4,
    projection: 'equirectangular',
  },
  // Photoreal stills from a viewport capture. Priced like a full still: it
  // costs an API call rather than GPU-seconds, but it is the same thing to a
  // user — one finished image of one camera.
  ai: {
    action: 'fullRender',
    width: 0,
    height: 0,
    samples: 0,
    maxBounces: 0,
    diffuseBounces: 0,
  },
  // CAD reconstruction. Not a camera at all — the width/height fields are
  // meaningless here and stay zero, exactly as the `ai` preset does. What it
  // buys is every piece of long-job machinery the queue already owns: the daily
  // cap, concurrency, metering, refund-on-failure, cancel, and reconciliation
  // after a restart.
  cad: {
    action: 'cadReconstruct',
    width: 0,
    height: 0,
    samples: 0,
    maxBounces: 0,
    diffuseBounces: 0,
  },
  bake: {
    action: 'lightmapBake',
    width: 2048, // lightmap texture resolution, not a camera framing
    height: 2048,
    samples: 256,
    maxBounces: 8,
    diffuseBounces: 4,
  },
}

/**
 * How many times a job orphaned MID-RENDER may be re-queued before it is
 * failed instead. One, by default: the first restart gets a free retry (the
 * multi-view renderer even resumes from its per-view cache), but a job that
 * takes the server down every time it runs must not be handed the gun again.
 * Jobs orphaned while still QUEUED never count against this — they ran
 * nothing, so they cannot have caused anything.
 */
const RESTART_RETRIES = Number(process.env.RENDER_RESTART_RETRIES ?? 1)

/**
 * The floor on how long a watched remote job is given to call back after a
 * restart, whatever remains of its time budget. A worker that finished during
 * the deploy needs a moment to deliver the result; failing the job in the
 * same tick would throw away GPU work that is already paid for and done.
 */
const WATCHDOG_FLOOR_MS = 5_000

/**
 * Reclaim jobs that a restart orphaned — by finishing their journey, not by
 * killing them.
 *
 * The queue's `running` map is in memory; the rows are not. When the process
 * goes down — a deploy, a crash, a file watcher noticing an edit — every job
 * still marked queued or rendering is orphaned. This used to fail and refund
 * all of them, which made every deploy a small massacre: ten queued bakes
 * died for nothing, because a queued job's spec is entirely in its row and it
 * lost no work at all.
 *
 * So instead, each orphan gets what its state deserves:
 *
 *   queued                    Re-queued, oldest first. Nothing ran, nothing
 *                             was lost, the credits stay spent on work that
 *                             will now happen. Never counts as a retry.
 *
 *   rendering, remote-owned   Left alone, with a watchdog. The worker pool
 *                             did not die with us and will call back
 *                             (`/jobs/:id/callback` writes straight to the
 *                             row, so it needs no in-memory state). Failing
 *                             it here would discard GPU seconds already
 *                             bought. If the callback never comes, the
 *                             watchdog fails and refunds it when whatever
 *                             remains of its time budget runs out.
 *
 *   rendering, in-process     The child died with the process; the work is
 *                             gone. Re-queued once (`RENDER_RESTART_RETRIES`),
 *                             because half the time the restart was a deploy
 *                             and the job is blameless — and failed with a
 *                             refund the time after, because the other half
 *                             it was the job that killed the box.
 *
 * Refunds still go through `settleRefund`, which stamps the decision so two
 * crashes in a row cannot pay out twice.
 */
export async function reconcileRenderJobs() {
  const orphans = await db.find(
    'renderJobs',
    (j) => j.status === 'queued' || j.status === 'rendering',
  )
  // Oldest first, so re-queued jobs run in the order they were submitted.
  orphans.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  const outcome = { requeued: 0, watched: 0, failed: 0 }

  for (const job of orphans) {
    if (job.status === 'rendering' && isRemoteOwned(job)) {
      watchRemoteJob(job)
      outcome.watched += 1
      continue
    }

    const restarts = job.restarts ?? 0
    if (job.status === 'rendering' && restarts >= RESTART_RETRIES) {
      await db.update('renderJobs', job.id, {
        status: 'failed',
        error:
          `The render server restarted ${restarts + 1} times while this job ` +
          'was running, so it was not retried again.',
      })
      // No `PRESETS` guard. A job whose preset is no longer registered still
      // took the user's credits, and skipping it was exactly how orphaned
      // jobs kept them — silently, because nothing errors on a missed lookup.
      await settleRefund(job.id, 'restart', PRESETS[job.preset]?.action)
      outcome.failed += 1
      continue
    }

    const fresh = await db.update('renderJobs', job.id, {
      status: 'queued',
      progress: 0,
      restarts: job.status === 'rendering' ? restarts + 1 : restarts,
    })
    await enqueue(fresh)
    outcome.requeued += 1
  }

  // Jobs held for lack of credits are NOT requeued — they were never charged
  // — but credits may have arrived while the process was down, so give them
  // the release check the inflow would have given them.
  const { releaseHeldJobs } = await import('../lib/renderQueue.js')
  outcome.releasedHeld = await releaseHeldJobs()

  return outcome
}

/**
 * Wait out a remote job's remaining time budget, then fail it if the worker
 * never reported back. Everything is re-read at the moment of firing, because
 * the healthy outcome is that the callback resolved the row first and this
 * timer finds nothing left to do.
 */
function watchRemoteJob(job) {
  const startedAt =
    typeof job.startedAt === 'number' ? job.startedAt : Date.now()
  const remaining = Math.max(
    WATCHDOG_FLOOR_MS,
    startedAt + timeoutFor(job) - Date.now(),
  )
  const timer = setTimeout(async () => {
    const row = await db.findOne('renderJobs', (j) => j.id === job.id)
    if (!row || row.status !== 'rendering') return
    await db.update('renderJobs', job.id, {
      status: 'failed',
      error:
        'The render server restarted while this job ran on the worker pool, ' +
        'and the worker never reported back.',
    })
    await settleRefund(job.id, 'restart', PRESETS[job.preset]?.action)
  }, remaining)
  // A held timer must not keep the process alive; it exists to serve the
  // process, not the other way round.
  timer.unref?.()
}

export async function registerRenderRoutes(app) {
  // The style list, served rather than duplicated in the client. One
  // definition means a style added here appears in the editor without a
  // matching change, and cannot drift out of step with what the renderer
  // actually accepts.
  app.get('/styles', async () => ({
    styles: Object.entries(AI_STYLES).map(([id, style]) => ({ id, name: style.name })),
  }))

  // ---- Submit a job ------------------------------------------------------
  app.post('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const {
      sceneId,
      preset = 'preview',
      cameraPosition,
      cameraRotation,
      hdriUrl,
    } = request.body ?? {}

    const config = PRESETS[preset]
    if (!config) {
      return reply.status(400).send({
        message: `Unknown preset. Use one of: ${Object.keys(PRESETS).join(', ')}.`,
      })
    }

    const scene = await db.findOne('scenes', (s) => s.id === sceneId)
    if (!scene) return reply.status(404).send({ message: 'Scene not found.' })
    if (scene.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That scene is not yours.' })
    }
    // An AI render works from a picture of the viewport, so it needs a
    // capture rather than a saved model — a scene with no geometry saved can
    // still be photographed.
    const isAi = preset === 'ai'
    const captureUrl = request.body?.captureUrl

    if (isAi && !captureUrl) {
      return reply
        .status(400)
        .send({ message: 'A photoreal render needs a captured view.' })
    }
    // ── captureUrl must be one of OUR uploads, nothing else ──────────────────
    // It is caller-supplied and flows, unresolved, all the way to
    // `readFile(sourcePath)` in the worker and then into an outbound POST to
    // Google's API. `resolveUrl` does NOT contain it: its final branch returns
    // any value that is not under the upload prefix unchanged, so an http(s)
    // URL renders an SSRF (the worker fetches it) and a bare path — `/etc/passwd`,
    // `A:/Web/Arcvia/.env` — is read off this server's disk and base64'd into
    // the request body. The legitimate value is always the key returned by
    // uploadCapture, i.e. `${UPLOAD_PUBLIC_PREFIX}/<key>`, so anything else is
    // either an attack or a bug, and both should be refused here rather than
    // resolved downstream.
    if (isAi && !isOwnUpload(captureUrl)) {
      return reply
        .status(400)
        .send({ message: 'A captured view must be an uploaded image.' })
    }
    if (isAi && !isStyle(request.body?.style ?? 'daylight')) {
      return reply.status(400).send({
        message: `Unknown style. Use one of: ${Object.keys(AI_STYLES).join(', ')}.`,
      })
    }

    if (!isAi && !scene.modelUrl) {
      return reply
        .status(409)
        .send({ message: 'Save the scene before rendering it.' })
    }

    // ── A body-supplied hdriUrl must be a catalogue env or our own upload ────
    // Like captureUrl, this reaches the worker: resolveUrl passes an http(s)
    // value through untouched (the worker then FETCHES it — SSRF, incl.
    // http://169.254.169.254/… metadata) and a bare path through too (read off
    // this server's disk). The only legitimate values are a shipped
    // environment (`/env/*.hdr`) or an uploaded HDR (`/uploads/…`). scene.hdriUrl
    // is trusted — it was written through the allow-listed scene PATCH — so
    // only the caller-supplied override is checked here.
    if (hdriUrl != null && !isEnvAsset(hdriUrl) && !isOwnUpload(hdriUrl)) {
      return reply
        .status(400)
        .send({ message: 'An environment must be a catalogue sky or an uploaded HDR.' })
    }

    // Resolved here rather than at the worker, because only this side knows
    // where the storage root is. Null means the stored URL points outside it,
    // which is not a render failure to be retried — it is a broken record.
    const inputUrl = resolveUrl(isAi ? captureUrl : scene.modelUrl)
    if (!inputUrl) {
      return reply
        .status(409)
        .send({ message: "That scene's model file could not be located." })
    }

    // ── Submitting twice must not charge twice ──────────────────────────────
    // A double-clicked button sent two identical requests, and each one charged
    // and queued. The user paid twice and got two renders of the same frame,
    // which are byte-identical, so the only visible trace is the balance.
    //
    // Two mechanisms, because they answer different questions:
    //
    //   Idempotency-Key   the caller states "this is the same submission".
    //                     Authoritative, and the right primitive — it is how a
    //                     client that retries after a dropped response says so.
    //   fingerprint       a backstop for callers that send no key, which is all
    //                     of them today. Same user, same scene, same preset,
    //                     same spec inputs, inside a few seconds.
    //
    // The window is deliberately short. Two identical submissions seconds apart
    // are a double-click; the same two a minute apart could be a deliberate
    // re-render after the first looked stuck, and collapsing THOSE would be its
    // own silent failure — the user asks for two and gets one, with nothing
    // saying so. Narrow enough to catch the accident, not the intention.
    const { existing, fields: idempotency } = await checkSubmission(request, [
      sceneId, preset,
      cameraPosition ?? null, cameraRotation ?? null,
      hdriUrl ?? null, captureUrl ?? null,
      request.body?.style ?? null, request.body?.note ?? null,
      Boolean(request.body?.prebakedUv),
    ])

    if (existing) {
      // 200 rather than 201: nothing was created. `deduplicated` is there so a
      // client can tell the difference — silently returning someone else's job
      // id as if it were new is the same class of lie this guard is closing.
      return reply.status(200).send({
        jobId: existing.id,
        status: existing.status,
        creditsCharged: 0,
        creditsRemaining: (await balanceFor(request.auth.userId)) ?? null,
        queueDepth: await queueDepth(),
        deduplicated: true,
        message:
          'This looks like the same submission as an existing job, so it was ' +
          'not charged or queued again.',
      })
    }

    // Charge before queueing. Charging on completion sounds fairer but lets a
    // user with zero credits fill the queue and consume GPU time anyway.
    //
    // `holdable`: render work is queueable, so running out of credits HOLDS
    // the job instead of refusing it (owner's policy — see credits.js). The
    // insert below writes status 'held' and skips the enqueue; the queue's
    // releaseHeldJobs charges and starts it when credits arrive.
    const charge = await spend(
      request.auth.userId,
      config.action,
      { sceneId, preset },
      { holdable: true },
    )

    const job = await db.insert('renderJobs', {
      sceneId,
      ownerId: request.auth.userId,
      preset,
      // Both persisted so the dedupe survives a restart. Holding them in memory
      // would make a double-click safe only until the process bounced, which is
      // exactly when a user is most likely to click twice.
      ...idempotency,
      // Recorded so a refund prices itself from what this job actually was,
      // not from whatever `PRESETS` happens to hold when it fails.
      action: config.action,
      status: charge.held ? 'held' : 'queued',
      progress: 0,
      creditsCharged: charge.charged,
      // Axis convention is fixed here, once, rather than at each call site.
      // The browser works in Y-up (Three.js); Blender is Z-up. Getting this
      // wrong produces a render that is silently rotated 90 degrees.
      spec: {
        inputUrl,
        lightsUrl: resolveUrl(scene.lightsUrl),
        hdriUrl: resolveUrl(hdriUrl ?? scene.hdriUrl),
        camera: {
          position: toBlenderVec(cameraPosition),
          // Converted, not forwarded — the position is turned into Z-up and the
          // orientation must take the identical turn or the camera faces the
          // wrong way. See toBlenderQuat.
          rotation: toBlenderQuat(cameraRotation),
          projection: config.projection ?? 'perspective',
        },
        width: config.width,
        height: config.height,
        samples: config.samples,
        maxBounces: config.maxBounces,
        diffuseBounces: config.diffuseBounces,
        type: preset === 'bake' ? 'bake' : 'render',
        // The studio lays out lightmap UVs itself before exporting, so the
        // worker must bake into the channel it was sent rather than unwrapping
        // its own. See apps/studio/src/plan/lightmapUV.ts — if the two layouts
        // disagree, every surface lights with some other surface's bake.
        //
        // Only claimed when the caller says so: a model uploaded from outside
        // the studio has no such channel and does need unwrapping.
        prebakedUv: preset === 'bake' && Boolean(request.body?.prebakedUv),
        // Only meaningful for the AI preset, and harmless elsewhere.
        style: request.body?.style ?? 'daylight',
        note: typeof request.body?.note === 'string' ? request.body.note : undefined,
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
      queueDepth: await queueDepth(),
    })
  })

  // ---- Poll ---------------------------------------------------------------
  app.get('/jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const job = await db.findOne('renderJobs', (j) => j.id === request.params.id)
    if (!job) return reply.status(404).send({ message: 'Job not found.' })
    if (job.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That job is not yours.' })
    }

    const live = await jobStatus(job.id)
    return {
      jobId: job.id,
      status: live?.status ?? job.status,
      progress: live?.progress ?? job.progress,
      outputUrl: job.outputUrl,
      error: job.error,
      // Live while it runs, persisted once it is done. A bake reports no
      // progress, so this is what the client has to show instead of a bar
      // stuck at zero — and `markers.device` is the answer to "why is this
      // taking six minutes", which is CPU Cycles nine times out of ten.
      elapsedMs: live?.elapsedMs ?? null,
      markers: live?.markers ?? job.markers ?? {},
    }
  })

  // ---- Cancel -------------------------------------------------------------
  app.post('/jobs/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const job = await db.findOne('renderJobs', (j) => j.id === request.params.id)
    if (!job) return reply.status(404).send({ message: 'Job not found.' })
    if (job.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'That job is not yours.' })
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return { jobId: job.id, status: job.status }
    }

    await cancelJob(job.id)
    await db.update('renderJobs', job.id, { status: 'cancelled' })

    // A HELD job was never charged, so there is nothing to refund or decline
    // — recording either would invent a settlement for money that never
    // moved, and the refund audit reads settlements as facts.
    if (job.status === 'held') {
      return { jobId: job.id, status: 'cancelled', refunded: false }
    }

    // Refund only if no GPU time was consumed. A job already rendering has
    // cost real money whether or not the user still wants the result.
    //
    // Both branches close the decision, and that is the point: killing a
    // running job makes it report a failure moments later, and the failure
    // path would otherwise refund what we just decided not to.
    if (job.status === 'queued') {
      await settleRefund(job.id, 'cancelled-before-start', PRESETS[job.preset]?.action)
    } else {
      await declineRefund(job.id, 'cancelled-while-rendering')
    }

    return { jobId: job.id, status: 'cancelled', refunded: job.status === 'queued' }
  })

  // ---- Worker callback ----------------------------------------------------
  // The GPU worker reports back here. Shared-secret auth rather than a user
  // token, because the worker acts on behalf of the system, not a person.
  app.post('/jobs/:id/callback', async (request, reply) => {
    const secret = request.headers['x-worker-secret']
    if (!secret || secret !== process.env.WORKER_SECRET) {
      return reply.status(401).send({ message: 'Unauthorised.' })
    }

    const { status, progress, outputUrl, error } = request.body ?? {}
    const job = await db.findOne('renderJobs', (j) => j.id === request.params.id)
    if (!job) return reply.status(404).send({ message: 'Job not found.' })

    // ── A settled job stays settled ─────────────────────────────────────────
    // A worker can finish after the row has already been resolved without it:
    // the owner cancelled, or the restart watchdog timed the job out and paid
    // the refund. Accepting the result now would flip a refunded 'failed' to
    // 'done' — the user keeps the refund AND gets the render, and the books
    // stop balancing. The work is acknowledged, and declined.
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return reply.status(409).send({
        message: `This job already resolved as '${job.status}'; the result was not applied.`,
      })
    }

    await db.update('renderJobs', job.id, {
      status: status ?? job.status,
      progress: progress ?? job.progress,
      outputUrl: outputUrl ?? job.outputUrl,
      error: error ?? null,
    })

    // A job that failed for our reasons should not cost the user anything.
    if (status === 'failed') {
      await settleRefund(job.id, 'worker-reported-failure', PRESETS[job.preset]?.action)
    }

    return { ok: true }
  })
}

/**
 * Three.js (Y-up, right-handed) -> Blender (Z-up, right-handed).
 *
 * (x, y, z) becomes (x, -z, y). This is the exact conversion the reference
 * implementation performs inline at every render call site; doing it once here
 * means a new call site cannot forget it.
 */
export function toBlenderVec(v) {
  if (!v) return null
  return { x: v.x, y: -v.z, z: v.y }
}

/**
 * The SAME axis change, for the camera's ORIENTATION.
 *
 * ── Why this had to exist ────────────────────────────────────────────────────
 * `toBlenderVec` rotated the camera's POSITION into Z-up (a +90° turn about X),
 * and the rotation was forwarded to Blender untouched — a Three.js Y-up world
 * quaternion applied to a camera in a Z-up scene. So the camera stood in the
 * right place and faced the wrong way: a view framing the origin from (6,4,6)
 * rendered aimed ~66° off, and a level walkthrough camera pointed at the floor.
 * Measured, on every AI and still render, and invisible in review because
 * `bake.mjs` asserted only the position.
 *
 * The orientation must take the same +90°-about-X the position took, applied on
 * the WORLD side: q_blender = Rx(+90°) · q_three. Premultiplying rotates the
 * whole orientation into the new frame, so the Blender camera's forward
 * (its local -Z) ends up being the old forward carried through the same axis
 * change as the position — which is the only way the two stay consistent.
 */
const RX_PLUS_90 = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }

/** Hamilton product a·b, quaternions as {x, y, z, w}. */
function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

export function toBlenderQuat(q) {
  if (!q) return null
  return quatMul(RX_PLUS_90, q)
}
