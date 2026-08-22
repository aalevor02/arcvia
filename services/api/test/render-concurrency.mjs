/**
 * One freed slot must not launch the whole backlog.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * drain() loops `while (running.size < CONCURRENCY …) { void start(job) }`, but
 * start() did not register the job in `running` until after its first `await`.
 * So `running.size` was unchanged when the loop re-tested, and the entire
 * `pending` array was shifted and started in one tick — at CONCURRENCY=1 that
 * is five simultaneous Blender processes locally, or five times the operator's
 * configured worst-case burn in remote mode, the exact number the CONCURRENCY
 * comment calls the most important cost control.
 *
 * ── How this proves it without a GPU ────────────────────────────────────────
 * The race is entirely in drain()/start(), before any worker matters. In remote
 * mode each start() POSTs the job to RENDER_WORKER_URL. Point that at a stub
 * that ACCEPTS and never replies, submit five jobs, and count how many POSTs
 * arrive: the held connections keep each reserved slot occupied, so with the
 * fix exactly one job leaves the queue, and without it all five do. The signal
 * is 1 vs 5, independent of anything the worker does.
 *
 * Run: node test/render-concurrency.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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

// ---- The stub worker: accept, count, never reply --------------------------
let inbound = 0
const held = []
const worker = createServer((req, res) => {
  inbound += 1
  held.push(res) // keep the socket open so the slot stays occupied
})
await new Promise((r) => worker.listen(0, '127.0.0.1', r))
const WORKER_URL = `http://127.0.0.1:${worker.address().port}`

// ---- The API in remote mode, concurrency 1 --------------------------------
const PORT = 8821
const BASE = `http://127.0.0.1:${PORT}`
const dir = await mkdtemp(join(tmpdir(), 'arcvia-conc-'))
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(dir, 'db.json'),
    RENDER_MODE: 'remote',
    RENDER_WORKER_URL: WORKER_URL,
    RENDER_CONCURRENCY: '1',
    WORKER_SECRET: 'test-secret',
  },
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
async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, payload: await r.json().catch(() => ({})) }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `worker ${WORKER_URL}, concurrency 1`)

  const stamp = Date.now()
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Concurrency Tester', email: `c-${stamp}@t.local`, password: 'correct horse battery st' },
  })
  const token = reg.payload.token
  const scene = (
    await call('/scenes/', { method: 'POST', token, body: { name: `Conc ${stamp}` } })
  ).payload.scene
  await call(`/scenes/${scene.id}`, { method: 'PATCH', token, body: { modelUrl: '/uploads/x.glb' } })

  // Fire five distinct preview jobs as fast as possible. Distinct cameras so
  // idempotency does not collapse them into one.
  const submissions = []
  for (let i = 0; i < 5; i++) {
    submissions.push(
      call('/render/jobs', {
        method: 'POST',
        token,
        body: { sceneId: scene.id, preset: 'preview', cameraPosition: { x: i, y: 2, z: 5 } },
      }),
    )
  }
  const results = await Promise.all(submissions)
  const accepted = results.filter((r) => r.status === 200 || r.status === 201).length
  ok('all five submissions were accepted and queued', accepted === 5, `${accepted}/5`)

  // Give drain() ample time to launch everything it is going to.
  await new Promise((r) => setTimeout(r, 1500))

  ok('exactly ONE job left the queue for the worker, not the whole backlog',
     inbound === 1, `worker received ${inbound} POST(s)`)
} finally {
  for (const res of held) res.destroy()
  worker.close()
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
