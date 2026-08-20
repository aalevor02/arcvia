import type { PlacedObject } from '../catalogue/types'

/**
 * The floor-plan data model.
 *
 * ── Why a graph and not a list of rooms ─────────────────────────────────────
 * The tempting model is `rooms: Polygon[]`. It is wrong, and it fails on the
 * first thing anyone does: two rooms share a wall. Store polygons and that wall
 * exists twice, so dragging it moves one copy and opens a gap. Every editor
 * that starts this way ends up bolting on a "merge coincident edges" pass that
 * never quite works.
 *
 * So walls are the primitive, and rooms are *derived* — the minimal cycles of
 * the graph, recomputed whenever the graph changes (see `rooms.ts`). A shared
 * wall is one edge belonging to two faces, which is what it physically is.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * Everything here is **metres**, always, with no exceptions. Display in feet
 * and inches is a formatting concern and lives in `lib/format.ts`.
 *
 * Storing display units is how you end up with a model that is 3.28× too big
 * after a round-trip, and it makes every downstream consumer — Three.js,
 * Blender, the BOQ — carry a conversion it should never have needed. Metres in
 * the model, imperial at the edge.
 */

export interface Vec2 {
  x: number
  y: number
}

export interface Vertex extends Vec2 {
  id: string
}

export interface Wall {
  id: string
  /** Vertex ids. Order defines the wall's own direction, nothing more. */
  a: string
  b: string
  /** Metres. Interior partitions are thinner than external walls. */
  thickness: number
  /** Metres, floor to ceiling. */
  height: number
}

/**
 * A derived room. Never stored — recomputed from the graph.
 *
 * `id` is deterministic (built from the sorted vertex ids of the cycle) so that
 * a name typed into a room survives a recompute as long as the cycle itself is
 * unchanged. Without that, every wall edit anywhere on the floor would rename
 * every room back to "Room 1".
 */
export interface Room {
  id: string
  /** Vertex ids in counter-clockwise order. */
  loop: string[]
  polygon: Vec2[]
  /** Square metres. */
  area: number
  /** Label anchor — the polygon's centroid, or a point inside it if concave. */
  label: Vec2
}

export interface Floor {
  id: string
  name: string
  /** Metres above datum. Floor 0 is 0. */
  elevation: number
  vertices: Record<string, Vertex>
  walls: Record<string, Wall>
  /** User-supplied room names, keyed by the derived room id. */
  roomNames: Record<string, string>
  /**
   * Furniture, fittings, doors and windows placed on this floor.
   *
   * Stored, unlike rooms — an object has an identity and properties a user set,
   * so there is nothing to derive it from. Keyed by id for the same reason
   * walls are: everything that references one references it by id.
   */
  objects: Record<string, PlacedObject>
  /** Optional traced floor-plan image sitting under the drawing. */
  underlay: Underlay | null
}

/**
 * A scanned drawing sitting under the plan, to trace over.
 *
 * `scale` is the whole problem. An uploaded image is a grid of pixels with no
 * idea how big anything on it is, so until someone says "this line is 3.6 m"
 * the drawing is unmeasurable. Everything else here exists to make that one
 * number correctable without redrawing.
 */
export interface Underlay {
  url: string
  /** The image's own pixel dimensions, so layout needs no decode first. */
  width: number
  height: number
  /** Metres. Where the image's top-left corner sits in world space. */
  origin: Vec2
  /** Metres per image pixel — set by the calibration tool. */
  scale: number
  opacity: number
  /**
   * Invert the image when drawing it.
   *
   * Defaults to true, and the reason is the canvas it lands on. Architectural
   * drawings are near-black lines on white; the editor is a dark surface. Drawn
   * as-is at any usable opacity the paper washes the whole viewport out and the
   * lines — the only part anyone cares about — end up the lowest-contrast thing
   * on screen. Inverted, the paper falls away to near-black and the lines come
   * through pale, which is exactly what a tracing reference should look like.
   *
   * A toggle rather than a fixed behaviour, because a plan exported white-on-
   * black is already right and inverting it would undo that.
   */
  invert: boolean
  /**
   * Locked underlays ignore drags.
   *
   * Defaults to true. Tracing means clicking directly on top of the image, and
   * an unlocked one would be dragged out of alignment by the first stray
   * movement — after which every wall already traced is wrong relative to it.
   */
  locked: boolean
}

export interface Plan {
  /** Bumped whenever the persisted shape changes incompatibly. */
  version: 1
  floors: Floor[]
  /** Which floor the editor is currently showing. */
  activeFloorId: string
}

// ---- Defaults --------------------------------------------------------------

/**
 * Wall defaults, in metres.
 *
 * 230 mm and 115 mm are the real thicknesses of a nine-inch and a four-and-a-
 * half-inch brick wall, which is what almost every plan this tool will see is
 * actually drawn to. Defaulting to a round 200 mm would make every plan subtly
 * wrong in a way nobody notices until the BOQ is priced.
 */
export const WALL_DEFAULTS = {
  exterior: { thickness: 0.23, height: 3.0 },
  interior: { thickness: 0.115, height: 3.0 },
} as const

/** Rooms smaller than this are traversal artefacts, not rooms. */
export const MIN_ROOM_AREA = 0.5 // m²
