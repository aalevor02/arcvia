/**
 * The attempt limiter, and the auth routes that now use it.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * /auth/login and /auth/password/forgot had no throttle at all. Measured in the
 * audit: 51 password guesses/sec from one host, and the reset mailer firable as
 * fast as the socket allowed. This pins the limiter's own behaviour with a
 * frozen clock, then proves the login route returns 429 after the ceiling and
 * that a correct password still works within the window.
 *
 * Run: node test/rate-limit.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLimiter, _setClock, _reset } from '../src/lib/rateLimit.js'

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// ---- Unit: the limiter, on a clock we control -----------------------------
{
  let t = 1_000_000
  _setClock(() => t)
  _reset()
  const lim = createLimiter({ limit: 3, windowMs: 10_000 })

  ok('fresh key is not limited', !lim.check('k').limited)
  lim.fail('k')
  lim.fail('k')
  ok('under the ceiling is allowed', !lim.check('k').limited)
  lim.fail('k')
  ok('at the ceiling is limited', lim.check('k').limited)
  ok('and reports a retry-after inside the window',
     lim.check('k').retryAfterSeconds > 0 && lim.check('k').retryAfterSeconds <= 10)

  ok('a different key is unaffected', !lim.check('other').limited)

  t += 10_001
  ok('the window expires', !lim.check('k').limited)

  lim.fail('k')
  ok('and counting restarts fresh after expiry', !lim.check('k').limited)

  lim.fail('k')
  lim.fail('k')
  ok('a success clears the count', (lim.succeed('k'), !lim.check('k').limited))

  _setClock() // restore real clock for the route test
  _reset()
}

// ---- Route: login locks out, then recovers --------------------------------
const PORT = 8820
const BASE = `http://127.0.0.1:${PORT}`
const dir = await mkdtemp(join(tmpdir(), 'arcvia-rl-'))
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (c) => (serverLog += c))
server.stderr.on('data', (c) => (serverLog += c))

async function ready(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await fetch(`${BASE}/health`)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return false
}

async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, payload: await r.json().catch(() => ({})) }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()
  const email = `victim-${stamp}@t.local`
  await call('/auth/register', { name: 'Victim User', email, password: 'the-real-password-1' })

  // Ten wrong guesses (the ceiling), then the eleventh is refused.
  let last
  for (let i = 0; i < 10; i++) {
    last = await call('/auth/login', { email, password: `wrong-${i}` })
  }
  ok('wrong guesses up to the ceiling stay 401', last.status === 401, `status ${last.status}`)

  const blocked = await call('/auth/login', { email, password: 'wrong-again' })
  ok('the next attempt is 429, not another 401', blocked.status === 429, `status ${blocked.status}`)

  // The CORRECT password is now also blocked from this IP+email — which is the
  // point: a guesser who reaches the ceiling cannot then try the real one.
  const correctButBlocked = await call('/auth/login', { email, password: 'the-real-password-1' })
  ok('even the correct password is blocked once locked', correctButBlocked.status === 429)

  // A different account from the same IP is not collateral damage — the key is
  // IP + email, so this account has its own budget.
  const other = `bystander-${stamp}@t.local`
  await call('/auth/register', { name: 'Bystander User', email: other, password: 'another-real-pw-2' })
  const otherOk = await call('/auth/login', { email: other, password: 'another-real-pw-2' })
  ok('a different account from the same host still logs in', otherOk.status === 200,
     `status ${otherOk.status}`)

  // ---- Forgot-password stays a non-oracle even while throttling ----------
  const real = await call('/auth/password/forgot', { email: other })
  const fake = await call('/auth/password/forgot', { email: `nobody-${stamp}@t.local` })
  ok('forgot-password answers identically for real and unknown addresses',
     real.status === fake.status && real.payload.message === fake.payload.message,
     `${real.status}/${fake.status}`)
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
