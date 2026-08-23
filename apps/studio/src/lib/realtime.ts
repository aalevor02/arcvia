import { getToken } from './api'
import { reduceRoster, type Peer, type ServerMessage } from './realtime-roster'

export type { Peer } from './realtime-roster'

/**
 * The studio's end of live co-editing.
 *
 * Connects to the API's realtime relay (services/api/src/realtime), sends the
 * local plan when it changes, and hands remote plans, cursors and presence back
 * to the editor. The transport is a whole-plan snapshot relay — see the server
 * module for why v1 is snapshots rather than per-op edits — so this client's job
 * is small: keep a socket alive, translate messages to callbacks, and track who
 * else is in the room.
 *
 * ── The two rules the editor must keep, restated where they are enforced ─────
 * They are NOT in this file, because they are about the editor's state, not the
 * wire: (1) a remote snapshot is applied only BETWEEN gestures — buffered during
 * a live drag and applied on release — or it clobbers the gesture baseline; and
 * (2) applying a remote snapshot must not mark the plan dirty, or the receiver
 * PATCHes back what it just got and two clients ping-pong. PlanEditor honours
 * both; this module only delivers the snapshot.
 */

export interface CursorMessage {
  from: string
  x: number
  y: number
}

/** ws(s):// base derived from the api base, so a phone or a LAN host works. */
function realtimeUrl(sceneId: string, token: string): string {
  const port = 8787
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const configured = import.meta.env.VITE_API_URL
  const base = configured
    ? String(configured).replace(/^http/, 'ws').replace(/\/$/, '')
    : `${proto}//${window.location.hostname}:${port}`
  return `${base}/realtime?scene=${encodeURIComponent(sceneId)}&token=${encodeURIComponent(token)}`
}

export interface ChannelHandlers {
  onPlan?: (plan: unknown, from: string) => void
  onCursor?: (cursor: CursorMessage) => void
  onPresence?: (roster: Peer[]) => void
  /** 'open' | 'closed' — for a small "N others editing" / "reconnecting" hint. */
  onStatus?: (status: 'open' | 'closed') => void
}

/**
 * A live connection to one scene's room.
 *
 * Reconnects on drop with a capped backoff — a co-editing session outlives a
 * laptop sleep or a flaky wifi hiccup, and dropping the collaborator silently
 * the first time the network blinks would be worse than not having the feature.
 * `close()` is final: it stops reconnecting.
 */
export class SceneChannel {
  private ws: WebSocket | null = null
  private roster: Peer[] = []
  private closed = false
  private backoff = 500
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly sceneId: string,
    private readonly handlers: ChannelHandlers,
  ) {}

  connect(): void {
    const token = getToken()
    if (!token || this.closed) return

    let ws: WebSocket
    try {
      ws = new WebSocket(realtimeUrl(this.sceneId, token))
    } catch {
      return this.scheduleReconnect()
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.backoff = 500 // a clean connection resets the penalty
      this.handlers.onStatus?.('open')
    })

    ws.addEventListener('message', (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      switch (msg.type) {
        case 'welcome':
        case 'joined':
        case 'left':
          this.roster = reduceRoster(this.roster, msg)
          this.handlers.onPresence?.(this.roster)
          break
        case 'plan':
          this.handlers.onPlan?.(msg.plan, msg.from)
          break
        case 'cursor':
          this.handlers.onCursor?.({ from: msg.from, x: msg.x, y: msg.y })
          break
      }
    })

    ws.addEventListener('close', () => {
      this.handlers.onStatus?.('closed')
      this.roster = []
      this.handlers.onPresence?.(this.roster)
      this.scheduleReconnect()
    })

    // An error is followed by a close; let close drive the reconnect so it is
    // not attempted twice.
    ws.addEventListener('error', () => ws.close())
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, 10_000)
  }

  private send(payload: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  /** Broadcast the local plan to everyone else in the room. */
  sendPlan(plan: unknown): void {
    this.send({ type: 'plan', plan })
  }

  /** Broadcast the local cursor position, in plan coordinates. */
  sendCursor(x: number, y: number): void {
    this.send({ type: 'cursor', x, y })
  }

  /** The people currently in the room, self excluded. */
  get peers(): Peer[] {
    return this.roster
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }
}
