/**
 * From a deck's renders to the model's materials.
 *
 * The deck reader (floorplan-ai) turns each render into a DesignSpec — floor,
 * walls, ceiling, furnishing, style, with colours ASSIGNED from the render's
 * measured palette rather than invented (see services/floorplan-ai/design.py).
 * This module is everything that happens to a spec after it arrives: the
 * client call that fetches it, the pure mapping onto the studio's finish and
 * surface vocabulary, the hub search queries that go looking for the same
 * materials, and the three.js application onto a loaded model.
 *
 * ── What "the same materials" honestly means ────────────────────────────────
 * The spec names a kind and a colour. The studio owns real photographed
 * surface maps per kind (catalogue/surfaces.ts) and a CC0/CC-BY hub of 856
 * materials. Applying a spec = the right KIND of surface, tinted toward the
 * measured colour, plus hub queries ranked for a human to pick an exact
 * match. What it is not — and does not pretend to be — is pixel-lifting the
 * architect's licensed material out of a 400px render.
 */

import * as THREE from 'three'
import { assignDesigns, confirmedAssignment, type RoomAssignment } from './roomAssignment'
import { surface } from './materials'
import type { SurfaceKind } from './materials'
import type { FloorFinish } from './types'

// ---- The spec, as the reader emits it --------------------------------------

export interface DesignSurface {
  material?: string
  finish?: string
  kind?: string
  colour?: string
  accent?: string | null
  pattern?: string
}

export interface DesignFurniture {
  item: string
  colour?: string
  style?: string
}

/**
 * Which of the deck's renders a spec was read from — page and index into the
 * stored document, plus whether the read fired automatically on scene open.
 * Provenance and room addressing: the panel uses page/index to mark worn
 * renders, while `applyDesignsToModel` uses the room caption to find a named
 * reconstruction floor. `applyDesignToModel` itself remains source-agnostic.
 */
export interface DesignSource {
  page: number
  index: number
  room?: string | null
  auto?: boolean
  /**
   * The room this render was CONFIRMED to be of, as the reconstruction numbers
   * its spaces (`floor_room3_...` is 3). Set when a person accepted a proposal
   * from the vision model, or picked the room themselves.
   *
   * It outranks every caption heuristic because it is not a heuristic: it is
   * somebody's answer. It also addresses the two rooms a caption cannot -- one
   * the drawing never labelled, and one of three all labelled BEDROOM.
   */
  roomIndex?: number | null
}

export interface DesignSpec {
  room: string
  floor?: DesignSurface
  walls?: DesignSurface
  ceiling?: DesignSurface
  furniture: DesignFurniture[]
  lighting?: string
  style?: string
  confidence?: number
  palette: string[]
  model?: string
  source?: DesignSource
}

/**
 * Scenes written before room-by-room dressing stored one object. New scenes
 * store an array, but the reader accepts both indefinitely so opening an old
 * project never depends on a migration having run first.
 */
export type StoredDesign = DesignSpec | DesignSpec[] | null | undefined

export function designsOf(stored: StoredDesign): DesignSpec[] {
  if (Array.isArray(stored)) return stored
  return stored ? [stored] : []
}

export function designRoomName(spec: DesignSpec): string {
  return spec.source?.room?.trim() || spec.room?.trim() || ''
}

/** A stable identity for replacing one room's look without losing the rest. */
export function designRoomKey(spec: DesignSpec): string {
  const room = compactRoom(designRoomName(spec))
  if (room) return `room:${room}`
  if (spec.source) return `render:${spec.source.page}:${spec.source.index}`
  return 'room:unknown'
}

/**
 * One review decision for one observed inventory. Replacing a room's render
 * keeps its material upsert key but must reopen furniture review when the
 * source or the items changed.
 */
export function designFurnitureKey(spec: DesignSpec): string {
  const source = spec.source ? `${spec.source.page}:${spec.source.index}` : 'unsourced'
  const inventory = spec.furniture
    .map((piece) => piece.item.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',')
  return `${designRoomKey(spec)}|${source}|${inventory}`
}

/** Append a new room, or replace that room in place so the first fallback is stable. */
export function upsertDesign(stored: StoredDesign, next: DesignSpec): DesignSpec[] {
  const designs = designsOf(stored)
  const key = designRoomKey(next)
  const index = designs.findIndex((candidate) => designRoomKey(candidate) === key)
  if (index < 0) return [...designs, next]
  return designs.map((candidate, at) => (at === index ? next : candidate))
}

// The network half (readDesign) lives with the panel, not here: this module
// is imported by headless tests, and lib/api reads Vite env at module load.

// ---- Pure mapping: spec vocabulary → studio vocabulary ----------------------

const FLOOR_FINISH_BY_MATERIAL: Record<string, FloorFinish> = {
  wood: 'floor-wood',
  tile: 'floor-tile',
  marble: 'floor-tile',
  stone: 'stone',
  concrete: 'concrete',
  paving: 'paving',
  grass: 'grass',
}

/**
 * The plan-room finish a spec implies, or null when the vocabulary has no
 * honest match (carpet: the plan has no carpet finish, and pretending tile
 * is carpet would be worse than leaving the default and saying so).
 */
export function finishForSpec(spec: DesignSpec): FloorFinish | null {
  return FLOOR_FINISH_BY_MATERIAL[spec.floor?.material ?? ''] ?? null
}

const FLOOR_SURFACE_BY_MATERIAL: Record<string, SurfaceKind> = {
  wood: 'floor-wood',
  tile: 'floor-tile',
  marble: 'floor-tile',
  stone: 'floor-tile',
  concrete: 'floor-tile',
}

/** Hub search queries for the spec — one per surface, ranked most useful
 *  first. The colour rides as a plain word because the hub indexes names and
 *  tags, not hexes; the panel shows the swatch beside the results. */
export function hubQueriesForSpec(spec: DesignSpec): { label: string; q: string; kind: string }[] {
  const queries: { label: string; q: string; kind: string }[] = []
  const style = (spec.style ?? '').replace(/-/g, ' ').trim()
  if (spec.floor?.material && spec.floor.material !== 'other') {
    queries.push({
      label: `Floor — ${spec.floor.material}${spec.floor.pattern ? `, ${spec.floor.pattern}` : ''}`,
      q: [spec.floor.material, spec.floor.pattern, colourWord(spec.floor.colour)]
        .filter(Boolean).join(' '),
      kind: 'material',
    })
  }
  if (spec.walls?.finish && spec.walls.finish !== 'paint') {
    queries.push({
      label: `Walls — ${spec.walls.finish}`,
      q: [spec.walls.finish, colourWord(spec.walls.colour)].filter(Boolean).join(' '),
      kind: 'material',
    })
  }
  for (const piece of spec.furniture.slice(0, 6)) {
    queries.push({
      label: `${piece.item}${piece.style ? ` — ${piece.style}` : ''}`,
      q: [piece.item, piece.style === 'modern' ? '' : piece.style, style]
        .filter(Boolean).join(' ').trim() || piece.item,
      kind: 'model',
    })
  }
  return queries
}

/**
 * A hex made speakable, for search text. Coarse ON PURPOSE — the hub's names
 * say "oak" and "walnut", not "#74777a", and a wrong-but-close word beats a
 * hex the index cannot match. The swatch beside the results carries the truth.
 */
export function colourWord(hex?: string | null): string {
  const c = parseHex(hex)
  if (!c) return ''
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  if (max - min < 24) {
    return light < 60 ? 'black' : light < 120 ? 'dark grey' : light < 190 ? 'grey' : 'white'
  }
  if (r >= g && g >= b) return light < 110 ? 'brown' : b < 100 ? 'beige' : 'warm'
  if (g >= r && g >= b) return 'green'
  if (b >= r && b >= g) return 'blue'
  return r > b ? 'red' : 'violet'
}

export function parseHex(hex?: string | null): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ---- Applying a spec to the loaded model -----------------------------------

/** Mesh-name conventions of the two model producers (CAD engine, plan
 *  builder), used to decide which meshes are floors, walls and ceilings. */
const FLOORS = /(^|_)floors?($|:|_)|^slab:/
const WALLS = /(^|_)walls?($|:|_)|^wall:|^corner:|^skirting:/
const CEILINGS = /^ceiling:|(^|_)ceilings?($|:|_)/

export interface AppliedDesign {
  floors: number
  walls: number
  ceilings: number
  /**
   * How each render past the first was matched to a room. Present so a caller
   * can SHOW the ones that did not resolve: a room wearing the fallback
   * because nothing matched looks identical to a room deliberately dressed
   * that way, and the difference is the whole question.
   */
  assignments?: RoomAssignment[]
}

/**
 * Dress a loaded model in the spec's finishes: the matching surface maps,
 * tinted toward the measured colours.
 *
 * One spec still dresses each matching surface class. Use
 * `applyDesignsToModel` when a scene carries the newer room-design array.
 *
 * Materials are CLONED from the shared surface cache before tinting.
 * `surface(kind)` returns the one instance every plan mesh shares — tinting
 * it in place would recolour every other scene the session opens.
 */
export function applyDesignToModel(root: THREE.Object3D, spec: DesignSpec): AppliedDesign {
  const applied: AppliedDesign = { floors: 0, walls: 0, ceilings: 0 }

  const floorMat = floorMaterial(spec)
  const wallMat = tinted('wall', spec.walls?.colour, 0.65)
  const ceilingMat = tinted('ceiling', spec.ceiling?.colour, 0.5)

  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !object.name) return
    if (FLOORS.test(object.name)) {
      mesh.material = floorMat
      applied.floors += 1
    } else if (WALLS.test(object.name)) {
      mesh.material = wallMat
      applied.walls += 1
    } else if (CEILINGS.test(object.name)) {
      mesh.material = ceilingMat
      applied.ceilings += 1
    }
  })
  return applied
}

/**
 * Dress a model from all saved room renders.
 *
 * The first render remains a whole-model fallback. This keeps old scenes and
 * aggregate plan-builder meshes looking exactly as they did before arrays
 * existed. Each later render then replaces only the named reconstruction
 * floor, wall-finish and ceiling meshes whose room slug matches its caption.
 * The structural `storeyN_walls` mesh keeps the fallback material underneath;
 * its room skins are what stop one paint colour at the doorway.
 */
/** Every distinct room slug the model actually contains. */
function roomsIn(root: THREE.Object3D): string[] {
  const found = new Set<string>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !object.name) return
    for (const kind of ['floor', 'wall', 'ceiling'] as const) {
      const slug = roomSurfaceSlug(object.name, kind)
      if (slug) found.add(slug)
    }
  })
  return [...found]
}

export function applyDesignsToModel(
  root: THREE.Object3D,
  stored: StoredDesign,
): AppliedDesign {
  const designs = designsOf(stored)
  if (designs.length === 0) return { floors: 0, walls: 0, ceilings: 0, assignments: [] }

  // The first render stays the fallback: a deck's opening view sets the
  // general look, and a room nobody photographed is better served by the
  // scheme than by bare grey. What changed is that every OTHER render must now
  // earn its room, and anything it cannot earn is reported rather than guessed.
  const applied = applyDesignToModel(root, designs[0])
  const rest = designs.slice(1)
  const rooms = roomsIn(root)
  const assignments = assignDesigns(rest.map(designRoomName), rooms)
  // A confirmed index replaces whatever the caption pass concluded, including
  // a 'confirm' it could not resolve — answering the question is what the
  // confirmation IS.
  rest.forEach((spec, index) => {
    const confirmed = spec.source?.roomIndex
    if (confirmed === undefined || confirmed === null) return
    assignments[index] = confirmedAssignment(designRoomName(spec), confirmed)
  })
  applied.assignments = assignments

  for (const [index, spec] of rest.entries()) {
    const assignment = assignments[index]
    // Only an unambiguous room is painted. A 'confirm' leaves the room on the
    // fallback and travels back to the caller as a question.
    if (assignment.status !== 'auto') continue
    const confirmed = spec.source?.roomIndex
    const target = assignment.room
    if (confirmed === undefined || confirmed === null) {
      if (!target) continue
    }
    const floor = spec.floor ? floorMaterial(spec) : null
    const wall = spec.walls ? tinted('wall', spec.walls.colour, 0.65) : null
    const ceiling = spec.ceiling ? tinted('ceiling', spec.ceiling.colour, 0.5) : null
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !object.name) return
      const floorSlug = roomSurfaceSlug(object.name, 'floor')
      const wallSlug = roomSurfaceSlug(object.name, 'wall')
      const ceilingSlug = roomSurfaceSlug(object.name, 'ceiling')
      // Compared against the RESOLVED room rather than re-running the caption
      // match per mesh. Re-matching here is what let one caption spread across
      // every room it happened to fit.
      // An absent surface means the reader could not identify it. Preserve the
      // fallback rather than converting uncertainty into a guessed material.
      // A confirmed index is compared against the mesh's own number; a caption
      // match against the slug it resolved to. Never both, and never the
      // caption again once somebody has answered.
      const hits = (
        surfaceSlug: string | null,
        surfaceIndex: number | null,
      ): boolean =>
        confirmed === undefined || confirmed === null
          ? surfaceSlug !== null && surfaceSlug === target
          : surfaceIndex === confirmed

      if (floor && hits(floorSlug, roomSurfaceIndex(object.name, 'floor'))) {
        mesh.material = floor
      } else if (wall && hits(wallSlug, roomSurfaceIndex(object.name, 'wall'))) {
        mesh.material = wall
      } else if (ceiling && hits(ceilingSlug, roomSurfaceIndex(object.name, 'ceiling'))) {
        mesh.material = ceiling
      }
    })
  }
  return applied
}

function floorMaterial(spec: DesignSpec): THREE.MeshStandardMaterial {
  const floorKind = FLOOR_SURFACE_BY_MATERIAL[spec.floor?.material ?? '']
  return tinted(floorKind ?? 'floor-tile', spec.floor?.colour, floorKind ? 0.35 : 0.8)
}

/** Extract an addressable indoor room surface, never lawn/paving/water. */
function roomSurfaceSlug(name: string, kind: 'floor' | 'wall' | 'ceiling'): string | null {
  return new RegExp(`(?:^|_)${kind}_room\\d+_([^:]+)$`, 'i').exec(name)?.[1] ?? null
}

/**
 * The room's NUMBER, which the slug alone cannot supply.
 *
 * `floor_room3_master-bedroom` carries two identities and the matcher was only
 * ever reading one. solidify.py puts the index there precisely because "the
 * numeric index is unambiguous even when a drawing contains three rooms all
 * labelled BEDROOM" - and those three are exactly the rooms a caption can never
 * separate. Once a person (or the vision model, confirmed by a person) has said
 * WHICH room, the index is how that decision is addressed: exact, stable, and
 * available even for a room the drawing never labelled.
 */
function roomSurfaceIndex(name: string, kind: 'floor' | 'wall' | 'ceiling'): number | null {
  const found = new RegExp(`(?:^|_)${kind}_room(\\d+)_`, 'i').exec(name)?.[1]
  return found === undefined ? null : Number(found)
}

function compactRoom(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function roomTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !['render', 'view', 'interior', 'design'].includes(token))
}

export function roomNameMatches(label: string, meshSlug: string): boolean {
  if (compactRoom(label) === compactRoom(meshSlug)) return true
  const wanted = roomTokens(label)
  const available = new Set(roomTokens(meshSlug))
  return wanted.length > 0 && wanted.every((token) => available.has(token))
}

/**
 * A clone of the shared surface material, pulled toward the spec's colour.
 *
 * `strength` is how far: a real map (wood grain) keeps most of its own
 * character at 0.35; a plain painted wall takes the measured colour almost
 * whole. Tint multiplies the map rather than replacing it, so relief and
 * grain survive — the same reason the surface system multiplies its own
 * colour maps.
 */
function tinted(kind: SurfaceKind, hex: string | undefined | null, strength: number): THREE.MeshStandardMaterial {
  const material = surface(kind).clone()
  const c = parseHex(hex)
  if (c) {
    const target = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255)
    // Around mid-grey the multiply is near-neutral; lerp from white keeps
    // light colours light instead of darkening everything the map touches.
    material.color = new THREE.Color(1, 1, 1).lerp(target, strength)
  }
  return material
}
