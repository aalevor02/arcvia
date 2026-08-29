import type { Underlay, Vec2 } from './types'
import { WALL_DEFAULTS } from './types'
import { add, distance, dot, labelPoint, normalise, pointInPolygon, scale, sub } from './geometry'

/**
 * Turn detector output into walls.
 *
 * ── The problem this exists to solve ────────────────────────────────────────
 * The detector traces *ink*, and a wall on an architectural drawing is drawn as
 * two parallel lines — its two faces. So a plan with 20 walls comes back as
 * roughly 40 segments, in pairs a few millimetres apart.
 *
 * Importing those directly produces a graph full of hairline slivers: two
 * "rooms" per wall, areas that are nonsense, and a 3D model made of paired
 * cardboard sheets. The pairing step below is what turns ink back into walls —
 * two faces become one centreline whose *thickness is the distance between
 * them*, which is a genuinely better number than any default, because it is
 * measured from the drawing.
 *
 * Unpaired segments are kept at a default thickness rather than discarded: a
 * single-line wall is common on smaller-scale drawings, and dropping it loses
 * real geometry.
 */

export interface DetectedPoint {
  /** Normalised 0..1 across the image. */
  x: number
  y: number
}

export interface DetectedWall {
  start: DetectedPoint
  end: DetectedPoint
  /** Normalised against image width. */
  thickness: number
  confidence: number
  /**
   * What the reader's adjudicator judged this line to be. Absent from an
   * older reader, and absent means wall -- which is what every line was
   * treated as before, so an old reader behaves exactly as it used to.
   */
  kind?: 'wall' | 'railing' | 'boundary'
}

export interface DetectedObject {
  label: string
  /** [x, y, w, h], normalised. */
  bbox: number[]
  confidence: number
  attaches_to: 'wall' | 'floor'
}

/**
 * An area the reader found enclosed, and what the drawing calls it.
 *
 * Rooms come back from the reader rather than being worked out here, because
 * the reader has to find them anyway — deciding which strokes are walls at all
 * depends on which of them bound a room. Sending only the walls would mean
 * throwing that away and rediscovering it, worse, from less information.
 */
export interface DetectedRoom {
  polygon: DetectedPoint[]
  /** Fraction of the building's footprint. */
  area: number
  /** Whatever was printed inside it, if anything was. */
  name: string | null
  /** `fitting` is joinery the drawing labelled — a wardrobe, a dresser. */
  kind: 'room' | 'fitting'
  /** The size printed inside it, in metres. */
  size: number[] | null
  /** Other room names inside the same outline: proof two spaces read as one. */
  also: string[]
}

/** A measured or feature-inferred scale reported by the plan reader. */
export interface DetectedScale {
  /** Metres per 1.0 of normalised x - that is, across the whole image. */
  metres_per_unit: number
  /** How many independent readings agreed on it. */
  samples: number
  /** How far apart they were. Null from a single reading. */
  spread: number | null
  /** Older readers omitted this; omission means the original measured method. */
  method?: 'measured' | 'inferred'
  /** Feature rulers that agreed when method is inferred. */
  agreed?: string[]
}

export function automaticScalePerPixel(
  scale: DetectedScale | null | undefined,
  imageWidth: number,
): number | null {
  if (!scale || scale.method === 'inferred' || imageWidth <= 0) return null
  if (scale.metres_per_unit < 3 || scale.metres_per_unit > 48) return null
  return scale.metres_per_unit / imageWidth
}

export interface DetectionResult {
  backend: string
  width: number
  height: number
  walls: DetectedWall[]
  objects: DetectedObject[]
  /** Absent from older readers, so every use has to tolerate undefined. */
  rooms?: DetectedRoom[]
  scale?: DetectedScale | null
  low_confidence: boolean
  /** The vision adjudicator's account of what it changed. Absent from
   *  readers without one configured, so every use tolerates undefined. */
  notes?: string[]
}

/** A wall ready to be drawn into the plan, in world metres. */
export interface ProposedWall {
  a: Vec2
  b: Vec2
  thickness: number
  /** Carried from the reader so the builder can stop short of the ceiling. */
  kind?: 'wall' | 'railing' | 'boundary'
  /** True when this came from a matched pair of drawn faces. */
  paired: boolean
  confidence: number
}

export interface ConversionOptions {
  /**
   * Faces further apart than this are different walls, not two sides of one.
   * Metres. Half a metre is thicker than any partition and thinner than a room.
   */
  maxWallThickness?: number
  /** Below this, two lines are the same drawn stroke, not a wall. */
  minWallThickness?: number
  /** Segments shorter than this are dimension ticks and lettering. */
  minLength?: number
  /** How parallel two faces must be to pair, in degrees. */
  angleToleranceDeg?: number
  /**
   * How far a wall end may be extended to meet a neighbour. Metres.
   *
   * Generous, because trimming can leave a gap of about half a wall thickness
   * at each corner and the detector often stops a stroke short of the join.
   * Bounded by the fact that it only ever snaps to a near-perpendicular wall
   * that is already close.
   */
  cornerTolerance?: number
  /**
   * Two segments closer than this, and near enough to parallel, are the same
   * wall. Used to stop a room-polygon edge duplicating a wall the face pass
   * already found. Metres.
   */
  roomEdgeTolerance?: number
  /**
   * Draw the reader's room polygons as walls where no wall was found.
   *
   * On a clean CAD export this changes almost nothing: every polygon edge sits
   * on a wall the face pass already produced and is dropped as a duplicate. It
   * exists for the styled presentation plan, where it is the difference between
   * a usable plan and an empty one. See `wallsFromRooms`.
   */
  useRoomPolygons?: boolean
}

const DEFAULTS: Required<ConversionOptions> = {
  maxWallThickness: 0.5,
  minWallThickness: 0.04,
  minLength: 0.35,
  angleToleranceDeg: 6,
  cornerTolerance: 0.6,
  roomEdgeTolerance: 0.12,
  useRoomPolygons: false,
}

/**
 * Map a normalised detector point into world space, through the underlay.
 *
 * This is why detection needed the underlay first: the detector works in image
 * fractions and has no idea how big the building is. The underlay carries the
 * two facts that make the conversion possible — where the image sits, and how
 * many metres a pixel is worth.
 */
export function toWorld(point: DetectedPoint, underlay: Underlay): Vec2 {
  return {
    x: underlay.origin.x + point.x * underlay.width * underlay.scale,
    // Image y runs down, world y runs up.
    y: underlay.origin.y - point.y * underlay.height * underlay.scale,
  }
}

export function convertDetections(
  result: DetectionResult,
  underlay: Underlay,
  options: ConversionOptions = {},
): ProposedWall[] {
  const config = { ...DEFAULTS, ...options }

  const segments = result.walls
    .map((wall) => ({
      a: toWorld(wall.start, underlay),
      b: toWorld(wall.end, underlay),
      confidence: wall.confidence,
      // The reader's verdict, carried rather than recomputed. Adding `kind` to
      // the interfaces was not enough: this map built the segment without it,
      // so every wall arrived at the editor undefined and the railing type was
      // never applied. Every link was tested and the JOIN between them was not.
      kind: wall.kind,
    }))
    .filter((s) => distance(s.a, s.b) >= config.minLength)

  const paired = joinCorners(pairFaces(segments, config), config.cornerTolerance)
  if (!config.useRoomPolygons) return paired

  const filled = wallsFromRooms(result, underlay, config, paired)
  if (!filled.length) return paired

  // NOT joined again. Each polygon arrives closed and its consecutive edges
  // already share exact endpoints, which `addWall` welds. Passing them through
  // joinCorners moves those endpoints onto crossings with unrelated walls and
  // reopens the loop the polygon was providing.
  return [...paired, ...filled]
}

/**
 * Walls along the reader's room polygons, minus everything already found.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Measured on the owner's own uploaded plan, a rendered presentation drawing:
 * the reader returned 12 walls and NINE room polygons. Those 12 walls convert
 * to 11 proposals, and 13 of the resulting 17 vertices are dangling ends. The
 * median distance from a dangling end to its nearest neighbour is 1.71 m, and
 * only 2 of 13 gaps fall under the 0.6 m `cornerTolerance`.
 *
 * That number is the whole argument. `joinCorners` was built for a plan whose
 * walls miss each other by centimetres, and it closes those. Here the walls are
 * METRES apart, because on a styled drawing most of them were never detected at
 * all — furniture, shading and hatching hide them. No corner tolerance reaches
 * 3.9 m without welding walls across unrelated rooms, so widening it cannot be
 * the fix and would make the output worse while appearing to try.
 *
 * The missing structure is not missing from the RESPONSE, only from the walls
 * array: the same reader returned nine closed polygons carrying 88 edges and
 * 73.83 m2. The plan reported zero rooms over a drawing whose rooms the reader
 * had already outlined.
 *
 * So this draws them. Edges duplicating a wall the face pass found are dropped,
 * which is what makes it safe to run always: on a clean export nearly every
 * edge is a duplicate and the result is unchanged.
 *
 * These are marked `paired: false`, because they are not a matched pair of
 * drawn faces and `summarise` counts them separately. A user accepting them
 * should be able to see how much of the plan was inferred rather than measured.
 */
export function wallsFromRooms(
  result: DetectionResult,
  underlay: Underlay,
  config: Required<ConversionOptions>,
  existing: ProposedWall[],
): ProposedWall[] {
  const rooms = result.rooms ?? []
  if (!rooms.length) return []

  // Thickness is not observable from a polygon edge, so it is borrowed from
  // what the face pass measured on this very drawing rather than guessed from
  // a constant. Falling back to the interior default only when nothing paired.
  const measured = existing.filter((w) => w.paired).map((w) => w.thickness).sort((a, b) => a - b)
  const thickness = measured.length
    ? measured[Math.floor(measured.length / 2)]
    : WALL_DEFAULTS.interior.thickness

  const kept: ProposedWall[] = []

  for (const room of rooms) {
    const polygon = withoutNeedles(
      (room.polygon ?? []).map((point) => toWorld(point, underlay)),
    )
    if (polygon.length < 3) continue

    // EVERY edge, including short ones. A polygon is only useful while it is
    // closed, and a loop with one edge missing encloses nothing at all -- the
    // same all-or-nothing property that makes `minLength` right for loose
    // segments and wrong here.
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]
      const b = polygon[(index + 1) % polygon.length]
      if (distance(a, b) < 1e-6) continue // a repeated point, not an edge

      const candidate: ProposedWall = {
        a,
        b,
        thickness,
        paired: false,
        confidence: 0.5,
      }

      // Dropped only when the face pass already drew THIS EDGE -- both ends
      // within `roomEdgeTolerance`, not merely running alongside. Adjacent
      // rooms are separated by a wall thickness, so a proximity test deletes
      // real boundaries. Deliberately no dedupe between polygons for the same
      // reason: two rooms sharing a partition legitimately contribute two
      // walls, one per inside face, which is what a partition is.
      if (existing.some((wall) => alreadyDrawn(candidate, wall, config))) continue

      kept.push(candidate)
    }
  }

  return kept
}

/**
 * Did the face pass already draw THIS edge?
 *
 * Identity, not proximity. Both endpoints of the candidate must lie on the
 * other wall, which two boundaries a partition apart do not satisfy. An earlier
 * version asked only "parallel and close", and on this plan that deleted six of
 * the nine rooms by removing one wall from each of their loops.
 */
function alreadyDrawn(
  candidate: ProposedWall,
  other: ProposedWall,
  config: Required<ConversionOptions>,
): boolean {
  if (!isParallel(candidate, other, config.angleToleranceDeg * 2)) return false

  const tolerance = config.roomEdgeTolerance
  return (
    distanceToSegment(candidate.a, other) <= tolerance &&
    distanceToSegment(candidate.b, other) <= tolerance
  )
}

/**
 * Extend wall ends to meet at corners.
 *
 * ── Why this step is not optional ───────────────────────────────────────────
 * Pairing trims each centreline to where its two faces overlap, which is
 * correct — but at a corner the faces stop where the *other* wall's faces
 * begin, so both centrelines end roughly half a wall thickness short of where
 * they should meet.
 *
 * The result looks completely right and encloses nothing. Every wall is a few
 * centimetres from its neighbours, no cycle closes, and the plan reports zero
 * rooms and zero area over a drawing that plainly has fifteen. That is exactly
 * the failure this codebase keeps running into: geometry that renders fine and
 * is topologically wrong.
 *
 * So: for every endpoint, find a near-perpendicular neighbour whose line it
 * nearly meets, and move it onto the intersection. Both walls then share a
 * point, `addWall` welds them into one vertex, and the cycle closes.
 */
export function joinCorners(walls: ProposedWall[], tolerance: number): ProposedWall[] {
  const joined = walls.map((w) => ({ ...w }))

  for (const wall of joined) {
    for (const end of ['a', 'b'] as const) {
      const point = wall[end]
      let best: { point: Vec2; distance: number } | null = null

      for (const other of joined) {
        if (other === wall) continue

        // Only corners. Two nearly-parallel walls have no meaningful crossing,
        // and forcing one produces a point far off down the drawing.
        if (isParallel(wall, other, 25)) continue

        const crossing = lineIntersection(wall, other)
        if (!crossing) continue

        const reach = distance(point, crossing)
        if (reach > tolerance) continue

        // The crossing must also be on, or just past, the other wall — not
        // somewhere out in space where its infinite line happens to pass.
        if (distanceToSegment(crossing, other) > tolerance) continue

        if (!best || reach < best.distance) best = { point: crossing, distance: reach }
      }

      if (best) wall[end] = best.point
    }
  }

  return joined
}

/** Where two walls' infinite lines cross, or null if they are parallel. */
function lineIntersection(p: { a: Vec2; b: Vec2 }, q: { a: Vec2; b: Vec2 }): Vec2 | null {
  const r = sub(p.b, p.a)
  const s = sub(q.b, q.a)
  const denominator = r.x * s.y - r.y * s.x
  if (Math.abs(denominator) < 1e-12) return null

  const offset = sub(q.a, p.a)
  const t = (offset.x * s.y - offset.y * s.x) / denominator
  return add(p.a, scale(r, t))
}

/** Shortest distance from a point to a segment (zero if it lies on it). */
function distanceToSegment(point: Vec2, segment: { a: Vec2; b: Vec2 }): number {
  const d = sub(segment.b, segment.a)
  const lengthSquared = dot(d, d)
  if (lengthSquared === 0) return distance(point, segment.a)

  const t = Math.max(0, Math.min(1, dot(sub(point, segment.a), d) / lengthSquared))
  return distance(point, add(segment.a, scale(d, t)))
}

interface Segment {
  a: Vec2
  b: Vec2
  confidence: number
  /** The reader's verdict, carried through pairing to the finished wall. */
  kind?: 'wall' | 'railing' | 'boundary'
}

/**
 * Match segments into face pairs and collapse each pair to a centreline.
 *
 * Greedy nearest-match rather than a global optimum. Two faces of one wall are
 * dramatically closer to each other than to anything else, so the greedy answer
 * and the optimal answer agree in practice — and a global matching over a few
 * hundred segments is not worth the code it would take to be occasionally
 * righter about a case that does not occur.
 */
function pairFaces(segments: Segment[], config: Required<ConversionOptions>): ProposedWall[] {
  const used = new Set<number>()
  const walls: ProposedWall[] = []

  // Longest first: a long wall's faces are the least ambiguous match, and
  // consuming them early stops a short stub stealing one of them.
  const order = segments
    .map((_, i) => i)
    .sort((i, j) => segLength(segments[j]) - segLength(segments[i]))

  for (const i of order) {
    if (used.has(i)) continue
    const segment = segments[i]

    let best: { index: number; gap: number } | null = null

    for (const j of order) {
      if (j === i || used.has(j)) continue
      const other = segments[j]

      if (!isParallel(segment, other, config.angleToleranceDeg)) continue

      const gap = perpendicularGap(segment, other)
      if (gap < config.minWallThickness || gap > config.maxWallThickness) continue

      // Faces of one wall run alongside each other. Two parallel segments at
      // opposite ends of the building are also "parallel and 0.2m apart" in the
      // perpendicular sense, so overlap along the shared direction is what
      // actually distinguishes them.
      if (overlapAlong(segment, other) < config.minLength) continue

      if (!best || gap < best.gap) best = { index: j, gap }
    }

    if (best) {
      used.add(i)
      used.add(best.index)
      // Two faces of one wall. If either face was read as a railing, the wall
      // is a railing: a parapet drawn as a pair should not lose the verdict
      // because only one of its lines carried it.
      const merged = centreline(segment, segments[best.index], best.gap)
      merged.kind = segment.kind && segment.kind !== 'wall'
        ? segment.kind
        : segments[best.index].kind
      walls.push(merged)
    } else {
      used.add(i)
      walls.push({
        a: segment.a,
        b: segment.b,
        thickness: WALL_DEFAULTS.interior.thickness,
        paired: false,
        confidence: segment.confidence,
        kind: segment.kind,
      })
    }
  }

  return walls
}

const segLength = (s: Segment) => distance(s.a, s.b)

function direction(s: Segment): Vec2 {
  return normalise(sub(s.b, s.a))
}

function isParallel(p: Segment, q: Segment, toleranceDeg: number): boolean {
  const cosine = Math.abs(dot(direction(p), direction(q)))
  // Absolute value, because a face drawn in the opposite direction is still the
  // same wall — the detector has no reason to be consistent about which way it
  // traces a line.
  return cosine >= Math.cos((toleranceDeg * Math.PI) / 180)
}

/** Distance from q's midpoint to p's infinite line. */
function perpendicularGap(p: Segment, q: Segment): number {
  const mid = { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 }
  const d = direction(p)
  const offset = sub(mid, p.a)
  const along = dot(offset, d)
  const projected = add(p.a, scale(d, along))
  return distance(mid, projected)
}

/** How much the two segments overlap when projected onto p's direction. */
function overlapAlong(p: Segment, q: Segment): number {
  const d = direction(p)
  const project = (point: Vec2) => dot(sub(point, p.a), d)

  const pRange = [project(p.a), project(p.b)].sort((m, n) => m - n)
  const qRange = [project(q.a), project(q.b)].sort((m, n) => m - n)

  return Math.max(0, Math.min(pRange[1], qRange[1]) - Math.max(pRange[0], qRange[0]))
}

/**
 * Collapse two faces to the wall between them.
 *
 * The centreline is trimmed to the *overlapping* part. Faces frequently differ
 * in length — one runs past a doorway the other stops at — and averaging the
 * raw endpoints would produce a wall that is half real and half invented.
 */
function centreline(p: Segment, q: Segment, gap: number): ProposedWall {
  const d = direction(p)
  const project = (point: Vec2) => dot(sub(point, p.a), d)

  const pRange = [project(p.a), project(p.b)].sort((m, n) => m - n)
  const qRange = [project(q.a), project(q.b)].sort((m, n) => m - n)

  const from = Math.max(pRange[0], qRange[0])
  const to = Math.min(pRange[1], qRange[1])

  const onP = (t: number) => add(p.a, scale(d, t))

  // Offset the line by half the gap, towards q.
  const mid = { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 }
  const toQ = normalise(sub(mid, add(p.a, scale(d, project(mid)))))
  const shift = scale(toQ, gap / 2)

  return {
    a: add(onP(from), shift),
    b: add(onP(to), shift),
    thickness: gap,
    paired: true,
    confidence: Math.min(p.confidence, q.confidence),
  }
}

/** Summary for the review step, so the user is told what they are accepting. */
export function summarise(walls: ProposedWall[]): {
  total: number
  paired: number
  totalLength: number
  medianThickness: number
} {
  const paired = walls.filter((w) => w.paired)
  const thicknesses = paired.map((w) => w.thickness).sort((a, b) => a - b)

  return {
    total: walls.length,
    paired: paired.length,
    totalLength: walls.reduce((sum, w) => sum + distance(w.a, w.b), 0),
    medianThickness: thicknesses.length
      ? thicknesses[Math.floor(thicknesses.length / 2)]
      : WALL_DEFAULTS.interior.thickness,
  }
}

/**
 * Names for imported rooms, taken from what the architect printed inside them.
 *
 * Deliberately keyed on the reader's own regions rather than re-running text
 * matching here. The reader read the labels, decided which region each one fell
 * in, and even chose between its two binarisations by counting how many named
 * rooms each one closed. Re-deriving that in the studio would be a second,
 * worse implementation of a decision already made on better evidence.
 *
 * A region whose centroid lands inside a derived room gives that room its name.
 * Larger regions are applied first so that when a big outline and a small one
 * both fall inside the same derived room -- which happens when two spaces read
 * as one -- the room takes the name of the space that dominates it rather than
 * of a cupboard inside it.
 */
export function namesFromDrawing(
  rooms: Array<{ id: string; polygon: Vec2[] }>,
  outlines: DetectedRoom[],
  underlay: Underlay,
): Record<string, string> {
  const named = (outlines ?? [])
    // A fitting is joinery, not a space. The reader draws that distinction
    // deliberately -- "`fitting` is joinery the drawing labelled -- a wardrobe,
    // a dresser" -- and ignoring it names a room after the cupboard standing in
    // it. Measured on the owner's own plan: the Wardrobe outline claimed a
    // 13 m2 room, which is the bedroom the wardrobe is inside.
    .filter((region) => region.kind !== 'fitting')
    .filter((region) => (region.name ?? '').trim().length > 0)
    .slice()
    .sort((a, b) => (b.area ?? 0) - (a.area ?? 0))

  const out: Record<string, string> = {}
  if (!named.length || !rooms.length) return out

  for (const region of named) {
    const points = (region.polygon ?? []).map((point) => toWorld(point, underlay))
    if (points.length < 3) continue
    // `labelPoint`, not a centroid. Measured on the owner's Avarana Basement:
    // the reader named Patio, Shower and Toilet and only two arrived, because
    // Toilet is a twelve-point outline and the centroid of a concave polygon
    // can lie outside it -- its anchor fell inside zero of the eight derived
    // rooms. labelPoint returns the centroid when it is inside and otherwise
    // sweeps for the widest interior span, so it is inside by construction.
    // Room.label is built the same way; this was the one place that re-derived
    // a naive centre.
    const centre = labelPoint(points)
    for (const room of rooms) {
      if (out[room.id]) continue
      if (!pointInPolygon(centre, room.polygon)) continue
      out[room.id] = (region.name ?? '').trim()
      break
    }
  }
  return out
}

/**
 * Drop needle tips from a traced contour.
 *
 * The reader's outlines are traced contours, not drafted polygons, and one can
 * run out to a point and come straight back along the same line. The damage is
 * NOT local to the region that carries the needle.
 *
 * Measured on the owner's Avarana Basement: an unnamed region reaches
 * y 0.8932 -> 0.678 -> 0.8932, a 2.69 m spike lying at x 0.345 -- 6 cm from the
 * TOILET's right wall at x 0.3412. `addWall` snaps within 0.15 m, so the spike
 * lands on top of that wall and consumes it, the two rooms collapse into one
 * face, and the word TOILET printed on the drawing has no room left to name.
 * The Toilet's OWN two needles are harmless; removing only those changes
 * nothing. That is why this runs over every outline rather than the one that
 * looks damaged -- a needle is a hazard to its neighbours, not to itself.
 *
 * The test is the TURN, not the length. At a needle tip the edge arriving and
 * the edge leaving point in nearly opposite directions, which is a property of
 * the artefact. A length threshold would have to guess how thin a real room may
 * be, and would have missed this one anyway: the spike is 2.69 m long.
 *
 * This does not weaken the rule that every edge of an outline is kept. A tip is
 * not an edge of the enclosed shape; removing it leaves the loop closed and
 * shorter, where dropping a real edge would open it.
 */
function withoutNeedles(polygon: Vec2[]): Vec2[] {
  if (polygon.length < 4) return polygon

  const kept: Vec2[] = []
  for (let i = 0; i < polygon.length; i += 1) {
    const previous = kept.length ? kept[kept.length - 1] : polygon[(i - 1 + polygon.length) % polygon.length]
    const current = polygon[i]
    const next = polygon[(i + 1) % polygon.length]

    const incoming = sub(current, previous)
    const outgoing = sub(next, current)
    const lengths = Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y)
    if (lengths > 0) {
      const turn = (incoming.x * outgoing.x + incoming.y * outgoing.y) / lengths
      // -1 is a complete reversal. -0.98 is about 11 degrees off one.
      if (turn < -0.98) continue
    }
    kept.push(current)
  }
  return kept.length >= 3 ? kept : polygon
}
