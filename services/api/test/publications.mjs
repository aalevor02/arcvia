/**
 * Publications — the record behind a client-facing project site.
 *
 * ── Why this test starts its own server ─────────────────────────────────────
 * Every other suite here talks to whatever is already listening on 8787, which
 * is fine when that process is current and misleading when it is not. The one
 * running in this environment was started before the commits it would be asked
 * to exercise, and an API that silently predates the feature under test reports
 * failures that are not there and passes that are not either.
 *
 * So this spawns its own, on its own port, against its own database file. It
 * leaves nothing behind and cannot collide with a session using the real one.
 *
 * Run: node test/publications.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8811
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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-pub-'))
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (c) => (serverLog += c))
server.stderr.on('data', (c) => (serverLog += c))

/** Wait for it to answer, rather than sleeping and hoping. */
async function ready(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await fetch(`${BASE}/publications/public/nothing-here`)
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
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  // ---- Two accounts, because ownership is half of what this route does -----
  const stamp = Date.now()
  const alice = await call('/auth/register', {
    method: 'POST',
    body: { email: `alice-${stamp}@test.local`, password: 'correct-horse-1', name: 'Alice' },
  })
  const bob = await call('/auth/register', {
    method: 'POST',
    body: { email: `bob-${stamp}@test.local`, password: 'correct-horse-2', name: 'Bob' },
  })
  const aliceToken = alice.payload.token
  const bobToken = bob.payload.token
  ok('two accounts exist', Boolean(aliceToken && bobToken), `${alice.status}/${bob.status}`)

  // ---- Creation ------------------------------------------------------------
  const created = await call('/publications/', {
    method: 'POST',
    token: aliceToken,
    body: { name: 'Casa Altinho' },
  })
  ok('a publication can be created', created.status === 201, String(created.status))
  const id = created.payload.publication?.id
  ok('it gets a slug', created.payload.publication?.slug === 'casa-altinho', created.payload.publication?.slug)
  ok('it starts unpublished', created.payload.publication?.published === false)
  ok('a nameless publication is refused', (await call('/publications/', { method: 'POST', token: aliceToken, body: { name: '  ' } })).status === 400)

  // Slugs must not collide: a published URL outlives the record.
  const second = await call('/publications/', { method: 'POST', token: aliceToken, body: { name: 'Casa Altinho' } })
  ok('a duplicate name gets a distinct slug', second.payload.publication?.slug === 'casa-altinho-2', second.payload.publication?.slug)

  // ---- Ownership -----------------------------------------------------------
  ok("another user cannot read it", (await call(`/publications/${id}`, { token: bobToken })).status === 404)
  ok("another user cannot patch it", (await call(`/publications/${id}`, { method: 'PATCH', token: bobToken, body: { name: 'Mine now' } })).status === 404)
  ok('and it is 404, not 403, so its existence is not confirmed', true)
  ok('an anonymous caller cannot read it', (await call(`/publications/${id}`)).status === 401)

  // ---- Publishing refuses an empty project --------------------------------
  const early = await call(`/publications/${id}/publish`, { method: 'POST', token: aliceToken })
  ok('publishing before composing is refused', early.status === 409, String(early.status))
  ok('and says what to do', /compose/i.test(early.payload.message ?? ''), early.payload.message)

  // ---- The payload ---------------------------------------------------------
  const project = {
    slug: 'casa-altinho',
    name: 'Casa Altinho',
    script: 'Casa',
    villaTypes: [{ id: 'a1', name: 'Type A1', floors: [], renders: [], appliesTo: [], totalSbua: 0, summary: '' }],
    gallery: [],
  }
  const saved = await call(`/publications/${id}`, { method: 'PATCH', token: aliceToken, body: { project } })
  ok('the project payload saves', saved.status === 200, String(saved.status))
  ok('and comes back whole', saved.payload.publication?.project?.villaTypes?.length === 1)

  // Unknown fields are rejected, not dropped — the studio must never believe it
  // saved something it did not.
  const bad = await call(`/publications/${id}`, { method: 'PATCH', token: aliceToken, body: { projekt: {} } })
  ok('an unknown field is rejected', bad.status === 400, String(bad.status))
  ok('and the message names it', /projekt/.test(bad.payload.message ?? ''), bad.payload.message)

  // ---- Publish and read as a client ---------------------------------------
  const published = await call(`/publications/${id}/publish`, { method: 'POST', token: aliceToken })
  ok('it publishes once composed', published.status === 200, String(published.status))
  ok('and returns the client URL', published.payload.url === '/p/casa-altinho/', published.payload.url)

  const publicRead = await call('/publications/public/casa-altinho')
  ok('a client can read it with no account', publicRead.status === 200, String(publicRead.status))
  ok('and gets the project', publicRead.payload.project?.name === 'Casa Altinho')
  // The one thing a public payload must never carry.
  ok(
    'the public payload carries no owner',
    !JSON.stringify(publicRead.payload).includes('ownerId'),
  )

  // ---- Unpublish keeps the address ----------------------------------------
  await call(`/publications/${id}/unpublish`, { method: 'POST', token: aliceToken })
  const afterUnpublish = await call('/publications/public/casa-altinho')
  ok('an unpublished project is not readable', afterUnpublish.status === 404, String(afterUnpublish.status))

  const republished = await call(`/publications/${id}/publish`, { method: 'POST', token: aliceToken })
  ok(
    'republishing returns the SAME address',
    republished.payload.url === '/p/casa-altinho/',
    republished.payload.url,
  )

  // ---- Listing -------------------------------------------------------------
  const list = await call('/publications/', { token: aliceToken })
  ok('the owner sees both', list.payload.publications?.length === 2, String(list.payload.publications?.length))
  ok(
    'the list omits the project payload',
    list.payload.publications?.every((p) => p.project === undefined),
  )
  ok(
    'but says how much is in each',
    list.payload.publications?.some((p) => p.unitTypes === 1 && p.hasProject === true),
  )
  ok('another user sees none of them', (await call('/publications/', { token: bobToken })).payload.publications?.length === 0)

  // ---- Deletion ------------------------------------------------------------
  ok('it can be deleted', (await call(`/publications/${id}`, { method: 'DELETE', token: aliceToken })).status === 204)
  ok('and is then gone', (await call('/publications/public/casa-altinho')).status === 404)
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
