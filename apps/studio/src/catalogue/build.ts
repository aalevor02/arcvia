import * as THREE from 'three'
import type { CatalogueItem, PlacedObject } from './types'
import { itemById } from './items'
import { elevationOf, sizeOf } from './placement'
import { surface, type SurfaceKind } from '../plan/materials'

/**
 * Parametric furniture.
 *
 * Each builder gets a unit box — width × depth × height in metres, centred on
 * the origin at floor level — and fills it. Keeping them dimension-driven
 * rather than modelled means one `sofa` builder serves the two-seat, three-seat
 * and armchair entries, and resizing an object in the inspector reshapes it
 * instead of scaling it into the wrong proportions.
 *
 * These are stand-ins for a real asset library, and they are honest about it:
 * blocky, readable, correctly sized. `PlacedObject.customUrl` is the seam where
 * a proper GLB takes over.
 */

/**
 * Catalogue tones map onto the shared surface materials.
 *
 * Kept as a mapping rather than merging the two vocabularies: an item says what
 * it is *made of* ("wood"), and the material layer decides what that looks like.
 * Swapping in a photographed oak later changes one function, not 46 catalogue
 * entries.
 */
const TONE_SURFACE: Record<string, SurfaceKind> = {
  wood: 'wood',
  fabric: 'fabric',
  metal: 'metal',
  stone: 'stone',
  glass: 'glass',
  plant: 'plant',
  white: 'white',
}

function material(tone = 'fabric'): THREE.MeshStandardMaterial {
  return surface(TONE_SURFACE[tone] ?? 'fabric')
}

/**
 * Materials are owned by `plan/materials.ts` and shared across every build, so
 * there is nothing per-catalogue to release. Kept as an explicit re-export so
 * callers have one teardown to call.
 */
export { disposeSurfaces as disposeMaterials } from '../plan/materials'

interface Box {
  width: number
  depth: number
  height: number
}

/**
 * Tones that must not cast a shadow.
 *
 * Three.js shadow maps store depth only, so a transparent material casts a
 * *fully opaque* shadow — the shadow map has no idea the surface can be seen
 * through. Left alone, a glazed window blocks the sun exactly as well as the
 * wall around it, and the daylight that should be pouring across the floor
 * never arrives. The room then looks evenly, sourcelessly lit, which is the
 * single most reliable way to make an interior read as a computer model.
 *
 * A set rather than a `transparent` check on the material, because a material
 * can legitimately be transparent and still block light — frosted glass, a
 * blind. This is the list of things daylight passes through.
 */
const TRANSMITS_LIGHT = new Set(['glass'])

/** A box positioned by its centre, in the object's local frame. */
function block(
  group: THREE.Group,
  tone: string,
  size: [number, number, number],
  at: [number, number, number],
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(tone))
  mesh.position.set(...at)
  mesh.castShadow = !TRANSMITS_LIGHT.has(tone)
  mesh.receiveShadow = true
  group.add(mesh)
}

function cylinder(
  group: THREE.Group,
  tone: string,
  radius: number,
  height: number,
  at: [number, number, number],
): void {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 16),
    material(tone),
  )
  mesh.position.set(...at)
  mesh.castShadow = !TRANSMITS_LIGHT.has(tone)
  group.add(mesh)
}

type Builder = (group: THREE.Group, size: Box, tone: string) => void

const BUILDERS: Record<string, Builder> = {
  /** A plain box filling the footprint. */
  box: (g, s, tone) => block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0]),

  /** Seat, back and two arms. Works for an armchair and a three-seater alike. */
  sofa: (g, s, tone) => {
    const arm = Math.min(0.18, s.width * 0.15)
    const back = Math.min(0.18, s.depth * 0.22)
    const seat = s.height * 0.45

    block(g, tone, [s.width, seat, s.depth], [0, seat / 2, 0])
    block(g, tone, [s.width, s.height - seat, back], [0, s.height - (s.height - seat) / 2, -(s.depth - back) / 2])
    block(g, tone, [arm, s.height * 0.75, s.depth], [-(s.width - arm) / 2, s.height * 0.375, 0])
    block(g, tone, [arm, s.height * 0.75, s.depth], [(s.width - arm) / 2, s.height * 0.375, 0])
  },

  chair: (g, s, tone) => {
    const seat = s.height * 0.5
    block(g, tone, [s.width, 0.05, s.depth], [0, seat, 0])
    block(g, tone, [s.width, s.height - seat, 0.05], [0, (s.height + seat) / 2, -(s.depth - 0.05) / 2])
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      block(g, tone, [0.04, seat, 0.04], [x * (s.width / 2 - 0.04), seat / 2, z * (s.depth / 2 - 0.04)])
    }
  },

  /** Top plus four legs — a dining table, desk or coffee table. */
  table: (g, s, tone) => {
    const top = 0.045
    block(g, tone, [s.width, top, s.depth], [0, s.height - top / 2, 0])
    const leg = 0.06
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      block(g, tone, [leg, s.height - top, leg], [
        x * (s.width / 2 - leg),
        (s.height - top) / 2,
        z * (s.depth / 2 - leg),
      ])
    }
  },

  bed: (g, s, tone) => {
    const base = s.height * 0.45
    block(g, 'wood', [s.width, base, s.depth], [0, base / 2, 0])
    // Mattress inset slightly so the base reads as a frame.
    block(g, tone, [s.width - 0.06, s.height - base, s.depth - 0.06], [0, s.height - (s.height - base) / 2, 0])
    // Headboard
    block(g, 'wood', [s.width, s.height * 1.1, 0.06], [0, s.height * 0.55, -(s.depth + 0.06) / 2])
    // Pillows
    const pillow = s.width > 1.2 ? 2 : 1
    for (let i = 0; i < pillow; i++) {
      const offset = pillow === 1 ? 0 : (i === 0 ? -1 : 1) * s.width * 0.22
      block(g, 'white', [s.width * 0.4, 0.11, 0.35], [offset, s.height + 0.05, -s.depth / 2 + 0.28])
    }
  },

  cabinet: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
    // A shadow line down the middle, so a wardrobe reads as having doors.
    block(g, 'metal', [0.012, s.height * 0.94, 0.012], [0, s.height / 2, s.depth / 2])
  },

  shelf: (g, s, tone) => {
    block(g, tone, [s.width, 0.03, s.depth], [0, 0.02, 0])
    block(g, tone, [0.03, s.height, s.depth], [-(s.width - 0.03) / 2, s.height / 2, 0])
    block(g, tone, [0.03, s.height, s.depth], [(s.width - 0.03) / 2, s.height / 2, 0])
    const shelves = Math.max(2, Math.round(s.height / 0.36))
    for (let i = 1; i <= shelves; i++) {
      block(g, tone, [s.width - 0.06, 0.025, s.depth], [0, (s.height / shelves) * i, 0])
    }
  },

  counter: (g, s, tone) => {
    block(g, 'wood', [s.width, s.height - 0.04, s.depth], [0, (s.height - 0.04) / 2, 0])
    block(g, tone, [s.width + 0.02, 0.04, s.depth + 0.02], [0, s.height - 0.02, 0])
  },

  sink: (g, s, tone) => {
    BUILDERS.counter(g, s, 'stone')
    block(g, tone, [s.width * 0.45, 0.03, s.depth * 0.6], [0, s.height, 0])
    cylinder(g, 'metal', 0.02, 0.28, [0, s.height + 0.14, -s.depth * 0.28])
  },

  appliance: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
    block(g, 'metal', [s.width * 0.7, 0.03, 0.03], [0, s.height * 0.75, s.depth / 2])
  },

  wc: (g, s, tone) => {
    block(g, tone, [s.width, s.height * 0.55, s.depth * 0.75], [0, s.height * 0.275, s.depth * 0.1])
    block(g, tone, [s.width, s.height, 0.16], [0, s.height / 2, -s.depth / 2 + 0.08])
  },

  basin: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
    cylinder(g, 'metal', 0.018, 0.22, [0, s.height + 0.11, -s.depth * 0.3])
  },

  tub: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
    block(g, 'white', [s.width - 0.14, 0.06, s.depth - 0.14], [0, s.height - 0.02, 0])
  },

  shower: (g, s, tone) => {
    block(g, 'stone', [s.width, 0.06, s.depth], [0, 0.03, 0])
    // Two glass panels, leaving the entry open.
    block(g, tone, [0.02, s.height, s.depth], [-(s.width - 0.02) / 2, s.height / 2, 0])
    block(g, tone, [s.width, s.height, 0.02], [0, s.height / 2, -(s.depth - 0.02) / 2])
  },

  /** A door leaf, standing open at its swing angle. */
  door: (g, s, tone) => {
    const frame = 0.05
    block(g, 'white', [frame, s.height, s.depth + 0.02], [-(s.width) / 2, s.height / 2, 0])
    block(g, 'white', [frame, s.height, s.depth + 0.02], [s.width / 2, s.height / 2, 0])
    block(g, 'white', [s.width + frame * 2, frame, s.depth + 0.02], [0, s.height, 0])

    // Hinged at the left jamb, swung 75 degrees into the room.
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(s.width, s.height - frame, 0.04),
      material(tone),
    )
    leaf.castShadow = true
    const pivot = new THREE.Group()
    pivot.position.set(-s.width / 2, 0, 0)
    pivot.rotation.y = -Math.PI * 0.42
    leaf.position.set(s.width / 2, (s.height - frame) / 2, 0)
    pivot.add(leaf)
    g.add(pivot)
  },

  'door-double': (g, s, tone) => {
    const half = { ...s, width: s.width / 2 }
    const left = new THREE.Group()
    BUILDERS.door(left, half, tone)
    left.position.x = -s.width / 4
    g.add(left)

    const right = new THREE.Group()
    BUILDERS.door(right, half, tone)
    right.position.x = s.width / 4
    right.rotation.y = Math.PI
    g.add(right)
  },

  window: (g, s, tone) => {
    const frame = 0.06
    block(g, 'white', [s.width, frame, s.depth + 0.02], [0, frame / 2, 0])
    block(g, 'white', [s.width, frame, s.depth + 0.02], [0, s.height - frame / 2, 0])
    block(g, 'white', [frame, s.height, s.depth + 0.02], [-(s.width - frame) / 2, s.height / 2, 0])
    block(g, 'white', [frame, s.height, s.depth + 0.02], [(s.width - frame) / 2, s.height / 2, 0])
    block(g, tone, [s.width - frame * 2, s.height - frame * 2, 0.012], [0, s.height / 2, 0])
    block(g, 'white', [0.03, s.height - frame * 2, 0.02], [0, s.height / 2, 0])
  },

  /** A hole with nothing in it. Nothing to draw in 3D — the cut is the object. */
  opening: () => {},

  'ceiling-light': (g, s) => {
    cylinder(g, 'white', s.width / 2, s.height, [0, -s.height / 2, 0])
  },

  pendant: (g, s, tone) => {
    cylinder(g, 'metal', 0.006, s.height, [0, -s.height / 2, 0])
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(s.width / 2, s.height * 0.6, 20, 1, true),
      material(tone),
    )
    shade.position.y = -s.height - s.height * 0.3
    shade.rotation.x = Math.PI
    g.add(shade)
  },

  panel: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
  },

  rug: (g, s, tone) => {
    block(g, tone, [s.width, s.height, s.depth], [0, s.height / 2, 0])
  },

  curtain: (g, s, tone) => {
    // Two gathered panels, one each side.
    const panel = s.width * 0.28
    for (const side of [-1, 1]) {
      block(g, tone, [panel, s.height, s.depth], [side * (s.width - panel) / 2, s.height / 2, 0])
    }
    block(g, 'metal', [s.width, 0.03, 0.03], [0, s.height, 0])
  },

  plant: (g, s) => {
    const potHeight = s.height * 0.22
    cylinder(g, 'stone', s.width * 0.28, potHeight, [0, potHeight / 2, 0])
    const foliage = new THREE.Mesh(
      new THREE.SphereGeometry(s.width * 0.42, 12, 10),
      material('plant'),
    )
    foliage.position.y = potHeight + s.height * 0.4
    foliage.scale.y = 1.25
    foliage.castShadow = true
    g.add(foliage)
  },
}

/**
 * Build one placed object, positioned and rotated in world space.
 *
 * Returns null for objects that have no geometry — an `opening` is a hole, and
 * the hole is cut by the wall builder, not filled by a mesh here.
 */
export function buildObject(object: PlacedObject, floorElevation: number): THREE.Group | null {
  const item: CatalogueItem | undefined = itemById(object.item)
  if (!item) return null

  const builder = BUILDERS[item.shape]
  if (!builder) return null

  const group = new THREE.Group()
  group.name = `object:${object.id}`

  builder(group, sizeOf(object), item.tone ?? 'fabric')
  if (group.children.length === 0) return null

  // plan (x, y) -> world (x, elevation, -y), the same mapping walls use.
  group.position.set(
    object.position.x,
    floorElevation + elevationOf(object),
    -object.position.y,
  )
  group.rotation.y = -object.rotation

  return group
}

/** Every object on a floor, as one group. */
export function buildObjects(
  objects: PlacedObject[],
  floorElevation: number,
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'objects'

  for (const object of objects) {
    const built = buildObject(object, floorElevation)
    if (built) group.add(built)
  }

  return group
}

export const hasShape = (shape: string): boolean => shape in BUILDERS
