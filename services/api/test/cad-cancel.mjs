/**
 * Cancelling a CAD job actually stops it, and it stays cancelled.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * DELETE /cad/jobs/:id wrote 'cancelled' and refunded, but never told the
 * queue: cad.js imported only { enqueue }. A queued job stayed in `pending` and
 * ran seconds later — free CPU, and a cancelled job reappearing as a completed
 * import. A running job kept going, and the queue's finish('done') then raced
 * the cancel and overwrote it — the API said cancelled, the record said done at
 * 100%, refunded 0.
 *
 * The fix wired cancelJob() into the route (splice a queued job, abort a
 * running one's engine), declined the refund for a running job that already
 * spent the CPU, and gave the queue's finish() a terminal-status guard so it
 * refuses to move a row already marked cancelled.
 *
 * This runs against the shared server (which has the Python engine), like
 * cad.mjs. Needs the API running with the CAD engine available: `npm run
 * dev:api`. Skips cleanly if the engine is not present.
 *
 * Run: node test/cad-cancel.mjs
 */

import { readFile } from 'node:fs/promises'

const BASE = 'http://localhost:8787'
const DRAWING = 'A:/Projects/CasaAltinho/_work/cad/dxf/DOWN VILLA -WD 22-1-24.dxf'

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

// A missing SERVER and a missing ENGINE are different answers and only one of
// them is a skip — see the longer note in `cad.mjs`. Reported as "0 passed, 0
// failed" with exit 0, a suite nobody started reads exactly like a suite that
// passed.
const health = await fetch(`${BASE}/cad/health`).then((r) => r.json()).catch(() => null)
if (health === null) {
  console.error(`FAIL  no API is listening on ${BASE} — start one before this suite:`)
  console.error('        cd services/api && node src/server.js')
  console.error('\n0 passed, 1 failed (nothing was tested)')
  process.exit(1)
}
if (!health.ok) {
  console.log('SKIP  the CAD engine is not available on this server')
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}

const stamp = Date.now()
const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Cancel Tester',
    email: `cadcancel+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Cancel Co',
  }),
}).then((r) => r.json())
const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }

async function balance() {
  const r = await fetch(`${BASE}/billing/credits`, { headers: auth }).then((x) => x.json())
  return r.credits ?? r.balance ?? 0
}
async function jobStatus(id) {
  return fetch(`${BASE}/cad/jobs/${id}`, { headers: auth }).then((r) => r.json())
}

// Upload a real DXF once; both jobs reference the same key.
const bytes = await readFile(DRAWING)
const form = new FormData()
form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'villa.dxf')
const upload = await fetch(`${BASE}/uploads/floorplan`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${account.token}` },
  body: form,
}).then((r) => r.json())
const key = upload.key
ok('a real DXF uploaded', Boolean(key), key)

// `frame` is part of the idempotency fingerprint, so distinct frames are two
// distinct jobs rather than one deduplicated submission.
async function submit(frame) {
  const r = await fetch(`${BASE}/cad/jobs`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ key, autoLayers: true, frame }),
  }).then((x) => x.json())
  return r.jobId
}
async function cancel(id) {
  // Authorization ONLY — no Content-Type. A DELETE carries no body, and Fastify
  // rejects a `Content-Type: application/json` with an empty body as a 400.
  return fetch(`${BASE}/cad/jobs/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${account.token}` },
  }).then((r) => r.json())
}

const before = await balance()

// Submit one job and cancel it as fast as possible. Real-engine timing decides
// whether the cancel catches it queued, running, or (if the villa reconstructs
// unusually fast) already done — so the test asserts the invariant that holds
// in every one of those cases rather than forcing a particular one.
const job = await submit(0)
ok('a job was accepted', Boolean(job), job)

const cancelled = await cancel(job)

if (cancelled.status === 'done' || cancelled.status === 'failed') {
  // The reconstruction beat the cancel. Nothing to assert about cancellation,
  // but the refund accounting must still be sane: a completed job is billed.
  console.log(`SKIP  the job reached ${cancelled.status} before the cancel landed`)
  ok('a completed job leaves the charge in place', before - (await balance()) === 3,
     `spent ${before - (await balance())}`)
} else {
  ok('the cancel reports cancelled', cancelled.status === 'cancelled', cancelled.status)

  // ── The core regression ──────────────────────────────────────────────────
  // Once cancelled, the job must STAY cancelled — this is the finish('done')
  // race that used to overwrite it, and the cancelJob() splice/abort that used
  // to be missing so a queued job ran anyway. Poll well past the seconds a
  // reconstruction takes: it must never reach done.
  let flippedToDone = false
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await jobStatus(job)
    if (s.status === 'done') flippedToDone = true
    if (['done', 'failed', 'cancelled'].includes(s.status)) {
      await new Promise((r) => setTimeout(r, 1200)) // let any late finish() try
      break
    }
  }
  const final = await jobStatus(job)
  ok('the cancelled job never ran to done — cancelJob stopped it, finish() left it alone',
     !flippedToDone && final.status === 'cancelled', final.status)

  // Money safety: the user is charged for at most one reconstruction and never
  // refunded twice. A cancel-while-queued refunds the full 3 (net 0); a
  // cancel-while-running either keeps the charge (net 3) or, if the abort's
  // failure path returns the money for a job that produced no usable output,
  // net 0 — both are defensible. What must NEVER happen is a negative net
  // (double refund) or a net above one job's price. The declineRefund stamp is
  // what guarantees a LATER failure cannot then refund again.
  const spent = before - (await balance())
  ok('the user is charged for at most one job and never double-refunded',
     spent >= 0 && spent <= 3, `refunded ${cancelled.refunded}, net spent ${spent}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
