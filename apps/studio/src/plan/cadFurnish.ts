import type { Proposal } from './furnish'
import { CATALOGUE } from '../catalogue/items'
import type { Size } from '../catalogue/types'

/**
 * Furnishing a plan from a CAD reconstruction.
 *
 * ── Why this is a different door into the same room ─────────────────────────
 * The raster path (`furnish.ts`) reads furniture out of an *image*: regions,
 * labels, guesses. A DWG needs none of that — every block reference carries an
 * exact position, rotation and footprint placed there by the architect, and
 * the engine's four-signal classifier has already resolved each block to a
 * catalogue item id with a confidence and a review flag. What arrives here is
 * not a detection but a statement, so this converter's whole job is to change
 * its shape, not to second-guess it.
 *
 * Both doors end at the same place on purpose: a `Proposal[]` into the same
 * FurnitureReview the raster path uses. One review surface, one accept path,
 * one credit trail — a second bespoke flow for CAD would drift from the first
 * within a month.
 *
 * ── Coordinates: identity, and that is load-bearing ─────────────────────────
 * Fixture positions arrive in the engine's sheet frame, already origin-shifted
 * and scaled to metres — the same frame the reconstructed walls and the GLB's
 * vertices use (verified on the villa: walls span x 90.6–119.2, fixtures
 * x 91.5–119.8). The GLB maps plan (x, y) to glTF (x, height, −y); the
 * studio places objects at (x, elevation, −y). Same convention, so a fixture
 * dropped at its reported position lands inside the room the model shows it
 * in. Do NOT re-transform here — the double-shift has already been a real bug
 * in the engine's own probes.
 */

/** One placement from `building.json`'s `elements.fixtures`. */
export interface CadFixture {
  block: string
  position: { x: number; y: number }
  /** Radians, counter-clockwise — converted from DXF degrees engine-side. */
  rotation: number
  room: string | null
  footprint: { w: number; d: number }
  label: string
  /** Catalogue item id, or null when the classifier could not name it. */
  item: string | null
  confidence: { score: number; margin: number }
  needsReview: boolean
  /** Present after a multi-storey merge; absent means storey 0. */
  storey?: number
}

/** One per-storey element block — only the registration is read here. */
export interface CadStoreyBlock {
  storey: number
  title?: string | null
  level?: number
  /**
   * The registration shift the engine applied to this storey's MESHES to
   * stack frames drawn at different spots on the sheet. Fixtures are
   * recorded in frame coordinates WITHOUT it — the engine's own comment
   * says so — and on the villa the Lower Ground's shift is (0, −17.578):
   * skipping it stood every basement bed 17.6 metres outside the building,
   * visibly, in the composed 3D view. Single-frame builds have no storey
   * blocks and no shift, which is the identity contract below.
   */
  shift?: [number, number]
  spaces?: CadSpace[]
  walls?: CadWall[]
  openings?: CadOpening[]
}

export interface CadWall {
  a: { x: number; y: number }
  b: { x: number; y: number }
  thickness: number
}

/** One measured room polygon from reconstruction's building.json. */
export interface CadSpace {
  index: number
  name?: string | null
  kind?: string | null
  area?: number
  loop: [number, number][]
  boundedBy?: number[]
}

export interface CadOpening {
  kind: 'door' | 'window' | 'opening' | string
  /** Index into the wall list of this storey block. */
  wall: number
  /** Metres from wall.a along the wall centreline. */
  along: number
  width: number
  height: number
  sill: number
  source?: string
  confidence?: number
}

/** The slice of building.json this reads. Everything else is ignored. */
export interface CadModel {
  wallHeight?: number
  storeys?: { primary?: number }
  elements?: {
    fixtures?: CadFixture[]
    walls?: CadWall[]
    spaces?: CadSpace[]
    openings?: CadOpening[]
    storeys?: CadStoreyBlock[]
  }
}

const BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]))

/**
 * The drawn footprint, unless it plainly disagrees with the catalogue.
 *
 * The same rule as the raster path, for the same reason: a footprint more than
 * double or under half the catalogue's is not this object drawn differently —
 * on a DWG it is usually a block that bundles a whole wardrobe RUN, or one
 * whose definition units lied. The catalogue size in the right place beats a
 * two-metre bedside table.
 */
function measured(itemId: string, w: number, d: number): Size | undefined {
  const item = BY_ID.get(itemId)
  if (!item || !w || !d) return undefined

  const drawn = w * d
  const expected = item.size.width * item.size.depth
  if (!expected || drawn / expected > 2 || drawn / expected < 0.5) return undefined

  return { width: w, depth: d, height: item.size.height }
}

/**
 * Proposals from a reconstruction, for one storey.
 *
 * Unnamed blocks are dropped rather than guessed at: the engine already tried
 * name, layer, footprint and room context, and what survived all four with no
 * item is a manhole cover or a north arrow. `needsReview` placements are kept
 * — a flagged sofa in the review list beats a silently missing one — with
 * their confidence carried through so the review can sort by it.
 */
export function furnishFromCad(model: CadModel, { storey = 0 }: { storey?: number } = {}): Proposal[] {
  const fixtures = model.elements?.fixtures ?? []
  const [shiftX, shiftY] = model.elements?.storeys?.find((s) => s.storey === storey)?.shift ?? [0, 0]

  return fixtures
    .filter((fixture) => (fixture.storey ?? 0) === storey)
    .filter((fixture) => fixture.item !== null && BY_ID.has(fixture.item))
    // Floor furniture only. The engine also classifies door and window blocks
    // — rightly, for its own bill of quantities — but those are in-wall
    // items here, and they are already in the reconstruction as hosted
    // openings. Proposing them as furniture would stand eight door leaves
    // in the middle of the villa's rooms. (Found on the villa, not foreseen.)
    .filter((fixture) => BY_ID.get(fixture.item as string)?.placement === 'floor')
    .map((fixture) => ({
      item: fixture.item as string,
      position: { x: fixture.position.x + shiftX, y: fixture.position.y + shiftY },
      rotation: fixture.rotation,
      size: measured(fixture.item as string, fixture.footprint.w, fixture.footprint.d),
      room: fixture.room,
      storey,
      storeyName: model.elements?.storeys?.find((candidate) => candidate.storey === storey)?.title ?? undefined,
      // A drawn, named block is the strongest evidence class the review
      // distinguishes — the architect put it there.
      evidence: 'labelled' as const,
      confidence: fixture.confidence.score,
      because:
        `drawn as "${fixture.block}"` +
        (fixture.room ? ` in ${fixture.room}` : '') +
        (fixture.needsReview ? ' — the classifier is unsure, check it' : ''),
    }))
}

/** Which storeys carry fixtures, for a caller that wants to offer a choice. */
export function cadStoreys(model: CadModel): number[] {
  const seen = new Set<number>()
  for (const fixture of model.elements?.fixtures ?? []) seen.add(fixture.storey ?? 0)
  return [...seen].sort((a, b) => a - b)
}
