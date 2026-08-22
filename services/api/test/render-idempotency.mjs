/**
 * Submitting the same render twice must not charge twice.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * POST /render/jobs charged and queued on every request. A double-clicked
 * button sent two identical bodies, so the user paid twice and got two renders
 * of the same frame — which are byte-identical, so the only visible trace is
 * the balance. Nothing errors, nothing looks wrong, and the second charge is
 * indistinguishable from a deliberate second render.
 *
 * Two mechanisms, tested separately because they answer different questions:
 *   Idempotency-Key   the caller states "this is the same submission"
 *   fingerprint       a backstop for callers sending no key, inside a short
 *                     window — which is every caller today
 *
 * ── What must NOT be deduplicated ──────────────────────────────────────────
 * Getting this too aggressive is its own silent failure: the user asks for two
 * renders, gets one, and nothing says so. So a different camera, a different
 * preset, a different scene and a different user all have to get their own job,
 * and each is asserted below.
 *
 * Needs the API running: `npm run dev:api`.
 */

const BASE = 'http://localhost:8787'
const stamp = Date.now()

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

async function account(tag) {
  const a = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Idem ${tag}`,
      email: `idem+${tag}+${stamp}@example.com`,
      password: 'correct horse battery staple',
      organisation: `Idem Co ${tag}`,
    }),
  }).then((r) => r.json())
  return { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }
}

const auth = await account('a')
const other = await account('b')

async function sceneFor(headers, name) {
  const s = await fetch(`${BASE}/scenes/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  })
    .then((r) => r.json())
    .then((r) => r.scene)
  // A render needs a model. The URL only has to resolve, not exist — submission
  // resolves it, the worker is what would read it.
  await fetch(`${BASE}/scenes/${s.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ modelUrl: '/uploads/scenes/x/model.glb' }),
  })
  return s
}

const scene = await sceneFor(auth, `Idem scene ${stamp}`)
const second = await sceneFor(auth, `Idem scene two ${stamp}`)
const theirs = await sceneFor(other, `Their scene ${stamp}`)
ok('set up two scenes and a second account', Boolean(scene?.id && second?.id && theirs?.id))

const submit = (headers, body, extra = {}) =>
  fetch(`${BASE}/render/jobs`, {
    method: 'POST',
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

const balance = (headers) =>
  fetch(`${BASE}/billing/subscription`, { headers })
    .then((r) => r.json())
    .then((r) => r.credits)

const job = { sceneId: scene.id, preset: 'preview', cameraPosition: { x: 1, y: 2, z: 3 } }

console.log('\n-- the double click --')
const before = await balance(auth)
const first = await submit(auth, job)
const dupe = await submit(auth, job)

ok('the first submission creates a job', first.status === 201, String(first.status))
ok('the second returns 200, not 201', dupe.status === 200, String(dupe.status))
ok('and the SAME job id', dupe.body.jobId === first.body.jobId,
  `${first.body.jobId} vs ${dupe.body.jobId}`)
ok('and says so, rather than passing off an old job as new',
  dupe.body.deduplicated === true)
ok('and charges nothing the second time', dupe.body.creditsCharged === 0,
  String(dupe.body.creditsCharged))

const after = await balance(auth)
ok('so two clicks cost one render',
  before - after === first.body.creditsCharged,
  `spent ${before - after}, one render costs ${first.body.creditsCharged}`)

console.log('\n-- what must still get its own job --')
// Each of these is a real second render. Collapsing any of them would mean the
// user asked for two and silently got one.
const moved = await submit(auth, { ...job, cameraPosition: { x: 9, y: 2, z: 3 } })
ok('a different camera is a different render', moved.status === 201,
  `${moved.status} ${moved.body.jobId}`)

const bigger = await submit(auth, { ...job, preset: 'isometric' })
ok('a different preset is a different render', bigger.status === 201, String(bigger.status))

const elsewhere = await submit(auth, { ...job, sceneId: second.id })
ok('a different scene is a different render', elsewhere.status === 201, String(elsewhere.status))

// The dedupe is keyed on the owner as well. Two users submitting identical
// bodies must not share a job — that would hand one user's render to another.
const mine = await submit(auth, { sceneId: scene.id, preset: 'full' })
const yours = await submit(other, { sceneId: theirs.id, preset: 'full' })
ok('another user never receives my job', yours.body.jobId !== mine.body.jobId,
  `${mine.body.jobId} vs ${yours.body.jobId}`)
ok('and is charged for their own', yours.status === 201, String(yours.status))

console.log('\n-- an explicit Idempotency-Key --')
const keyed = { 'Idempotency-Key': `key-${stamp}` }
const k1 = await submit(auth, { sceneId: second.id, preset: 'full' }, keyed)
// Deliberately a DIFFERENT body under the same key. A key is a statement about
// the submission, not about the payload — a client retrying after a dropped
// response is the case it exists for, and it should not create a second job
// just because a timestamp inside the body moved.
const k2 = await submit(auth, { sceneId: scene.id, preset: 'preview' }, keyed)
ok('a repeated key returns the first job', k2.body.jobId === k1.body.jobId,
  `${k1.body.jobId} vs ${k2.body.jobId}`)
ok('even when the body differs', k2.status === 200 && k2.body.deduplicated === true)

const k3 = await submit(auth, { sceneId: second.id, preset: 'full' },
  { 'Idempotency-Key': `other-${stamp}` })
ok('a different key is a different job', k3.body.jobId !== k1.body.jobId,
  String(k3.status))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
