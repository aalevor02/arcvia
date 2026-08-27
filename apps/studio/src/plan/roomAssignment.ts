/**
 * Which render belongs to which room.
 *
 * The join between a deck's renders and a reconstruction's rooms used to be a
 * single subset test, and it was wrong in a way nothing surfaced. `roomTokens`
 * splits on non-alphanumerics, so `master-bedroom` yields ['master','bedroom'],
 * and a render captioned merely "Bedroom" satisfies
 * `every(token => available.has(token))` against BOTH `room3_bedroom` and
 * `room8_master-bedroom`. The guest bedroom's finish landed on the master
 * bedroom, silently, and the only evidence was a client saying it looked wrong.
 *
 * Two ideas fix it without discarding the fallback the deck loop was built on:
 *
 *   1. SPECIFICITY. An exact match outranks a subset match, so the common case
 *      — "Bedroom" against both `bedroom` and `master-bedroom` — resolves on
 *      its own and never reaches a human. Precision earns automation.
 *
 *   2. AMBIGUITY IS A QUESTION, NOT A COIN TOSS. When a caption is genuinely
 *      torn between rooms, or two renders claim the same room, nothing is
 *      painted from it. The room keeps the fallback and the assignment is
 *      returned for confirmation, naming what it was torn between.
 *
 * A visibly undressed or fallback-coloured room is a question somebody can
 * answer. A confidently wrong material is a mistake that ships.
 */

/** How a render was matched to a room, and whether anyone need be asked. */
export type AssignmentStatus =
  /** Resolved to exactly one room. Safe to apply without asking. */
  | 'auto'
  /** Resolvable, but not to one room. Needs a person before anything is painted. */
  | 'confirm'
  /** No room corresponds. The render describes something not in this plan. */
  | 'unmatched'

export interface RoomAssignment {
  /** The caption this was matched on, as written on the deck. */
  label: string
  /** The resolved room slug — only ever set when status is 'auto'. */
  room: string | null
  status: AssignmentStatus
  /** 1 for an exact caption, lower for a looser one. 0 when unresolved. */
  confidence: number
  /** Why, in words a person can act on. Shown beside the render. */
  reason: string
  /** What it was torn between, when it was torn. Empty otherwise. */
  candidates: string[]
}

function compact(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function tokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !['render', 'view', 'interior', 'design'].includes(token))
}

function list(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}

/**
 * Match one caption against the rooms a model actually contains.
 *
 * Exact first, subset only if exact found nothing — checking both tiers and
 * preferring the better is what stops "Bedroom" from being a coin toss between
 * `bedroom` and `master-bedroom`.
 */
export function assignOne(label: string, rooms: string[]): RoomAssignment {
  const trimmed = label.trim()
  const base: RoomAssignment = {
    label: trimmed, room: null, status: 'unmatched', confidence: 0,
    reason: '', candidates: [],
  }

  if (!trimmed) {
    return { ...base, reason: 'This render carries no room caption, so there is nothing to match on.' }
  }

  const wanted = compact(trimmed)
  const exact = rooms.filter((room) => compact(room) === wanted)
  if (exact.length === 1) {
    return {
      ...base, room: exact[0], status: 'auto', confidence: 1,
      reason: `The caption is exactly the room name "${exact[0]}".`,
    }
  }
  if (exact.length > 1) {
    return {
      ...base, status: 'confirm', candidates: exact,
      reason: `${exact.length} rooms are named "${trimmed}". Which one is this render of?`,
    }
  }

  const parts = tokens(trimmed)
  if (parts.length === 0) {
    return { ...base, reason: `"${trimmed}" reduces to no usable words.` }
  }
  const subset = rooms.filter((room) => {
    const available = new Set(tokens(room))
    return parts.every((token) => available.has(token))
  })
  if (subset.length === 1) {
    return {
      ...base, room: subset[0], status: 'auto', confidence: 0.75,
      reason: `"${trimmed}" matches only "${subset[0]}".`,
    }
  }
  if (subset.length > 1) {
    return {
      ...base, status: 'confirm', candidates: subset,
      // The message names the rooms because "ambiguous" alone sends someone
      // back to the drawing to work out what the choices even were.
      reason: `"${trimmed}" fits ${list(subset)}. Pick one, or caption the render more precisely.`,
    }
  }
  return { ...base, reason: `No room in this model matches "${trimmed}".` }
}

/**
 * Assign every caption, then resolve renders that landed on the same room.
 *
 * The per-caption pass cannot see a collision — two different renders each
 * matching one room unambiguously is only a problem when compared. Left alone
 * the later one silently overwrote the earlier, which is the same class of
 * quiet wrongness as the subset bug.
 */
export function assignDesigns(labels: string[], rooms: string[]): RoomAssignment[] {
  const assignments = labels.map((label) => assignOne(label, rooms))

  const claims = new Map<string, number[]>()
  assignments.forEach((assignment, index) => {
    if (assignment.status !== 'auto' || !assignment.room) return
    const held = claims.get(assignment.room) ?? []
    held.push(index)
    claims.set(assignment.room, held)
  })

  for (const [room, holders] of claims) {
    if (holders.length < 2) continue
    for (const index of holders) {
      const other = holders
        .filter((candidate) => candidate !== index)
        .map((candidate) => `"${assignments[candidate].label}"`)
      assignments[index] = {
        ...assignments[index], room: null, status: 'confirm', confidence: 0,
        candidates: [room],
        reason: `This and ${list(other)} both resolve to "${room}". Only one render can dress it.`,
      }
    }
  }
  return assignments
}

/** Everything a caller must show a person before the model is trustworthy. */
export function unresolved(assignments: RoomAssignment[]): RoomAssignment[] {
  return assignments.filter((assignment) => assignment.status !== 'auto')
}

/**
 * The assignment for a render somebody has already answered.
 *
 * No matching happens: a confirmed index is a decision, and re-deriving it from
 * the caption would let a heuristic overturn a person. Kept here beside the
 * heuristics so the one rule that outranks them is impossible to miss.
 */
export function confirmedAssignment(label: string, roomIndex: number): RoomAssignment {
  return {
    label: label.trim(),
    room: null,
    status: 'auto',
    confidence: 1,
    reason: `Confirmed as room ${roomIndex}.`,
    candidates: [],
  }
}
