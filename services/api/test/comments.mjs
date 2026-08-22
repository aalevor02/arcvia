/**
 * Visitor comments on a published walkthrough.
 *
 * Spawns its own API on its own port and database, like publications.mjs and
 * for the same reason: the server on 8787 is whatever was running when someone
 * last started it, and an API that predates the feature under test reports
 * failures that are not there.
 *
 * Run: node test/comments.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8812
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  cond ? passed++ : failed++
}

const dir = await mkdtemp(join(tmpdir(), 'arcvia-comments-'))
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (c) => (log += c))
server.stderr.on('data', (c) => (log += c))

async function ready(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await fetch(`${BASE}/scenes/public/nothing`)
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
    console.log(log.slice(-1500))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()
  const owner = await call('/auth/register', {
    method: 'POST',
    body: { email: `owner-${stamp}@test.local`, password: 'correct-horse-1', name: 'Owner' },
  })
  const other = await call('/auth/register', {
    method: 'POST',
    body: { email: `other-${stamp}@test.local`, password: 'correct-horse-2', name: 'Other' },
  })
  const token = owner.payload.token
  const otherToken = other.payload.token

  const made = await call('/scenes/', { method: 'POST', token, body: { name: 'Villa A' } })
  const sceneId = made.payload.scene.id
  await call(`/scenes/${sceneId}`, {
    method: 'PATCH',
    token,
    body: { modelUrl: '/uploads/scenes/x/model.glb' },
  })
  const published = await call(`/scenes/${sceneId}/publish`, { method: 'POST', token })
  const slug = published.payload.scene.publishedSlug
  ok('a published scene to comment on', Boolean(slug), slug)

  // ---- A visitor leaves a note ----------------------------------------------
  const posted = await call(`/scenes/public/${slug}/comments`, {
    method: 'POST',
    body: { name: 'A buyer', message: 'Can the kitchen wall move half a metre?', view: 'Kitchen' },
  })
  ok('a visitor can leave a note with no account', posted.status === 201, String(posted.status))

  // ---- Validation -------------------------------------------------------------
  ok(
    'an empty note is refused',
    (await call(`/scenes/public/${slug}/comments`, { method: 'POST', body: { message: '  ' } }))
      .status === 400,
  )
  const long = await call(`/scenes/public/${slug}/comments`, {
    method: 'POST',
    body: { message: 'x'.repeat(2001) },
  })
  ok('an over-long note is refused whole, not truncated', long.status === 400, String(long.status))
  ok('and the refusal states the limit', /2000/.test(long.payload.message ?? ''))
  ok(
    'an unknown slug is 404',
    (await call('/scenes/public/no-such/comments', { method: 'POST', body: { message: 'hi' } }))
      .status === 404,
  )

  // ---- The owner reads them, nobody else --------------------------------------
  const list = await call(`/scenes/${sceneId}/comments`, { token })
  ok('the owner sees the note', list.payload.comments?.length === 1, String(list.payload.comments?.length))
  const comment = list.payload.comments?.[0] ?? {}
  ok('with its name, view and time', Boolean(comment.name && comment.view && comment.at))
  ok(
    'another user cannot read them',
    (await call(`/scenes/${sceneId}/comments`, { token: otherToken })).status === 404,
  )
  const publicScene = await call(`/scenes/public/${slug}`)
  ok(
    'visitors never see comments — the public payload has none',
    !('comments' in (publicScene.payload.scene ?? publicScene.payload)),
  )
  ok(
    'comments cannot be forged through PATCH',
    (await call(`/scenes/${sceneId}`, { method: 'PATCH', token, body: { comments: [] } }))
      .status === 400,
  )

  // ---- Throttle ----------------------------------------------------------------
  let throttledAt = 0
  for (let i = 2; i <= 8; i++) {
    const r = await call(`/scenes/public/${slug}/comments`, {
      method: 'POST',
      body: { message: `note ${i}` },
    })
    if (r.status === 429) {
      throttledAt = i
      break
    }
  }
  ok('a script gets throttled', throttledAt > 0 && throttledAt <= 6, `429 at post ${throttledAt}`)

  // ---- Deletion -----------------------------------------------------------------
  ok(
    "another user cannot delete the owner's comments",
    (await call(`/scenes/${sceneId}/comments/${comment.id}`, { method: 'DELETE', token: otherToken }))
      .status === 404,
  )
  ok(
    'the owner can',
    (await call(`/scenes/${sceneId}/comments/${comment.id}`, { method: 'DELETE', token }))
      .status === 204,
  )
  ok(
    'deleting it again is 404, not silently fine',
    (await call(`/scenes/${sceneId}/comments/${comment.id}`, { method: 'DELETE', token }))
      .status === 404,
  )

  // ---- Unpublishing closes the door ---------------------------------------------
  await call(`/scenes/${sceneId}/unpublish`, { method: 'POST', token })
  ok(
    'an unpublished walkthrough takes no more notes',
    (await call(`/scenes/public/${slug}/comments`, { method: 'POST', body: { message: 'hello?' } }))
      .status === 404,
  )
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
