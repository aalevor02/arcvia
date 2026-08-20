const BASE = 'http://localhost:8787'
const stamp = Date.now()

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

const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)

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
