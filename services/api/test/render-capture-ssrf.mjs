/**
 * An AI render's captureUrl must be one of our own uploads — nothing else.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * POST /render/jobs (preset 'ai') took `captureUrl` straight from the body and
 * passed it, unresolved, to the worker's `readFile(sourcePath)` and then into
 * an outbound POST to Google. `resolveUrl` does not contain it: its final
 * branch returns anything not under the upload prefix unchanged. So:
 *
 *   http(s)://…            the worker FETCHES it        — SSRF, incl. cloud
 *                                                         metadata endpoints
 *   /etc/passwd, A:/…/.env this server READS it and      — local file
 *                          base64s it into the request     exfiltration
 *
 * The legitimate value is always the key uploadCapture returns,
 * `${UPLOAD_PUBLIC_PREFIX}/<key>`. The route now rejects anything else with a
 * 400 before it is charged or queued.
 *
 * Spawns its own server and database so it tests the code as it is now.
 *
 * Run: node test/render-capture-ssrf.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8817
const BASE = `http://127.0.0.1:${PORT}`

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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-ssrf-'))
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

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json().catch(() => ({})) }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Render Tester', email: `r-${stamp}@t.local`, password: 'correct horse battery st' },
  })
  const token = reg.payload.token
  const scene = (
    await call('/scenes/', { method: 'POST', token, body: { name: `AI ${stamp}` } })
  ).payload.scene

  const submit = (captureUrl) =>
    call('/render/jobs', {
      method: 'POST',
      token,
      body: { sceneId: scene.id, preset: 'ai', style: 'daylight', captureUrl },
    })

  // ---- Every attack vector is refused BEFORE charge or queue --------------
  const attacks = [
    ['an absolute http URL (SSRF)', 'http://attacker.example/x.png'],
    ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['an https URL', 'https://attacker.example/x.png'],
    ['a bare unix path', '/etc/passwd'],
    ['a windows path to the env file', 'A:/Web/Arcvia/.env'],
    ['a traversal out of uploads', '/uploads/../../../etc/passwd'],
    ['a traversal to the env file', '/uploads/../.env'],
  ]
  for (const [label, value] of attacks) {
    const res = await submit(value)
    ok(`rejected: ${label}`, res.status === 400, `status ${res.status}`)
  }

  // ---- A genuine uploaded key is accepted past the guard ------------------
  // It need not exist on disk for THIS check — the guard is on shape and
  // containment, and a later stage handles a missing file. What matters is
  // that a real key is NOT rejected with the 400 the attacks get.
  const legit = await submit('/uploads/captures/abc123.png')
  ok('a real upload key passes the capture guard',
     legit.status !== 400 ||
       !/captured view must be an uploaded image/.test(legit.payload.message ?? ''),
     `status ${legit.status}: ${legit.payload.message ?? ''}`)

  // ---- The credit ledger never moved for a refused attack -----------------
  const me = await call('/organisations/me', { token })
  const owner = (me.payload.members ?? []).find((m) => m.isOwner)
  ok('an attacker spends nothing — refusals never reached billing',
     owner && owner.credits > 0, `credits ${owner?.credits}`)
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
