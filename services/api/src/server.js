import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'

import { registerAuthRoutes } from './routes/auth.js'
import { registerOrgRoutes } from './routes/organisation.js'
import { registerSceneRoutes } from './routes/scenes.js'
import { registerPublicationRoutes } from './routes/publications.js'
import { registerShareRoutes } from './routes/share.js'
import { registerRenderRoutes, reconcileRenderJobs } from './routes/render.js'
import { attachRealtime } from './realtime/index.js'
import { readToken } from './lib/auth.js'
import { db } from './store.js'
import { registerLeadRoutes } from './routes/leads.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerReferralRoutes } from './routes/referral.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerDetectRoutes } from './routes/detect.js'
import { registerCadRoutes } from './routes/cad.js'
import { registerAssetRoutes, registerHubFileRoutes } from './routes/assets.js'
import { isOriginAllowed } from './lib/origins.js'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Never let a password or bearer token reach the log sink.
    redact: ['req.headers.authorization', 'req.body.password', 'req.body.code'],
  },
  // Uploaded floor plans and GLB exports are large; the default 1MB is far too
  // small. Real caps are enforced per-route.
  // Must move in step with the multipart fileSize below and with
  // uploads.js's MAX_DOCUMENT_BYTES. They were 32/32/64, which made the
  // 64 MB branch unreachable — a large drawing was refused by a limit no
  // error message mentioned.
  bodyLimit: 64 * 1024 * 1024,
})

await app.register(cors, {
  origin(origin, cb) {
    // Same-origin and server-to-server calls arrive with no Origin header.
    if (!origin) return cb(null, true)

    const allowed = isOriginAllowed(origin)
    if (!allowed) {
      // Log it. A rejected origin surfaces in the browser as a generic network
      // error with no server-side trace, which is close to undebuggable unless
      // the refusal is written down somewhere.
      app.log.warn({ origin }, 'CORS: origin rejected')
    }
    cb(null, allowed)
  },
  credentials: true,
})

await app.register(multipart, {
  limits: { fileSize: 64 * 1024 * 1024, files: 4 },
})

app.get('/health', async () => ({
  ok: true,
  service: 'arcvia-api',
  time: new Date().toISOString(),
}))

// Route groups map 1:1 onto what used to be separate deployments. Splitting
// them back out later means changing this file and nothing else.
await app.register(registerAuthRoutes, { prefix: '/auth' })
await app.register(registerOrgRoutes, { prefix: '/organisations' })
await app.register(registerSceneRoutes, { prefix: '/scenes' })
await app.register(registerPublicationRoutes, { prefix: '/publications' })
await app.register(registerRenderRoutes, { prefix: '/render' })
await app.register(registerBillingRoutes, { prefix: '/billing' })
await app.register(registerReferralRoutes, { prefix: '/referral' })
await app.register(registerUploadRoutes, { prefix: '/uploads' })
await app.register(registerDetectRoutes, { prefix: '/detect' })
await app.register(registerCadRoutes, { prefix: '/cad' })
await app.register(registerAssetRoutes, { prefix: '/assets' })
// No prefix: preview and conditioned-model URLs are plain `/hub/...` paths an
// <img> or GLTFLoader can hold without knowing the API's route layout.
await app.register(registerHubFileRoutes)
await app.register(registerLeadRoutes)
// No prefix: `/p/<slug>/` is the address printed on a client's link, and it is
// served as HTML rather than JSON. See routes/share.js.
await app.register(registerShareRoutes)

app.setErrorHandler((error, request, reply) => {
  const status = error.statusCode ?? 500

  // 5xx is our fault and needs a stack trace. 4xx is the caller's and does not.
  if (status >= 500) request.log.error({ err: error }, 'unhandled error')

  reply.status(status).send({
    message: status >= 500 ? 'Something went wrong on our side.' : error.message,
    code: error.code,
  })
})

// Before accepting traffic: pick up whatever a previous life of this process
// left behind. Queued jobs re-queue (they lost nothing), remote renders get a
// watchdog while their worker calls back, and in-process work gets one retry
// before it is failed and refunded. This is the difference between a deploy
// costing users credits and a deploy being invisible.
const reclaimed = await reconcileRenderJobs()
if (reclaimed.requeued + reclaimed.watched + reclaimed.failed > 0) {
  app.log.warn(
    `Restart reconciliation: ${reclaimed.requeued} job(s) re-queued, ` +
      `${reclaimed.watched} awaiting their worker, ${reclaimed.failed} failed and refunded`,
  )
}

// Live co-editing rides the SAME http server as the REST API — one port to
// deploy. The relay only carries the live cursor between saves; durable writes
// still go through the scene PATCH path. See src/realtime/.
attachRealtime(app.server, {
  readToken,
  db,
  log: (msg) => app.log.warn(msg),
})

try {
  await app.listen({ port: PORT, host: HOST })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
