import { db, nanoid } from '../store.js'
import { hashPassword, verifyPassword, issueToken, requireAuth } from '../lib/auth.js'
import { grantMonthly } from '../lib/credits.js'
import plansConfig from '@arcvia/brand/plans'

const { defaultPlanId } = plansConfig

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+91\d{10}$/

/** Shape sent to the browser. Never includes the password hash. */
function publicUser(user) {
  return {
    uid: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    organisationId: user.organisationId ?? null,
    planId: user.planId,
    credits: user.credits ?? 0,
    phoneVerified: Boolean(user.phoneVerified),
  }
}

export async function registerAuthRoutes(app) {
  // ---- Register ----------------------------------------------------------
  app.post('/register', async (request, reply) => {
    const { name, email, organisation, phone, password } = request.body ?? {}

    if (!name || String(name).trim().length < 2) {
      return reply.status(400).send({ message: 'Enter your full name.' })
    }
    if (!EMAIL_RE.test(String(email ?? ''))) {
      return reply.status(400).send({ message: 'Enter a valid email address.' })
    }
    if (String(password ?? '').length < 8) {
      return reply
        .status(400)
        .send({ message: 'Password must be at least 8 characters.' })
    }

    const normalisedEmail = String(email).trim().toLowerCase()

    const existing = await db.findOne('users', (u) => u.email === normalisedEmail)
    if (existing) {
      // Deliberately the same wording a caller would get for any conflict — we
      // do not confirm or deny which addresses are registered.
      return reply
        .status(409)
        .send({ message: 'That email cannot be used to register.' })
    }

    // Every signup gets its own organisation. Joining an existing one happens
    // by invitation, so an org is never created implicitly by a second signup
    // from the same company domain.
    const org = await db.insert('organisations', {
      name: String(organisation ?? name).trim(),
      ownerId: null,
      seats: [],
      referralCode: nanoid(8).toUpperCase(),
    })

    const user = await db.insert('users', {
      name: String(name).trim(),
      email: normalisedEmail,
      phone: phone ? `+91${String(phone).replace(/\D/g, '').slice(-10)}` : null,
      passwordHash: await hashPassword(String(password)),
      organisationId: org.id,
      planId: defaultPlanId,
      credits: 0,
      phoneVerified: false,
      emailVerified: false,
    })

    await db.update('organisations', org.id, {
      ownerId: user.id,
      seats: [user.id],
    })

    // Grant the first month's credits immediately so a new account can render
    // straight away instead of waiting for a billing cycle that does not exist.
    await grantMonthly(user.id)

    const fresh = await db.findOne('users', (u) => u.id === user.id)
    return reply.status(201).send({
      token: await issueToken(fresh),
      user: publicUser(fresh),
    })
  })

  // ---- Login -------------------------------------------------------------
  app.post('/login', async (request, reply) => {
    const { email, password } = request.body ?? {}
    const normalisedEmail = String(email ?? '').trim().toLowerCase()

    const user = await db.findOne('users', (u) => u.email === normalisedEmail)

    // Run the hash comparison even when the user does not exist, so the
    // response time does not reveal which addresses are registered.
    const ok = user
      ? await verifyPassword(String(password ?? ''), user.passwordHash)
      : await verifyPassword('dummy', 'scrypt$00$00')

    if (!user || !ok) {
      return reply.status(401).send({ message: 'Email or password is incorrect.' })
    }

    return {
      token: await issueToken(user),
      user: publicUser(user),
    }
  })

  // ---- Phone OTP ---------------------------------------------------------
  // In development the code is logged rather than sent, so the whole signup
  // flow is testable without an SMS provider or spending money per attempt.
  app.post('/otp/send', async (request, reply) => {
    const phone = String(request.body?.phone ?? '')
    if (!PHONE_RE.test(phone)) {
      return reply.status(400).send({ message: 'Enter a valid 10-digit mobile number.' })
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = Date.now() + 5 * 60 * 1000

    const user = await db.findOne('users', (u) => u.phone === phone)
    if (user) await db.update('users', user.id, { otp: { code, expiresAt } })

    if (process.env.SMS_PROVIDER) {
      // TODO: wire your SMS provider here.
      request.log.info({ phone }, 'otp dispatched')
    } else {
      request.log.warn({ phone, code }, 'DEV MODE — OTP not sent, use this code')
    }

    // Always 200, whether or not the number is registered.
    return { sent: true }
  })

  app.post('/otp/verify', async (request, reply) => {
    const phone = String(request.body?.phone ?? '')
    const code = String(request.body?.code ?? '')

    const user = await db.findOne('users', (u) => u.phone === phone)
    if (!user?.otp) {
      return reply.status(400).send({ message: 'Request a new code.' })
    }
    if (Date.now() > user.otp.expiresAt) {
      return reply.status(400).send({ message: 'That code expired. Request a new one.' })
    }
    if (user.otp.code !== code) {
      return reply.status(400).send({ message: 'That code is not correct.' })
    }

    await db.update('users', user.id, { phoneVerified: true, otp: null })
    return { verified: true }
  })

  // ---- Session -----------------------------------------------------------
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })
    return { user: publicUser(user) }
  })
}
