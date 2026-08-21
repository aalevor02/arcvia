// packages/building-model/src/schema.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTRACT. Everything in the engine produces one of these or consumes one.
//
// UNITS: metres. ANGLES: radians. AXES: +Z up, plan XY == world XY.
// The Three.js flip (plan x,y -> world x, elevation, -y) stays where it already
// lives, in apps/studio/src/plan/buildGeometry.ts:14. The Blender flip stays in
// services/api/src/routes/render.js:320 toBlenderVec. This file NEVER converts:
// a render that comes back rotated 90 degrees is always a third conversion site.
//
// Mirrored 1:1 into services/reconstruct/model/types.py by
// datamodel-code-generator from packages/building-model/schema/building-1.json,
// which ts-json-schema-generator emits from this file. The generated Python is
// CHECKED IN, so drift is a reviewable diff and not a runtime KeyError.
//
// SCOPE RULE (learned from a rival design that priced a schema ahead of its
// extractors): every element type below has a named fabricator in section 4.
// Beam, Ramp, Grid, multi-layer Assembly, pitched/hipped Roof forms and
// IfcRelSpaceBoundary are DELIBERATELY ABSENT from v1. Nothing can fill them.
// ─────────────────────────────────────────────────────────────────────────────

export type Id = string
/** Derived from provenance so a re-import diffs instead of duplicating:
 *  'w:dxf:LATEST#2F3A' | 'w:pair:s3-f0-0117' | 'op:blk:D750#41' | 'w:plan:v12-v13' */

export type M = number      // metres
export type Rad = number    // radians
export type P2 = [M, M]

export type Unit = 'm' | 'mm' | 'cm' | 'in' | 'ft'
export type SourceKind =
  | 'dwg' | 'dxf' | 'pdf-vector' | 'pdf-raster' | 'raster' | 'ifc' | 'human'

// ── CURVES ───────────────────────────────────────────────────────────────────
/** A baseline. Arcs stay arcs; chording is a BUILD-time choice at a stated
 *  sagitta, never a READ-time loss. cad.py:200 skips ARC today only because it
 *  had nowhere to put one. LWPOLYLINE bulges MUST be read with
 *  e.get_points('xyb') — get_points('xy') is the single commonest way a curved
 *  wall silently becomes a straight one. */
export interface Curve2 { start: P2; spans: Span[]; closed?: boolean }
export type Span =
  | { to: P2 }                                       // straight
  | { to: P2; bulge: number }                        // DXF bulge = tan(theta/4), verbatim
  | { to: P2; r: M; large: boolean; ccw: boolean }   // SVG form, for PDF/raster arcs

// ── PROVENANCE AND BELIEF ────────────────────────────────────────────────────
export type Emitter =
  | 'facePair' | 'perimeterTrace' | 'blockSized' | 'blockHint'
  | 'rasterGap' | 'rasterRegion' | 'dimension' | 'mtext' | 'ocr'
  | 'openingCluster' | 'stackPrior' | 'ifcElement' | 'default' | 'user'

/** Where a number came from. Never optional: an element with no evidence is a
 *  bug, and the schema validator enforces evidence.length >= 1. */
export interface Evidence {
  src: Id                 // SourceRef.id
  emitter: Emitter
  weight: number          // 0..1 prior trust in THIS emitter for THIS quantity
  ref?: {
    layer?: string
    block?: string
    handle?: string       // DXF entity handle — the audit trail back to the file
    blockPath?: string[]  // ['A_UNIT','WINDOWS'] when the wall was 3 INSERTs deep
    entity?: string       // 'LWPOLYLINE'
    page?: number; index?: number       // PDF sheet coordinates
    bbox?: [number, number, number, number]   // raster source pixels
  }
}

/** A fused belief about one scalar. The disagreement is kept, not averaged. */
export interface Measured {
  value: number
  sigma: number           // metres; post-solve standard error
  evidence: Evidence[]    // >= 1, always
  residual?: number       // |value - what the solver wanted|. Drives review.
}

/** LOW MARGIN, not low score, is the ask-a-human signal. A parser that is 0.6
 *  confident and has no rival is fine; two rivals at 0.55 and 0.54 is not. */
export interface Confidence {
  score: number
  margin: number
  alternatives?: { label: string; score: number }[]
}

/** Attached to every element. `locked` and `suppressed` are what make
 *  re-importing a revised DWG safe over a drawing a human has already fixed. */
export interface Provenance {
  primary: Evidence
  confidence: Confidence
  locked: boolean         // a human decided this — a re-solve MUST NOT overwrite it
  suppressed?: boolean    // a human deleted it — a re-import MUST NOT resurrect it
}

// ── SOURCES, FRAMES, DECISIONS ───────────────────────────────────────────────
export interface SourceRef {
  id: Id
  kind: SourceKind
  storageKey: string      // storage.js key, NEVER a URL (detect.js:271 discipline)
  sha256: string
  bytes: number
  converter?: {
    tool: 'libredwg'
    version: string           // asserted >= 0.14 BEFORE the output is trusted
    modelSpaceEntities: number // the 0.13.3 detector: valid file, empty drawing
    args: string[]
  }
  page?: number
  warnings: string[]
}

/** ONE plan drawing on ONE sheet. A sheet holding four villa types yields four
 *  Frames. This stage is MANDATORY and runs before anything else touches
 *  geometry: without it, a DWG model space collapses five buildings into one
 *  wall graph and every downstream cycle is nonsense. */
export interface Frame {
  id: Id
  source: Id
  bboxSource: [number, number, number, number]   // in SOURCE units, un-shifted
  kind: 'plan' | 'section' | 'elevation' | 'detail' | 'site' | 'titleblock' | 'unknown'
  title?: string          // 'FIRST FLOOR PLAN' — from MTEXT/TEXT/OCR, never sheet position
  unitId: Id | null       // which unit type / villa this frame draws
  storeyId: Id | null
  wallLength: M           // total wall-layer linework inside the frame
  entityCount: number
}

/** cad.py:310's scaleCandidates, generalised. Offered, never auto-decided:
 *  a wrong unit builds the villa 1000x too small and looks perfectly fine. */
export interface UnitDecision {
  unit: Unit
  scale: number                    // source units * scale = metres
  posterior: Record<Unit, number>  // sums to 1
  margin: number                   // top / runner-up. < 3.0 => blocking residual
  decidedBy: 'dimension' | 'wallThickness' | 'printedRoomSize' | 'header' | 'extent' | 'user'
  candidates: { scale: number; label: string; extent: M; suggested: boolean }[]
  agreement: {                     // the cross-check that must escalate, not average
    dimension: Unit | null
    wallThickness: Unit | null
    conflict: boolean
  }
}

// ── ELEMENTS ─────────────────────────────────────────────────────────────────
export interface Vertex { id: Id; x: M; y: M; pinned?: boolean; sigma?: M }

/** An unpaired single line is a RAILING. Extrude it to ceiling height and every
 *  balcony becomes a sealed box that blacks out the rooms behind it. This is a
 *  named role with its own height, not a boolean. */
export type WallRole =
  | 'masonry' | 'partition' | 'perimeter' | 'parapet' | 'railing' | 'kerb' | 'rejected'

export interface Wall {
  id: Id
  baseline: Curve2        // CENTRELINE. Faces are derived, never stored.
  a: Id; b: Id            // endpoint Vertex ids — the planar graph handles
  align: 'centre' | 'left' | 'right'
  thickness: Measured     // MEASURED from the face gap; defaulted only when unpaired
  height: Measured        // railing 1.0; parapet from a note; masonry = storey clear
  base: { storeyId: Id; offset: M }
  role: WallRole
  paired: boolean         // two drawn faces, or one line and an assumption
  axisFamily: number | null   // index into Storey.axes; null = deliberately free-angle
  layer?: string
  stackedWith?: Id[]      // wall ids on other storeys constrained to share x,y
  openingIds: Id[]
  provenance: Provenance
}

export type OpeningKind =
  | 'door' | 'double-door' | 'window' | 'glazing' | 'opening' | 'arch'

/** HOSTED AT ARC-LENGTH along its wall's baseline, not at a world position.
 *  A world XY goes stale the instant the wall moves, and drifting doors are the
 *  first thing to break. `hinge`/`swing` live here and are read by BOTH the 2D
 *  symbol and the 3D leaf, which is the fix for build.ts:227 hard-coding
 *  pivot.rotation.y = -Math.PI * 0.42 and rendering every door left-hung. */
export interface Opening {
  id: Id
  wallId: Id | null       // null => cut as a prism through whatever is there
  along: M                // arc-length from vertex a to the opening CENTRE
  width: Measured         // D750 => 0.750 exactly, and ALSO a dimensional constraint
  sill: Measured          // above this storey's finished floor
  head: Measured          // door (0.00,2.10) window (0.90,2.25) glazing (0.05,2.45)
  kind: OpeningKind
  profile: 'rect' | 'arch' | { poly: P2[] }
  reveal: M               // jamb setback; 0 means raw pier faces
  hinge?: 'left' | 'right'
  swing?: Rad
  panels?: 1 | 2
  definitionId?: Id       // the D750 block that placed it
  provenance: Provenance
}

/** A room. Derived from the graph, but PERSISTED with its fused label so a
 *  user-typed name survives a re-solve. `id` is roomId(loop) — the rotation-
 *  invariant cycle hash from apps/studio/src/plan/rooms.ts:172. */
export interface Space {
  id: Id
  loop: Id[]              // vertex ids, CCW (signedArea > 0)
  boundary: Curve2        // FINISHED FACE, not centrelines. Real m2 an architect signs.
  holes: Curve2[]
  area: M                 // square metres. Not a fraction of a bounding box.
  name: { value: string | null; provenance: Provenance }
  kind: 'room' | 'wet' | 'circulation' | 'service' | 'outdoor' | 'shaft' | 'fitting'
  printedSize?: [M, M]    // metres as drawn — a HARD dimensional constraint
  ceiling: Measured       // LOCAL, not averageWallHeight(floor)
  /** WHICH STRETCH of which wall faces this room. This is the topology the
   *  planar graph only implies, and it is what lets skirting be cut at a
   *  doorway (buildGeometry.ts:373 currently runs straight through one). */
  boundedBy: { wallId: Id; s0: M; s1: M }[]
  derivedFrom: 'graph-cycle' | 'solid-interior-ring' | 'raster-region' | 'manual'
  alsoNamed?: string[]    // labels.py `also` — proof two spaces read as one outline
  provenance: Provenance
}

export interface Column {
  id: Id
  at: P2; yaw: Rad
  profile: 'rect' | 'round'
  size: [M, M]
  base: { storeyId: Id; offset: M }
  height: M
  provenance: Provenance
}

/** MASSING ONLY, and named so. A 2D plan carries no riser height; treads/going
 *  are not inferable without a section. We extrude the clustered footprint as a
 *  ramped solid between two storeys and tag it `massing`. */
export interface Stair {
  id: Id
  footprint: Curve2
  fromStoreyId: Id; toStoreyId: Id
  fidelity: 'massing' | 'stepped'
  width: M
  direction: P2           // unit vector of ascent
  provenance: Provenance
}

export interface Slab {
  id: Id
  outline: Curve2
  holes: Curve2[]         // stairwells, double-height voids, shafts
  thickness: M
  topOffset: M            // 0 = this storey's level IS the slab top
  function: 'floor' | 'terrace' | 'deck' | 'landing' | 'plinth'
  mode: 'contour' | 'hull' | 'rooms'   // footprint() raster-close vs <45% hull fallback
  provenance: Provenance
}

/** v1 supports flat only, plus the half-plane clip that blender_build.py:524
 *  already does. Pitched/hipped forms are absent until something extracts them. */
export interface Roof {
  id: Id
  outline: Curve2
  holes: Curve2[]
  thickness: M
  overhang: M
  form: { type: 'flat' } | { type: 'clip'; keep: { p: P2; n: P2 } }
  provenance: Provenance
}

export interface SiteFeature {
  id: Id
  feature: 'pool' | 'deck' | 'lawn' | 'path' | 'road' | 'planting' | 'compound-wall'
  outline: Curve2
  holes: Curve2[]
  depth?: M
  z?: M
  provenance: Provenance
}

/** One per block TYPE. One D750 definition, 88 instances. */
export interface Definition {
  id: Id
  name: string                 // 'D750', '3 st sofa'
  source: 'dxf-block' | 'catalogue' | 'glb'
  catalogueItem?: string       // apps/studio/src/catalogue/items.ts id, via guess_item()
  size: { width: M; depth: M; height: M }
  anchor: 'centre' | 'base-centre' | 'insert-point'
  yaw: Rad                     // AssetModel.yaw / condition_asset detect_facing()
  openingSpec?: { width: M; height: M; kind: OpeningKind }   // D750 -> 750mm door
  meshUrl?: string
  /** REQUIRED whenever meshUrl is set. Copy the CONSTRAINT from
   *  apps/studio/src/catalogue/types.ts:86 — it is what makes CC-BY compliance
   *  structurally impossible to forget. */
  licence?: { spdx: string; author: string; source: string }
}

export interface Fixture {
  id: Id
  definitionId: Id
  at: P2
  yaw: Rad                // radians CCW — exact author-placed INSERT data
  z: M                    // above this storey's floor
  size?: { width: M; depth: M; height: M }
  mirrored?: boolean      // INSERT with a negative x scale
  hostWallId?: Id
  anchor?: 'floor' | 'wall' | 'in-wall' | 'ceiling'
  customUrl?: string
  provenance: Provenance
}

// ── ANNOTATIONS: carried, then used to GRADE the model ───────────────────────
/** THE highest-leverage thing nothing in Arcvia reads today. A DIMENSION entity
 *  carries the architect's own explicit assertion of a distance plus its two
 *  definition points. It has a DUAL ROLE:
 *    (a) the unit minimising median |value - drawnDistance * scale| across all
 *        DimObs is the decisive unit estimator (weight 0.40, section 4 stage 3);
 *    (b) each one becomes a direct residual (measured - model) in the
 *        relaxation and again in the pre-GPU verify gate (stage 7). */
export interface Annotation {
  id: Id
  kind: 'text' | 'mtext' | 'dimension' | 'roomTag' | 'levelMarker' | 'title' | 'north'
  at: P2
  storeyId?: Id
  frameId?: Id
  text: string
  textHeight?: M          // metres — deck.py's size-first caption ranking
  rotation?: Rad
  measure?: {
    value: M              // the printed number, in metres
    axis: 'x' | 'y' | 'aligned' | 'radial'
    from: P2; to: P2      // DXF DIMENSION definition points
    overridden: boolean   // DIMENSION text manually edited => downweight, never trust
  }
  refersTo?: Id           // the Space this room tag names
  provenance: Provenance
}

// ── STOREYS ──────────────────────────────────────────────────────────────────
export type Axis = { theta: Rad; weight: number }   // mod pi/2. K FAMILIES, not one grid.

export interface Storey {
  id: Id
  name: string
  /** CANONICAL order from title text, never sheet y. One real sheet ascends and
   *  another descends; ordering by y stacks half the villas upside down. */
  index: number
  elevation: Measured
  floorToFloor: Measured
  slabThickness: Measured
  clearHeight: Measured
  axes: Axis[]
  frames: Id[]
  vertices: Record<Id, Vertex>
  walls: Record<Id, Wall>
  openings: Record<Id, Opening>
  spaces: Space[]
  columns: Record<Id, Column>
  slabs: Record<Id, Slab>
  roofs: Record<Id, Roof>
  fixtures: Record<Id, Fixture>
  site: Record<Id, SiteFeature>
  footprint: { outline: Curve2; area: M; mode: Slab['mode'] } | null
  /** THE MARGIN IS THE CONFIDENCE. build_villas.py:350 prints peak and runner-up;
   *  here it is data, and below 1.25x it becomes a question, never an auto-accept. */
  registration: {
    method: 'stacking' | 'maskCorrelation' | 'annotation' | 'user' | 'none'
    offset: P2
    against: Id | null
    peak: number
    runnerUp: number
    accepted: 'auto' | 'user' | 'pending'
  } | null
  reconstructed: string | null   // 'traced from brochure p7' — never shown as surveyed
}

export interface StoreyLink {
  id: Id
  kind: 'stair' | 'lift' | 'void' | 'duct' | 'atrium'
  polygon: Curve2
  fromStoreyId: Id
  toStoreyId: Id
}

// ── RESIDUE: the entire human review surface ─────────────────────────────────
export type ResidualCode =
  | 'CONVERTER_DROPPED_MODELSPACE' | 'UNIT_AMBIGUOUS' | 'UNIT_CONFLICT'
  | 'NO_FRAMES' | 'FRAME_KIND_UNKNOWN' | 'STOREY_UNREGISTERED'
  | 'OPEN_CYCLE' | 'NO_PERIMETER' | 'WALL_OR_RAILING' | 'WALL_CONFLICT'
  | 'OPENING_ORPHAN' | 'SPACE_MERGED' | 'DIM_CONFLICT' | 'DIM_AGREEMENT_LOW'
  | 'CURVE_CHORDED' | 'BLOCK_GEOMETRY_HIDDEN' | 'LAYER_UNCHOSEN'
  | 'SOLVER_DIVERGED' | 'GEOMETRY_DEGRADED' | 'UNVERIFIED'

export interface Residual {
  id: Id
  severity: 'blocking' | 'high' | 'low' | 'info'
  code: ResidualCode
  message: string          // written for an architect, not a developer
  targets: { storeyId?: Id; frameId?: Id; elementIds: Id[] }
  metric: { observed: number; expected: number; unit: string } | null
  choices?: { label: string; patch: ModelPatch }[]   // the review UI renders exactly these
}

/** The ONLY way a human edits the model. Replayed on every re-solve, so a
 *  decision is permanent and re-running after a better DXF arrives never asks
 *  the same question twice. */
export interface ModelPatch {
  op:
    | 'setUnit' | 'setLayerRole' | 'setFrameKind' | 'setWallRole' | 'setSpaceKind'
    | 'moveVertex' | 'setStoreyElevation' | 'setRegistration'
    | 'acceptAlternative' | 'suppressElement' | 'addWall' | 'nameSpace'
    | 'setOpeningKind' | 'setOpeningHinge'
  target: Id
  value: unknown
  by: 'user' | 'solver'
  at: string               // ISO. Provenance for decisions, not just for geometry.
}

// ── ROOT ─────────────────────────────────────────────────────────────────────
export interface BuildingModel {
  schema: 'arcvia.building/1'
  id: Id
  name: string
  units: 'm'               // invariant, stated so no consumer ever wonders
  up: 'z'
  status:
    | 'surveying' | 'needs-unit' | 'needs-frames' | 'needs-levels'
    | 'needs-review' | 'ready' | 'stale'
  sources: SourceRef[]
  frames: Frame[]
  unit: UnitDecision
  /** Subtracted ONCE PER SOURCE, not per frame. Shifting each frame to its own
   *  min-corner destroys exactly the relative alignment that storey
   *  registration exists to recover — the contradiction that made a rival
   *  design's registration stage unreachable. */
  sourceOrigin: Record<Id, P2>
  northAngle: Rad
  storeys: Storey[]
  storeyLinks: StoreyLink[]
  definitions: Record<Id, Definition>
  annotations: Annotation[]
  residuals: Residual[]
  patches: ModelPatch[]
  quality: {
    solved: boolean
    closedSpaceFraction: number   // spaces closed / spaces named. THE headline number.
    meanWallResidual: M
    dimAgreement: number | null   // 1 - median |dim - model| / dim. null = unverified.
    dimSamples: number
    unitMargin: number
    mitreFallbacks: number
    unpairedRuns: number
    openingsUnassigned: number
    blocking: number
  }
}
