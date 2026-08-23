/**
 * Who is in which scene, right now.
 *
 * A room is a live set of connections editing one scene. This module is the
 * whole of the shared state: connections join and leave, messages are relayed
 * to the rest of a room, and a presence roster falls out of the membership.
 * Deliberately in-memory and per-process, the same trade the render queue and
 * the rate limiter make — co-editing is a "while everyone is looking at it
 * together" feature, not durable state. What is DURABLE still goes through the
 * scene PATCH path; this only carries the live cursor between saves.
 *
 * No persistence here on purpose. A second write path that bypassed the scene
 * allow-list is exactly how the scene.credits / options invariants would die,
 * so a relayed snapshot is never written to the database from this layer — the
 * editing client saves it through PATCH, as it already did alone.
 */

export class Rooms {
  constructor() {
    /** sceneId -> Set<connection> */
    this._byScene = new Map()
  }

  /**
   * Add a connection to a scene's room. Returns the room's current members so
   * the caller can hand the newcomer a roster.
   */
  join(sceneId, conn) {
    let room = this._byScene.get(sceneId)
    if (!room) {
      room = new Set()
      this._byScene.set(sceneId, room)
    }
    room.add(conn)
    return room
  }

  /** Remove a connection. Drops the room when it empties, so the map cannot grow without bound. */
  leave(sceneId, conn) {
    const room = this._byScene.get(sceneId)
    if (!room) return
    room.delete(conn)
    if (room.size === 0) this._byScene.delete(sceneId)
  }

  /** Every connection in a scene, or an empty array. */
  members(sceneId) {
    return [...(this._byScene.get(sceneId) ?? [])]
  }

  /**
   * The presence roster for a scene: one entry per PERSON, not per connection.
   *
   * Collapsed by userId because one person with the editor open in two tabs is
   * one collaborator, not two — showing them twice in the "who else is here"
   * strip reads as a bug. Name and colour come off the connection so the studio
   * can label and tint each cursor without a second lookup.
   */
  roster(sceneId) {
    const seen = new Map()
    for (const conn of this.members(sceneId)) {
      if (!seen.has(conn.userId)) {
        seen.set(conn.userId, { userId: conn.userId, name: conn.name, colour: conn.colour })
      }
    }
    return [...seen.values()]
  }

  /**
   * Send an already-serialised message to every member of a scene except
   * `origin` (a relay never echoes to its sender). Dead sockets are skipped;
   * the connection close handler is what actually reaps them.
   */
  relay(sceneId, payload, origin = null) {
    for (const conn of this.members(sceneId)) {
      if (conn === origin) continue
      conn.send(payload)
    }
  }

  /** Total live connections, across all rooms — for a health check. */
  get size() {
    let n = 0
    for (const room of this._byScene.values()) n += room.size
    return n
  }
}
