import type { Vec2 } from './types'

/**
 * Plane geometry for the floor-plan editor. Pure functions, no state, no DOM —
 * which is what makes the drawing behaviour testable without a canvas.
 */

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
export const length = (a: Vec2): number => Math.hypot(a.x, a.y)
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)

export function normalise(a: Vec2): Vec2 {
  const l = length(a)
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

/** Unit normal, 90 degrees counter-clockwise from `a`. Used for wall thickness. */
export const perpendicular = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

/**
 * Signed area of a polygon (the shoelace formula).
 *
 * The *sign* carries the winding direction and is load-bearing here: face
 * extraction uses it to tell an enclosed room (positive, counter-clockwise)
 * from the outer boundary of the building (negative). Taking the absolute value
 * too early is how the outside of the house becomes the biggest room in it.
 */
export function signedArea(points: Vec2[]): number {
  let total = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    total += p.x * q.y - q.x * p.y
  }
  return total / 2
}

export const area = (points: Vec2[]): number => Math.abs(signedArea(points))

export function centroid(points: Vec2[]): Vec2 {
  const a = signedArea(points)

  // Degenerate (collinear) polygons have zero area and would divide by zero.
  // The vertex average is a poor centroid but a finite one.
  if (Math.abs(a) < 1e-9) {
    const sum = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 })
    return scale(sum, 1 / Math.max(1, points.length))
  }

  let x = 0
  let y = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const f = p.x * q.y - q.x * p.y
    x += (p.x + q.x) * f
    y += (p.y + q.y) * f
  }
  return { x: x / (6 * a), y: y / (6 * a) }
}

export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * A point guaranteed to be *inside* the polygon, for placing the room label.
 *
 * The centroid is the obvious choice and it is correct for convex rooms. An
 * L-shaped room is the common case where it is not: the centroid of an L sits
 * in the notch, outside the room, and the label lands in the corridor next
 * door. So use the centroid when it is genuinely inside, and otherwise fall
 * back to a scanline probe that is guaranteed to be interior.
 */
export function labelPoint(polygon: Vec2[]): Vec2 {
  const c = centroid(polygon)
  if (pointInPolygon(c, polygon)) return c

  // Sweep horizontal lines through the polygon and take the midpoint of the
  // widest interior span found. That is both inside and visually sensible: it
  // puts the label in the room's broadest part.
  const ys = polygon.map((p) => p.y)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  let best: { point: Vec2; width: number } | null = null

  const STEPS = 24
  for (let i = 1; i < STEPS; i++) {
    const y = minY + ((maxY - minY) * i) / STEPS
    const crossings: number[] = []

    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      const a = polygon[j]
      const b = polygon[k]
      if (a.y > y !== b.y > y) {
        crossings.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
      }
    }

    crossings.sort((p, q) => p - q)
    // Crossings pair up into interior spans: [0,1] inside, [1,2] outside, ...
    for (let s = 0; s + 1 < crossings.length; s += 2) {
      const width = crossings[s + 1] - crossings[s]
      if (!best || width > best.width) {
        best = { point: { x: (crossings[s] + crossings[s + 1]) / 2, y }, width }
      }
    }
  }

  return best?.point ?? c
}

// ---- Segments --------------------------------------------------------------

/** Closest point to `p` on segment ab, and how far along it that is (0..1). */
export function closestPointOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; t: number; distance: number } {
  const ab = sub(b, a)
  const lengthSquared = dot(ab, ab)

  // Zero-length segment: every point on it is `a`.
  if (lengthSquared === 0) return { point: a, t: 0, distance: distance(p, a) }

  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lengthSquared))
  const point = add(a, scale(ab, t))
  return { point, t, distance: distance(p, point) }
}

/**
 * Where two segments cross, or null.
 *
 * `inclusive` decides whether touching at an endpoint counts. Wall splitting
 * wants it exclusive: two walls that merely share a corner are already
 * connected, and must not be split at the corner they share.
 */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  p4: Vec2,
  inclusive = false,
): Vec2 | null {
  const d1 = sub(p2, p1)
  const d2 = sub(p4, p3)
  const denominator = cross(d1, d2)

  // Parallel or collinear. Collinear overlap is deliberately not handled: two
  // walls drawn exactly on top of each other is a modelling mistake, and
  // silently inventing an intersection for it produces stranger results than
  // leaving it alone.
  if (Math.abs(denominator) < 1e-12) return null

  const t = cross(sub(p3, p1), d2) / denominator
  const u = cross(sub(p3, p1), d1) / denominator

  const lo = inclusive ? 0 : 1e-9
  const hi = inclusive ? 1 : 1 - 1e-9
  if (t < lo || t > hi || u < lo || u > hi) return null

  return add(p1, scale(d1, t))
}

// ---- Snapping --------------------------------------------------------------

export interface SnapResult {
  point: Vec2
  /** What the point locked onto, so the canvas can draw the right indicator. */
  kind: 'free' | 'vertex' | 'wall' | 'grid' | 'axis'
  /** Set when `kind` is 'vertex' or 'wall'. */
  targetId?: string
}

/**
 * Constrain a point to the nearest axis from an origin.
 *
 * Architectural plans are overwhelmingly orthogonal, so this is on by default
 * and released by holding a modifier, which is the inverse of most drawing
 * tools. If you have to hold a key to get a straight wall, every wall in the
 * drawing ends up 0.4 degrees off, and it stays invisible until the 3D model
 * has a wedge-shaped room in it.
 */
export function snapToAxis(origin: Vec2, point: Vec2, toleranceDeg = 12): Vec2 {
  const d = sub(point, origin)
  if (length(d) < 1e-9) return point

  const angle = Math.atan2(d.y, d.x)
  const step = Math.PI / 4 // 45 degree increments: orthogonal plus diagonals
  const nearest = Math.round(angle / step) * step

  if (Math.abs(angle - nearest) > (toleranceDeg * Math.PI) / 180) return point

  // Project onto the snapped direction rather than rotating the point, so the
  // wall keeps the length the pointer implies instead of jumping.
  const dir = { x: Math.cos(nearest), y: Math.sin(nearest) }
  return add(origin, scale(dir, dot(d, dir)))
}

export const snapToGrid = (point: Vec2, size: number): Vec2 => ({
  x: Math.round(point.x / size) * size,
  y: Math.round(point.y / size) * size,
})
