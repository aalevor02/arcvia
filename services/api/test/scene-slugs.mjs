/**
 * Published scene slugs: one address, one scene.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * Publish derived its slug as `slugify(scene.name)` with no uniqueness check,
 * and `/scenes/public/:slug` resolves by first match in the collection. Two
 * users who both named a scene "Living Room" therefore shared
 * `/view/living-room/` — and whichever published FIRST owned it. The second
 * user was handed that URL as their own, printed it, and their client opened
 * somebody else's project. Publications solved this on day one
 * (`uniqueSlug`); scenes never got the same care.
 *
 * Also pinned: a name that is all punctuation slugifies to the empty string,
 * which published as the URL `/view//` — a link that never worked.
 *
 * Spawns its own server on its own database, so it tests the code as it is
 * now rather than whatever is already listening on 8787.
 *
 * Run: node test/scene-slugs.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8815
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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-slugs-'))
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

/** Register a user, create a scene with `name`, give it a model, publish it. */
async function publishScene(email, name) {
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Slug Tester', email, password: 'correct horse battery st' },
  })
  const token = reg.payload.token
  const scene = (
    await call('/scenes/', { method: 'POST', token, body: { name } })
  ).payload.scene
  // A model URL unique to the scene: the public payload deliberately carries
  // no id — leaking record ids to visitors is publicPayload's whole job to
  // prevent — so identity is asserted through the one field that is public
  // AND distinct per scene.
  await call(`/scenes/${scene.id}`, {
    method: 'PATCH',
    token,
    body: { modelUrl: `/uploads/${scene.id}.glb` },
  })
  const pub = await call(`/scenes/${scene.id}/publish`, { method: 'POST', token })
  return { token, scene, slug: pub.payload.scene?.publishedSlug, url: pub.payload.url }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()

  // ---- Two owners, one name -----------------------------------------------
  const first = await publishScene(`a-${stamp}@t.local`, 'Living Room')
  const second = await publishScene(`b-${stamp}@t.local`, 'Living Room')

  ok('the first publish takes the natural slug', first.slug === 'living-room', first.slug)
  ok('the second gets its own address, not the first user\'s',
     Boolean(second.slug) && second.slug !== first.slug, second.slug)

  const openFirst = await call(`/scenes/public/${first.slug}`)
  const openSecond = await call(`/scenes/public/${second.slug}`)
  ok("each address opens its owner's scene, not the first match",
     openFirst.payload.scene?.modelUrl === `/uploads/${first.scene.id}.glb` &&
     openSecond.payload.scene?.modelUrl === `/uploads/${second.scene.id}.glb`)
  ok('and the public payload leaks no record id',
     openFirst.payload.scene?.id === undefined)

  // ---- Republish keeps the address ----------------------------------------
  const again = await call(`/scenes/${second.scene.id}/publish`, {
    method: 'POST',
    token: second.token,
  })
  ok('a republish keeps the slug — the link may already be on paper',
     again.payload.scene?.publishedSlug === second.slug)

  // ---- A name that slugifies to nothing -----------------------------------
  const punct = await publishScene(`c-${stamp}@t.local`, '!!! ???')
  ok('an all-punctuation name still gets a real address',
     Boolean(punct.slug) && punct.slug.length > 0, punct.slug)
  ok('and its URL is not /view//', punct.url !== '/view//', punct.url)

  // ---- Many collisions stay distinct --------------------------------------
  const slugs = new Set([first.slug, second.slug])
  for (let n = 0; n < 3; n++) {
    const extra = await publishScene(`d${n}-${stamp}@t.local`, 'Living Room')
    slugs.add(extra.slug)
  }
  ok('five scenes named identically hold five distinct addresses',
     slugs.size === 5, [...slugs].join(', '))
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
