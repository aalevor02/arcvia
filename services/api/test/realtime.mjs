/**
 * The live co-editing relay: what one editor does appears on another's screen,
 * and only people allowed in the scene get in.
 *
 * Attaches the relay to a BARE http server with injected fakes — a readToken
 * that trusts a token of the shape "uid:orgid", and a db with one scene — so
 * the whole transport is exercised with no Fastify, no real JWT, no database.
 * That is the point of the dependency injection in attachRealtime.
 *
 * Run: node test/realtime.mjs
 */

import { createServer } from 'node:http'
import { WebSocket } from 'ws'

import { attachRealtime } from '../src/realtime/index.js'

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

// ---- Fakes ----------------------------------------------------------------
// A token is "userId:orgId". readToken splits it; an empty string throws, which
// stands in for an invalid JWT.
const readToken = async (token) => {
  if (!token || !token.includes(':')) throw new Error('bad token')
  const [sub, orgId] = token.split(':')
  return { sub, orgId, email: `${sub}@studio.test` }
}

// One scene, owned by alice in org acme.
const SCENE = { id: 'scene1', ownerId: 'alice', organisationId: 'acme' }
const db = { findOne: async (_c, pred) => ([SCENE].find(pred) ?? null) }

const server = createServer()
const realtime = attachRealtime(server, { readToken, db })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const url = (scene, token) =>
  `ws://127.0.0.1:${PORT}/realtime?scene=${scene}&token=${encodeURIComponent(token)}`

/** Open a client and collect the messages it receives. */
function client(scene, token) {
  const ws = new WebSocket(url(scene, token))
  const inbox = []
  const waiters = []
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d))
    inbox.push(msg)
    for (const w of waiters.splice(0)) w(msg)
  })
  ws.inbox = inbox
  ws.closed = new Promise((res) => ws.on('close', (code) => res(code)))
  ws.opened = new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  // Resolve with the next message of `type`, or after a short timeout.
  ws.next = (type, ms = 1500) =>
    new Promise((res) => {
      const hit = inbox.find((m) => m.type === type)
      if (hit) return res(hit)
      const to = setTimeout(() => res(null), ms)
      waiters.push((m) => {
        if (m.type === type) {
          clearTimeout(to)
          res(m)
        }
      })
    })
  return ws
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

try {
  // ---- Two editors in one scene relay to each other ----------------------
  const alice = client('scene1', 'alice:acme')
  await alice.opened
  const welcome = await alice.next('welcome')
  ok('a joiner is welcomed with their own identity', welcome?.you?.userId === 'alice', welcome?.you?.colour)
  ok('and an empty roster when first in', Array.isArray(welcome?.peers) && welcome.peers.length === 0)

  // bob is in the same ORG but is not the owner — team co-editing.
  const bob = client('scene1', 'bob:acme')
  await bob.opened
  const bobWelcome = await bob.next('welcome')
  ok('a second org member is let in', bobWelcome?.you?.userId === 'bob')
  ok("and sees the first editor already in the room",
     bobWelcome.peers.some((p) => p.userId === 'alice'))

  const aliceHeardJoin = await alice.next('joined')
  ok('the first editor is told the second arrived', aliceHeardJoin?.peer?.userId === 'bob')
  ok('and each gets a distinct cursor colour', welcome.you.colour !== bobWelcome.you.colour,
     `${welcome.you.colour} vs ${bobWelcome.you.colour}`)

  // Alice edits; bob must receive the plan, alice must NOT get it back.
  alice.send(JSON.stringify({ type: 'plan', plan: { walls: [1, 2, 3] } }))
  const bobGotPlan = await bob.next('plan')
  ok("an edit reaches the other editor", bobGotPlan?.plan?.walls?.length === 3)
  ok('stamped with who made it', bobGotPlan?.from === 'alice')
  await settle()
  ok('and is NOT echoed to its sender',
     !alice.inbox.some((m) => m.type === 'plan'))

  // A cursor relays the same way.
  bob.send(JSON.stringify({ type: 'cursor', x: 5, y: 9 }))
  const aliceGotCursor = await alice.next('cursor')
  ok('a cursor relays to the other editor', aliceGotCursor?.x === 5 && aliceGotCursor?.from === 'bob')

  // An unknown message type is dropped, never relayed.
  bob.send(JSON.stringify({ type: 'evil', payload: 'x' }))
  await settle()
  ok('an unknown message type is not relayed', !alice.inbox.some((m) => m.type === 'evil'))

  // ---- Leaving broadcasts a departure ------------------------------------
  bob.close()
  const aliceHeardLeave = await alice.next('left')
  ok('the other editor is told when someone leaves', aliceHeardLeave?.userId === 'bob')
  await settle()
  ok('and the room is reaped when empty (only alice remains)',
     realtime.rooms.members('scene1').length === 1)

  // ---- Access control -----------------------------------------------------
  const badToken = client('scene1', 'not-a-real-token')
  ok('a bad token is closed with 4401', (await badToken.closed) === 4401)

  const noScene = client('ghost', 'alice:acme')
  ok('an unknown scene is closed with 4404', (await noScene.closed) === 4404)

  const outsider = client('scene1', 'mallory:othercorp')
  ok('someone from another org is closed with 4403', (await outsider.closed) === 4403)

  const noParams = new WebSocket(`ws://127.0.0.1:${PORT}/realtime`)
  const noParamsClosed = await new Promise((res) => noParams.on('close', res))
  ok('a connection with no scene or token is closed with 4400', noParamsClosed === 4400)

  alice.close()
} finally {
  realtime.close()
  server.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
