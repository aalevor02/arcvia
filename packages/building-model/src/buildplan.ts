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
import type { Id, M, P2, Provenance, Rad } from './schema'

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
