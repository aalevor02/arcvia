import { itemById } from '../catalogue/items'
import { resolvePlacement, sizeOf, WALL_SNAP_DISTANCE } from '../catalogue/placement'
import { closestPointOnSegment, distance } from './geometry'
import { activeFloor, addObject } from './planStore'
import { toWorld, type DetectionResult, type ProposedWall } from './detections'
import type { Plan, Underlay, Vec2 } from './types'

export interface ProposedOpening {
  kind: 'door' | 'window'
  position: Vec2
  rotation: number
  width: number
  confidence: number
}

const MIN_WIDTH = 0.3
const MAX_WIDTH = 4

/**
 * Convert only explicitly classified raster objects into wall openings.
 *
 * The heuristic reader also returns `opening`, which proves a gap exists but
 * cannot say door versus window. It is deliberately ignored here: choosing a
 * window would invent glazing and choosing a door would invent circulation.
 */
export function proposeRasterOpenings(
  result: DetectionResult,
  underlay: Underlay,
  walls: ProposedWall[],
): ProposedOpening[] {
  const candidates: ProposedOpening[] = []

  for (const object of result.objects ?? []) {
    const kind = object.label.trim().toLowerCase()
    if ((kind !== 'door' && kind !== 'window') || object.attaches_to !== 'wall') {
      continue
    }
    if (
      object.bbox.length < 4 ||
      !object.bbox.slice(0, 4).every(Number.isFinite) ||
      object.bbox[2] <= 0 ||
      object.bbox[3] <= 0
    ) {
      continue
    }

    const centre = toWorld({
      x: object.bbox[0] + object.bbox[2] / 2,
      y: object.bbox[1] + object.bbox[3] / 2,
    }, underlay)
    const width = Math.max(
      object.bbox[2] * underlay.width * underlay.scale,
      object.bbox[3] * underlay.height * underlay.scale,
    )
    if (width < MIN_WIDTH || width > MAX_WIDTH) continue

    let best: { point: Vec2; distance: number; wall: ProposedWall } | null = null
    for (const wall of walls) {
      const hit = closestPointOnSegment(centre, wall.a, wall.b)
      if (hit.distance > WALL_SNAP_DISTANCE) continue
      if (!best || hit.distance < best.distance) {
        best = { point: hit.point, distance: hit.distance, wall }
      }
    }
    if (!best) continue

    const span = distance(best.wall.a, best.wall.b)
    if (width > span) continue
    candidates.push({
      kind,
      position: best.point,
      rotation: Math.atan2(
        best.wall.b.y - best.wall.a.y,
        best.wall.b.x - best.wall.a.x,
      ),
      width,
      confidence: object.confidence,
    })
  }

  // A detector can return nested boxes around the same symbol. Keep the most
  // confident same-kind reading rather than cutting the wall twice.
  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .filter((candidate, index, all) =>
      !all.slice(0, index).some((kept) =>
        kept.kind === candidate.kind &&
        distance(kept.position, candidate.position) <=
          Math.max(0.2, Math.min(kept.width, candidate.width) * 0.35),
      ),
    )
}

/** Commit reviewed openings through the same placement rules as manual drops. */
export function placeRasterOpenings(plan: Plan, openings: ProposedOpening[]): Plan {
  return openings.reduce((next, opening) => {
    const floor = activeFloor(next)
    const duplicate = Object.values(floor.objects).some((object) =>
      (object.item === opening.kind ||
        object.item.startsWith(`${opening.kind}-`)) &&
      distance(object.position, opening.position) <=
        Math.max(0.2, Math.min(sizeOf(object).width, opening.width) * 0.35),
    )
    if (duplicate) return next

    const base = itemById(opening.kind)
    if (!base) return next
    const sized = {
      ...base,
      size: { ...base.size, width: opening.width },
    }
    const placed = resolvePlacement(floor, sized, opening.position)
    if (placed.problem || !placed.wallId) return next
    const wall = floor.walls[placed.wallId]
    if (!wall) return next

    return addObject(next, {
      item: opening.kind,
      position: placed.position,
      rotation: placed.rotation,
      wallId: placed.wallId,
      elevation: base.mountHeight ?? 0,
      size: {
        width: opening.width,
        depth: wall.thickness,
        height: base.size.height,
      },
      label:
        `Detected ${opening.kind} (${Math.round(opening.confidence * 100)}%) - verify`,
    })
  }, plan)
}
