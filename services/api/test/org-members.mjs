/**
 * Removing a member deletes only your OWN member.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * DELETE /organisations/members/:userId proved the CALLER was an org owner and
 * proved nothing about the TARGET. `db.remove('users', id)` filters the whole
 * users collection by id with no scope, so an owner could pass any user id in
 * the system and hard-delete that account. Since every signup is the owner of
 * its own organisation, "be an owner" is just "have an account" — so any user
 * could delete any other user, across tenants, with one request. The route's
 * own seat-filter hid it: it dropped the id from the CALLER's seat list
 * whether or not it was there, so the call returned 204 while the victim's
 * real record was already gone.
 *
 * Spawns its own server and database.
 *
 * Run: node test/org-members.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8816
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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-org-'))
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

async function register(email) {
  const r = await call('/auth/register', {
    method: 'POST',
    body: { name: email.split('@')[0], email, password: 'correct horse battery st' },
  })
  return { token: r.payload.token, id: r.payload.user?.id ?? r.payload.user?.uid }
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()

  // Two independent owners in two organisations, and one invited member under A.
  const alice = await register(`alice-${stamp}@a.test`)
  const mallory = await register(`mallory-${stamp}@m.test`)

  const invited = await call('/organisations/members', {
    method: 'POST',
    token: alice.token,
    body: { name: 'Bob', email: `bob-${stamp}@a.test` },
  })
  const bobId = invited.payload.member?.uid
  ok('alice invited a member into her org', Boolean(bobId), String(invited.status))

  // ---- The attack: mallory tries to delete alice's member -----------------
  const cross = await call(`/organisations/members/${bobId}`, {
    method: 'DELETE',
    token: mallory.token,
  })
  ok("an outsider cannot delete another org's member", cross.status === 404,
     `status ${cross.status}`)

  // The victim must still be alive: prove it by re-fetching alice's members.
  const listedAfter = await call('/organisations/me', { token: alice.token })
  const stillThere = (listedAfter.payload.members ?? []).some((m) => m.uid === bobId)
  ok('and the victim account still exists', stillThere)

  // ---- The owner CAN remove her own member --------------------------------
  const legit = await call(`/organisations/members/${bobId}`, {
    method: 'DELETE',
    token: alice.token,
  })
  ok('the real owner can remove her own member', legit.status === 204,
     `status ${legit.status}`)
  const listedFinal = await call('/organisations/me', { token: alice.token })
  ok('and the member is then gone',
     !(listedFinal.payload.members ?? []).some((m) => m.uid === bobId))

  // ---- A made-up id is a 404, not a 204 -----------------------------------
  const ghost = await call('/organisations/members/does-not-exist', {
    method: 'DELETE',
    token: alice.token,
  })
  ok('deleting an id that is not a member is a 404', ghost.status === 404,
     `status ${ghost.status}`)
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
