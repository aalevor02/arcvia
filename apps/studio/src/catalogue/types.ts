import type { Vec2 } from '../plan/types'

/**
 * The furniture catalogue and the objects placed from it.
 *
 * ── Why the geometry is parametric and not a library of models ──────────────
 * The reference product ships hundreds of GLB files on a CDN, in 59 categories.
 * That library is real work and real money, and it is not something this
 * codebase can invent.
 *
 * What it *can* do is note which half of the value lives where. For space
 * planning — does the sofa fit, can the door swing, is there a metre to walk
 * past the bed — what matters is that the object is the right size in the right
 * place. Photoreal meshes matter for the client-facing render, later.
 *
 * So the catalogue is defined as dimensions plus a small builder function, and
 * `customUrl` is the seam where a real GLB replaces the stand-in without
 * anything else changing.
 */

/**
 * How an object attaches to the building.
 *
 * This is the reference's taxonomy and it is the right one, because it decides
 * placement, snapping and what the object does to the wall it lands on:
 *
 *   floor    sits on the floor, free position
 *   wall     hangs on a wall face, rotates to it (a TV, a painting)
 *   in-wall  occupies a hole through the wall (a door, a window)
 *   ceiling  hangs from the ceiling at a given drop
 */
export type Placement = 'floor' | 'wall' | 'in-wall' | 'ceiling'

export interface Size {
  /** Metres, along the object's local X — its width as you face it. */
  width: number
  /** Metres, along local Z — how far it projects from a wall. */
  depth: number
  /** Metres, vertical. */
  height: number
}

export interface CatalogueItem {
  id: string
  name: string
  category: string
  placement: Placement
  size: Size
  /**
   * Height above floor level, for wall and ceiling objects. Metres.
   * For `ceiling` this is a drop *below* the ceiling instead.
   */
  mountHeight?: number
  /** Which builder in `build.ts` draws it. */
  shape: string
  /** Rough palette hint, so a room does not come out uniformly grey. */
  tone?: 'wood' | 'fabric' | 'metal' | 'stone' | 'glass' | 'plant' | 'white'
  /** Shown in the picker when the difference between two items is not obvious. */
  note?: string
}

/** An instance of a catalogue item, placed on a floor. */
export interface PlacedObject {
  id: string
  /** Catalogue item id. */
  item: string
  /** Plan coordinates, metres — the object's centre. */
  position: Vec2
  /**
   * Rotation about the vertical axis, radians, counter-clockwise from +X.
   *
   * Stored rather than derived even for wall-mounted objects, which are
   * *initially* aligned to their wall. Deriving it would silently re-orient
   * everything hung on a wall the moment that wall is dragged, which is not
   * what someone who nudged a painting into place expects.
   */
  rotation: number
  /** Overrides the catalogue size when the user has resized it. */
  size?: Size
  /** Metres above this floor's level. Defaults to the item's mountHeight. */
  elevation?: number
  /** Wall this is attached to, for `wall` and `in-wall` placements. */
  wallId?: string
  /** Replaces the parametric shape with an uploaded model. */
  customUrl?: string
  /** User-facing name, if renamed. */
  label?: string
}

/** Doors and windows carry a little more state than other objects. */
export interface OpeningOptions {
  /** Which side the hinge is on, looking through the opening. */
  hinge?: 'left' | 'right'
  /** Degrees the leaf stands open, for the plan symbol and the 3D. */
  swing?: number
}

export interface PlacedOpening extends PlacedObject, OpeningOptions {}
