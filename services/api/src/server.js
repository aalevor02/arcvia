import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'

import { registerAuthRoutes } from './routes/auth.js'
import { registerOrgRoutes } from './routes/organisation.js'
import { registerSceneRoutes } from './routes/scenes.js'
import { registerRenderRoutes } from './routes/render.js'
import { registerLeadRoutes } from './routes/leads.js'
import { registerBillingRoutes } from './routes/billing.js'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

// Origins allowed to call this API. One list, one place — as opposed to the
// eight separate CORS configurations the reference architecture needed.
const ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  'http://localhost:4321,http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

/** Loopback, or an RFC1918 private LAN address. */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/

/**
 * Decide whether an Origin may call this API.
 *
 * Outside production we accept any origin on the local machine or the local
 * network. The reason is practical: testing "works on any device" means opening
 * the site from a phone, which arrives as `http://192.168.x.x:4321` — an origin
 * nobody thought to allowlist, and whose IP changes whenever DHCP feels like it.
 * Pinning the list to `localhost` makes every cross-device test fail with what
 * looks like a server outage.
 *
 * In production this is strictly the configured list. No pattern matching.
 */
function isOriginAllowed(origin) {
  if (ORIGINS.includes(origin)) return true
  if (IS_PRODUCTION) return false

  try {
    const { hostname, protocol } = new URL(origin)
    return protocol === 'http:' && PRIVATE_HOST.test(hostname)
  } catch {
    return false
  }
}

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
