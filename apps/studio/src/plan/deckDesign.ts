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
 * Provenance only: `applyDesignToModel` never looks at it. It exists so the
 * panel can mark the render the model is wearing after a reload, and so an
 * automatic read is distinguishable from a chosen one.
 */
export interface DesignSource {
  page: number
  index: number
  room?: string | null
  auto?: boolean
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
}

/**
 * Dress a loaded model in the spec's finishes: the matching surface maps,
 * tinted toward the measured colours.
 *
 * Works on whole mesh classes because that is what the models offer: a CAD
 * GLB has one floors mesh per storey, so "the bedroom's carpet" cannot be
 * painted onto one room of it — per-room split is an engine change, recorded
 * as the follow-up, and the panel says which render's finishes were applied.
 *
 * Materials are CLONED from the shared surface cache before tinting.
 * `surface(kind)` returns the one instance every plan mesh shares — tinting
 * it in place would recolour every other scene the session opens.
 */
export function applyDesignToModel(root: THREE.Object3D, spec: DesignSpec): AppliedDesign {
  const applied: AppliedDesign = { floors: 0, walls: 0, ceilings: 0 }

  const floorKind = FLOOR_SURFACE_BY_MATERIAL[spec.floor?.material ?? '']
  const floorMat = tinted(floorKind ?? 'floor-tile', spec.floor?.colour, floorKind ? 0.35 : 0.8)
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
