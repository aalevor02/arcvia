/**
 * Referral codes and the password-reset round trip.
 *
 * ── Why this header exists ─────────────────────────────────────────────────
 * Every assertion below used to be decorative. `ok()` was a bare
 * `console.log` — it printed the word FAIL and then did nothing with it: no
 * counter, no summary line, no exit code. The file therefore **could not
 * fail**. A regression in referral codes or in password reset would have
 * printed thirteen FAIL lines into a scrolling log and still exited 0, and the
 * `&&` chain in package.json would have carried straight on to the next file
 * and reported the suite green.
 *
 * It was found by counting rather than by reading: every other file in this
 * directory ends with "N passed, M failed" and this one ended with a PASS
 * line, so the run's total came up short of the 485 on the board. That is the
 * only signal it ever gave.
 *
 * Two consequences, both deliberate:
 *
 *   - `ok()` counts, the file prints a summary, and a failure sets the exit
 *     code. A test that cannot fail is worse than no test, because it occupies
 *     the space where a real one would be noticed missing.
 *   - No server means the HARNESS is wrong, not that there is nothing to test.
 *     Unlike test/cad.mjs there is no legitimate skip here — this file needs no
 *     separate install, only a server — so a dead fetch exits 1 and names the
 *     command, rather than crashing with an uncaught TypeError the way it did
 *     before.
 *
 * Needs the API running: `npm run dev:api`.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now()

// A dead fetch and a failing assertion are different answers and used to look
// identical: an unguarded `await fetch` threw an uncaught TypeError, which
// killed the &&-chain with a stack trace that named node internals rather than
// the missing server.
const reachable = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)
if (!reachable) {
  console.error(`FAIL  no API is listening on ${BASE} — start one before this suite:`)
  console.error('        npm run dev:api')
  console.error('\n0 passed, 1 failed (nothing was tested)')
  process.exit(1)
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) passed++
  else failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

// 1. Alice registers (the referrer)
const alice = await call('/auth/register', {
  method: 'POST',
  body: {
    name: 'Alice Referrer',
    email: `alice${stamp}@example.com`,
    organisation: `Alice Studio ${stamp}`,
    password: 'password123',
  },
})
ok('register referrer', alice.status === 201, String(alice.status))

// 2. Alice reads her referral code
const ref = await call('/referral/me', { token: alice.json.token })
ok('referral/me returns a code', /^[A-Z0-9]{8}$/.test(ref.json.code ?? ''), ref.json.code)
ok('referral link contains code', String(ref.json.link).includes(ref.json.code))
ok('payouts flagged off while billing is off', ref.json.payoutsEnabled === false)
ok('earnings null (not 0) while billing off', ref.json.earnings === null)
ok('starts with zero referrals', ref.json.total === 0)

// 3. Validate the code, and a bogus one
const good = await call(`/referral/validate/${ref.json.code}`)
const goodLower = await call(`/referral/validate/${String(ref.json.code).toLowerCase()}`)
const bad = await call('/referral/validate/NOPE1234')
ok('validate accepts real code', good.json.valid === true)
ok('validate is case-insensitive', goodLower.json.valid === true)
ok('validate rejects unknown code', bad.json.valid === false)

// 4. Bob registers WITH Alice's code
const bob = await call('/auth/register', {
  method: 'POST',
  body: {
    name: 'Bob Referred',
    email: `bob${stamp}@example.com`,
    organisation: `Bob Builders ${stamp}`,
    password: 'password123',
    referralCode: ref.json.code.toLowerCase(), // lowercase on purpose
  },
})
ok('referred signup succeeds', bob.status === 201, String(bob.status))

const ref2 = await call('/referral/me', { token: alice.json.token })
ok('referral recorded', ref2.json.total === 1, `total=${ref2.json.total}`)
ok(
  'referral names the org',
  ref2.json.joined?.[0]?.organisation === `Bob Builders ${stamp}`,
  ref2.json.joined?.[0]?.organisation,
)

// 5. Self-referral must not credit
const selfRef = await call('/referral/me', { token: bob.json.token })
const carol = await call('/auth/register', {
  method: 'POST',
  body: {
    name: 'Carol Self',
    email: `carol${stamp}@example.com`,
    organisation: `Carol Co ${stamp}`,
    password: 'password123',
    referralCode: 'TOTALLYFAKE',
  },
})
ok('unknown code does not block signup', carol.status === 201, String(carol.status))

// 6. Password reset round trip
const forgot = await call('/auth/password/forgot', {
  method: 'POST',
  body: { email: `alice${stamp}@example.com` },
})
ok('forgot returns generic success', forgot.json.sent === true)
ok('forgot exposes dev token in dev', typeof forgot.json.devToken === 'string')

const unknown = await call('/auth/password/forgot', {
  method: 'POST',
  body: { email: `nobody${stamp}@example.com` },
})
ok(
  'unknown email gets identical response (no enumeration)',
  unknown.json.sent === true && unknown.json.message === forgot.json.message,
)
ok('unknown email gets no token', unknown.json.devToken === undefined)

const reset = await call('/auth/password/reset', {
  method: 'POST',
  body: { token: forgot.json.devToken, password: 'brand-new-pass' },
})
ok('reset succeeds and signs in', reset.status === 200 && Boolean(reset.json.token))

const replay = await call('/auth/password/reset', {
  method: 'POST',
  body: { token: forgot.json.devToken, password: 'another-one' },
})
ok('token cannot be reused', replay.status === 400)

const short = await call('/auth/password/reset', {
  method: 'POST',
  body: { token: 'x', password: 'short' },
})
ok('short password rejected', short.status === 400)

const loginNew = await call('/auth/login', {
  method: 'POST',
  body: { email: `alice${stamp}@example.com`, password: 'brand-new-pass' },
})
ok('new password works', loginNew.status === 200)

const loginOld = await call('/auth/login', {
  method: 'POST',
  body: { email: `alice${stamp}@example.com`, password: 'password123' },
})
ok('old password rejected', loginOld.status === 401)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
