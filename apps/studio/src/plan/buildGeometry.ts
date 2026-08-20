import * as THREE from 'three'
import type { Floor, Vec2 } from './types'
import { detectRooms } from './rooms'
import { distance, dot, normalise, sub } from './geometry'
import { buildObjects } from '../catalogue/build'
import { itemById } from '../catalogue/items'
import { elevationOf, sizeOf } from '../catalogue/placement'
import type { PlacedObject } from '../catalogue/types'

/**
 * Extrude a floor plan into Three.js meshes.
 *
 * ── Axes ────────────────────────────────────────────────────────────────────
 * The plan is 2D in metres with Y pointing north. Three.js is Y-up, so the
 * mapping is `plan (x, y)` → `world (x, elevation, -y)`. The negation keeps the
 * handedness right: without it the 3D preview is a mirror image of the plan and
 * every door ends up on the wrong side.
 *
 * This is the *second* axis conversion in the codebase — the first is
 * `toBlenderVec()` in the render API, for Blender's Z-up. They are unrelated
 * and must stay separate; conflating them is how a render comes back rotated.
 *
 * ── Why walls are boxes and not an extruded outline ─────────────────────────
 * A proper solution insets the wall polygons and mitres the corners, which is
 * real work and needs a robust offsetting library. A box per wall segment,
 * centred on the graph edge and overlapping slightly at the joints, is
 * geometrically wrong at every corner by half a wall thickness — and completely
 * invisible in a preview. When this becomes a *deliverable* model rather than a
 * preview, that is the moment to do it properly.
 */

export interface BuildOptions {
  /** Metres. Slab under each detected room. */
  slabThickness?: number
  /** Draw a ceiling slab as well. Off by default — you cannot see in. */
  ceilings?: boolean
}

export function buildFloorGeometry(
  floor: Floor,
  options: BuildOptions = {},
): THREE.Group {
  const { slabThickness = 0.12, ceilings = false } = options

  const group = new THREE.Group()
  group.name = `floor:${floor.id}`

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8dde5,
    roughness: 0.92,
    metalness: 0,
  })
  const slabMaterial = new THREE.MeshStandardMaterial({
    color: 0x9aa4b2,
    roughness: 0.95,
    metalness: 0,
  })

  // ---- Walls ---------------------------------------------------------------
  const objects = Object.values(floor.objects ?? {})

  for (const wall of Object.values(floor.walls)) {
    const a = floor.vertices[wall.a]
    const b = floor.vertices[wall.b]
    if (!a || !b) continue

    const length = distance(a, b)
    if (length < 1e-4) continue

    const bearing = -Math.atan2(b.y - a.y, b.x - a.x)
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }

    // Where along this wall each opening sits, as a span plus a height band.
    const holes = openingsIn(wall.id, objects, a, b, length)

    for (const piece of solidPieces(wall.height, length, holes)) {
      const geometry = new THREE.BoxGeometry(piece.length, piece.height, wall.thickness)
      const mesh = new THREE.Mesh(geometry, wallMaterial)

      // Pieces are positioned along the wall's own axis, then the whole thing
      // is placed and rotated as before.
      const alongOffset = piece.centre - length / 2
      mesh.position.set(
        midpoint.x + Math.cos(-bearing) * alongOffset,
        floor.elevation + piece.bottom + piece.height / 2,
        -midpoint.y + Math.sin(-bearing) * alongOffset * -1,
      )
      mesh.rotation.y = bearing
      mesh.name = `wall:${wall.id}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }

  // ---- Floor slabs ---------------------------------------------------------
  // One per detected room rather than a single big rectangle, so a plan with a
  // courtyard or an L-shaped footprint does not get floor where there is none.
  for (const room of detectRooms(floor)) {
    const shape = new THREE.Shape()
    room.polygon.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, p.y)
      else shape.lineTo(p.x, p.y)
    })
    shape.closePath()

    const slab = extrudedSlab(shape, slabThickness, slabMaterial)
    slab.position.y = floor.elevation - slabThickness
    slab.name = `slab:${room.id}`
    group.add(slab)

    if (ceilings) {
      const height = averageWallHeight(floor)
      const ceiling = extrudedSlab(shape, slabThickness, slabMaterial)
      ceiling.position.y = floor.elevation + height
      ceiling.name = `ceiling:${room.id}`
      group.add(ceiling)
    }
  }

  // ---- Furniture and fittings ----------------------------------------------
  const furniture = buildObjects(objects, floor.elevation)
  if (furniture.children.length > 0) group.add(furniture)

  return group
}

/**
 * Openings cut into one wall, expressed along its length.
 *
 * The object stores a world position; what the wall builder needs is how far
 * along its own run that lands. Projecting onto the wall direction gives it.
 */
function openingsIn(
  wallId: string,
  objects: PlacedObject[],
  a: Vec2,
  b: Vec2,
  length: number,
): Hole[] {
  const direction = normalise(sub(b, a))

  return objects
    .filter((object) => object.wallId === wallId)
    .filter((object) => itemById(object.item)?.placement === 'in-wall')
    .map((object) => {
      const size = sizeOf(object)
      const along = dot(sub(object.position, a), direction)
      const bottom = elevationOf(object)

      return {
        from: Math.max(0, along - size.width / 2),
        to: Math.min(length, along + size.width / 2),
        bottom,
        top: bottom + size.height,
      }
    })
    .filter((hole) => hole.to > hole.from)
    .sort((p, q) => p.from - q.from)
}

interface Hole {
  from: number
  to: number
  bottom: number
  top: number
}

interface Piece {
  centre: number
  length: number
  bottom: number
  height: number
}

/**
 * Cut a wall into the solid pieces left around its openings.
 *
 * ── Why this and not CSG ────────────────────────────────────────────────────
 * The reference runs a real CSG subtraction, and its own code comments record
 * three separate fallbacks for when that fails. For a rectangular hole in a
 * straight wall, CSG is a large hammer: the result is always the same handful
 * of boxes — full-height pier, pier, lintel over the opening, sill under it —
 * and boxes are exact, fast and cannot fail.
 *
 * CSG earns its keep on arched or angled openings. When those exist, it can be
 * added for those cases only.
 */
function solidPieces(wallHeight: number, length: number, holes: Hole[]): Piece[] {
  if (holes.length === 0) {
    return [{ centre: length / 2, length, bottom: 0, height: wallHeight }]
  }

  const pieces: Piece[] = []
  let cursor = 0

  for (const hole of holes) {
    // Overlapping openings would otherwise produce a negative-length pier.
    const from = Math.max(cursor, hole.from)
    const to = Math.max(from, hole.to)

    if (from > cursor) {
      pieces.push({
        centre: (cursor + from) / 2,
        length: from - cursor,
        bottom: 0,
        height: wallHeight,
      })
    }

    const width = to - from
    if (width > 1e-4) {
      // Sill below the opening — a window has one, a door does not.
      if (hole.bottom > 1e-4) {
        pieces.push({ centre: (from + to) / 2, length: width, bottom: 0, height: hole.bottom })
      }
      // Lintel above it.
      const above = wallHeight - hole.top
      if (above > 1e-4) {
        pieces.push({ centre: (from + to) / 2, length: width, bottom: hole.top, height: above })
      }
    }

    cursor = to
  }

  if (cursor < length) {
    pieces.push({
      centre: (cursor + length) / 2,
      length: length - cursor,
      bottom: 0,
      height: wallHeight,
    })
  }

  return pieces.filter((piece) => piece.length > 1e-4 && piece.height > 1e-4)
}

/** Build a whole plan — every floor, stacked at its elevation. */
export function buildPlanGeometry(floors: Floor[], options?: BuildOptions): THREE.Group {
  const group = new THREE.Group()
  group.name = 'plan'
  for (const floor of floors) group.add(buildFloorGeometry(floor, options))
  return group
}

/**
 * Extrude a 2D shape into a slab lying in the XZ plane.
 *
 * ExtrudeGeometry pushes along +Z, so the result is stood up by rotating -90°
 * about X. That also flips the plan's Y into world -Z, which is exactly the
 * axis mapping described at the top of this file — so the slab lands in the
 * same frame as the walls without a second conversion.
 */
function extrudedSlab(
  shape: THREE.Shape,
  thickness: number,
  material: THREE.Material,
): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)

  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  return mesh
}

function averageWallHeight(floor: Floor): number {
  const walls = Object.values(floor.walls)
  if (walls.length === 0) return 3
  return walls.reduce((sum, w) => sum + w.height, 0) / walls.length
}

/**
 * Where to stand a first-person camera when entering the 3D view.
 *
 * The centre of the largest room at eye height, looking at the plan's middle.
 * Dropping the camera at the world origin instead means it is usually outside
 * the building, or inside a wall.
 */
export function suggestedCamera(floor: Floor): { position: Vec2; height: number } | null {
  const rooms = detectRooms(floor)
  if (rooms.length === 0) return null
  return { position: rooms[0].label, height: floor.elevation + 1.6 }
}
