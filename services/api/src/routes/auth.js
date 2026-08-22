import { db, nanoid } from '../store.js'
import { hashPassword, verifyPassword, issueToken, requireAuth } from '../lib/auth.js'
import { grantMonthly } from '../lib/credits.js'
import { recordReferral, generateReferralCode } from './referral.js'
import plansConfig from '@arcvia/brand/plans'
import { createLimiter } from '../lib/rateLimit.js'

const { defaultPlanId } = plansConfig

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ── Throttles for the unauthenticated credential endpoints ──────────────────
// Failures only. A user with the right password is never limited; a guesser is.
// Login is keyed on IP + email so one attacker cannot lock every account and a
// real owner is not locked out from their own network by a guesser elsewhere.
// Forgot-password is keyed on IP alone — it must not reveal whether an address
// exists, so it cannot branch on the email — plus a per-email cap so a mailbox
// cannot be flooded from many IPs.
const loginLimiter = createLimiter({ limit: 10, windowMs: 15 * 60 * 1000 })
const forgotIpLimiter = createLimiter({ limit: 20, windowMs: 60 * 60 * 1000 })
const forgotEmailLimiter = createLimiter({ limit: 5, windowMs: 60 * 60 * 1000 })

/** The caller's address, honouring a proxy hop when one is configured. */
function clientIp(request) {
  const fwd = request.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return request.ip || 'unknown'
}

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_COOLDOWN_MS = 30 * 1000

/** True once a real SMS provider is configured. */
const SMS_CONFIGURED = Boolean(process.env.SMS_PROVIDER)
/** True once a real mail provider is configured. */
const MAIL_CONFIGURED = Boolean(process.env.MAIL_PROVIDER)
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

/**
 * How long a password-reset link stays usable.
 *
 * Short, because this token *is* the account for as long as it lives, and it
 * lives in an inbox — a place with a long memory and, frequently, other
 * people's access. One hour is enough for someone to find the mail and act on
 * it, and short enough that a forwarded thread from last week is inert.
 */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

/**
 * How long a cross-origin hand-off ticket lives.
 *
 * Thirty seconds. The ticket exists only to survive one redirect, so anything
 * longer is pure exposure — it rides in a URL, which lands in browser history
 * and can leak through a referrer header.
 */
const HANDOFF_TTL_MS = 30 * 1000

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

/**
 * Send the reset link, or log it in development.
 *
 * Mirrors deliverOtp deliberately: same two-condition guard, same shape. When
 * the mail provider is wired up, this is the only function that changes.
 */
async function deliverPasswordReset(app, user, token) {
  const url = `${process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321'}/reset-password/?token=${token}`

  if (MAIL_CONFIGURED) {
    // TODO: call your mail provider here.
    app.log.info({ email: user.email }, 'password reset dispatched')
    return
  }

  app.log.warn(`\n  DEV PASSWORD RESET for ${user.email}\n  →  ${url}\n`)
}

/** The live token for a user, for the development-only echo. */
async function currentResetToken(userId) {
  const record = await db.findOne(
    'passwordResets',
    (r) => r.userId === userId && !r.usedAt,
  )
  return record?.token
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
    const { name, email, organisation, phone, password, referralCode } =
      request.body ?? {}

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
      referralCode: generateReferralCode(),
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

    // Credit the referral *now*, at the only moment the code is in hand. A
    // referral that is not recorded at signup cannot be reconstructed later —
    // there is no trace linking the two accounts once the form is gone. An
    // unknown or self-referring code is ignored rather than rejected: a typo
    // must never cost someone their account.
    if (referralCode) {
      await recordReferral(user.id, org.id, referralCode)
    }

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

    // Keyed on IP AND email: an attacker guessing one account is limited on
    // that account, and cannot lock every account by rotating the email; a real
    // owner is not locked out of their account by a guesser on another network.
    const key = `${clientIp(request)}|${normalisedEmail}`
    const gate = loginLimiter.check(key)
    if (gate.limited) {
      return reply
        .status(429)
        .header('retry-after', String(gate.retryAfterSeconds))
        .send({ message: 'Too many sign-in attempts. Try again in a few minutes.' })
    }

    const user = await db.findOne('users', (u) => u.email === normalisedEmail)

    // Run the hash comparison even when the user does not exist, so the
    // response time does not reveal which addresses are registered.
    const ok = user
      ? await verifyPassword(String(password ?? ''), user.passwordHash)
      : await verifyPassword('dummy', 'scrypt$00$00')

    if (!user || !ok) {
      loginLimiter.fail(key)
      return reply.status(401).send({ message: 'Email or password is incorrect.' })
    }

    // A correct sign-in clears the count, so a user who fat-fingered their
    // password twice and then got it right does not carry those attempts.
    loginLimiter.succeed(key)
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
    // ── Changing the number un-verifies it ───────────────────────────────────
    // Writing the new `phone` while leaving `phoneVerified` at its old `true`
    // let a verified user point the field at a stranger's number: /otp/verify
    // short-circuits on the stale flag before the code is even compared, so
    // `000000` returned {verified:true} for a number that never consented.
    // Nothing reads phoneVerified today, so the live damage is a wasted SMS and
    // a wrong field — but it becomes real the day anything trusts it, and the
    // fix is one clause: verified survives only if the number did not change.
    const phoneVerified = phone === user.phone && Boolean(user.phoneVerified)
    await db.update('users', user.id, { phone, otp, phoneVerified })

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

  // ---- Password reset ----------------------------------------------------
  //
  // Two routes, and the interesting decisions are both in the first one.

  app.post('/password/forgot', async (request, reply) => {
    const email = String(request.body?.email ?? '').trim().toLowerCase()

    // Two limits, and the ORDER of what they gate matters for the membership
    // oracle this endpoint is careful not to be. The IP limit is checked first
    // and returns the SAME generic 429 whether or not the address exists — it
    // cannot branch on the user. The per-email limit gates only the mailer
    // inside the `if (user)` branch below, so it changes how many emails a
    // mailbox receives but never changes the response, which stays identical
    // for a real and a fake address.
    const ipGate = forgotIpLimiter.check(clientIp(request))
    if (ipGate.limited) {
      return reply
        .status(429)
        .header('retry-after', String(ipGate.retryAfterSeconds))
        .send({ message: 'Too many requests. Try again later.' })
    }
    forgotIpLimiter.fail(clientIp(request))

    const user = EMAIL_RE.test(email)
      ? await db.findOne('users', (u) => u.email === email)
      : null

    if (user && !forgotEmailLimiter.check(email).limited) {
      forgotEmailLimiter.fail(email)
      // Invalidate any outstanding token before issuing a new one. Otherwise
      // every "I didn't get the email, send it again" click leaves another
      // working key to the account lying in an inbox.
      const outstanding = await db.find(
        'passwordResets',
        (r) => r.userId === user.id && !r.usedAt,
      )
      for (const r of outstanding) await db.remove('passwordResets', r.id)

      const record = await db.insert('passwordResets', {
        userId: user.id,
        token: `${nanoid(16)}${nanoid(16)}`,
        expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
        usedAt: null,
      })

      await deliverPasswordReset(app, user, record.token)
    }

    // Always the same response, whether or not the address exists. The
    // alternative — "no account with that email" — turns this endpoint into a
    // free membership oracle: anyone can test a list of addresses against it
    // and learn who has an account here.
    return {
      sent: true,
      message:
        'If that address has an account, a reset link is on its way to it.',
      // Development only, and only with no mail provider configured: without
      // this the flow cannot be tested without wiring up SMTP first.
      ...(!MAIL_CONFIGURED && !IS_PRODUCTION && user
        ? { devToken: await currentResetToken(user.id) }
        : {}),
    }
  })

  app.post('/password/reset', async (request, reply) => {
    const token = String(request.body?.token ?? '')
    const password = String(request.body?.password ?? '')

    if (password.length < 8) {
      return reply
        .status(400)
        .send({ message: 'Password must be at least 8 characters.' })
    }

    const record = await db.findOne('passwordResets', (r) => r.token === token)

    // One message for missing, expired and already-used. Distinguishing them
    // tells an attacker holding a guessed token whether it ever existed.
    if (!record || record.usedAt || Date.now() > record.expiresAt) {
      return reply
        .status(400)
        .send({ message: 'That reset link is invalid or has expired.' })
    }

    const user = await db.findOne('users', (u) => u.id === record.userId)
    if (!user) {
      return reply
        .status(400)
        .send({ message: 'That reset link is invalid or has expired.' })
    }

    await db.update('users', user.id, {
      passwordHash: await hashPassword(password),
    })
    await db.update('passwordResets', record.id, {
      usedAt: new Date().toISOString(),
    })

    // Sign them straight in. Making someone who has just proved control of the
    // account type the password they set four seconds ago is friction with no
    // security value.
    const fresh = await db.findOne('users', (u) => u.id === user.id)
    return { token: await issueToken(fresh), user: publicUser(fresh) }
  })

  // ---- Cross-origin hand-off ---------------------------------------------
  //
  // The site and the studio are separate origins, so they do not share
  // localStorage — signing in on one leaves the other signed out, and there is
  // no way around that short of cookies on a shared parent domain, which does
  // not exist during local development (`localhost:4321` vs `localhost:5173`).
  //
  // So: a signed-in page asks for a single-use ticket, puts it in the URL it
  // navigates to, and the receiving app trades it for a real session.
  //
  // The ticket is deliberately weak on purpose — short-lived, one-use, and it
  // grants exactly what the bearer already had. It travels in a URL, which
  // means it will end up in browser history and possibly a referrer header, so
  // it must be worthless within seconds of being used.

  app.post('/handoff', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })

    const ticket = await db.insert('handoffTickets', {
      userId: user.id,
      ticket: `${nanoid(16)}${nanoid(16)}`,
      expiresAt: Date.now() + HANDOFF_TTL_MS,
      usedAt: null,
    })

    return { ticket: ticket.ticket, expiresInSeconds: HANDOFF_TTL_MS / 1000 }
  })

  app.post('/handoff/redeem', async (request, reply) => {
    const supplied = String(request.body?.ticket ?? '')
    const record = await db.findOne('handoffTickets', (t) => t.ticket === supplied)

    // One message for missing, expired and already-used, as with password
    // reset: distinguishing them tells a holder of a guessed ticket whether it
    // ever existed.
    if (!record || record.usedAt || Date.now() > record.expiresAt) {
      return reply.status(400).send({ message: 'That sign-in link has expired.' })
    }

    const user = await db.findOne('users', (u) => u.id === record.userId)
    if (!user) {
      return reply.status(400).send({ message: 'That sign-in link has expired.' })
    }

    // Burn it before issuing the session, not after. If the write fails, the
    // caller gets an error and no session — which is the safe way round.
    await db.update('handoffTickets', record.id, {
      usedAt: new Date().toISOString(),
    })

    return { token: await issueToken(user), user: publicUser(user) }
  })

  // ---- Session -----------------------------------------------------------
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })
    return { user: publicUser(user) }
  })
}
