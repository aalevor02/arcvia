/**
 * The queue survives a restart.
 *
 * ── What this pins down ─────────────────────────────────────────────────────
 * Reconciliation used to fail-and-refund every orphan, which made a deploy a
 * small massacre: ten queued bakes died having lost nothing. Now each orphan
 * gets what its state deserves, and this proves all three branches:
 *
 *   1. LIVE, remote mode: submit three jobs, kill the server mid-flight,
 *      restart on the same database. The queued two re-queue and run; the
 *      rendering one is left for its worker, whose callback still lands —
 *      the callback writes to the row, not to any in-memory state.
 *   2. WATCHDOG: a seeded 'rendering' remote job whose worker never calls
 *      back is failed and refunded when its remaining time budget runs out.
 *   3. RETRY CAP, in-process: a job orphaned mid-render re-queues once and
 *      is failed-and-refunded the second time; queued orphans re-queue
 *      without ever counting against the cap.
 *
 * ── The RENDER_DAILY_CAP=0 trick ────────────────────────────────────────────
 * Section 3 needs re-queued jobs to STAY queued so their rows can be read,
 * without a Blender to run them. The daily cap holds jobs in `pending`
 * without failing them — a spend guard doing double duty as a freeze-frame.
 *
 * Run: node test/queue-persistence.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const SECRET = 'test-secret'
const PORT = 8823
const BASE = `http://127.0.0.1:${PORT}`

// ---- Stub worker: accept, count, never reply -------------------------------
let inbound = 0
const held = []
const worker = createServer((req, res) => {
  inbound += 1
  held.push(res)
})
await new Promise((r) => worker.listen(0, '127.0.0.1', r))
const WORKER_URL = `http://127.0.0.1:${worker.address().port}`

const servers = []
function boot(dbPath, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
      RENDER_MODE: 'remote',
      RENDER_WORKER_URL: WORKER_URL,
      RENDER_CONCURRENCY: '1',
      WORKER_SECRET: SECRET,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.log = ''
  child.stdout.on('data', (c) => (child.log += c))
  child.stderr.on('data', (c) => (child.log += c))
  servers.push(child)
  return child
}

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

async function gone(child) {
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  // The port must actually be free before the next boot claims it.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/health`)
      await new Promise((r) => setTimeout(r, 100))
    } catch {
      return
    }
  }
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, payload: await r.json().catch(() => ({})) }
}

/**
 * Wait for a condition, and remember how long it actually took.
 *
 * The boolean alone cannot tell a comfortable pass from a pass that nearly was
 * not one, which is why this file's known flake could be observed and never
 * diagnosed: branch 2's watchdog missed its 15 s window once, on the day's
 * first full chain, and passed on every run since. The recorded suspicion is
 * cold-start contention -- 25 prior test files each booting a server -- and the
 * tempting remedy is to widen the window. That would hide the only evidence
 * there is.
 *
 * So the margin is reported even on success. A wait that has crept from 5 s to
 * 13 s of a 15 s budget is the same failure arriving, and it is invisible while
 * the assertion still says PASS. The number that has been fine for a month is
 * the one worth printing, because it is the only thing that will notice when it
 * stops being fine.
 */
const until = async (test, timeoutMs = 15000) => {
  const started = Date.now()
  const end = started + timeoutMs
  while (Date.now() < end) {
    if (await test()) {
      until.elapsedMs = Date.now() - started
      until.budgetMs = timeoutMs
      return true
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  until.elapsedMs = Date.now() - started
  until.budgetMs = timeoutMs
  return false
}

/** How close that wait came to its budget, as something a reader can act on. */
const margin = () => {
  const used = until.elapsedMs ?? 0
  const budget = until.budgetMs ?? 0
  if (!budget) return ''
  const share = used / budget
  const note = share >= 0.6 ? '  <-- NARROW, this is the flake approaching' : ''
  return `${(used / 1000).toFixed(1)}s of ${(budget / 1000).toFixed(0)}s${note}`
}

const readDb = async (dbPath) => JSON.parse(await readFile(dbPath, 'utf8'))

const dir = await mkdtemp(join(tmpdir(), 'arcvia-qp-'))

try {
  // =========================================================================
  console.log('\n-- 1. a restart re-queues the queued and waits for the rendering --')
  const dbA = join(dir, 'a', 'db.json')
  await mkdir(join(dir, 'a'), { recursive: true })

  let server = boot(dbA)
  ok('the test server started', await ready(), `worker ${WORKER_URL}`)

  const stamp = Date.now()
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Queue Tester', email: `q-${stamp}@t.local`, password: 'correct horse battery st' },
  })
  const token = reg.payload.token
  const scene = (
    await call('/scenes/', { method: 'POST', token, body: { name: `QP ${stamp}` } })
  ).payload.scene
  await call(`/scenes/${scene.id}`, { method: 'PATCH', token, body: { modelUrl: '/uploads/x.glb' } })

  const jobs = []
  for (let i = 0; i < 3; i++) {
    const r = await call('/render/jobs', {
      method: 'POST',
      token,
      body: { sceneId: scene.id, preset: 'preview', cameraPosition: { x: i, y: 2, z: 5 } },
    })
    jobs.push(r.payload.jobId)
  }
  ok('three jobs submitted', jobs.every(Boolean))
  ok('the first reached the worker and holds its slot', await until(() => inbound === 1))

  await gone(server)
  server = boot(dbA)
  ok('the server restarted on the same database', await ready())

  // The rendering job is the worker's; the queued two re-queue, and with
  // concurrency 1... the watched job does NOT occupy the in-memory slot, so
  // the first re-queued job goes straight to the worker.
  ok('a re-queued job reached the worker after the restart',
     await until(() => inbound >= 2), `worker saw ${inbound} submissions`)

  const j1 = await call(`/render/jobs/${jobs[0]}`, { token })
  ok("the mid-render job was left for its worker, not failed",
     j1.payload.status === 'rendering', `status=${j1.payload.status}`)

  let db = await readDb(dbA)
  ok('no orphan was refunded by the restart',
     db.renderJobs.every((j) => !j.refund),
     db.renderJobs.map((j) => `${j.status}${j.refund ? '/refunded' : ''}`).join(', '))

  // The old worker finishes the watched job AFTER the restart: its callback
  // writes to the row directly, so no in-memory state is needed.
  const cb = await call(`/render/jobs/${jobs[0]}/callback`, {
    method: 'POST',
    headers: { 'x-worker-secret': SECRET },
    body: { status: 'done', progress: 100, outputUrl: '/renders/u/x.png' },
  })
  ok('the worker callback still lands after a restart', cb.status === 200)
  const j1b = await call(`/render/jobs/${jobs[0]}`, { token })
  ok('...and the job is done', j1b.payload.status === 'done')

  // A resolved job refuses a second life: cancel the still-queued third job,
  // then have a confused worker report it done.
  const third = await call(`/render/jobs/${jobs[2]}`, { token })
  ok('the third job is still queued', third.payload.status === 'queued')
  await call(`/render/jobs/${jobs[2]}/cancel`, { method: 'POST', token })
  const late = await call(`/render/jobs/${jobs[2]}/callback`, {
    method: 'POST',
    headers: { 'x-worker-secret': SECRET },
    body: { status: 'done', progress: 100, outputUrl: '/renders/u/y.png' },
  })
  ok('a late callback on a settled job is refused', late.status === 409)
  const j3 = await call(`/render/jobs/${jobs[2]}`, { token })
  ok('...and the cancellation stands', j3.payload.status === 'cancelled')

  await gone(server)

  // =========================================================================
  console.log('\n-- 2. the watchdog fails a remote job whose worker never calls back --')
  const dbB = join(dir, 'b', 'db.json')
  await mkdir(join(dir, 'b'), { recursive: true })
  await writeFile(dbB, JSON.stringify({
    users: [{ id: 'u1', email: 'w@t.local', name: 'W', credits: 10 }],
    renderJobs: [{
      id: 'watched1', ownerId: 'u1', sceneId: 's1', preset: 'preview',
      action: 'render-preview', status: 'rendering', progress: 40,
      creditsCharged: 5, startedAt: Date.now() - 60 * 60 * 1000,
      createdAt: new Date().toISOString(), spec: {},
    }],
  }))

  // The budget is long spent, so the watchdog fires at its 5 s floor — the
  // grace that lets a worker that finished during the deploy deliver.
  server = boot(dbB, { RENDER_TIMEOUT_MS: '1000' })
  ok('the server started over the seeded database', await ready())

  const watchdogFired = await until(async () => {
    const state = await readDb(dbB)
    return state.renderJobs[0].status === 'failed'
  }, 15000)
  db = await readDb(dbB)
  ok('the silent job was failed when its budget ran out', watchdogFired,
     `${margin()}  status=${db.renderJobs[0].status}`)
  ok('...with an error naming the missing worker',
     (db.renderJobs[0].error ?? '').includes('never reported back'))
  ok('...and its credits were returned',
     db.renderJobs[0].refund?.settled === true && db.users[0].credits === 15,
     `credits=${db.users[0].credits}`)

  const dead = await call('/render/jobs/watched1/callback', {
    method: 'POST',
    headers: { 'x-worker-secret': SECRET },
    body: { status: 'done', outputUrl: '/renders/u/z.png' },
  })
  ok('a callback arriving after the refund is refused', dead.status === 409)

  await gone(server)

  // =========================================================================
  console.log('\n-- 3. in-process orphans: one retry, then failed and refunded --')
  const dbC = join(dir, 'c', 'db.json')
  await mkdir(join(dir, 'c'), { recursive: true })
  const seedJob = (id, status, restarts) => ({
    id, ownerId: 'u1', sceneId: 's1', preset: 'preview',
    action: 'render-preview', status, progress: 30, creditsCharged: 5,
    restarts, startedAt: Date.now() - 1000,
    createdAt: new Date().toISOString(), spec: {},
  })
  await writeFile(dbC, JSON.stringify({
    users: [{ id: 'u1', email: 'l@t.local', name: 'L', credits: 10 }],
    renderJobs: [
      seedJob('firstCrash', 'rendering', 0),
      seedJob('secondCrash', 'rendering', 1),
      seedJob('neverRan', 'queued', 0),
    ],
  }))

  // Local mode: the crashed children died with the old process. The daily cap
  // at zero freezes the queue so the re-queued rows can be read as rows.
  server = boot(dbC, { RENDER_MODE: 'local', RENDER_DAILY_CAP: '0' })
  ok('the local-mode server started', await ready())
  await new Promise((r) => setTimeout(r, 500))

  db = await readDb(dbC)
  const row = (id) => db.renderJobs.find((j) => j.id === id)
  ok('a first mid-render orphan is re-queued, not failed',
     row('firstCrash').status === 'queued' && row('firstCrash').restarts === 1,
     `status=${row('firstCrash').status} restarts=${row('firstCrash').restarts}`)
  ok('...and keeps its credits spent on work that will happen',
     !row('firstCrash').refund)
  ok('a second mid-render orphan is failed',
     row('secondCrash').status === 'failed'
       && (row('secondCrash').error ?? '').includes('not retried again'))
  ok('...and refunded', row('secondCrash').refund?.settled === true
       && db.users[0].credits === 15, `credits=${db.users[0].credits}`)
  ok('a queued orphan re-queues without counting as a retry',
     row('neverRan').status === 'queued' && row('neverRan').restarts === 0)

  await gone(server)
} finally {
  for (const s of servers) s.kill('SIGKILL')
  for (const res of held) res.destroy()
  worker.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
