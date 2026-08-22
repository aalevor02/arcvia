import type { Floor as PublishedFloor, Project, Room as PublishedRoom, VillaType } from '@arcvia/publication'

import { detectRooms, displayName, totalArea } from '../plan/rooms'
import type { Floor, Plan, Room } from '../plan/types'

/**
 * Turn scenes into the project a client opens.
 *
 * ── What can be derived, and what cannot ────────────────────────────────────
 * A published project is two things wearing one shape. Half of it is
 * measurable — how many floors, which rooms, how big, what the walkthrough
 * loads. The other half is written by a person: the tagline, the developer's
 * name, the RERA number, the disclaimer, what makes the place worth buying.
 *
 * This derives the first half and leaves the second alone. It does not invent
 * copy, and it does not guess at anything commercial.
 *
 * ── Why it reports what it assumed ──────────────────────────────────────────
 * Every derived figure here ends up on a page a buyer reads. A composer that
 * silently defaults an area, or quietly names a room "Room 3", produces a
 * document that looks authored and is not. So it returns warnings alongside
 * the project, and the studio shows them before anything is published — the
 * same discipline as the engine's "price what was measured, report what was
 * defaulted".
 */

/** What the author supplies per scene, because none of it is in the drawing. */
export interface TypeInput {
  /** The scene to derive floors and the walkthrough from. */
  scene: ComposableScene
  /** "Type A1", "The Courtyard House" — what the client calls it. */
  name: string
  /** Unit codes sharing this drawing set, for the master plan. */
  appliesTo?: string[]
  summary?: string
  /** Render slugs, most representative first. */
  renders?: string[]
}

/** Only the parts of a studio scene this needs, so tests need no API. */
export interface ComposableScene {
  id: string
  name?: string
  plan: Plan | null
  modelUrl?: string | null
  hdriUrl?: string | null
  views?: { id: string; name: string; position: [number, number, number]; rotation: [number, number] }[]
}

export interface ComposeResult {
  project: Project
  /**
   * Everything a person should look at before this is published.
   *
   * Not errors — a project with warnings is publishable, and most will be. They
   * exist because the alternative is a page that looks finished and contains a
   * measurement nobody checked.
   */
  warnings: string[]
}

/**
 * What a room's name says it is.
 *
 * ── Why by name, and why that is a limitation worth stating ─────────────────
 * The published page groups a schedule into habitable, service, circulation and
 * outdoor, and sorts by that order. The studio knows only what someone typed on
 * the plan, so this reads the name and nothing else.
 *
 * The engine does better and it is worth knowing why: `quantify/schedules.py`
 * uses name AND kind together, because the two disagree in both directions —
 * `OFFICE PATIO` has an indoor kind and is outdoor by name, and an "Enclosed
 * Balcony" is the reverse. The studio has no kind, so a name that says nothing
 * gets no classification rather than a guess.
 *
 * Undefined is a real answer. The page falls back to `habitable` for sorting,
 * which is a display default rather than a claim about the room.
 */
const ROOM_KINDS: { kind: NonNullable<PublishedRoom['kind']>; words: string[] }[] = [
  // Outdoor first: a name matching both lists is almost always outdoor, because
  // "balcony" and "terrace" are more specific than the words they contain.
  {
    kind: 'outdoor',
    words: ['balcony', 'terrace', 'patio', 'deck', 'veranda', 'verandah', 'courtyard', 'garden', 'lawn', 'pool', 'sit out', 'sitout', 'open to sky', 'ots'],
  },
  {
    kind: 'circulation',
    words: ['foyer', 'lobby', 'corridor', 'passage', 'hall way', 'hallway', 'stair', 'staircase', 'landing', 'lift', 'elevator', 'entry', 'entrance', 'porch'],
  },
  {
    kind: 'service',
    words: ['toilet', 'wc', 'bath', 'bathroom', 'shower', 'powder', 'utility', 'laundry', 'wash', 'store', 'storage', 'pantry', 'walk-in', 'walk in', 'wardrobe', 'closet', 'servant', 'maid', 'plant', 'meter', 'shaft', 'duct', 'garage', 'parking'],
  },
  {
    kind: 'habitable',
    words: ['bedroom', 'bed room', 'master', 'living', 'dining', 'family', 'kitchen', 'study', 'office', 'lounge', 'den', 'guest', 'media', 'home theatre', 'home theater', 'gym'],
  },
]

export function classifyRoom(name: string): PublishedRoom['kind'] | undefined {
  const haystack = name.toLowerCase()
  for (const { kind, words } of ROOM_KINDS) {
    // Whole-word-ish containment. Substring matching is a defect this codebase
    // has recorded three times — "m sand" inside "20 mm sand", "CC Attribution"
    // inside "CC Attribution-NonCommercial", NormalGL inside NormalDX — so a
    // word here must sit on a boundary rather than anywhere in the string.
    if (words.some((word) => new RegExp(`(^|[^a-z])${escapeForRegExp(word)}([^a-z]|$)`).test(haystack))) {
      return kind
    }
  }
  return undefined
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A room's extent, for the schedule's "3.82 × 4.00" column. */
function extent(room: Room): { width: number; depth: number } | null {
  if (room.polygon.length === 0) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of room.polygon) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  // The bounding box, which is the width and depth an architect writes on a
  // plan. It overstates an L-shaped room, and the area column beside it is
  // measured from the polygon rather than from these two numbers, so the two
  // do not silently multiply into a wrong figure.
  return { width: round(maxX - minX), depth: round(maxY - minY) }
}

const round = (value: number): number => Math.round(value * 100) / 100

/**
 * One studio floor as a published floor.
 *
 * ── What `area` actually measures, since it is printed on a sales page ──────
 * Rooms are the bounded faces of the wall graph, so their polygons run along
 * wall CENTRELINES. The sum is therefore carpet area plus roughly half the
 * thickness of every wall — between carpet and built-up, and not either.
 *
 * It is emphatically **not** a certified super built-up area. SBUA is a
 * commercial figure with a legal meaning, typically 1.2 to 1.5 times carpet,
 * and it is not derivable from a drawing. The published model happens to define
 * `totalSbua` as the sum of these floor areas, so that is what is written — and
 * a warning says so, every time, so the number is confirmed by a person before
 * a buyer reads it.
 */
function composeFloor(floor: Floor, warnings: string[], typeName: string): PublishedFloor {
  const rooms = detectRooms(floor)
  const named = [...rooms].sort((a, b) => b.area - a.area)

  const published: PublishedRoom[] = named.map((room, index) => {
    const name = displayName(room, index, floor.roomNames)
    if (!floor.roomNames[room.id]) {
      warnings.push(
        `${typeName} · ${floor.name}: a room is unnamed and will appear as "${name}".`,
      )
    }

    const size = extent(room)
    const kind = classifyRoom(name)
    return {
      name,
      ...(size ?? {}),
      ...(kind ? { kind } : {}),
    }
  })

  const unclassified = published.filter((room) => !room.kind).length
  if (unclassified > 0) {
    warnings.push(
      `${typeName} · ${floor.name}: ${unclassified} room(s) could not be classified from their names ` +
        'and will be listed as habitable.',
    )
  }

  return {
    id: floor.id,
    label: floor.name,
    area: round(totalArea(rooms)),
    // No drawing is generated yet. Left empty rather than pointed at a file
    // that does not exist, which would render as a broken image on a client's
    // page — worse than an absent one.
    plan: '',
    rooms: published,
  }
}

function composeType(input: TypeInput, warnings: string[]): VillaType | null {
  const { scene, name } = input
  const id = slugify(name)

  if (!scene.plan || scene.plan.floors.length === 0) {
    warnings.push(`${name}: the scene has no plan, so it cannot be included.`)
    return null
  }

  const floors = scene.plan.floors.map((floor) => composeFloor(floor, warnings, name))
  const totalSbua = round(floors.reduce((sum, floor) => sum + floor.area, 0))

  warnings.push(
    `${name}: ${totalSbua} m² is measured from the drawing at wall centrelines, not a certified ` +
      'super built-up area. Confirm it before publishing.',
  )

  if (floors.every((floor) => floor.plan === '')) {
    warnings.push(`${name}: no floor-plan drawings yet, so the plan tab will show room schedules only.`)
  }

  const walkthrough = scene.modelUrl
    ? {
        model: scene.modelUrl,
        ...(scene.hdriUrl ? { environment: scene.hdriUrl } : {}),
        // 1.6 m is standing eye height, the same figure the studio's own walk
        // controller uses. Sharing it matters: a walkthrough that stands at a
        // different height from the editor is a different building.
        eyeHeight: 1.6,
        views: (scene.views ?? []).map((view) => ({
          id: view.id,
          name: view.name,
          position: view.position,
          rotation: view.rotation,
        })),
      }
    : undefined

  if (!walkthrough) {
    warnings.push(`${name}: the scene has no saved model, so this type has no walkthrough.`)
  } else if (walkthrough.views.length === 0) {
    warnings.push(`${name}: the walkthrough has no named views, so a visitor starts wherever the camera lands.`)
  }

  return {
    id,
    name,
    appliesTo: input.appliesTo ?? [],
    totalSbua,
    floors,
    renders: input.renders ?? [],
    summary: input.summary ?? '',
    ...(walkthrough ? { walkthrough } : {}),
  }
}

export function slugify(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * An empty project, so a composed one is never missing a field the page reads.
 *
 * The published site indexes into `sitePlan.units`, `gallery`, `contacts` and
 * the rest without guarding, which is correct for a hand-written data file and
 * fatal for a generated one. Every array exists here even when nothing has
 * filled it.
 */
export function emptyProject(name: string): Project {
  return {
    slug: slugify(name),
    name,
    script: '',
    place: '',
    developer: '',
    developerNote: '',
    tagline: '',
    rera: '',
    architect: '',
    intro: { heading: '', body: [] },
    sections: [],
    stats: [],
    sitePlan: { image: '', imageSmall: '', units: [], labels: [] },
    villaTypes: [],
    gallery: [],
    locationMap: { image: '', note: [] },
    contacts: [],
    offices: [],
    disclaimer: '',
  }
}

/**
 * Compose a project from scenes plus whatever a person has written.
 *
 * `authored` wins over everything derived except `villaTypes`, which is the one
 * part this owns — the whole point is that room schedules come from the drawing
 * rather than from a person retyping them.
 */
export function composeProject(
  name: string,
  types: TypeInput[],
  authored: Partial<Project> = {},
): ComposeResult {
  const warnings: string[] = []

  const villaTypes = types
    .map((type) => composeType(type, warnings))
    .filter((type): type is VillaType => type !== null)

  if (villaTypes.length === 0) {
    warnings.push('No unit types could be composed, so there is nothing for a visitor to look at.')
  }

  const ids = villaTypes.map((type) => type.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length > 0) {
    // Two types with the same slug collide in the URL and one becomes
    // unreachable — the page renders, the link just goes to the wrong villa.
    warnings.push(
      `Two unit types share the address "${duplicates[0]}". Rename one, or one of them cannot be opened.`,
    )
  }

  const project: Project = {
    ...emptyProject(name),
    ...authored,
    // Derived last and deliberately not overridable: a person editing a room
    // schedule by hand is a schedule that no longer matches the drawing.
    villaTypes,
  }

  for (const [field, label] of [
    ['developer', 'developer'],
    ['rera', 'RERA number'],
    ['disclaimer', 'disclaimer'],
  ] as const) {
    // Named individually rather than as "some fields are empty". These three
    // are the ones a buyer's eye goes to and the ones a regulator asks about.
    if (!project[field]) warnings.push(`The ${label} has not been written yet.`)
  }

  if (project.contacts.length === 0) {
    warnings.push('There is nobody to contact, so a visitor who wants to buy cannot.')
  }

  return { project, warnings }
}
