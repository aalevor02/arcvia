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
export const TONE_SURFACE: Record<string, SurfaceKind> = {
  wood: 'wood',
  fabric: 'fabric',
  metal: 'metal',
  stone: 'stone',
  glass: 'glass',
  plant: 'plant',
  white: 'white',
  water: 'water',
  grass: 'grass',
  paving: 'paving',
  /**
   * Surface kinds used directly by builders.
   *
   * The pool's tank passed 'floor-tile' before this key existed, and the
   * `?? 'fabric'` below made its floor and walls THE SAME MATERIAL INSTANCE as
   * every sofa — which the surface upgrade then painted grey woven upholstery,
   * visible through the water and above the waterline, on the way to a client.
   * Found by the product audit, not by the harness that rendered the pool: the
   * procedural fabric fallback is grey-ish, so the tank looked plausible.
   *
   * Exported, and tones.test.ts scans every literal a builder passes against
   * this table — the fallback exists for uploaded models with unknown tones,
   * not as a place for catalogue code to land by typo.
   */
  'floor-tile': 'floor-tile',
  'floor-wood': 'floor-wood',
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
const TRANSMITS_LIGHT = new Set(['glass', 'water'])

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

  // ---- Outdoor -------------------------------------------------------------

  /**
   * A pool: coping, a recessed tank, and a water surface inside it.
   *
   * ── Why it is a hole and not a blue box ─────────────────────────────────
   * A pool is read as a pool because the water sits BELOW the deck it is set
   * into. A blue slab on the ground reads as a rug. So the coping is built at
   * full height, the tank walls drop from it, and the water plane sits a little
   * under the coping — which also puts the deck's own shadow on the water,
   * which is most of what makes it look wet.
   *
   * `height` is the depth of the tank, so resizing it deepens the pool rather
   * than lifting it into the air.
   *
   * ⚠ Everything here is at or below y=0, because that is where a pool is. So
   * anything opaque spanning its footprint at ground level HIDES IT — place
   * paving and decking AROUND a pool, not under it. Verified: against a solid
   * ground plane the pool renders as a bare white outline and looks broken;
   * with nothing under it, the tank and water read correctly.
   *
   * The proper fix is for a slab to take an aperture where a pool overlaps it,
   * which is floor-geometry work rather than a catalogue shape. Until then the
   * item notes say so, because the failure looks like a bug in the pool.
   */
  pool: (g, s) => {
    const coping = Math.min(0.35, Math.min(s.width, s.depth) * 0.12)
    const rim = 0.12
    const inner = { w: Math.max(0.4, s.width - coping * 2), d: Math.max(0.4, s.depth - coping * 2) }

    // Coping, as four kerbs rather than a slab, so the tank inside is open.
    block(g, 'stone', [s.width, rim, coping], [0, -rim / 2, (s.depth - coping) / 2])
    block(g, 'stone', [s.width, rim, coping], [0, -rim / 2, -(s.depth - coping) / 2])
    block(g, 'stone', [coping, rim, inner.d], [(s.width - coping) / 2, -rim / 2, 0])
    block(g, 'stone', [coping, rim, inner.d], [-(s.width - coping) / 2, -rim / 2, 0])

    // The tank: a floor at depth, and four walls to hide the ground through it.
    block(g, 'floor-tile', [inner.w, 0.06, inner.d], [0, -s.height, 0])
    block(g, 'floor-tile', [inner.w, s.height, 0.06], [0, -s.height / 2, inner.d / 2])
    block(g, 'floor-tile', [inner.w, s.height, 0.06], [0, -s.height / 2, -inner.d / 2])
    block(g, 'floor-tile', [0.06, s.height, inner.d], [inner.w / 2, -s.height / 2, 0])
    block(g, 'floor-tile', [0.06, s.height, inner.d], [-inner.w / 2, -s.height / 2, 0])

    // Water, a hand's width below the coping — never flush, which reads as a
    // solid lid rather than a surface you could put a hand through.
    block(g, 'water', [inner.w, 0.02, inner.d], [0, -0.18, 0])
  },

  /** A flat area — decking, paving, a lawn. Tone decides which. */
  slab: (g, s, tone) => {
    const t = Math.max(0.04, Math.min(s.height, 0.12))
    block(g, tone, [s.width, t, s.depth], [0, t / 2, 0])
  },

  /**
   * A tree: trunk and a layered canopy.
   *
   * Three offset spheres rather than one, because a single sphere on a stick is
   * the most recognisable "3D placeholder" shape there is and undoes the work
   * every other object here does.
   */
  tree: (g, s) => {
    const trunk = Math.max(0.06, s.width * 0.06)
    const clear = s.height * 0.38
    cylinder(g, 'wood', trunk, clear, [0, clear / 2, 0])

    const r = s.width * 0.34
    for (const [dx, dy, dz, k] of [
      [0, clear + r * 0.9, 0, 1],
      [r * 0.5, clear + r * 1.5, r * 0.25, 0.72],
      [-r * 0.45, clear + r * 1.35, -r * 0.3, 0.66],
    ]) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r * k, 12, 10), material('plant'))
      mesh.position.set(dx, dy, dz)
      mesh.castShadow = true
      g.add(mesh)
    }
  },

  /** A clipped hedge or shrub mass — a rounded box, not a sphere. */
  hedge: (g, s) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.width, s.height, s.depth), material('plant'))
    mesh.position.y = s.height / 2
    mesh.castShadow = true
    mesh.receiveShadow = true
    g.add(mesh)
  },

  /** A parasol: pole, and a canopy that actually shades something. */
  parasol: (g, s) => {
    cylinder(g, 'metal', 0.03, s.height, [0, s.height / 2, 0])
    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(s.width / 2, s.height * 0.18, 8),
      material('fabric'),
    )
    canopy.position.y = s.height - s.height * 0.09
    canopy.castShadow = true
    g.add(canopy)
  },

  /** A sun lounger: a raked back on a low frame. */
  lounger: (g, s, tone) => {
    const bed = s.height * 0.55
    block(g, tone, [s.width, 0.08, s.depth * 0.62], [0, bed, s.depth * 0.19])
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(s.width, 0.08, s.depth * 0.42),
      material(tone),
    )
    back.position.set(0, bed + s.depth * 0.13, -s.depth * 0.28)
    back.rotation.x = -0.62
    back.castShadow = true
    g.add(back)
    for (const x of [-1, 1]) {
      block(g, 'metal', [0.05, bed, 0.05], [x * (s.width / 2 - 0.05), bed / 2, s.depth * 0.4])
      block(g, 'metal', [0.05, bed, 0.05], [x * (s.width / 2 - 0.05), bed / 2, -s.depth * 0.3])
    }
  },

  /** A pergola: posts and a slatted roof that casts a striped shadow. */
  pergola: (g, s) => {
    const post = 0.12
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      block(g, 'wood', [post, s.height, post], [
        x * (s.width / 2 - post / 2),
        s.height / 2,
        z * (s.depth / 2 - post / 2),
      ])
    }
    block(g, 'wood', [s.width, 0.12, post], [0, s.height - 0.06, (s.depth - post) / 2])
    block(g, 'wood', [s.width, 0.12, post], [0, s.height - 0.06, -(s.depth - post) / 2])

    // Slats. The striped shadow is the entire reason a pergola is built.
    const slats = Math.max(4, Math.round(s.depth / 0.32))
    for (let i = 0; i < slats; i++) {
      const z = -s.depth / 2 + (i + 0.5) * (s.depth / slats)
      block(g, 'wood', [s.width, 0.06, 0.06], [0, s.height + 0.03, z])
    }
  },

  /** A planter: a box with foliage above it. */
  planter: (g, s, tone) => {
    const box = s.height * 0.45
    block(g, tone, [s.width, box, s.depth], [0, box / 2, 0])
    const foliage = new THREE.Mesh(
      new THREE.SphereGeometry(Math.min(s.width, s.depth) * 0.42, 10, 8),
      material('plant'),
    )
    foliage.position.y = box + s.height * 0.28
    foliage.scale.y = 0.8
    foliage.castShadow = true
    g.add(foliage)
  },

  /** A boundary: posts with rails between them. */
  fence: (g, s, tone) => {
    const posts = Math.max(2, Math.round(s.width / 1.8) + 1)
    for (let i = 0; i < posts; i++) {
      const x = -s.width / 2 + (i * s.width) / (posts - 1)
      block(g, tone, [0.09, s.height, 0.09], [x, s.height / 2, 0])
    }
    for (const y of [s.height * 0.32, s.height * 0.72]) {
      block(g, tone, [s.width, 0.07, 0.045], [0, y, 0])
    }
  },
}

/**
 * Build one placed object, positioned and rotated in world space.
 *
 * Returns null for objects that have no geometry — an `opening` is a hole, and
 * the hole is cut by the wall builder, not filled by a mesh here.
 */
export function buildObject(
  object: PlacedObject,
  floorElevation: number,
  /** Where the ceiling is, for objects that hang from it. 3 m is WALL_DEFAULTS'. */
  ceilingHeight = 3.0,
): THREE.Group | null {
  const item: CatalogueItem | undefined = itemById(object.item)
  if (!item) return null

  const builder = BUILDERS[item.shape]
  if (!builder) return null

  const group = new THREE.Group()
  group.name = `object:${object.id}`

  const size = sizeOf(object)
  builder(group, size, item.tone ?? 'fabric')
  if (group.children.length === 0) return null

  // Tag, do not load. Building geometry is synchronous and must stay that way
  // — the plan is rebuilt on every wall drag, and an await in that path would
  // make the 2D and 3D views disagree for a frame on every edit. The tag is
  // enough for `upgradeModels` to come along afterwards and swap it.
  //
  // A per-placement `customUrl` wins over the catalogue's own model, which is
  // what makes "use this exact sofa here" possible without a catalogue entry.
  const modelUrl = object.customUrl ?? item.model?.url
  if (modelUrl) {
    group.userData.modelUrl = modelUrl
    group.userData.modelSize = size
    // Only meaningful for a catalogue model. A per-placement `customUrl` is
    // somebody else's file and the catalogue has no idea which way it faces.
    group.userData.modelYaw = object.customUrl ? 0 : (item.model?.yaw ?? 0)
    // An uploaded model gets the glTF default. The catalogue records the truth
    // per asset, because a great many exports are Z-up and nothing in the file
    // says which.
    group.userData.modelUpAxis = object.customUrl ? 'y' : (item.model?.upAxis ?? 'y')
    // Per-axis footprint fill, only where the catalogue asserts its dims are
    // real measurements (see AssetModel.fitFootprint). Never for uploads: a
    // stranger's file makes no such claim.
    group.userData.modelFitFootprint = object.customUrl
      ? false
      : Boolean(item.model?.fitFootprint)
  }

  /**
   * plan (x, y) -> world (x, elevation, -y), the same mapping walls use.
   *
   * ── Ceiling objects hang from the top, not the bottom ────────────────────
   * `elevationOf` for a ceiling item is a DROP BELOW THE CEILING — the type
   * says so — but this used to add it to the floor line like every other
   * placement. A pendant with a 0.4 m drop sat at y = 0.4 in the middle of the
   * room's air, and a flush ceiling light (drop 0) sat at y = 0, INSIDE the
   * 120 mm floor slab — invisible, in every editor view and every published
   * walkthrough, with nothing anywhere reporting it.
   */
  const y =
    item?.placement === 'ceiling'
      ? floorElevation + ceilingHeight - elevationOf(object)
      : floorElevation + elevationOf(object)
  group.position.set(object.position.x, y, -object.position.y)
  group.rotation.y = -object.rotation

  return group
}

/** Every object on a floor, as one group. */
export function buildObjects(
  objects: PlacedObject[],
  floorElevation: number,
  ceilingHeight = 3.0,
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'objects'

  for (const object of objects) {
    const built = buildObject(object, floorElevation, ceilingHeight)
    if (built) group.add(built)
  }

  return group
}

export const hasShape = (shape: string): boolean => shape in BUILDERS
