# Arcvia CAD→3D Asset Engine — Build Blueprint

**Architecture:** solver-first (Keystone), with the DIMENSION dual-role estimator, the vector-PDF front door, the decision-margin review signal, the `BuildPlan` two-emitter split, arc-length-hosted openings, and the pre-GPU verify gate grafted in. Fatal flaws from all three rival designs are fixed by construction, and each fix is named at the point it applies.

---

## 1. What we are building and why it beats mnml

mnml/studio is a prompt surface over `google_nano_banana`. All eight of their "experts" resolve to the same `editModel`; their "camera angle" re-rolls a fresh image; their user-settable Seed exists precisely because two views of the same building are two independent samples that do not have to agree. There is no mesh, no scale, no export, no second view of the *same* thing. We are building the thing they simulate: a headless pipeline that takes a DWG, DXF, vector PDF, scanned PDF or a photo of a plan and produces a **semantic building model** (walls, openings, rooms, storeys, real metres, provenance per element), a **clean tagged GLB** with lightmap-ready UVs, and derived deliverables — orthographic plan, the isometric "3D floor plan" cutaway that is literally the image mnml diffuses, interior and exterior views — all from one solved model. Then we put an mnml-shaped render surface on top of it, where Engine is a Cycles sample count, Expert is a camera solver plus a scope, Style is a shader and line-art configuration, Camera Angle moves an actual camera, and cross-view consistency is not a feature we ship but a property we cannot avoid. Diffusion survives only as an optional finishing pass over a real Cycles render conditioned on real depth, normal and Cryptomatte passes — a filter with a geometric prior, never the source of truth. The competitive sentence is one line in our UI: *"Geometry is deterministic. The seed only affects the optional finishing pass."*

---

## 2. The intermediate building model

Two files, one npm workspace package. `schema.ts` is the semantic contract; `buildplan.ts` is the solved mesh recipe that both emitters consume so the browser preview and the headless deliverable cannot drift. Both are pure types plus a JSON Schema emitter — zero runtime dependencies, importable from the studio, from Node, and mirrored into Python by codegen.

### `packages/building-model/src/schema.ts`

```ts
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
```

### `packages/building-model/src/buildplan.ts`

```ts
// packages/building-model/src/buildplan.ts
// ─────────────────────────────────────────────────────────────────────────────
// The SOLVED mesh recipe. Pure data: no THREE, no bpy, no DOM.
// Written ONCE and consumed by exactly two thin emitters —
//   packages/building-model/src/emit/three.ts   (studio preview + GLB)
//   services/render-worker/assemble_building.py (Blender/Cycles deliverable)
// so the preview and the deliverable structurally cannot drift apart.
//
// The atlas is a TABLE HERE, not a coincidence of traversal order in two files.
// apps/studio/src/plan/lightmapUV.ts:34 and services/render-worker/render.py:444
// currently BOTH recompute ceil(sqrt(n)) and must stay byte-identical or light
// leaks from the wrong room. After this, both READ atlas.cells.
// ─────────────────────────────────────────────────────────────────────────────
import type { Id, M, P2, Provenance } from './schema'

export type SurfaceKind =
  | 'wall-paint' | 'wall-exterior' | 'floor-wood' | 'floor-tile' | 'ceiling'
  | 'skirting' | 'glass' | 'metal' | 'stone' | 'water' | 'ground'

export type PieceTag =
  | 'wall' | 'pier' | 'sill' | 'lintel' | 'reveal' | 'perimeter'
  | 'railing' | 'parapet' | 'column' | 'slab' | 'ceiling' | 'skirting'
  | 'stair' | 'roof' | 'glazing' | 'site' | 'fixture'

/** Exactly two primitives, as blender_build.py:120/:136. No boolean modifiers,
 *  ever: they fail on the coplanar faces an in-face opening creates. */
export type Shape =
  | { kind: 'box'; centre: [M, M, M]; size: [M, M, M]; yaw: number }
  | { kind: 'prism'; polygon: P2[]; holes: P2[][]; z0: M; z1: M }

export interface Piece {
  id: Id
  /** Named in the GLB and addressable by Cryptomatte:
   *  'storey0/wall/w12/pier1', 'storey0/slab/room:v3,v4,v9'. */
  name: string
  storeyId: Id
  tag: PieceTag
  shape: Shape
  material: SurfaceKind
  atlasCell: number        // index into BuildPlan.atlas.cells; -1 = not lightmapped
  castShadow: boolean      // false for `glass` — a shadow map stores depth only,
                           // so glazing otherwise blocks sun exactly like masonry
  /** glTF `extras`. This is what makes the output a semantic building rather
   *  than a bag of triangles, and what the Layers rail and the BOQ read. */
  extras: {
    elementId: Id
    kind: string
    spaceId?: Id
    wallId?: Id
    openingId?: Id
    definitionId?: Id
    layer?: string
    confidence: number
    provenance: Provenance['primary']
  }
}

export interface BuildPlan {
  schema: 'arcvia.buildplan/1'
  buildingId: Id
  atlas: {
    /** 'grid-v1' is byte-compatible with the CURRENT ceil(sqrt(n)) packing in
     *  lightmapUV.ts and render.py. Do not change the algorithm and the
     *  consumers in one step; move the table first, version it, migrate later. */
    layout: 'grid-v1' | 'shelf-area-v2'
    size: number           // atlas px
    grid: number
    margin: number         // texel gutter
    cells: { piece: Id; u: number; v: number; w: number; h: number }[]
  }
  pieces: Piece[]
  cameras: SolvedCamera[]
  qa: {
    storeys: number
    spaces: number
    floorArea: M           // real m2
    triangles: number
    mitreFallbacks: number
    unpairedRuns: number
    openingsUnassigned: number
    dimAgreement: number | null
    verdict: 'ship' | 'review' | 'reject'
  }
}

export interface SolvedCamera {
  id: Id
  name: string
  expert: 'exterior' | 'interior' | 'masterplan' | 'landscape' | 'plan' | 'product'
  storeyId: Id | null
  spaceId?: Id
  /** Plan-space metres + elevation. The emitters apply their own axis flip. */
  position: [M, M, M]
  yaw: Rad
  pitch: Rad
  projection: 'perspective' | 'ortho'
  focalLength?: M          // 0.035 = 35mm
  orthoScale?: M
  clip?: { z: M; keepBelow: boolean }   // the 1.2 m plan section cut
  clearance: M             // metres of free space around the eye — the solve quality
  aimedAt?: Id             // the glazing Opening this interior view faces
}
```

---

## 3. Module layout

### New: `packages/building-model/` (npm workspace, matched by the existing `packages/*` glob)

| Path | Role |
|---|---|
| `packages/building-model/package.json` | Private workspace, `type: module`, `main: src/index.ts`, **no build step** (cloned from `packages/viewer/package.json`'s shape). `three` only as an optional peer for the `emit/three` entry. |
| `packages/building-model/src/schema.ts` | Section 2 above. The semantic contract. |
| `packages/building-model/src/buildplan.ts` | Section 2 above. The solved mesh recipe. |
| `packages/building-model/src/curve.ts` | `flatten(curve, sagitta)`, `lengthOf`, `pointAt`, `normalAt`, `offset`. DXF bulge → arc maths. Mirrored byte-for-byte by `curve.py` against a shared golden fixture. |
| `packages/building-model/src/geometry.ts` | **MOVED verbatim** from `apps/studio/src/plan/geometry.ts`. `signedArea` (sign is load-bearing), `labelPoint`'s centroid-then-scanline fallback, `closestPointOnSegment`, `segmentIntersection` with its `inclusive` flag. |
| `packages/building-model/src/rooms.ts` | **MOVED verbatim** from `apps/studio/src/plan/rooms.ts`. `detectRooms` + `roomId`. Not reimplemented, not ported to Python — the closure energy in stage 5 calls it over a Node bridge. |
| `packages/building-model/src/pairing.ts` | **MOVED** from `apps/studio/src/plan/detections.ts` (`pairFaces`, `joinCorners`, `centreline`, `toWorld`, `summarise`) **plus a mandatory STRtree/spatial-hash rewrite of the candidate scan**. The originals are O(n²) with a source comment scoping them to "a few hundred segments"; one real DWG carries 26,194 model-space entities. Constants (`angleTolerance 6°`, gap `0.04–0.5`, `overlapAlong 0.35`, `cornerTolerance 0.6`, corner-parallel skip `25°`) are preserved exactly; only the neighbour query changes. |
| `packages/building-model/src/detectionQuality.ts` | **MOVED** from `apps/studio/src/plan/detectionQuality.ts`. `assessDetection` / `countClusters` — the extents-not-midpoints gutter trick, promoted from a quality gate to the **frame splitter** in stage 2. |
| `packages/building-model/src/planStore.ts` | **MOVED** from `apps/studio/src/plan/planStore.ts`. `addWall` / `ensureVertex` / `splitWall` stay the only insertion API; `reserveIds()` gains the `openings` and `links` namespaces (the shared-counter hazard that once made furniture overwrite itself). `addWall`'s `{...working.walls}` spread is replaced by a mutable batch builder for CAD-scale inserts. |
| `packages/building-model/src/catalogue/{types,items,placement,credits}.ts` | **MOVED** from `apps/studio/src/catalogue/`. 46 dimensioned items, `nearestWall`/`resolvePlacement`/`facingIntoRoom`, and `AssetModel`'s required licence fields. `build.ts` and `models.ts` stay in the studio (they import THREE). |
| `packages/building-model/src/toPlan.ts` | `BuildingModel → Plan` (`version: 1`, no migration). Feeds every wall through `planStore.addWall(..., { snapRadius: 0.15 })`. Emits a `PlanProjection` map plus an **enumerated** loss list (arcs chorded at N; `align:'left'` recentred; Slab/Roof/Stair/Annotation dropped; Space names mapped to `Floor.roomNames` by `roomId(loop)`). |
| `packages/building-model/src/absorbPlan.ts` | `absorbPlanEdits(model, plan, projection)` — a **merge**, not a replace. A plan wall with no projection entry becomes a new element with `locked: true`; a model element whose projected wall vanished becomes `suppressed: true`. |
| `packages/building-model/src/solidify.ts` | `BuildingModel → BuildPlan`. Shapely-equivalent mitred bands (via the Python side; the TS side reads the result). Owns opening splitting, reveals, skirting cut at doorways, slab inset to inner faces, perimeter extrusion, atlas cell allocation. |
| `packages/building-model/src/emit/three.ts` | `BuildPlan → THREE.Group`. ~120 lines. Keeps `materials.ts`'s `CAN_DRAW` guard and FLAT colour fallback so it runs in bare Node. Replaces the geometry half of `buildGeometry.ts`. |
| `packages/building-model/src/emit/glbNode.ts` | Node `FileReader` shim + `GLTFExporter.parseAsync` + `writeFile`. Unblocks a headless preview GLB with no Blender spawn. Pinned to `three@0.171` and re-verified on any bump. |
| `packages/building-model/src/validate.ts` | `ajv` schema validation plus the invariants a schema cannot express: every `Opening.wallId` resolves and `0 <= along <= lengthOf(baseline)`; every `evidence.length >= 1`; every `Definition.meshUrl` has a `licence`; every `Space.loop` closes. |
| `packages/building-model/schema/building-1.json` | Generated by `ts-json-schema-generator`. The open, versioned artefact a third party validates against and the Python types are generated from. |
| `packages/building-model/test/` | `pairing.test.ts`, `curve.test.ts`, `toPlan.test.ts`, `solidify.test.ts`, plus the eleven moved studio tests re-pointed here. Runs on `apps/studio/test/run.mjs`'s existing esbuild-bundle-then-import harness — no new test framework. |
| `packages/building-model/test/golden/` | The shared TS↔Python golden fixture. `pairing.golden.json` and `curve.golden.json` are asserted by both `test/pairing.test.ts` and `services/reconstruct/test/test_pairing.py`. **If this test is ever skipped as slow, the two importers drift silently.** |

### New: `services/reconstruct/` (FastAPI, own Python 3.12 venv, port 8091)

Deliberately a **separate process** from `floorplan-ai`: `labels.py:36` instantiates `RapidOCR()` as a module-import singleton, and the `rapidocr` / `opencv-python-headless` dependency conflict stays quarantined there. Reconstruct calls `/detect` over HTTP as one evidence emitter among six.

| Path | Role |
|---|---|
| `services/reconstruct/main.py` | Routes: `GET /health`, `POST /survey` (free — sources → `Frame[]`, layer report, `UnitDecision` candidates), `POST /reconstruct` (→ `BuildingModel` + residuals), `POST /resolve` (apply `ModelPatch[]`, re-solve), `POST /solidify` (→ `BuildPlan`). |
| `services/reconstruct/requirements.txt` | `ezdxf==1.4.4`, `shapely>=2.1`, `numpy`, `opencv-python-headless==4.10.0.84`, `pymupdf`, `fastapi`, `uvicorn`, `pydantic`. **No rapidocr.** Python 3.12 (3.13+ has no wheel story here). |
| `services/reconstruct/model/types.py` | Generated from `building-1.json` by `datamodel-code-generator`, **checked in**. |
| `services/reconstruct/model/curve.py` | Python mirror of `curve.ts`. Uses `ezdxf.path.make_path(e).flattening(sagitta)` for source arcs; exact bulge maths for round-trips. |
| `services/reconstruct/ingest/dwg.py` | The LibreDWG gate. Verified on this box: `A:/Tools/LibreDWG/dwg2dxf.exe --version` prints `dwg2dxf 0.14`. Asserts the version string, converts, re-opens with ezdxf and counts **model-space** entities specifically (not table/block entities — the 0.13.3 failure emits ~2,993 of *those*), writes the receipt onto `SourceRef.converter`. |
| `services/reconstruct/ingest/dxf.py` | Extends `cad.py`'s reader. Adds the four things it refuses today: `ARC/CIRCLE/ELLIPSE/SPLINE` via `ezdxf.path`, **LWPOLYLINE bulges via `get_points('xyb')`**, recursive `virtual_entities()` INSERT explosion (depth 8, cycle-guarded, accumulating `blockPath`), xref + paperspace traversal, and `DIMENSION`/`TEXT`/`MTEXT`/`ATTRIB` harvest into `Annotation`. |
| `services/reconstruct/ingest/pdf_vector.py` | `PyMuPDF page.get_drawings()` **first**. A CAD print-to-PDF is exact vector geometry; `deck.py` never looks and returns an empty sheet list that reads as a successful import of nothing. Pseudo-layers clustered by stroke width + colour. Falls through to `deck.outline()`'s embedded-raster walk, then `page.get_pixmap(dpi=300)`. |
| `services/reconstruct/ingest/raster.py` | HTTP client to `floorplan-ai` `/detect` and `/document`. Maps `DetectionResult` into observations with raster provenance. Handles the client type lag: `Room.kind` may be `'outdoor'`. |
| `services/reconstruct/ingest/ifc.py` | **Stub with a working shape only.** IfcOpenShell is not installed. Architecturally a sixth emitter entering at weight 0.95 as committed elements that skip stages 4–6 but still pass stage 7 Verify. Out of v1. |
| `services/reconstruct/evidence/types.py` | `LineObs`, `ArcObs`, `TextObs`, `DimObs`, `BlockObs`, `RegionObs`. The type-level enforcement of the thesis: **a parser has no vocabulary for the word "wall".** |
| `services/reconstruct/solve/frames.py` | **Stage 2. Mandatory, and the fix for a rival design's fatal flaw.** 2D extents-gutter clustering + a plan/section/elevation discriminator. |
| `services/reconstruct/solve/units.py` | Imports `infer_scale_from_walls`, `classify`, `guess_item`, `_BLOCK_HINTS`, `_SIZED_OPENING` **vendored** from `cad.py` into `services/reconstruct/vendor/cad_kernel.py` with a `test_vendor_parity.py` diff test (not a cross-service `sys.path` insert + sha256 pin — that is a landmine on a Windows box with a recorded CRLF/UTF-8 hazard). Adds the **DimObs unit estimator**. |
| `services/reconstruct/solve/storeys.py` | Canonical index from frame titles; registration by shared-grid → `cv2.matchTemplate` wall-mask cross-correlation; always records peak **and** runner-up. |
| `services/reconstruct/hypothesise/pair.py` | The single canonical face pairer, STRtree-indexed, port-tested against `packages/building-model/test/golden/pairing.golden.json`. Arcs pair in (centre, radius) space; lines in (direction-bin, offset) space. |
| `services/reconstruct/hypothesise/perimeter.py` | **`add_perimeter` (blender_build.py:477) ported on day one.** The README is explicit that it did more for output quality than every material and lighting change combined, and its absence is what makes a partitions-only plan produce zero closed spaces. |
| `services/reconstruct/hypothesise/openings.py` | Three emitters into one shape: opening-layer union-find clusters + `minAreaRect`; `_SIZED_OPENING` blocks; `detect_openings`' collinear gaps. Each projected onto its host baseline to yield `wallId` + `along`. |
| `services/reconstruct/hypothesise/fixtures.py` | `cad.furniture()` → `Definition` + `Fixture`. Exact author-placed position and rotation, strictly better than any image recognition. |
| `services/reconstruct/solve/commit.py` | **Stage 5a — the fix for solver-first's fatal flaw.** Deterministic conflict resolution over a spatial-hash overlap graph *before* any labelling. Decides *which candidates exist*; ICM never has to. |
| `services/reconstruct/solve/labelling.py` | **Stage 5b.** ICM MAP labelling over `WallRole` on already-committed candidates only — a genuine per-element labelling problem. Closure / outdoor / attachment / stack pairwise terms. Publishes a margin per decision. |
| `services/reconstruct/solve/relax.py` | **Stage 6.** IRLS Huber Gauss-Newton; Jacobi-preconditioned CG in numpy over the sparse normal equations. Residual blocks: ortho (K axis families), **dim**, collinear, storey-stack, Tikhonov prior. |
| `services/reconstruct/solve/verify.py` | **Stage 7 — the pre-GPU gate.** Grades built geometry against every carried `Annotation.measure` and printed room size. |
| `services/reconstruct/solve/residue.py` | Turns unresolved energy and post-solve residuals into `Residual[]` with one-click `choices`. |
| `services/reconstruct/build/solidify.py` | `BuildingModel → BuildPlan`. Pure Python, **no `bpy` import**, so the hardest geometry is unit-testable without Blender. |
| `services/reconstruct/test/` | pytest + golden `.building.json` fixtures from the seven Casa Altinho DXFs. The first tests any geometry code in this repo has had. |
| `services/reconstruct/vendor/cad_kernel.py` | Vendored `cad.py` kernel functions + parity test. |

### New: `services/render-worker/`

| Path | Role |
|---|---|
| `assemble_building.py` | `blender -b --factory-startup --python assemble_building.py -- --plan X.buildplan.json --out Y.glb`. `add_box`/`add_prism` bmesh kernel lifted from `blender_build.py:120/:136` with the module globals replaced by an explicit builder object. One joined mesh per storey named `storey_<id>`, pieces named `arcvia:<pieceId>` with glTF `extras`. Prints `ARCVIA_OUTPUT:` + `ARCVIA_CAD_UNIT:`, `ARCVIA_CAD_SPACES:`, `ARCVIA_DIM_AGREEMENT:`, `ARCVIA_MITRE_FALLBACKS:`. |
| `style_passes.py` | The Style selector as real Blender configuration: Freestyle line art (CAD, Sketch), clay+AO (Model), full Cycles (Photoreal), Standard-transform (CGI), flat emission (RAW). |
| `aov.py` | Cycles AOV pass: Combined, Depth (Z), Normal, AO, **Cryptomatte-Object keyed by `arcvia:<pieceId>`**. Written as EXR + PNG on disk. |
| `derive_views.py` | Camera solver (`views.py:101-176` generalised to `Space.boundary`), orthographic plan section at 1.2 m, isometric cutaway at yaw 45° / pitch 35.264°. Writes a `views[]` JSON matching `SceneView` — no more TypeScript printed to stdout for hand-pasting. |
| `finish_ai.py` | The optional diffusion finish. The only place a generative model touches anything. |

### New: `tools/cad-engine/cli.mjs`
Headless orchestrator: `node cli.mjs --input <path|key> --out <dir> [--frame <id>] [--unit mm] [--deliverables plan,iso,interior]`. Calls the Python service, runs `building-model`, writes `building.json` + `buildplan.json`, spawns Blender, prints the marker protocol. This is what Milestone 1 runs.

### New: `apps/studio/src/screens/CadImport.tsx`
Not a wizard — a ranked list of `Residual`s over the existing `PlanCanvas`, each highlighting its elements and rendering the solver's own `choices` as buttons. Plus the ask-once unit picker (candidates with the building size each implies) and the layer picker with a live preview of the chosen subset.

### EXISTING Arcvia files modified — exhaustive

| File:line | Change |
|---|---|
| `packages/brand/plans.config.mjs:23` | `creditCost` gains `cadSurvey: 0`, `cadReconstruct: 8`, `cadAssemble: 12`, `isometricCutaway: 3`, `styleFinish: 4`. **Must land first** — `spend()` throws `Unknown metered action` for any key not here. |
| `apps/web/src/pages/pricing.astro:15-20` | Hand-add the same rows. That METERED list is **not** generated from `creditCost` and silently goes stale. |
| `services/api/src/lib/storage.js:44` | `ALLOWED` gains `['image/vnd.dwg','.dwg']`, `['image/vnd.dxf','.dxf']`, `['application/json','.json']`. Confirmed today it holds only png/jpeg/webp/glb/pdf. |
| `services/api/src/routes/uploads.js:138` | Serve `.dwg`/`.dxf` with `Content-Disposition: attachment`, alongside the existing PDF branch — `/uploads/*` is unauthenticated and same-origin. |
| `services/api/src/routes/uploads.js:156` | `sniff()` gains: DWG (`AC10` + two version digits at offset 0), ASCII DXF (`/^\s*0\r?\nSECTION/`), binary DXF (`AutoCAD Binary DXF\r\n\x1a\x00`). Confirmed today it checks PNG/JPEG/glTF/PDF/WebP only. New route `POST /uploads/cad` modelled on `/uploads/scene` at `:89`. |
| `services/api/src/server.js:27` **and** `:48` | Raise `bodyLimit` and `@fastify/multipart` `fileSize` to **256 MB together**. Today both are 32 MB while the route branches claim 64 MB, making those branches unreachable; CAD sets routinely exceed 32 MB. |
| `services/api/src/server.js:59` | One line: `await app.register(registerCadRoutes, { prefix: '/cad' })`. |
| `services/api/src/routes/render.js:22` | `PRESETS` gains `reconstruct` (action `cadReconstruct`), `assemble` (`cadAssemble`), `cutaway` (`isometricCutaway`, 1920×1080, 32 samples), `ortho` (`isometricCutaway`), `finish` (`styleFinish`), `ultra` (`fullRender`, 2560×1440, 256 samples). Every key needs an `action` that exists in `creditCost`, or `reconcileRenderJobs`' `if (PRESETS[job.preset])` guard at `:97` silently skips its orphans. |
| `services/api/src/routes/render.js` (new) | `GET /render/jobs` listing endpoint. The History rail has no source without it. |
| `services/api/src/lib/renderQueue.js:52` | `timeoutFor` stops being `job.preset === 'bake' ? BAKE : JOB` (confirmed verbatim) and becomes a table: `reconstruct` 20 min, `assemble` 45 min, `cutaway` 20 min, `ultra` 45 min, `bake` unchanged at 45 min, default 10 min. |
| `services/api/src/lib/renderQueue.js:138` | `start()` gains two branches. `reconstruct`/`finish` copy the `job.preset === 'ai'` branch verbatim (confirmed at `:155`): it registers in `running`, so cap/concurrency/reconciliation apply with no special cases, and makes an HTTP call instead of spawning Blender. `assemble`/`cutaway`/`ortho` take the local Blender spawn path with `SCRIPT` swapped for `assemble_building.py`. |
| `services/api/src/lib/renderQueue.js:141` | **REQUIRED BUG FIX.** `finish()` currently only calls `db.update` (confirmed). In `RENDER_MODE=local` nothing refunds a failed job — measured 29 failed jobs against 6 refund rows, 4 of them via `reason: 'restart'`. Add a refund on `status === 'failed'`, guarded by a `refunded: true` flag on the row so `reconcileRenderJobs` cannot double-refund. A 12-credit assemble makes the current behaviour indefensible. Copy `detect.js:67-125` — the only place in the repo that gets refunds fully right. |
| `services/api/src/lib/renderQueue.js:120` | `drain()` gains per-preset lanes (see Open Decision 2). |
| `services/api/src/store.js:21` | `EMPTY` gains `buildings: []` — a light **index only** (`id, sceneId, ownerId, storageKey, sha256, status, counts`). The model body lives in content-addressed storage: every `db.update` rewrites the entire JSON file, and the serialised write chain at `:55` must not be simplified away. |
| `services/api/src/routes/scenes.js:82` | Writable allow-list gains `buildingUrl`, `buildPlanUrl`, `projection`. A write to a field not on that list is silently dropped. |
| `apps/studio/src/plan/index.ts` (new) | `export * from '@arcvia/building-model'` re-export shim, so the extraction is one commit touching no React component. **Deleted once imports migrate** — left in place it makes the package boundary meaningless. |
| `apps/studio/src/plan/buildGeometry.ts` | Keeps `buildFloorGeometry`/`buildPlanGeometry`/`suggestedCamera` as its public surface; delegates to `solidify()` + `emit/three.ts`. `solidPieces` and `openingsIn` move into the package rather than being rewritten. |
| `apps/studio/src/plan/lightmapUV.ts:34` | Becomes a thin adapter that reads `BuildPlan.atlas.cells` instead of recomputing `ceil(sqrt(n))`. **`layout: 'grid-v1'` produces byte-identical cells**, so no baked GLB is invalidated and `render.py:444` needs no change on day one (`prebakedUv: true` already tells it not to smart-project). |
| `services/render-worker/render.py:444` | Same adapter, second commit. These two change **as a matched pair or not at all**. |
| `packages/viewer/src/SceneViewer.ts:642` | Self-host the Draco decoder (copy `node_modules/three/examples/jsm/libs/draco/` into each app's `public/`). Every GLB we emit is Draco level 6; the hardcoded gstatic CDN fails under CSP/offline with an unhelpful parse error. |
| `services/floorplan-ai/` | **UNCHANGED.** Consumed over HTTP as one evidence emitter. Its room-first architecture, two-binarisation race and morphological pipeline are inherited, not revisited. `ezdxf` is never installed into that venv (confirmed absent; the stray `cad.cpython-314.pyc` is why). |
| `tools/cad-to-3d/` | Left in place as the Casa Altinho harness and the porting reference. `README.md` gets a header pointing at `services/reconstruct`. |

---

## 4. The pipeline, stage by stage

### Stage 0 — Intake and converter assertion
- **Input:** an uploaded storage key: `.dwg` / `.dxf` / `.pdf` / `.png` / `.jpg` / (`.ifc` stretch).
- **Output:** `SourceRef[]` with converter receipt and a normalised file on disk.
- **Library:** `A:/Tools/LibreDWG/dwg2dxf.exe` (verified 0.14 on this box), `ezdxf.recover`, Node `child_process`.
- **Algorithm:** DWG — parse `dwg2dxf --version`, refuse anything below `0.14`. Convert. Re-open with `ezdxf.recover.readfile` and count **`msp` entities specifically**, not table or block-definition entities: the recorded 0.13.3 failure emits a structurally valid file with ~2,993 plausible *table/block* entities and an empty model space. Threshold is `len(list(msp)) < 50` **plus** `total wall-layer linework < 5 m` — an entity count alone rejects a legitimately small single-plan drawing. Convert twice and keep the larger model space (same DWG, two DXFs is a recorded reality — recovery discards blocks non-deterministically). DXF/PDF/raster pass through with sha256 + byte count.
- **Failure mode:** semantically empty DXF; password-protected or AC1032 DWG; a `.dxf` that is a renamed `.dwg`.
- **Fallback:** none — this is a hard stop with `CONVERTER_DROPPED_MODELSPACE`, naming the version found. Every downstream stage would otherwise produce a confident empty building. A blocking residual offers "try paperspace layouts" and "send a DXF export".

### Stage 1 — Evidence extraction (parsers emit observations, never elements)
- **Input:** `SourceRef[]`.
- **Output:** `Observation[]` — `LineObs`, `ArcObs`, `TextObs`, `DimObs`, `BlockObs`, `RegionObs`, each with source id, emitter, weight, **source-native coordinates**.
- **Library:** `ezdxf 1.4.4`, `PyMuPDF 1.28.2` (confirmed in the floorplan-ai venv), `opencv-python-headless 4.10`, `floorplan-ai` over HTTP.
- **Algorithm, per format:**
  - **DXF/DWG:** `recover.readfile`, walk model space **and** paperspace layouts (flagged `isPaper`). `_explode` extended: `LINE`, `LWPOLYLINE` **with `get_points('xyb')` so bulges survive**, `POLYLINE`, plus `ARC`/`CIRCLE`/`ELLIPSE`/`SPLINE` via `ezdxf.path.make_path(e)` kept as a `Curve2` span **and** cached as a `.flattening(0.01)` chord list for the spatial index. Recursive `entity.virtual_entities()` INSERT explosion, depth cap 8, definition-name cycle guard, accumulating `blockPath` — today any wall drawn inside a block is invisible to both the layer report and `walls_from()`. `DIMENSION` → `DimObs` with value + two definition points + an `overridden` flag; `TEXT`/`MTEXT`/`ATTRIB` → `TextObs`, MTEXT format codes (`{\C2;VILLA - E1}`) stripped by a plain-text reducer then filtered through `labels.py` `NOISE`.
  - **PDF-vector:** `page.get_drawings()` **first**. Path items `'l'`,`'c'`,`'re'` in PDF points (1 pt = 1/72 in) give a true physical page size. Pseudo-layers clustered by stroke width + colour. This is the recorded gap: `deck.py` only walks `page.get_images(full=True)`, so a CAD print-to-PDF returns an empty sheet list that looks like a successful read.
  - **PDF-scan:** `< 200` path items → `deck.outline()`'s embedded-raster walk verbatim (`repeated_text()` boilerplate stripping, `nearest_caption()` type-size-first ranking, `classify_pixels()` paper-ratio test) → `page.get_pixmap(dpi=300)` page rasterisation as last resort.
  - **Raster:** `POST /detect` unchanged. `walls`/`rooms`/`scale` become `LineObs`/`RegionObs` at weight 0.55.
  - **Blocks:** through `guess_item()` and `_SIZED_OPENING` verbatim. `D750` is simultaneously an opening hypothesis **and** a 750 mm dimensional constraint.
- **Failure mode:** all walls live in an unresolvable xref; self-referencing block; SPLINE flattening explodes segment count on a traced site boundary.
- **Fallback:** unresolvable INSERTs become `BlockObs` points only (exactly what `furniture()` does today) plus a `BLOCK_GEOMETRY_HIDDEN` residual, so a plan whose walls are all in one block does not come back silently empty. Chords per entity capped at 200 with a `CURVE_CHORDED` info residual.

### Stage 2 — Frame segmentation and sheet triage **(mandatory; nothing downstream is meaningful without it)**
- **Input:** `Observation[]` in source coordinates.
- **Output:** `Frame[]`, each typed `plan` / `section` / `elevation` / `detail` / `site` / `titleblock`.
- **Library:** numpy, shapely `STRtree`.
- **Algorithm:** generalise `detectionQuality.ts:45` `countClusters` to **both axes**: project observation **extents** (not midpoints) onto x and y, find gutters wider than 5% of the drawing extent, take the cross product of the surviving bands. Keep frames holding 4–26 m of wall-layer linework. Title each from the largest nearby `TextObs` using `deck.py:250` `nearest_caption`'s ranking — **type size first, distance second** (the fix for full-bleed sheets where every text block overlaps). Plan/section discriminator: a plan has a bimodal wall-direction histogram, closed cycles in its linework, and room-word text; a section has a dominant horizontal datum run, level markers, and no closed cycles. This replaces `discover.py`'s practice-specific `{\C2;…}` regexes, its ±26-unit x window and its +3.0/−6.0/+34.0 bands entirely.
- **The origin rule, stated once:** the origin shift is subtracted **once per SOURCE** and recorded in `BuildingModel.sourceOrigin`, never per frame. Shifting each frame to its own min-corner destroys exactly the relative alignment that storey registration exists to recover. A building at eastings 512,000 is still made findable; frames stay in their true relative positions on the sheet.
- **Failure mode:** a single-plan sheet (degenerates to one frame — correct); a sheet where sections and plans interleave with no gutter; a frame that is actually a title block.
- **Fallback:** an untyped frame raises `FRAME_KIND_UNKNOWN` (high, not blocking) and is offered to the user as plan/section/elevation buttons. Zero frames raises blocking `NO_FRAMES`.

### Stage 3 — Unit, origin and storey resolution
- **Input:** `Frame[]` + `Observation[]`.
- **Output:** one `UnitDecision`, `sourceOrigin`, `Storey[]` skeletons with `registration`.
- **Library:** vendored `cad_kernel.infer_scale_from_walls`, numpy, `cv2.matchTemplate`.
- **Algorithm — units as a posterior over `{m, mm, cm, in, ft}`, fused from five estimators, never a single decision:**
  1. **`DimObs` residual scoring, weight 0.40 — the decisive estimator and the grafted idea.** For each candidate unit, compute `median |annotation.measure.value − drawnDistance × scale|` across every non-overridden DIMENSION. The minimiser wins. This is the architect's own explicit assertion of a distance, it is ~80 lines, and nothing in Arcvia reads it today.
  2. `infer_scale_from_walls`, weight 0.35, **verbatim**: 64 direction bins over 180°, perpendicular offsets between parallels, gap histogram at `bin = min_gap/4`, modal gap, pick the unit landing it in 0.07–0.45 m, require ≥20 gaps and `min(len_a, len_b) >= gap*3`.
  3. `labels.infer_scale` median printed-room-size ratio, weight 0.15, with IQR spread.
  4. `$INSUNITS`, weight 0.05 — **it demonstrably lies**: a real drawing declares 4 (mm) and is authored in metres.
  5. Extent plausibility (`_PLAUSIBLE = 3–400 m`), weight 0.05, acting mostly as a veto.
  - **Estimators 1 and 2 are fully independent, so they cross-check.** If they disagree, `UnitDecision.agreement.conflict = true` and it **escalates**, never averages — a drawing globally rescaled after its dimensions were overridden is exactly the case where both would be confidently wrong in different directions.
  - Storeys: canonical order from frame titles (`lower-ground < stilt < ground < upper-ground < first < second`), **never sheet y** — one real sheet ascends and another descends. Registration by shared grid intersections if grids exist, else `cv2.matchTemplate` normalised cross-correlation of 0.02 m/px wall masks over ±3.0 m at 0.10 m. Always record peak **and** runner-up.
- **Failure mode:** `top posterior / runner-up < 3.0`; fewer than 20 gaps and no dimensions; registration margin below 1.25×.
- **Fallback:** blocking `UNIT_AMBIGUOUS` carrying `scaleCandidates` with the building size each implies. **Ask once. Never auto-decide.** Even the measured inference is recorded (commit `d8f3f14`) as having landed on centimetres for a drawing known to be metres. A low registration margin sets `accepted: 'pending'` and `status: 'needs-levels'` — it does not guess; a floor stacked 400 mm out is invisible in plan and catastrophic in section.

### Stage 4 — Hypothesis generation
- **Input:** frames + observations + the resolved scale.
- **Output:** candidate walls, perimeter, openings, columns, stairs, fixtures — each with unary scores and labelled alternatives.
- **Library:** shapely `STRtree`, numpy, opencv.
- **Algorithm:**
  - **Face pairing — ONE canonical pairer, not two.** Greedy longest-first (a long wall's faces are the least ambiguous match, and consuming them early stops a short stub stealing one), with the neighbour scan served by an `STRtree` rather than the O(n²) all-pairs loop the TS original uses. Three filters, constants preserved: `|dot(dirP, dirQ)| >= cos(6°)` (the `abs` matters — faces are traced in arbitrary directions); perpendicular gap from q's midpoint to p's infinite line in `[0.04, 0.5]` m; `overlapAlong >= 0.35` m (this is what stops two parallel walls at opposite ends of the building pairing). `centreline()` takes the **overlapping span only** (`from = max of mins, to = min of maxes`) then shifts by `gap/2` — averaging raw endpoints produces a wall half real and half invented. `thickness = gap`, measured from the drawing.
  - **`joinCorners` is not optional.** Trimming to the overlap leaves every centreline about half a wall thickness short of every corner; the result "looks completely right and encloses nothing" — zero rooms over a drawing that plainly has fifteen. Extend each endpoint onto the infinite-line intersection of the nearest non-parallel neighbour, skipping anything within 25° of parallel, requiring reach ≤ 0.6 m **and** `distanceToSegment(crossing, other) ≤ 0.6`.
  - **Perimeter — day one, not a residual.** `add_perimeter` ported: trace the slab footprint (raster close at 0.02 m/px, largest external contour, convex-hull fallback below 45% bbox coverage — the two-mode design is a real distinction between closed-perimeter villas and open-sided row units), extrude it as a 0.23 m exterior wall, **skipping any edge already covered by a paired wall within 0.45 m**. Drawings draw a perimeter as an *outline*, not as a face pair; without this the buildings have interior partitions and no elevations, and the shapely union in stage 9 produces no interior rings and therefore no `Space`s at all.
  - **Unpaired runs > 0.8 m** become a two-alternative hypothesis `{masonry@storey-height, railing@1.0 m}` — never a wall by default.
  - **Openings** from three emitters (layer clusters, sized blocks, collinear gaps), each projected onto the nearest host baseline as `{wallId, along, width}`.
  - **Fixtures/columns/stairs** by spatial-hash union-find + `minAreaRect` (`pieces()`, gaps 0.28 / 0.22 / 0.45), plus exact INSERT placements.
- **Failure mode:** a single-line drawing yields zero pairs; two facing faces across a 1.1 m corridor pair into a fat "wall".
- **Fallback:** unpaired segments are **kept, not discarded**, at `WALL_DEFAULTS.interior.thickness` with `paired: false` — single-line walls are common on small-scale drawings — and reported in `quality.unpairedRuns`. Any survivor above the p90 measured thickness raises `WALL_CONFLICT`.

### Stage 5 — Commit, then label *(this is the fix for solver-first's fatal flaw)*
The original design ran two independent greedy segment-consuming pairers and asked a per-element MAP labeller to arbitrate. Competing pairings are different **topologies** — different vertex sets, different centrelines — not different labels on one element, and ICM with no mutual-exclusion term would happily accept both (one fat double wall) or reject both (a missing wall). The two problems are separated:

**5a — Commit (deterministic, no search).**
- **Input:** candidate walls with unary scores.
- **Output:** a committed, non-overlapping candidate set; losers attached to winners as `Confidence.alternatives`.
- **Algorithm:** build a conflict graph with an `STRtree` — two candidates conflict if their thickness bands overlap by more than 30% of the thinner one's area. Within each conflict component, accept greedily by score; every rejected candidate becomes an `alternative` on the accepted one, not a deleted object. Deterministic, O(n log n), no restarts, no local minima.
- **Fallback:** none needed — the output is always a valid non-overlapping topology.

**5b — Label (ICM MAP over roles only).**
- **Input:** the committed graph.
- **Output:** one `WallRole` per wall, plus a **margin** per decision.
- **Algorithm:** Iterated Conditional Modes, ~180 lines, 8 fixed-seed restarts, deterministic, no new dependency. Unary = fused evidence confidence. Pairwise:
  - **CLOSURE** — a wall whose deletion breaks a graph cycle containing a named room gets a strong bonus for staying masonry. This is how the labeller learns furniture strokes are not walls **without ever looking at a stroke**. Cycles come from `detectRooms` over a Node bridge (`node --input-type=module` invoked from Python), not a Python reimplementation — `rooms.ts` is the one file the map flags as unrecoverable if lost.
  - **OUTDOOR** — a region reading lawn/pool pushes its bounding walls towards railing/kerb. This is what stops a villa coming back wrapped in masonry that traces the swimming pool. Balcony/verandah/terrace deliberately stay indoor — they have a slab.
  - **ATTACHMENT** — an opening not on any wall is heavily penalised; two openings on the same span merge.
  - **STACK** — a wall directly above a masonry wall on the storey below is more likely masonry.
- **Failure mode:** a local minimum.
- **Fallback:** **a degraded path to geometry always exists.** If ICM does not converge in 50 sweeps, every wall takes its unary argmax role and a `SOLVER_DIVERGED` residual is raised. The engine never produces "only a residue list and no building" — that was the structural failure of the original thesis. Every decision with margin < 0.15 becomes a `WALL_OR_RAILING` residual with both alternatives as one-click patches.

### Stage 6 — Continuous relaxation
- **Input:** labelled graph + every `DimObs` and printed room size.
- **Output:** solved vertex positions, storey elevations, per-element residuals and sigmas.
- **Library:** numpy only.
- **Algorithm:** robust Gauss-Newton over vertex `(x,y)` per storey plus storey elevations, solved by IRLS with a Huber loss (`δ = 3σ`), linearised by Jacobi-preconditioned conjugate gradient over the sparse normal equations (~40 lines). ~2k vertices converges in under a second. Residual blocks:
  - `r_ortho` — principal axes from a **length-weighted angular histogram mod 90°**, allowing **K axis families** (a wing at 30° is a second family, not an error). Diagonal walls become solvable, which the axis-aligned morphological detector structurally cannot do. A flat histogram (hand-drafted plan) ⇒ no dominant axes ⇒ the term is disabled automatically.
  - `r_dim` — **every DIMENSION and printed room size as `(measured − model)` directly.** Dimensional agreement is a first-class force, not a post-hoc check.
  - `r_collinear` — near-collinear walls across a doorway pulled onto one line.
  - `r_storey` — a wall within 0.25 m of a similarly-thick wall below shares x,y. Load-bearing walls stack; this is free inter-storey registration, initialised from the stage-3 correlation.
  - `r_prior` — Tikhonov pull to the observed position, so the solver improves a building rather than inventing one.
- **Failure mode:** over-regularisation producing a plausible building nobody drew; contradictory dimension pairs; non-convergence.
- **Fallback:** hard guard — **no vertex may move further than 3× its input sigma**. Breach ⇒ keep the last iterate, `quality.solved = false`, `SOLVER_DIVERGED`. Huber downweights a single lying dimension and emits `DIM_CONFLICT` with observed/expected in metres.

### Stage 7 — Verify **(the pre-GPU gate; grafted from ir-first)**
- **Input:** the relaxed model + all annotations.
- **Output:** `quality.dimAgreement`, `dimSamples`, and a pass/fail before a single GPU-second is spent.
- **Library:** numpy; `labels.parse_dimension` vendored.
- **Algorithm:** for every `Annotation.measure`, find the geometry it spans (nearest wall faces or space extent along the dimension axis) and compare — printed 3600 mm vs built 3.598 m is 0.06%. Aggregate the median absolute relative error. `> 2%` ⇒ the unit or the scale is wrong and `status = 'stale'`. Also assert: every opening's host exists and `0 <= along <= length`; every element's storey resolves; every space closes; a perimeter exists (a building with partitions and no exterior wall is `add_perimeter`'s exact failure case).
- **Why this is the highest-value cheap idea in the whole design:** on this box Cycles is CPU-only at ~55–60 s/frame; a lightmap bake is tens of minutes. A wrong unit today produces a confident, beautiful, 1000×-too-small building at full render cost. Verification costs milliseconds and runs before the Blender spawn.
- **Failure mode:** a drawing with no DIMENSION entities and no printed sizes has nothing to verify against.
- **Fallback:** `UNVERIFIED` at severity `info`, and the pipeline **passes**. An unverified model is not a wrong one. `dimAgreement: null`, `dimSamples: 0`, surfaced in the UI as "not checkable" rather than as a green tick.

### Stage 8 — Residue triage and human review
- **Input:** the model + `Residual[]`.
- **Output:** the same model with `ModelPatch[]` applied and the solver re-run from stage 5.
- **Algorithm:** residuals ranked `blocking > high > low > info`, rendered by `CadImport.tsx` over the existing `PlanCanvas`. Each highlights its targets and renders its `choices` as literal one-click patches. Patches append to `BuildingModel.patches` and are **replayed on every re-solve**, so a decision is permanent and re-running after a better DXF arrives never asks the same question twice. Everything not in the residue list is never shown — the reviewer sees the disagreement, not the drawing.
- **Failure mode / fallback:** a blocking residual left unresolved refuses the `assemble` job and names the outstanding question, rather than producing a 1000×-too-small GLB. Low and info residuals never block.

### Stage 9 — Solidify → `BuildPlan`
- **Input:** a `ready` `BuildingModel`.
- **Output:** `BuildPlan` — pure data, no bpy import, unit-testable without Blender.
- **Library:** `shapely 2.1.2` (confirmed present in the floorplan-ai venv).
- **Algorithm:**
  - **Walls are finally MITRED.** `baseline.buffer(thickness/2, cap_style='flat', join_style='mitre', mitre_limit=4)` per wall, then `unary_union` per storey. Mitring falls out of the union for free — **no corner posts, no half-thickness error at every joint, no z-fighting.** `buildGeometry.ts:24-30` admits this is the single largest geometry defect in the current preview; the fix is a shapely call.
  - **Openings stay ARITHMETIC, never boolean.** Subtract opening footprints from the unioned band in shapely along the wall's own arc-length, then extrude the surviving pier / sill / lintel pieces plus real `reveal` jamb faces. Boolean modifiers genuinely fail on the coplanar faces an in-face opening creates.
  - **Slabs offset OUTWARD by half wall thickness** from the space boundary, fixing the recorded bug that centreline-derived slabs stop half a wall short and leave corridors unfloored.
  - **Skirting is cut at every opening** using `Space.boundedBy` intervals — `skirtingRuns` (buildGeometry.ts:373) currently walks the room polygon knowing nothing about holes and runs straight through every doorway.
  - **Spaces at the finished face:** take the **interior rings** of the unioned wall solids as `Space.boundary`, so `area` is the number an architect would sign, with `polygonize(unary_union(centrelines))` kept as a cross-check.
  - Every piece named `<storey>/<tag>/<id>` with glTF `extras`. Atlas cells allocated here as data, `layout: 'grid-v1'`.
- **Failure mode:** `unary_union` self-intersects at a tight reflex mitre; slivers where two walls are 2 mm apart; a valid polygon with an unwanted hole.
- **Fallback:** `is_valid` check → `make_valid` / `buffer(0)` repair → per-wall fallback to the un-mitred box + corner post, counted in `qa.mitreFallbacks`. **`GEOMETRY_DEGRADED` surfaces as a visible marker, not a log line** — a storey that silently degrades is a regression the user cannot see. Above 10% fallbacks ⇒ `verdict: 'review'`.

### Stage 10 — Emit and condition
- **Input:** `BuildPlan`.
- **Output:** a shippable GLB; a live THREE.Group in the studio.
- **Library:** Blender bmesh, `bpy.ops.export_scene.gltf`, `condition_asset.py`, three 0.171 `GLTFExporter`.
- **Algorithm:** two thin emitters over one recipe. `assemble_building.py` uses only `add_box`/`add_prism` — no modifiers, no booleans, no cleanup passes — joins one mesh per storey named `storey_<id>` (a single fused mesh cannot be lifted apart for a dollhouse), then chains into `condition_asset.py`'s existing hygiene: texture cap, WEBP q80, `export_yup`, Draco level 6, **decimation off** (a building is not a prop). `emit/three.ts` gives the studio the same solve for preview, and `emit/glbNode.ts` produces a preview GLB with no Blender spawn via a six-line `FileReader` shim (three 0.171's binary exporter calls `new FileReader()` unconditionally at `GLTFExporter.js:598/632`; Node 24 has none).
- **Failure mode:** degenerate baseline → null solid; Draco export failure; over-budget triangle count.
- **Fallback:** each element built in its own try/except — one missing wall out of 240 is recoverable, a failed job is not. Draco failure ⇒ export uncompressed and warn: a 12 MB GLB that loads beats a 3 MB one that does not.

### Stage 11 — Derive deliverables
- **Input:** `BuildingModel` + conditioned GLB.
- **Output:** orthographic plan, isometric cutaway, interior/exterior stills, `views[]` JSON.
- **Algorithm:** the **orthographic plan is emitted as vector SVG directly from the shapely polygons** — instant, dimensioned, resolution-free, with `Space.name` + `Space.area` typeset from the model. Strictly better than rendering a picture of a plan. The **isometric 3D-floor-plan cutaway** — literally the image mnml generates — is a Cycles ortho camera at yaw 45° / pitch 35.264° over a ceiling-suppressed storey clipped by a half-plane. Cameras from the `views.py` solver generalised to `Space.boundary`: best-clearance point near a room label, aimed at the **farthest** unobstructed glazing, with `role: 'railing'` walls explicitly non-occluding. Writes JSON matching `SceneView`, never a TypeScript snippet to stdout.
- **Failure mode:** a storey with no room labels; a terrace with no enclosing walls; a space under 1.4 m clearance.
- **Fallback:** `suggestedCamera` (largest space's `labelPoint` at +1.6 m) → framed exterior orbit on the slab hull. Tiny spaces are skipped rather than producing a camera inside a wall.

**IFC (noted, not centred):** `IfcWallStandardCase`/`IfcDoor`/`IfcWindow`/`IfcSpace`/`IfcBuildingStorey` map onto `Wall`/`Opening`/`Space`/`Storey` directly. Architecturally it is a sixth evidence emitter entering at weight 0.95 as pre-committed elements that skip stages 4–6 and still pass stage 7 Verify — so an IFC merged with a newer DXF reconciles rather than overwrites. `ifcopenshell` is not installed and has heavy binary deps. Out of v1; do not promise import.

---

## 5. The render surface

Every mnml control maps onto something physical, because we own the model. Two of theirs are honestly labelled as image tools rather than dressed up as building tools.

**ENGINE.** `Fast` = Cycles CPU, 960×540, 16 samples + the OIDN compositor denoise `render.py:288` already wires. `Ultra` = 2560×1440, 128–256 samples, full AOV set. Both are `PRESETS` entries, so both inherit submit/poll/cancel/callback/reconcile/cap for free. **EEVEE is not an option — it renders black under `--background`.** Where mnml's "deep reasoning" is prompt elaboration, Ultra buys light bounces.

**EXPERT.** Seven of eight are camera solvers plus a scope over the *same* `BuildingModel` — which is the entire competitive claim, since mnml maps all six of theirs to one `editModel` and their Interior and Exterior of one building are two unrelated images. Ours are two cameras in one room.
- *Exterior* — orbit the convex hull of all `Slab.outline`s, roofs on.
- *Interior* — clearance search inside each `Space`, aimed at the farthest unoccluded `Opening{kind: 'glazing'|'window'}`.
- *Masterplan* — top-down ortho over `SiteFeature`s + slab outlines; also feeds `apps/planviewer`'s self-contained hotspot HTML.
- *Landscape* — swap world and ground; `Space.kind: 'outdoor'` drives ground treatment so a pool is water, not masonry.
- *Plan* — **vector SVG from the shapely polygons**, not a render at all. Dimensionable, resolution-free.
- *Product* — isolate one `Definition` on a turntable through `condition_asset.py`.
- *Enhancer* / *Text-to-Render* — the honest diffusion-only lane, labelled in the UI as **"image tool — this does not update your model"**.

**RENDER STYLE.** Seven of nine never touch a diffusion model, because they are shading configurations on real geometry: RAW = flat emission over the albedo table; Photoreal = full Cycles + HDRI + DOF at a real f-number; CGI = Photoreal with AgX swapped for Standard and a clean studio rig; **CAD = Blender Freestyle line art over flat fills, trivially correct because we have actual edges**; Freehand Sketch = Freestyle with jitter + thickness modifiers; Model = clay with AO, per-storey colour banding; Auto = pick by expert. Only *Illustration* and *Watercolor* route through diffusion. The competitive line is exact: **their CAD style is a diffusion model imitating a line drawing; ours is a line drawing.**

**SCENE EFFECTS BOOSTER.** Real Cycles parameters with physical meaning, not a prompt suffix: DOF from the 35 mm f/4 rig in `render_hero.py`, sun azimuth/elevation from date/time and site latitude, volumetric haze, bloom, exposure.

**CAMERA ANGLE.** Auto runs the expert's solver against the actual model. Manual takes `viewer.cameraSpec()`, which already returns exactly the `{position, rotation, focalLength}` shape `render.js` consumes, through `toBlenderVec` at `render.js:320` — **the one and only site where Y-up becomes Z-up**. Moving the camera moves a camera. Cross-view consistency is not a feature we implement; it is a property we cannot avoid.

**SEED.** Present, honest, and demoted. It seeds **only** the optional diffusion finish. On any geometry-only style it renders greyed out with the label: *"Geometry is deterministic. The seed only affects the optional finishing pass."* mnml needs a settable seed because their views are independent samples; ours exists so a stylisation can be re-rolled without re-solving anything.

**CANVAS TOOLBAR.** Upscale = re-render at 2× (real detail, not invented) or `mcp__claude_ai_higg__upscale_image` for a finished frame. Extender = widen camera FOV and re-render — extending the scene rather than imagining past its edge. Animate = `render_hero.py`'s resumable orbit + `encode_film.py`'s ping-pong encode. Mask / magic-wand / eraser operate on **Cryptomatte object IDs keyed by `arcvia:<pieceId>`**, so selecting "the sofa" selects the sofa by identity, not by colour similarity. Brush-inpainting and Extender exist in mnml because a diffusion product has no model to edit; here the primary edit path is: select the wall in the 2D canvas, change it, re-render.

**RIGHT RAIL.** *History* = `renderJobs` rows per scene (needs the new `GET /render/jobs`). *Layers* = the storey/space/wall/opening/fixture tree read straight from the `BuildingModel`, with per-element confidence and provenance visible — **click a wall and see it came from layer `A1 WALLS`, handle `2F3A`, at 0.87 confidence, paired from two faces 230 mm apart.** A pure image product structurally cannot offer this. *Adjust* re-tonemaps the saved passes (exposure, view transform, white balance, per-object relight via Cryptomatte) — instant, and free where theirs costs 30 credits.

### The diffusion finishing pass — exactly where it fits

`aov.py` writes, from the **same camera as the beauty render**: Combined (EXR), Depth/Z (EXR), Normal (EXR), AO, and Cryptomatte-Object. `finish_ai.py` then runs the finish as a `PRESETS.finish` job on the **non-Blender lane** — the `job.preset === 'ai'` branch at `renderQueue.js:155`, copied verbatim so cap, concurrency and boot reconciliation apply with no special cases.

- **What we send that mnml cannot:** they must *infer* depth, normals and segmentation from a flat image. We *render* them. The conditioning is exact, so the roof stays where the roof is.
- **Which MCP tooling:** the funded, uncapped path on this machine is **Higgsfield** (`mcp__claude_ai_higg__*`, account switched 2026-07-16 to a max plan, credit gate gone). Dev-time and low-volume production route through `mcp__claude_ai_higg__generate_image` with the Cycles beauty render plus the normal/depth PNGs supplied as reference/input media (`mcp__claude_ai_higg__media_upload` first), `mcp__claude_ai_higg__upscale_image` for the Upscale tool, `mcp__claude_ai_higg__outpaint_image` for Extender, and `mcp__claude_ai_higg__jobs_wait` + `mcp__claude_ai_higg__job_status` for the poll. `mcp__nanobanana__edit_image` (Gemini native) is the **parked** alternate path behind the Gemini spend cap and is not the default. In-product, the call goes through the existing `renderWithAi` seam that already backs `PRESETS.ai`, so no second HTTP client is written.
- **Strength is clamped at ≤ 0.35** and the pass is always optional. It is a filter with a geometric prior, never the source of truth.
- **Local diffusion is not viable on this box** (Intel Arc, no CUDA), which is the correct answer anyway: it keeps the geometry path free of a GPU dependency it does not have.

**INTEL ARC HAZARD — a standing rule for this entire surface.** No deliverable, conditioning image, thumbnail or derived pixel is ever produced by reading back a GPU texture. This box returns unstable data from `get_image()`-style readback, so `SceneViewer.snapshot()` (a WebGL framebuffer read with no `preserveDrawingBuffer`) is banned from every path except the in-editor thumbnail, where a wrong pixel is cosmetic. Every atlas, AOV, still and history thumbnail is written to disk by Blender on CPU and re-read as file bytes; history thumbnails are downscaled server-side with `sharp`. The Adjust panel composites in a **2D canvas**, explicitly not WebGL. Cycles is pinned to CPU rather than left to `enable_gpu()`'s probe order — the oneAPI path on Arc is the same readback surface. This rule needs a comment at each call site, not only in this document.

---

## 6. Integration contract with Arcvia

**Nothing here builds a second queue, a second storage layer, a second metering system or a second DXF reader.**

### API routes
```
POST /uploads/cad                       # new; modelled on uploads.js:89 /uploads/scene
POST /cad/survey     { key }            # FREE. -> { sources, frames, layers, unitCandidates }
POST /cad/reconstruct{ key[], choices } # metered cadReconstruct -> jobId (queued)
GET  /cad/buildings/:id                 # -> BuildingModel (from storage, not db.json)
PATCH/cad/buildings/:id  { patches[] }  # apply ModelPatch[], re-solve, return residuals
POST /cad/assemble   { buildingId }     # metered cadAssemble -> jobId
GET  /cad/health                        # proxies the Python /health, 3s timeout
GET  /render/jobs                       # NEW listing; the History rail has no source today
```
All of them live in `services/api/src/routes/cad.js`, registered as one line at `services/api/src/server.js:59`, cloned from `services/api/src/routes/detect.js` including:
- **`storageKey()` (detect.js:271)** — the server never fetches an address a caller chose. This closes the residual SSRF that still exists in the render path, where `resolveUrl` (storage.js:161) passes any absolute http(s) URL through untouched and `render.py:56` calls `urlretrieve` on it.
- **Spend up front, refund on EVERY failure branch** with a distinguishing `meta.reason` (detect.js:67-125).
- **4xx from the engine remapped to 422 `UNREADABLE`**, because a bad drawing is a statement about the file, not the infrastructure (detect.js:104-118).

### Job records
New `PRESETS` keys at `services/api/src/routes/render.js:22` (confirmed structure — `{action, width, height, samples, maxBounces, diffuseBounces}`):

| preset | action | dispatch | timeout |
|---|---|---|---|
| `reconstruct` | `cadReconstruct` | HTTP to `:8091`, `ai`-branch clone | 20 min |
| `assemble` | `cadAssemble` | local Blender `assemble_building.py` | 45 min |
| `cutaway` | `isometricCutaway` | local Blender, 1920×1080 / 32 samples | 20 min |
| `ortho` | `isometricCutaway` | Python SVG, no Blender | 5 min |
| `ultra` | `fullRender` | local Blender, 2560×1440 / 256 samples | 45 min |
| `finish` | `styleFinish` | HTTP, `ai`-branch clone | 15 min |

`renderJob.spec` gains `buildingUrl`, `buildPlanUrl`, `frameId`, `styleId`, `expert`, `seed`. Worker stdout adds `ARCVIA_CAD_UNIT:`, `ARCVIA_CAD_SPACES:`, `ARCVIA_DIM_AGREEMENT:`, `ARCVIA_MITRE_FALLBACKS:`, `ARCVIA_RESIDUALS:` — the parser at `renderQueue.js:228-252` turns any `ARCVIA_*` key into `job.markers` with **zero code changes**. `Sample N/M` still drives progress; a non-Cycles job reports 0 progress for its run, mitigated by `elapsedMs` + markers.

### Credit costs — `packages/brand/plans.config.mjs:23`
```js
cadSurvey: 0,          // free, like /detect/document
cadReconstruct: 8,
cadAssemble: 12,
isometricCutaway: 3,
styleFinish: 4,
```
Confirmed today the map holds `sceneCreate:0, sceneSave:0, floorplanDetect:1, previewRender:1, isometricRender:3, fullRender:5, lightmapBake:25`. `spend()` throws `Unknown metered action` for any key not present, so this change lands first. `billingEnabled = false` and `planFor()` forces every account onto `free` with 100,000 credits, so this **meters and never charges** — `RENDER_DAILY_CAP` is the only real guard.

### Persistence
`services/api/src/store.js:21` `EMPTY` gains `buildings: []`, holding an **index only** — the model body goes through `storage.put()`. Every `db.update` rewrites the entire JSON file (189 users, 493 ledger rows already), so a 2 MB IR inline would make every progress tick unbearable. Do not add per-percent progress persistence. `services/api/src/routes/scenes.js:82`'s writable allow-list gains `buildingUrl`, `buildPlanUrl`, `projection` — a write to a field not on that list is silently dropped.

### The studio import path
```
BuildingModel
  -> packages/building-model/src/toPlan.ts
       for each Wall: planStore.addWall(plan, a, b, { thickness, height, snapRadius: 0.15 })
  -> Plan { version: 1 }   // NO migration, NO version bump
  -> Scene.plan (apps/studio/src/lib/api.ts:149)
```
`addWall` (`planStore.ts:271`) is the **only** correct insertion API: it welds to existing vertices within `max(WELD_DISTANCE=0.02, snapRadius)`, splits any wall it lands on mid-span so a T-junction becomes a real graph junction, finds every crossing and splits those, and chains the new run through all junctions in order. The studio already feeds detector output through it at `snapRadius: 0.15`, which is exactly what a CAD importer should do. `reserveIds()` must list **every** namespace — vertices, walls, floors, objects and now openings and links share one global counter, and objects were once missed, so placing furniture in a reopened plan silently overwrote an existing piece with no symptom but a count that would not go up.

Room names survive by `roomId(loop)` (`rooms.ts:172`): rotate the cycle so the lexicographically smallest vertex id leads, take `min(rotated, reversed)`, join with commas. `toPlan` maps `Space.name` into `Floor.roomNames` keyed by that hash, and the mapping is recorded in `PlanProjection` so `absorbPlanEdits` can carry a renamed room back.

---

## 7. Build sequence

Each milestone is independently shippable and verifiable. Day estimates are honest: the three rival designs estimated 32–48 days for scopes this size and the adversarial reviews put the real figures at 110–150. The engine core (M1–M6) is ~55–70 focused days; the render surface (M7–M9) is a second product and is budgeted as one.

**M1 — One real DXF → one loadable GLB, end to end.** *(8–10 days)*
Narrowest possible slice: `services/reconstruct` with `ingest/dxf.py` (lines + LWPOLYLINE bulges), `solve/units.py` (vendored `infer_scale_from_walls` only), `hypothesise/pair.py` + `joinCorners`, `hypothesise/perimeter.py`, a single hard-selected frame and storey, `build/solidify.py` with shapely mitre, `assemble_building.py`. No solver, no residuals, no HTTP — a CLI.
```
node tools/cad-engine/cli.mjs \
  --input "A:/Projects/CasaAltinho/_work/cad/dxf/LATEST DRAWINGS - SITE PLAN & ALL VILLAS  FOR 3D 24-11-23.dxf" \
  --frame e1-upper-ground --unit-hint auto --out A:/tmp/m1
# PASS: prints unit=m, walls>=40, spaces>=8, floorArea 120..400 m2, mitreFallbacks<10%
node tools/cad-engine/verify-glb.mjs A:/tmp/m1/e1.glb
# PASS: GLTFLoader parses, triangles 500..8000, every mesh name matches /^storey0\//
```

**M2 — DWG intake with the LibreDWG gate.** *(3 days)*
`ingest/dwg.py` version assertion + model-space entity + wall-length assertion, converter receipt on `SourceRef`.
```
python services/reconstruct/ingest/dwg.py "A:/Projects/CasaAltinho/Casa Altinho/ALL PLANS (16-4-24).dwg" --out A:/tmp/m2
# PASS: converter.version == "0.14", modelSpaceEntities > 10000, no CONVERTER_DROPPED_MODELSPACE
python services/reconstruct/test/test_dwg_gate.py   # asserts a synthetic empty-modelspace DXF is REFUSED
```

**M3 — Frames, units posterior, DimObs, and the Verify gate.** *(10–12 days)*
Stage 2 + stage 3 + stage 7. This is where the grafted DIMENSION dual role and the pre-GPU gate land, and it is the single highest value-per-day block in the plan.
```
python -m services.reconstruct.cli survey --input <dxf> --json A:/tmp/m3/survey.json
# PASS: frames >= 5 for the ALL PLANS sheet, each typed, each titled from its own text
python -m services.reconstruct.cli verify --model A:/tmp/m3/e1.building.json
# PASS: dimAgreement > 0.98, dimSamples > 20; and a deliberately mis-scaled model reports status='stale'
```

**M4 — Openings, fixtures, spaces at the finished face.** *(8–10 days)*
Three opening emitters, arc-length hosting, `cad.furniture()` → `Definition`/`Fixture`, shapely interior rings → `Space` with `boundedBy`, skirting cut at doorways, reveals.
```
python -m services.reconstruct.cli reconstruct --input <dxf> --frame e1-upper-ground --json A:/tmp/m4/
# PASS: openings >= 12, openingsUnassigned == 0, every Space.area within 5% of the drawing's printed size
node packages/building-model/test/run.mjs   # openings.test.ts: moving a vertex carries its doors
```

**M5 — Commit + label + relax + residuals.** *(12–15 days)*
Stages 5a/5b/6/8 with the conflict graph, ICM, IRLS-Huber CG, and `Residual[]` generation. `CadImport.tsx`.
```
python -m services.reconstruct.test.corpus --dir services/reconstruct/test/golden
# PASS across 12 drawings (7 Casa Altinho DXFs + 5 deliberately awful: a scan, a photo,
#   a vector PDF, a survey-grid drawing, a sheet holding four plans):
#   closedSpaceFraction >= 0.85, meanWallResidual <= 0.03 m, zero unhandled exceptions
npm --workspace @arcvia/building-model test   # golden fixture: TS and Python pairing agree exactly
```
**Do not start M5 without that 12-drawing corpus.** The solver is untestable otherwise and should not be funded.

**M6 — Storeys, registration, and the Arcvia integration.** *(10–12 days)*
Stage 3's storey half, `PRESETS` keys, `cad.js` routes, uploads/sniff/ALLOWED/bodyLimit, `store.js`, the **refund fix**, `timeoutFor` table, `toPlan` into the studio.
```
npm --workspace @arcvia/api test
node services/api/test/refund.test.mjs
# PASS: a deliberately failing local Blender job leaves ledger delta == 0 for that user
curl -F file=@"ALL PLANS (16-4-24).dwg" -H "Authorization: Bearer $T" localhost:8080/uploads/cad
# PASS: 201 with contentType image/vnd.dwg; a 40 MB file is NOT truncated at 32 MB
```

**M7 — BuildPlan two-emitter unification + atlas as data.** *(6–8 days)*
`emit/three.ts` replaces `buildGeometry.ts`'s guts; `lightmapUV.ts` and `render.py` both read `atlas.cells` at `layout: 'grid-v1'` (byte-identical, no migration, no baked GLB invalidated).
```
node apps/studio/test/run.mjs
# PASS: buildGeometry.test.ts's 4x3 m room still asserts the same mesh counts through the new path
node services/render-worker/check_atlas.test.mjs A:/tmp/m7/atlas.png
# PASS: exactly N cells used for N meshes, black gutters, coverage < 100% (100% means overlap)
```

**M8 — Deliverables: ortho SVG, isometric cutaway, camera solver.** *(8–10 days)*
```
node tools/cad-engine/cli.mjs --input <dxf> --deliverables plan,iso,interior --out A:/tmp/m8
# PASS: plan.svg opens with room names + m2; iso.png at 1920x1080 in < 4 min CPU Cycles;
#       views.json parses as SceneView[] and every camera has clearance >= 0.6 m
```

**M9 — Render surface: Engine/Expert/Style/Camera/Seed + AOVs + optional finish.** *(20–30 days — budget separately)*
`style_passes.py`, `aov.py`, `finish_ai.py`, the Layers/Adjust rails, Cryptomatte masking.
```
node services/render-worker/test/styles.test.mjs
# PASS: all 7 geometry-only styles render the SAME camera of the SAME model, byte-stable across runs
```

---

## 8. Open decisions

**1. Is the `BuildingModel` the persistent source of truth for a scene, or a one-shot importer?**
Round-trip means `absorbPlanEdits`, `patches`, `locked`/`suppressed` and re-import all exist, so a revised DWG can be merged over a drawing the architect has already corrected by hand — but every studio edit has to survive a lossy projection (arcs are chorded on the way out and come back as N locked straight walls, permanently destroying the curve). One-shot means the model is discarded after import, the studio `Plan` is the only record, `absorb.ts` and half the provenance machinery are never built (roughly 10–12 days saved), and a revised drawing means re-importing from scratch and redoing every manual fix. Which?

**2. Per-preset queue lanes, or keep the single global queue?**
`RENDER_CONCURRENCY` defaults to 1 and `drain()` is install-wide, so one 45-minute `assemble` blocks every 240 px preview for every user, and a CPU-only Cycles box makes that routine rather than rare. Lanes (a small weighted-slot rewrite of `drain()` at `renderQueue.js:120`, ~1–2 days) fix responsiveness but multiply worst-case CPU burn on a machine with no GPU for Cycles. Accept the block and show queue depth, or add lanes?

**3. Illustration/Watercolor as Freestyle NPR only, or route through Higgsfield img2img?**
Freestyle-only is fully deterministic, zero external dependency, zero credit cost, works offline — and looks like a line drawing with a wash, not like a painting. Higgsfield (`mcp__claude_ai_higg__generate_image`, funded and uncapped on this account) gets much closer to the mnml look, but its API takes reference images rather than true ControlNet depth/normal conditioning, so our AOV advantage is only partially realised and the output is non-deterministic. Ship both styles as NPR in v1, or wire the Higgsfield path?

**4. Does the engine own DWG→DXF conversion server-side, or do we accept DXF only?**
Owning it means `dwg2dxf.exe` must exist on every deploy host — today that is one Windows box with LibreDWG 0.14 at `A:/Tools/LibreDWG`, and a Linux deploy needs LibreDWG built from source. Accepting DXF only removes the whole `ingest/dwg.py` gate and the `AC10` sniff signature, but pushes a manual export step onto every architect who sends a DWG (which is most of them), and loses the converter receipt that makes the 0.13.3 empty-model-space failure loud instead of silent.

---

## 9. Known traps

**CAD and units**
- **LibreDWG 0.13.3 silently drops model space.** It parses AC1021 well enough to emit tables and block definitions — ~2,993 plausible entities — with no error and no drawing. 0.14 yields 26,194 model-space entities from the same file. Version-pin the converter, assert model-space entities *specifically*, and never fall back.
- **`$INSUNITS` lies.** A real drawing declares 4 (millimetres) and is authored in metres, and its extents are plausible under both readings so no sanity check catches it. Order of trust is **measured > header > extent**, and even the measured inference has landed on centimetres for a drawing known to be metres — which is why the shipped answer is `scaleCandidates` and one question. A wrong unit is not a subtle defect: it builds the villa 1000× too small and looks perfectly fine.
- **The same DWG converted twice gives different DXFs** — one with an empty model space (recovery discarded the blocks), another with 9,856 lines. Convert twice, keep the larger, record the count per conversion.
- **Walls are two face lines, not centrelines.** Extruding face lines gives paper-thin walls that look wrong at every door reveal.
- **A single unpaired line is a railing, not a wall.** Extrude it to ceiling height and every balcony becomes a sealed box that blacks out the rooms behind it.
- **Layer names are unguessable.** One practice used `walls`, `A1 WALLS`, `NEW WALLS`, `Wall`, and openings on `doors & windows`, `A4 DOOR WIN`, `door`, `WINDOW`, `WINDOW1` across seven drawings. `classify()` PRE-SELECTS; it never decides.
- **`LWPOLYLINE.get_points('xy')` throws away bulges** — the commonest curved-wall encoding. Use `'xyb'`.
- **`_SIZED_OPENING` must be checked BEFORE `_MEANINGLESS`.** `D750` shares its shape with genuine noise like `VXCBX` and `A$C00566C6E`; get the order wrong and 88 real door placements are discarded.
- **Survey grids sit 45 km from the origin.** Translate to `min(x), min(y)` — once per source, never per frame.
- **`cad.read()` returns non-serialisable `_segments`/`_origin`** — it cannot be handed straight to a FastAPI response.
- **`ezdxf` is undeclared and absent from the floorplan-ai venv** (confirmed). It exists only on system Python 3.14, which is why a stray `cad.cpython-314.pyc` sits beside `cpython-312` for everything else. Importing `cad` from `main.py` today crashes the service at startup.

**Rendering and Blender**
- **EEVEE renders BLACK under `--background`.** Every headless render must hard-set `engine='CYCLES'`.
- **No usable GPU for Cycles on this box:** ~55–60 s/frame at 1280×720 / 64 samples. A 120-frame orbit is ~2 hours. Every long render must be resumable (skip frames already on disk) and placed from frame index, never from previous camera state.
- **Cycles has never denoised BAKES** — `cycles.use_denoising` applies to renders only. Route the atlas through a compositor Denoise node.
- **`uv_layers.new()` does NOT unwrap**; Blender bakes `active_render`, not `active` (set both); and you must **deselect INSIDE the per-object loop** or `mode_set('EDIT')` enters multi-object edit mode and re-unwraps everything already packed. Diagnostic: a correct atlas for N objects uses exactly N cells with black gutters — 100% coverage means overlap.
- **Bake DIFFUSE without the colour pass, not COMBINED** — Three.js multiplies the lightMap by albedo and COMBINED double-applies colour. Force `view_transform` to Standard before save or AgX tone-maps the irradiance table.
- **Boolean modifiers fail on the coplanar faces** an in-face opening creates. Cut arithmetically.
- **Spawn Blender with `--factory-startup`** so a render cannot depend on installed add-ons.
- **The stdout contract is load-bearing:** `Sample N/M` drives progress and `ARCVIA_OUTPUT:<path>` is how the API learns where the result landed. Change either print and the job runs, exits 0, and is marked failed because `outputPath` is null.

**GPU and viewer**
- **Intel Arc returns unstable data from GPU texture readback.** CPU-side image data must never round-trip through a texture, and `SceneViewer.snapshot()` is banned from every derived-asset path.
- **`texture.channel = 1`** is mandatory for a lightmap since three r152, and materials must be **cloned per mesh** or one mesh's bake lights the whole scene. `flipY = false`.
- **`lightmapUV.ts` and `render.py` must produce the same cell for the same mesh index** — both use `ceil(sqrt(n))` in traversal order. Change one without the other and light leaks from the wrong room. Moving the table into `BuildPlan.atlas` removes the hazard permanently; until then, they change as a matched pair.
- **`exportForBake` uses `scene.clone(true)`, which SHARES geometry by reference — deliberately.** Deep-cloning looks tidier and silently breaks the round trip (bake succeeds, applies to nothing).
- **A mesh with an array material and no geometry groups draws NOTHING.** This is the bug that made a published walkthrough render an empty sky and the reason `packages/viewer` exists.
- **The Draco decoder is a hardcoded gstatic CDN path.** Every GLB we emit is Draco level 6; offline or CSP-restricted delivery fails with an unhelpful parse error.
- **three 0.171's `GLTFExporter` binary path calls `new FileReader()` unconditionally**; Node 24 has none, so headless GLB export needs a shim and re-verification on any three bump.
- **OrbitControls and an animation loop cannot both own the camera** — driving the camera while controls are enabled produces a black canvas.

**API and platform**
- **`finish()` at `renderQueue.js:141` never refunds** (confirmed: it calls only `db.update`). In `RENDER_MODE=local` a failed job keeps the money — 29 failed jobs against 6 refund rows in the live database. Fix this before adding a 12-credit job type.
- **`bodyLimit` (server.js:27) and multipart `fileSize` (server.js:48) are both 32 MB** while route branches claim 64 MB, making those branches unreachable. Raise both together.
- **`reconcileRenderJobs`' `if (PRESETS[job.preset])` guard at render.js:97** means a job type not registered in `PRESETS` silently never refunds its orphans.
- **`refund()` uses the CURRENT tariff from `creditCost`**, not the recorded `job.creditsCharged`. Move a price and all three refund sites misbehave together.
- **`store.js` serialises writes through a promise chain** because `await` yields between read and write. Do not simplify it. Every `db.update` rewrites the entire JSON file — never persist per-percent progress.
- **Queue state is entirely in memory.** A deploy, crash or `--watch` file save destroys an in-flight 45-minute assemble, and `reconcileRenderJobs` fails it wholesale after the CPU is spent. Checkpoint the `BuildingModel` to storage at the end of stage 7 so a restart loses the Blender half but not the extraction half. There is no idempotency key on submit — a double-clicked assemble charges and runs twice.
- **`apps/web/src/pages/pricing.astro:15-20` is hand-maintained**, not generated from `creditCost`, and silently goes stale.
- **`scenes.js:82`'s writable allow-list** silently drops a write to any field not on it.
- **The `rapidocr` / `opencv-python-headless` conflict:** `pip install -r requirements.txt` will uninstall the headless build. The mandated sequence is `pip install onnxruntime` then `pip install --no-deps rapidocr-onnxruntime`, and on Windows uvicorn must be stopped first or the uninstall dies with WinError 5 holding `cv2.pyd`. This is why `services/reconstruct` gets its own venv and never installs rapidocr.
- **Python 3.10–3.12 only** for these services; 3.13+ has no wheel story here.
- **Never round-trip UTF-8 files through PowerShell 5.1 default encodings** — use the Edit tool or Node. This is why `cad.py` is vendored with a parity test rather than pinned by sha256 across services.
- **The id counter is global** across vertices, walls, floors, objects (and now openings, links). `reserveIds()` must list every namespace or a reopened plan silently overwrites existing elements with no symptom but a count that will not go up.
- **Do not revert the room-first detector to per-stroke classification.** A double bed and a partition wall are the same length, weight and colour; the symptom is 92 confident walls enclosing 0 rooms.