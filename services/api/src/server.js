import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'

import { registerAuthRoutes } from './routes/auth.js'
import { registerOrgRoutes } from './routes/organisation.js'
import { registerSceneRoutes } from './routes/scenes.js'
import { registerRenderRoutes } from './routes/render.js'
import { registerLeadRoutes } from './routes/leads.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerReferralRoutes } from './routes/referral.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerDetectRoutes } from './routes/detect.js'
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
  bodyLimit: 32 * 1024 * 1024,
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
  limits: { fileSize: 32 * 1024 * 1024, files: 4 },
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
await app.register(registerRenderRoutes, { prefix: '/render' })
await app.register(registerBillingRoutes, { prefix: '/billing' })
await app.register(registerReferralRoutes, { prefix: '/referral' })
await app.register(registerUploadRoutes, { prefix: '/uploads' })
await app.register(registerDetectRoutes, { prefix: '/detect' })
await app.register(registerLeadRoutes)

app.setErrorHandler((error, request, reply) => {
  const status = error.statusCode ?? 500

  // 5xx is our fault and needs a stack trace. 4xx is the caller's and does not.
  if (status >= 500) request.log.error({ err: error }, 'unhandled error')

  reply.status(status).send({
    message: status >= 500 ? 'Something went wrong on our side.' : error.message,
    code: error.code,
  })
})

try {
  await app.listen({ port: PORT, host: HOST })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
