/**
 * The presence roster, as a pure reducer.
 *
 * Split from `realtime.ts` for one reason: that module imports the browser
 * (WebSocket, window, the api client's localStorage), so it cannot be loaded in
 * a Node test. The roster logic is the part most likely to drift as message
 * types are added — a "left" that does not remove, a duplicate on a second tab —
 * so it lives here, importing nothing, and is tested directly.
 */

export interface Peer {
  userId: string
  name: string
  colour: string
}

export type ServerMessage =
  | { type: 'welcome'; you: Peer; peers: Peer[] }
  | { type: 'joined'; peer: Peer }
  | { type: 'left'; userId: string }
  | { type: 'plan'; from: string; plan: unknown }
  | { type: 'cursor'; from: string; x: number; y: number }

/** The roster after applying one server message. */
export function reduceRoster(roster: Peer[], msg: ServerMessage): Peer[] {
  switch (msg.type) {
    case 'welcome':
      // The server already excludes us from `peers`; trust it as the truth.
      return [...msg.peers]
    case 'joined':
      return roster.some((p) => p.userId === msg.peer.userId)
        ? roster
        : [...roster, msg.peer]
    case 'left':
      return roster.filter((p) => p.userId !== msg.userId)
    default:
      return roster
  }
}
