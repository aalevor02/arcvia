import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { spend, refund, InsufficientCredits } from '../lib/credits.js'
import { enqueue, jobStatus, cancelJob, queueDepth } from '../lib/renderQueue.js'

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
  bake: {
    action: 'lightmapBake',
    width: 2048, // lightmap texture resolution, not a camera framing
    height: 2048,
    samples: 256,
    maxBounces: 8,
    diffuseBounces: 4,
  },
}

export async function registerRenderRoutes(app) {
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
    if (!scene.modelUrl) {
      return reply
        .status(409)
        .send({ message: 'Save the scene before rendering it.' })
    }

    // Charge before queueing. Charging on completion sounds fairer but lets a
    // user with zero credits fill the queue and consume GPU time anyway.
    let charge
    try {
      charge = await spend(request.auth.userId, config.action, { sceneId, preset })
    } catch (err) {
      if (err instanceof InsufficientCredits) {
        return reply.status(402).send({
          message: err.message,
          code: 'INSUFFICIENT_CREDITS',
          required: err.required,
          available: err.available,
        })
      }
      throw err
    }

    const job = await db.insert('renderJobs', {
      sceneId,
      ownerId: request.auth.userId,
      preset,
      status: 'queued',
      progress: 0,
      creditsCharged: charge.charged,
      // Axis convention is fixed here, once, rather than at each call site.
      // The browser works in Y-up (Three.js); Blender is Z-up. Getting this
      // wrong produces a render that is silently rotated 90 degrees.
      spec: {
        inputUrl: scene.modelUrl,
        lightsUrl: scene.lightsUrl ?? null,
        hdriUrl: hdriUrl ?? scene.hdriUrl ?? null,
        camera: {
          position: toBlenderVec(cameraPosition),
          rotation: cameraRotation ?? null,
        },
        width: config.width,
        height: config.height,
        samples: config.samples,
        maxBounces: config.maxBounces,
        diffuseBounces: config.diffuseBounces,
        type: preset === 'bake' ? 'bake' : 'render',
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

    // Refund only if no GPU time was consumed. A job already rendering has
    // cost real money whether or not the user still wants the result.
    if (job.status === 'queued') {
      await refund(request.auth.userId, PRESETS[job.preset].action, { jobId: job.id })
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

    await db.update('renderJobs', job.id, {
      status: status ?? job.status,
      progress: progress ?? job.progress,
      outputUrl: outputUrl ?? job.outputUrl,
      error: error ?? null,
    })

    // A job that failed for our reasons should not cost the user anything.
    if (status === 'failed') {
      await refund(job.ownerId, PRESETS[job.preset].action, { jobId: job.id })
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
function toBlenderVec(v) {
  if (!v) return null
  return { x: v.x, y: -v.z, z: v.y }
}
