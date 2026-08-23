import { WebSocketServer } from 'ws'
import { URL } from 'node:url'

import { Rooms } from './rooms.js'

/**
 * Live co-editing transport.
 *
 * A client editing a scene opens `ws://…/realtime?scene=<id>&token=<jwt>`. This
 * relays two things between everyone in that scene's room: whole-plan snapshots
 * (so an edit one person makes appears on everyone else's screen) and presence
 * (who else is here, and where their cursor is). It is a RELAY, not a store —
 * durable saves still go through the scene PATCH path with its allow-list, which
 * is the one place a scene is written. See rooms.js on why persistence stays
 * out of here.
 *
 * ── Why v1 relays whole snapshots, not per-op edits ──────────────────────────
 * A snapshot is the same shape the autosave already sends, so it needs no
 * schema change and no operational-transform machinery. Last-writer-wins per
 * connection: each client applies the newest plan it receives. The studio
 * buffers a remote snapshot during a live gesture and applies it on release, so
 * a drag is never clobbered mid-motion, and it applies a remote snapshot
 * WITHOUT marking the plan dirty, so two clients do not ping-pong saves. Those
 * two rules live in the studio client; this layer just moves the bytes.
 *
 * ── Dependency-injected on purpose ───────────────────────────────────────────
 * `readToken` and `db` are passed in rather than imported, so the whole relay
 * can be tested against a bare http server with fakes — no Fastify, no real
 * JWT, no database. attach it to the real server with the real two in server.js.
 */

//: A plan for a furnished villa is tens of kilobytes; 2 MB is generous headroom
//: and still refuses a client trying to use the relay as a firehose.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

//: Cursor colours handed to joiners in turn, so two people are visually
//: distinct without the client having to pick. Wraps after eight, which is more
//: simultaneous editors than a scene realistically has.
const CURSOR_COLOURS = [
  '#2f6df6', '#e8590c', '#2f9e44', '#ae3ec9',
  '#1098ad', '#e03131', '#5c7cfa', '#f08c00',
]

/** The message types a client may send. Anything else is dropped, not relayed. */
const RELAYABLE = new Set(['plan', 'cursor', 'selection'])

/**
 * Attach the realtime relay to a running http server.
 *
 * @param {import('node:http').Server} server  the same server Fastify listens on
 * @param {object} deps
 * @param {(token: string) => Promise<object>} deps.readToken  verifies a JWT, throws if invalid
 * @param {{ findOne: Function }} deps.db  the datastore, for the scene access check
 * @param {(msg: string) => void} [deps.log]  optional logger for refusals
 * @returns {{ rooms: Rooms, close: () => void }}
 */
export function attachRealtime(server, { readToken, db, log = () => {} }) {
  const rooms = new Rooms()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

  let nextColour = 0

  server.on('upgrade', (request, socket, head) => {
    let url
    try {
      url = new URL(request.url, 'http://localhost')
    } catch {
      return socket.destroy()
    }
    // One path, so the relay never collides with any other upgrade a future
    // dependency might want (HMR, a metrics socket).
    if (url.pathname !== '/realtime') return
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url)
    })
  })

  wss.on('connection', async (ws, request, url) => {
    const sceneId = url.searchParams.get('scene')
    const token = url.searchParams.get('token')

    // Everything that can go wrong before the socket is trusted closes it with
    // a specific code, so the client can tell "wrong door" from "not allowed".
    if (!sceneId || !token) return close(ws, 4400, 'scene and token are required')

    let auth
    try {
      auth = await readToken(token)
    } catch {
      return close(ws, 4401, 'invalid or expired token')
    }
    const userId = auth.sub
    const orgId = auth.orgId

    const scene = await db.findOne('scenes', (s) => s.id === sceneId)
    if (!scene) return close(ws, 4404, 'no such scene')

    // Access: the owner, or a member of the scene's organisation — co-editing
    // is a team feature, and the whole point is that a colleague can be in the
    // same model. This is READ-through: durable saves still go through PATCH,
    // which today only the owner passes, so a non-owner co-editor sees and
    // proposes live but cannot yet persist. Widening PATCH to org members is a
    // scene-ownership change owned elsewhere, deliberately not bundled here.
    const owns = scene.ownerId === userId
    const sameOrg = orgId && scene.organisationId && scene.organisationId === orgId
    if (!owns && !sameOrg) return close(ws, 4403, 'not your scene')

    // Label and tint this connection. Name is best-effort — the token carries an
    // email, and a first name off it beats a raw address over a cursor.
    ws.userId = userId
    ws.name = displayName(auth)
    ws.colour = CURSOR_COLOURS[nextColour++ % CURSOR_COLOURS.length]
    ws.sceneId = sceneId
    ws.send = wrapSend(ws)

    rooms.join(sceneId, ws)

    // The newcomer gets the roster of everyone ELSE already here; everyone else
    // gets told one more person arrived. `peers` excludes the joiner's own
    // userId — presence is "who else", and a second tab of your own is not a
    // collaborator to show yourself.
    const peers = rooms.roster(sceneId).filter((p) => p.userId !== userId)
    ws.send(JSON.stringify({ type: 'welcome', you: presenceOf(ws), peers }))
    rooms.relay(sceneId, JSON.stringify({ type: 'joined', peer: presenceOf(ws) }), ws)

    ws.on('message', (data, isBinary) => {
      if (isBinary) return // the protocol is JSON text; a binary frame is noise
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return // a frame that is not JSON is dropped, never relayed
      }
      if (!message || !RELAYABLE.has(message.type)) return

      // Stamp who it came from so the receiver can attribute the cursor and
      // ignore an echo of its own user from a second tab. The sender cannot
      // forge this — it is set here, from the authenticated connection.
      message.from = userId
      rooms.relay(sceneId, JSON.stringify(message), ws)
    })

    ws.on('close', () => {
      rooms.leave(sceneId, ws)
      rooms.relay(sceneId, JSON.stringify({ type: 'left', userId }))
    })

    // A broken pipe is a close by another name; without this the error is an
    // uncaught 'error' event that takes the process down.
    ws.on('error', () => ws.close())
  })

  return {
    rooms,
    close: () => wss.close(),
  }
}

function presenceOf(ws) {
  return { userId: ws.userId, name: ws.name, colour: ws.colour }
}

/** A readable name from a token payload: the part of the email before the @, else the id. */
function displayName(auth) {
  const email = typeof auth.email === 'string' ? auth.email : ''
  const local = email.split('@')[0]
  return local || String(auth.sub ?? 'Someone')
}

/**
 * A send that never throws.
 *
 * A relay iterates a room and sends to each member; if one socket is
 * half-closed, a raw `.send` throws and aborts the loop, so one dead client
 * would stop everyone else receiving the update. Swallowing here keeps the
 * broadcast whole — the close handler reaps the dead socket a moment later.
 */
function wrapSend(ws) {
  const raw = ws.send.bind(ws)
  return (payload) => {
    if (ws.readyState !== ws.OPEN) return
    try {
      raw(payload)
    } catch {
      /* reaped on close */
    }
  }
}

function close(ws, code, reason) {
  try {
    ws.close(code, reason)
  } catch {
    ws.terminate()
  }
}
