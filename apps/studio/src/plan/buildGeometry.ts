import * as THREE from 'three'
import { wallTypeById } from './types'
import type { Floor, Vec2, WallTypeId } from './types'
import { detectRooms } from './rooms'
import { distance, dot, normalise, sub } from './geometry'
import { buildObjects } from '../catalogue/build'
import { itemById } from '../catalogue/items'
import { elevationOf, sizeOf } from '../catalogue/placement'
import type { PlacedObject } from '../catalogue/types'
import { surface } from './materials'

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
  /** Floor finish. Per-room finishes are a materials-editor feature; this is
   *  the whole-floor default until that exists. */
  floorFinish?: 'floor-wood' | 'floor-tile'
  /** Skirting boards around each room. On by default — see the build. */
  skirting?: boolean
}

/** Metres. A standard domestic skirting: 100 mm tall, 18 mm proud of the wall. */
const SKIRTING_HEIGHT = 0.1
const SKIRTING_PROUD = 0.018

export function buildFloorGeometry(
  floor: Floor,
  options: BuildOptions = {},
): THREE.Group {
  const {
    slabThickness = 0.12,
    ceilings = false,
    floorFinish = 'floor-wood',
    skirting = true,
  } = options

  const group = new THREE.Group()
  group.name = `floor:${floor.id}`

  // Shared, textured materials rather than a flat colour per build. See
  // materials.ts: untextured geometry reads as a diagram however well it is lit.
  const wallMaterial = surface('wall')

  /**
   * The material for one wall, from its build-up.
   *
   * Looked up per wall rather than once for the floor: a plan routinely mixes a
   * plastered external skin, an exposed brick feature and a glazed screen, and
   * drawing all three as plaster is the state this replaces. `surface()` caches
   * one material per kind, so a floor with fifty walls of three types still
   * compiles three shaders.
   */
  const materialFor = (wall: { type?: WallTypeId }) =>
    surface(wallTypeById(wall.type)?.surface ?? 'wall')
  const slabMaterial = surface(floorFinish)
  const ceilingMaterial = surface('ceiling')
  // Painted timber, not the floor finish: skirting that matches the floor
  // exactly disappears into it, which defeats the point of having it.
  const skirtingMaterial = surface('ceiling')

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
      const mesh = new THREE.Mesh(geometry, materialFor(wall))

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

  // ---- Corner posts --------------------------------------------------------
  // Walls are boxes centred on their graph edge, so where two meet they overlap
  // in the middle and leave a wedge of nothing on the outside of the corner —
  // a visible notch of daylight in every external corner of the building.
  //
  // A square post at each vertex, as thick as the fattest wall arriving there,
  // fills it. Deliberately not solved by lengthening the walls: the opening
  // positions are measured along the wall's true length, and stretching the
  // geometry would silently shift every door and window along it.
  for (const post of cornerPosts(floor)) {
    const geometry = new THREE.BoxGeometry(post.size, post.height, post.size)
    const mesh = new THREE.Mesh(geometry, wallMaterial)
    mesh.position.set(post.at.x, floor.elevation + post.height / 2, -post.at.y)
    mesh.rotation.y = post.bearing
    mesh.name = `corner:${post.vertexId}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
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
      const ceiling = extrudedSlab(shape, slabThickness, ceilingMaterial)
      ceiling.position.y = floor.elevation + height
      ceiling.name = `ceiling:${room.id}`
      group.add(ceiling)
    }

    // ---- Skirting ----------------------------------------------------------
    // A hundred millimetres of timber where the wall meets the floor.
    //
    // Small, and the single most effective piece of detail in the whole model.
    // Every real room has one, and a wall meeting a floor at a perfectly clean
    // line is something the eye reads as *wrong* long before it can say why —
    // it is the same tell as a corner with no shadow in it. It also gives the
    // junction an edge for light to catch, so the room stops looking like it
    // was folded out of paper.
    if (skirting) {
      for (const run of skirtingRuns(floor, room.polygon, room.loop)) {
        const geometry = new THREE.BoxGeometry(run.length, SKIRTING_HEIGHT, SKIRTING_PROUD)
        const mesh = new THREE.Mesh(geometry, skirtingMaterial)
        mesh.position.set(run.centre.x, floor.elevation + SKIRTING_HEIGHT / 2, -run.centre.y)
        mesh.rotation.y = run.bearing
        mesh.name = `skirting:${room.id}`
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
      }
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
 * A square post at every vertex where walls meet, filling the corner notch.
 *
 * Sized to the thickest wall arriving, and turned to that wall's bearing, so a
 * 230 mm external corner gets a 230 mm post aligned with the wall rather than
 * with the world — an axis-aligned post on a wall running at 30° would stick
 * out of both faces.
 *
 * Vertices with a single wall are skipped: there is no corner there, and a post
 * would just be a lump on the end of a wall.
 */
function cornerPosts(floor: Floor): {
  vertexId: string
  at: Vec2
  size: number
  height: number
  bearing: number
}[] {
  const meeting = new Map<string, { thickness: number; height: number; bearing: number }[]>()

  for (const wall of Object.values(floor.walls)) {
    const a = floor.vertices[wall.a]
    const b = floor.vertices[wall.b]
    if (!a || !b || distance(a, b) < 1e-4) continue

    const bearing = -Math.atan2(b.y - a.y, b.x - a.x)
    for (const id of [wall.a, wall.b]) {
      const list = meeting.get(id) ?? []
      list.push({ thickness: wall.thickness, height: wall.height, bearing })
      meeting.set(id, list)
    }
  }

  const posts = []
  for (const [vertexId, walls] of meeting) {
    if (walls.length < 2) continue

    const vertex = floor.vertices[vertexId]
    if (!vertex) continue

    // The fattest wall decides the post. Anything smaller leaves part of the
    // notch open, which is the whole failure being fixed.
    const fattest = walls.reduce((widest, w) => (w.thickness > widest.thickness ? w : widest))

    posts.push({
      vertexId,
      at: { x: vertex.x, y: vertex.y },
      size: fattest.thickness,
      // The tallest, for the same reason: a short post under a tall wall
      // leaves a gap at the top of the corner instead of the bottom.
      height: Math.max(...walls.map((w) => w.height)),
      bearing: fattest.bearing,
    })
  }

  return posts
}

/**
 * Where skirting runs along one room's walls, and how long each length is.
 *
 * The room polygon follows wall *centrelines*, so the visible face of the wall
 * is half a thickness inboard of it — and the skirting sits against that face,
 * proud by its own depth again. Getting this offset wrong is not subtle: the
 * skirting either floats in the middle of the room or is buried in the wall.
 *
 * Rooms come out of `detectRooms` counter-clockwise, so the interior is always
 * to the left of each directed edge and the inward normal is the same rotation
 * every time. That is a property worth relying on — the alternative is a
 * point-in-polygon test per edge.
 */
function skirtingRuns(
  floor: Floor,
  polygon: Vec2[],
  loop: string[],
): { centre: Vec2; length: number; bearing: number }[] {
  const runs = []

  for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i]
    const to = polygon[(i + 1) % polygon.length]

    const length = distance(from, to)
    if (length < 1e-4) continue

    const direction = normalise(sub(to, from))
    // Left of the direction of travel, which for a counter-clockwise loop is
    // into the room.
    const inward = { x: -direction.y, y: direction.x }

    const thickness = wallBetween(floor, loop[i], loop[(i + 1) % loop.length])
    const offset = thickness / 2 + SKIRTING_PROUD / 2

    runs.push({
      centre: {
        x: (from.x + to.x) / 2 + inward.x * offset,
        y: (from.y + to.y) / 2 + inward.y * offset,
      },
      // Shortened by a thickness so two runs meeting at a corner stop against
      // each other's faces instead of crossing through them. Overlapping
      // skirting produces a bright z-fighting seam exactly at eye-catching
      // corner height.
      length: Math.max(length - thickness, 0.01),
      bearing: -Math.atan2(to.y - from.y, to.x - from.x),
    })
  }

  return runs
}

/** The thickness of the wall joining two vertices, or a sane default. */
function wallBetween(floor: Floor, a: string, b: string): number {
  const wall = Object.values(floor.walls).find(
    (w) => (w.a === a && w.b === b) || (w.a === b && w.b === a),
  )
  // A room edge with no wall behind it should not happen — rooms are derived
  // from walls — but a default beats a NaN offset that puts the skirting
  // somewhere unrenderable.
  return wall?.thickness ?? 0.115
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

  // ExtrudeGeometry's default UVs are the shape's own coordinates, which are in
  // metres here. That is exactly what a tiled floor wants: the material sets
  // texture.repeat in tiles-per-metre and the grain comes out the same size in
  // every room, whatever the room's dimensions.

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
