/**
 * Per-preset queue lanes: a bake cannot starve a preview.
 *
 * ── The failure this pins down ──────────────────────────────────────────────
 * With one global slot, a long deliverable (full render, bake, CAD) at the
 * head of the queue held every preview hostage behind it — the user watching
 * the viewport paid the waiting cost of someone else's overnight job. Lanes
 * split the work by shape: `fast` (preview, isometric, ai) and `heavy`
 * (full, panorama, bake, cad), each with its own concurrency.
 *
 * ── How this proves it without a GPU ────────────────────────────────────────
 * Same instrument as render-concurrency.mjs: remote mode against a stub
 * worker that accepts and never replies, so every started job holds its slot
 * forever and the count of POSTs that arrive IS the concurrency observed.
 * With both limits at 1, the old queue would show exactly one POST however
 * many jobs are submitted; lanes show one per lane — and a freed slot must go
 * to its OWN lane's next job, not whichever job is oldest overall.
 *
 * Run: node test/queue-lanes.mjs
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

// ---- Stub worker: accept, record which job arrived, never reply ------------
const arrivals = []
const held = []
const worker = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      arrivals.push(JSON.parse(body).jobId)
    } catch {
      arrivals.push('?')
    }
  })
  held.push(res)
})
await new Promise((r) => worker.listen(0, '127.0.0.1', r))
const WORKER_URL = `http://127.0.0.1:${worker.address().port}`

const PORT = 8824
const BASE = `http://127.0.0.1:${PORT}`
const dir = await mkdtemp(join(tmpdir(), 'arcvia-lanes-'))
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(dir, 'db.json'),
    RENDER_MODE: 'remote',
    RENDER_WORKER_URL: WORKER_URL,
    RENDER_CONCURRENCY: '1',
    RENDER_HEAVY_CONCURRENCY: '1',
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
const until = async (test, timeoutMs = 10000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await test()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const settle = () => new Promise((r) => setTimeout(r, 800))

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, 'both lane limits at 1')

  const stamp = Date.now()
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Lane Tester', email: `lane-${stamp}@t.local`, password: 'correct horse battery st' },
  })
  const token = reg.payload.token
  const scene = (
    await call('/scenes/', { method: 'POST', token, body: { name: `Lanes ${stamp}` } })
  ).payload.scene
  await call(`/scenes/${scene.id}`, { method: 'PATCH', token, body: { modelUrl: '/uploads/x.glb' } })

  const submit = async (preset, i) =>
    (
      await call('/render/jobs', {
        method: 'POST',
        token,
        body: { sceneId: scene.id, preset, cameraPosition: { x: i, y: 2, z: 5 } },
      })
    ).payload.jobId

  // A heavy job takes its lane...
  const full1 = await submit('full', 1)
  ok('a full render starts', await until(() => arrivals.includes(full1)))

  // ...and a preview flows PAST it instead of queueing behind it.
  const prev1 = await submit('preview', 2)
  const prev2 = await submit('preview', 3)
  ok('a preview is not starved by the running full render',
     await until(() => arrivals.includes(prev1)),
     `arrivals: ${arrivals.length}`)
  await settle()
  ok('the second preview waits for the fast lane, not the heavy one',
     !arrivals.includes(prev2) && arrivals.length === 2,
     `arrivals: ${arrivals.length}`)

  // A second heavy job waits for the heavy lane.
  const panorama1 = await submit('panorama', 4)
  await settle()
  ok('a panorama waits for the occupied heavy lane',
     !arrivals.includes(panorama1) && arrivals.length === 2)

  const j = async (id) => (await call(`/render/jobs/${id}`, { token })).payload.status
  ok('statuses agree: full1 and prev1 rendering, prev2 and panorama queued',
     (await j(full1)) === 'rendering' && (await j(prev1)) === 'rendering'
       && (await j(prev2)) === 'queued' && (await j(panorama1)) === 'queued')

  // A freed fast slot serves the fast lane...
  await call(`/render/jobs/${prev1}/cancel`, { method: 'POST', token })
  ok('cancelling the running preview starts the queued preview',
     await until(() => arrivals.includes(prev2)), `arrivals: ${arrivals.length}`)
  ok('...and not the queued panorama', !arrivals.includes(panorama1))

  // ...and a freed heavy slot serves the heavy lane.
  await call(`/render/jobs/${full1}/cancel`, { method: 'POST', token })
  ok('cancelling the running full render starts the queued panorama',
     await until(() => arrivals.includes(panorama1)), `arrivals: ${arrivals.length}`)

  ok('four starts in total — no lane ever ran two at once',
     arrivals.length === 4, `arrivals: ${arrivals.join(', ')}`)
} finally {
  server.kill('SIGKILL')
  for (const res of held) res.destroy()
  worker.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
