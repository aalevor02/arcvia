import { SignJWT, jwtVerify } from 'jose'
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'dev-only-secret-change-me-in-production',
)
const ISSUER = 'arcvia'
const TOKEN_TTL = process.env.JWT_TTL ?? '12h'

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production')
}

// ---- Password hashing ------------------------------------------------------

/**
 * scrypt rather than bcrypt: it ships in Node's standard library, so there is
 * no native module to compile and nothing to go stale. The cost parameters
 * below are the Node defaults (N=16384), which is a reasonable 2020s baseline.
 */
export async function hashPassword(plain) {
  const salt = randomBytes(16)
  const derived = await scryptAsync(plain, salt, 64)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(plain, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false

  const derived = await scryptAsync(plain, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')

  // Length check first: timingSafeEqual throws on a length mismatch, and that
  // throw would itself leak information about the stored hash.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

// ---- Tokens ----------------------------------------------------------------

export async function issueToken(user) {
  return new SignJWT({
    email: user.email,
    orgId: user.organisationId ?? null,
    planId: user.planId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(SECRET)
}

export async function readToken(token) {
  const { payload } = await jwtVerify(token, SECRET, { issuer: ISSUER })
  return payload
}

// ---- Route guard -----------------------------------------------------------

/**
 * Fastify preHandler that populates `request.auth`.
 *
 * Attach with `{ preHandler: requireAuth }` on any route that needs a signed-in
 * caller. Routes stay free of token-parsing boilerplate, and a route that
 * forgets the guard fails loudly (request.auth is undefined) rather than
 * silently serving another user's data.
 */
export async function requireAuth(request, reply) {
  const header = request.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    return reply.status(401).send({ message: 'Authentication required.' })
  }

  try {
    const payload = await readToken(token)
    request.auth = {
      userId: payload.sub,
      email: payload.email,
      orgId: payload.orgId,
      planId: payload.planId,
    }
  } catch {
    return reply.status(401).send({ message: 'Session expired. Sign in again.' })
  }
}
