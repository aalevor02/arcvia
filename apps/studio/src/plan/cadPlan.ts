import type { PlacedObject } from '../catalogue/types'
import type {
  CadModel,
  CadOpening,
  CadSpace,
  CadStoreyBlock,
  CadWall,
} from './cadFurnish'
import { detectRooms } from './rooms'
import type { Floor, Plan, Vec2, Vertex, Wall } from './types'

interface SourceFloor {
  storey: number
  title: string
  shift: [number, number]
  walls: CadWall[]
  spaces: CadSpace[]
  openings: CadOpening[]
}

const WELD_METRES = 0.02

/** Convert editable building.json geometry into the Studio's real 2D plan. */
export function planFromCad(model: CadModel): Plan | null {
  const sources = sourceFloors(model)
  if (sources.length === 0 || sources.every((source) => source.walls.length === 0)) {
    return null
  }

  const height = positive(model.wallHeight, 3)
  const floors = sources.map((source, index) =>
    buildFloor(source, index, height, height + 0.3),
  )
  const primary = model.storeys?.primary ?? 0
  const active = floors.find((_floor, index) => sources[index].storey === primary) ?? floors[0]

  return {
    version: 1,
    floors,
    activeFloorId: active.id,
  }
}

function sourceFloors(model: CadModel): SourceFloor[] {
  const blocks = model.elements?.storeys
  if (blocks?.length) {
    return [...blocks]
      .sort((a, b) => a.storey - b.storey)
      .map((block) => sourceFromBlock(block))
  }

  const walls = model.elements?.walls ?? []
  if (walls.length === 0) return []
  return [{
    storey: 0,
    title: 'Ground floor',
    shift: [0, 0],
    walls,
    spaces: model.elements?.spaces ?? [],
    openings: model.elements?.openings ?? [],
  }]
}

function sourceFromBlock(block: CadStoreyBlock): SourceFloor {
  return {
    storey: block.storey,
    title: block.title?.trim() || `Floor ${block.storey + 1}`,
    shift: block.shift ?? [0, 0],
    walls: block.walls ?? [],
    spaces: block.spaces ?? [],
    openings: block.openings ?? [],
  }
}

function buildFloor(
  source: SourceFloor,
  index: number,
  wallHeight: number,
  rise: number,
): Floor {
  const vertices: Record<string, Vertex> = {}
  const walls: Record<string, Wall> = {}
  const wallIds: Array<string | null> = []
  let vertexCounter = 0

  const vertex = (point: Vec2): string => {
    for (const candidate of Object.values(vertices)) {
      if (Math.hypot(candidate.x - point.x, candidate.y - point.y) <= WELD_METRES) {
        return candidate.id
      }
    }
    const id = `cad-v-${source.storey}-${vertexCounter++}`
    vertices[id] = { id, ...point }
    return id
  }

  for (const [wallIndex, cadWall] of source.walls.entries()) {
    const a = shifted(cadWall.a, source.shift)
    const b = shifted(cadWall.b, source.shift)
    const aId = vertex(a)
    const bId = vertex(b)
    if (aId === bId) {
      wallIds[wallIndex] = null
      continue
    }
    const id = `cad-w-${source.storey}-${wallIndex}`
    wallIds[wallIndex] = id
    walls[id] = {
      id,
      a: aId,
      b: bId,
      thickness: positive(cadWall.thickness, 0.115),
      height: wallHeight,
    }
  }

  const objects = openingsFrom(source, wallIds)
  const floor: Floor = {
    id: `cad-floor-${source.storey}`,
    name: source.title,
    elevation: index * rise,
    // A DWG/DXF carries no BIM semantics, so this is empty by fact rather than
    // by omission. Left explicit so the absence reads as measured, not skipped.
    bimComponents: {},
    vertices,
    walls,
    roomNames: {},
    objects,
    underlay: null,
  }

  const derived = detectRooms(floor)
  for (const room of derived) {
    const sourceRoom = source.spaces.find((candidate) =>
      candidate.name && pointInPolygon(
        room.label,
        candidate.loop.map(([x, y]) => shifted({ x, y }, source.shift)),
      ),
    )
    if (sourceRoom?.name) floor.roomNames[room.id] = sourceRoom.name
  }
  return floor
}

function openingsFrom(
  source: SourceFloor,
  wallIds: Array<string | null>,
): Record<string, PlacedObject> {
  const objects: Record<string, PlacedObject> = {}
  for (const [index, opening] of source.openings.entries()) {
    const wall = source.walls[opening.wall]
    const wallId = wallIds[opening.wall]
    if (!wall || !wallId) continue

    const a = shifted(wall.a, source.shift)
    const b = shifted(wall.b, source.shift)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length <= 1e-6) continue
    const along = Math.max(0, Math.min(length, opening.along))
    const t = along / length
    const id = `cad-opening-${source.storey}-${index}`
    objects[id] = {
      id,
      item: opening.kind === 'window' ? 'window' : 'door',
      label:
        opening.kind === 'opening'
          ? 'Unclassified opening - verify door/window'
          : undefined,
      position: {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      },
      rotation: Math.atan2(b.y - a.y, b.x - a.x),
      wallId,
      elevation: Math.max(0, opening.sill || 0),
      size: {
        width: positive(opening.width, opening.kind === 'window' ? 1.2 : 0.9),
        depth: positive(wall.thickness, 0.115),
        height: positive(opening.height, opening.kind === 'window' ? 1.2 : 2.1),
      },
    }
  }
  return objects
}

function shifted(point: Vec2, [x, y]: [number, number]): Vec2 {
  return { x: point.x + x, y: point.y + y }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses =
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}
