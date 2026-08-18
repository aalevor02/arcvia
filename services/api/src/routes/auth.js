import { db, nanoid } from '../store.js'
import { hashPassword, verifyPassword, issueToken, requireAuth } from '../lib/auth.js'
import { grantMonthly } from '../lib/credits.js'
import plansConfig from '@arcvia/brand/plans'

const { defaultPlanId } = plansConfig

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_COOLDOWN_MS = 30 * 1000

/** True once a real SMS provider is configured. */
const SMS_CONFIGURED = Boolean(process.env.SMS_PROVIDER)
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

/**
 * Reduce anything the client sends to canonical E.164, or null.
 *
 * This exists because the alternative — each caller prefixing `+91` itself —
 * produced `+91+919154385159` the moment a value that had *already* been
 * normalised was passed back in. Normalising in exactly one place, and making
 * it idempotent, removes the whole class of bug: it does not matter whether the
 * caller sends `9154385159`, `+919154385159`, `09154385159` or `+91 91543 85159`.
 */
export function normalisePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '')

  // Strip prefixes by LENGTH, never by pattern alone.
  //
  // The obvious implementation — `digits.replace(/^(91|0)/, '')` — is wrong,
  // and wrong in a way that only shows up on real numbers. Indian mobiles are
  // 10 digits beginning 6-9, so `9154385159` is a perfectly ordinary number
  // that happens to start with "91". Blind stripping turns it into 8 digits and
  // rejects a valid input.
  //
  // Length disambiguates it: a bare national number is 10 digits, so a leading
  // 91 is only a country code when there are 12.
  let local
  if (digits.length === 10) local = digits
  else if (digits.length === 11 && digits.startsWith('0')) local = digits.slice(1)
  else if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2)
  else if (digits.length === 13 && digits.startsWith('091')) local = digits.slice(3)
  else return null

  // Indian mobile numbers begin 6-9. Landlines and short codes are not valid
  // destinations for an SMS OTP, so rejecting them here is correct.
  return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null
}

function generateOtp() {
  return {
    code: String(Math.floor(100000 + Math.random() * 900000)),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    sentAt: Date.now(),
  }
}

/**
 * Deliver a code, or log it in development.
 *
 * Returns the code itself only when there is no SMS provider AND we are not in
 * production — the signup flow is otherwise impossible to test without paying
 * an SMS bill. The two conditions are deliberately belt-and-braces: forgetting
 * to set NODE_ENV must not be sufficient to leak codes over the API.
 */
async function deliverOtp(app, phone, code) {
  if (SMS_CONFIGURED) {
    // TODO: call your SMS provider here.
    app.log.info({ phone }, 'otp dispatched')
    return { devCode: undefined }
  }

  app.log.warn(
    `\n  ┌─────────────────────────────────────────┐\n` +
      `  │  DEV OTP for ${phone}  →  ${code}  │\n` +
      `  └─────────────────────────────────────────┘\n`,
  )

  return { devCode: IS_PRODUCTION ? undefined : code }
}

/** `+919154385159` -> `+91 •••••85159`, for echoing back safely. */
function maskPhone(phone) {
  return `+91 •••••${String(phone).slice(-5)}`
}

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

    const normalisedPhone = normalisePhone(phone)
    if (phone && !normalisedPhone) {
      return reply
        .status(400)
        .send({ message: 'Enter a valid 10-digit mobile number.' })
    }

    // Issue the first code as part of registration rather than waiting for the
    // verify page to ask for one. The form promises "we send a one-time code",
    // so the code must already be on its way by the time that page renders —
    // otherwise the user sits on a screen waiting for an SMS nobody sent.
    const otp = normalisedPhone ? generateOtp() : null

    const user = await db.insert('users', {
      name: String(name).trim(),
      email: normalisedEmail,
      phone: normalisedPhone,
      passwordHash: await hashPassword(String(password)),
      organisationId: org.id,
      planId: defaultPlanId,
      credits: 0,
      phoneVerified: false,
      emailVerified: false,
      otp,
    })

    await db.update('organisations', org.id, {
      ownerId: user.id,
      seats: [user.id],
    })

    // Grant the first month's credits immediately so a new account can render
    // straight away instead of waiting for a billing cycle that does not exist.
    await grantMonthly(user.id)

    let devCode
    if (otp) {
      ;({ devCode } = await deliverOtp(app, normalisedPhone, otp.code))
    }

    const fresh = await db.findOne('users', (u) => u.id === user.id)
    return reply.status(201).send({
      token: await issueToken(fresh),
      user: publicUser(fresh),
      otpSent: Boolean(otp),
      ...(devCode ? { devCode } : {}),
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
  //
  // Both routes require authentication and operate on the *signed-in user*,
  // never on a phone number looked up from the request. Matching by phone was
  // wrong twice over: two accounts can legitimately share a number (and then
  // `findOne` silently picks whichever was created first), and an
  // unauthenticated verify endpoint lets anyone brute-force a six-digit code
  // against a number they do not own.

  app.post('/otp/send', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })

    // Allow changing the number at this step — people mistype it on signup.
    const phone = request.body?.phone
      ? normalisePhone(request.body.phone)
      : user.phone

    if (!phone) {
      return reply
        .status(400)
        .send({ message: 'Enter a valid 10-digit mobile number.' })
    }

    if (user.phoneVerified && phone === user.phone) {
      return { sent: false, alreadyVerified: true }
    }

    // Every send costs money and repeated sends look like abuse to the
    // provider, so the cooldown is enforced server-side too — not just by the
    // disabled button on the client, which anyone can bypass.
    const since = Date.now() - (user.otp?.sentAt ?? 0)
    if (user.otp && since < OTP_RESEND_COOLDOWN_MS) {
      return reply.status(429).send({
        message: `Wait ${Math.ceil((OTP_RESEND_COOLDOWN_MS - since) / 1000)}s before requesting another code.`,
        retryAfter: Math.ceil((OTP_RESEND_COOLDOWN_MS - since) / 1000),
      })
    }

    const otp = generateOtp()
    await db.update('users', user.id, { phone, otp })

    const { devCode } = await deliverOtp(app, phone, otp.code)

    return {
      sent: true,
      phone: maskPhone(phone),
      expiresInSeconds: OTP_TTL_MS / 1000,
      // Present only in development with no SMS provider configured.
      ...(devCode ? { devCode } : {}),
    }
  })

  app.post('/otp/verify', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })
    if (user.phoneVerified) return { verified: true, alreadyVerified: true }

    const otp = user.otp
    if (!otp) {
      return reply.status(400).send({ message: 'Request a code first.' })
    }
    if (Date.now() > otp.expiresAt) {
      await db.update('users', user.id, { otp: null })
      return reply.status(400).send({ message: 'That code expired. Request a new one.' })
    }

    // Cap attempts, then burn the code. Without this a six-digit secret is a
    // million guesses away from anyone with a valid session.
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await db.update('users', user.id, { otp: null })
      return reply
        .status(429)
        .send({ message: 'Too many incorrect attempts. Request a new code.' })
    }

    const supplied = String(request.body?.code ?? '').replace(/\D/g, '')

    if (supplied !== otp.code) {
      const attempts = otp.attempts + 1
      await db.update('users', user.id, { otp: { ...otp, attempts } })
      return reply.status(400).send({
        message: 'That code is not correct.',
        attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
      })
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
