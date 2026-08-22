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
  /**
   * Which build-up this is, from `WALL_TYPES`.
   *
   * ── Why the type does not keep owning the thickness ───────────────────────
   * Choosing a type SETS the thickness, because that is the point of naming
   * one. It does not keep owning it: a drawing routinely has a 230 mm wall
   * measured at 240 where it was rendered both sides, and a model that snapped
   * it back every time would be arguing with the survey.
   *
   * So thickness stays the measured truth and the type says what the wall is
   * MADE OF — which is what the material, and later the bill of quantities,
   * need. Absent means plastered masonry, which is what every wall was before
   * this existed.
   */
  type?: WallTypeId
}

/**
 * Named wall build-ups.
 *
 * ── Why these thicknesses ─────────────────────────────────────────────────
 * Indian residential practice, which is the market this is built for. A nine-
 * inch brick wall is 230 mm and a four-and-a-half is 115 mm — the two numbers
 * almost every plan this tool sees is drawn to, and the reason `WALL_DEFAULTS`
 * already used them. An AAC block is 200 mm because that is the unit, and an
 * RCC shear wall is 150 mm.
 *
 * Round numbers are avoided for the reason the furniture avoids them: a tidy
 * 200 mm default would make every masonry quantity subtly wrong in a way nobody
 * notices until it is priced.
 */
export type WallTypeId =
  | 'brick-230'
  | 'brick-115'
  | 'block-200'
  | 'rcc-150'
  | 'brick-exposed'
  | 'concrete-fair'
  | 'glazed'

export interface WallType {
  id: WallTypeId
  name: string
  /** Metres. Applied when the type is chosen, then left alone. */
  thickness: number
  /** Which surface the faces are drawn with. */
  surface: 'wall' | 'brick' | 'concrete' | 'glass'
  note: string
}

export const WALL_TYPES: readonly WallType[] = [
  {
    id: 'brick-230',
    name: 'Brick, 230 mm',
    thickness: 0.23,
    surface: 'wall',
    note: 'Nine-inch external wall, plastered both sides.',
  },
  {
    id: 'brick-115',
    name: 'Brick, 115 mm',
    thickness: 0.115,
    surface: 'wall',
    note: 'Four-and-a-half inch internal partition.',
  },
  {
    id: 'block-200',
    name: 'AAC block, 200 mm',
    thickness: 0.2,
    surface: 'wall',
    note: 'Lighter than brick, used where the frame carries the load.',
  },
  {
    id: 'rcc-150',
    name: 'RCC, 150 mm',
    thickness: 0.15,
    surface: 'concrete',
    note: 'Structural — a shear wall or a lift shaft, not a partition.',
  },
  {
    id: 'brick-exposed',
    name: 'Exposed brick, 230 mm',
    thickness: 0.23,
    surface: 'brick',
    note: 'Left unplastered as a finish.',
  },
  {
    id: 'concrete-fair',
    name: 'Fair-faced concrete, 200 mm',
    thickness: 0.2,
    surface: 'concrete',
    note: 'Cast and left as struck.',
  },
  {
    id: 'glazed',
    name: 'Glazed partition, 50 mm',
    thickness: 0.05,
    surface: 'glass',
    note: 'A glass screen — divides the plan without dividing the light.',
  },
]

export const wallTypeById = (id: WallTypeId | undefined): WallType | undefined =>
  id ? WALL_TYPES.find((type) => type.id === id) : undefined

/**
 * What a floor is finished in.
 *
 * ── Why these six ──────────────────────────────────────────────────────────
 * They are the surfaces a residential drawing actually distinguishes between,
 * and no more. Timber and tile cover most of the inside; stone is the counter-
 * and-sill material that also appears as a floor in an entrance; concrete is a
 * finish in its own right and the honest answer for a garage or a service yard;
 * paving and grass are what the more-than-half of a site that is outdoors is
 * made of.
 *
 * Deliberately not one entry per product. A finish picker with forty options is
 * a specification tool, and this is a plan — the question it answers is "is this
 * room tiled or timber", which changes how the room reads and what it costs.
 */
export type FloorFinish =
  | 'floor-wood'
  | 'floor-tile'
  | 'stone'
  | 'concrete'
  | 'paving'
  | 'grass'

export const FLOOR_FINISHES: readonly { id: FloorFinish; name: string }[] = [
  { id: 'floor-wood', name: 'Timber' },
  { id: 'floor-tile', name: 'Tile' },
  { id: 'stone', name: 'Stone' },
  { id: 'concrete', name: 'Concrete' },
  { id: 'paving', name: 'Paving' },
  { id: 'grass', name: 'Grass' },
]

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
   * Floor finish per room, keyed by the derived room id.
   *
   * ── Why per room and not per floor ────────────────────────────────────────
   * The finish was one setting for the whole scene, so a plan could be entirely
   * timber or entirely tiled and nothing in between. Every real dwelling mixes
   * them — a tiled bathroom off a timber bedroom is the normal case, not an
   * edge one — and the room is the unit people choose a finish for.
   *
   * Keyed the same way `roomNames` is, and for the same reason stated there: a
   * room is derived from the wall graph and has no identity of its own, so
   * anything a person attaches to one is stored against the hash of its cycle.
   * Edit an unrelated wall and the hash is unchanged, so the finish stays put.
   *
   * Absent means the floor's default, which is what every room had before this.
   */
  roomFinishes?: Record<string, FloorFinish>
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
  /**
   * Whether the scale is known rather than assumed.
   *
   * Exists so the reader can set the scale from the sizes printed on the
   * drawing without ever overriding a person. An architect who has calibrated
   * against a dimension they trust has said something; silently replacing it
   * with a number read by OCR would be the software disagreeing with its user
   * about a fact the user is better placed to know.
   */
  calibrated?: boolean
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
