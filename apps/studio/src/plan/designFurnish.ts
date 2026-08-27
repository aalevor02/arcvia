import { CATALOGUE } from '../catalogue/items'
import { fromLabel } from '../catalogue/recognise'
import type { CatalogueItem } from '../catalogue/types'
import type { CadModel, CadSpace, CadWall } from './cadFurnish'
import {
  designRoomName,
  designFurnitureKey,
  designsOf,
  roomNameMatches,
  type StoredDesign,
} from './deckDesign'
import type {
  Proposal,
  ProposalAttachmentEdge,
  ProposalPlacementContext,
} from './furnish'
import type { Plan, Vec2 } from './types'
import { detectRooms } from './rooms'

export function planAsMeasuredModel(plan: Plan): CadModel {
  const storeys = plan.floors.map((floor, storey) => {
    const rooms = detectRooms(floor)
    const walls: CadWall[] = Object.values(floor.walls).flatMap((wall) => {
      const a = floor.vertices[wall.a]
      const b = floor.vertices[wall.b]
      return a && b ? [{ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, thickness: wall.thickness }] : []
    })
    return { storey, title: floor.name, shift: [0, 0] as [number, number], walls,
      spaces: rooms.map((room, index) => ({ index, name: floor.roomNames[room.id] ?? `Room ${index + 1}`, kind: 'room', area: room.area,
        loop: room.polygon.map((point) => [point.x, point.y] as [number, number]) })) }
  })
  return { elements: { storeys } }
}

/**
 * Furniture observed in a render, arranged inside measured reconstruction rooms.
 *
 * A render proves inventory but not plan position: perspective destroys that
 * measurement. `building.json` supplies the missing room polygon. The result
 * is therefore reviewable `rendered` evidence, never presented as a position
 * the architect drew.
 */

const BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]))

interface RoomBlock {
  storey: number
  title: string | null
  shift: [number, number]
  spaces: CadSpace[]
  walls: CadWall[]
}

interface Slot {
  centre: Vec2
  width: number
  depth: number
}

type AttachmentEdge = ProposalAttachmentEdge

export interface MeasuredRoomPlacement {
  position: Vec2
  rotation: number
  width: number
  depth: number
}

export interface MeasuredPlacementChoice {
  index: number
  label: string
}

const CEILING_POINTS = [
  { fx: 0.5, fy: 0.5, label: 'Room centre' },
  { fx: 0.33, fy: 0.5, label: 'Left of centre' },
  { fx: 0.67, fy: 0.5, label: 'Right of centre' },
  { fx: 0.5, fy: 0.33, label: 'Near side' },
  { fx: 0.5, fy: 0.67, label: 'Far side' },
] as const

export function furnishFromDesign(
  model: CadModel,
  stored: StoredDesign,
  plan?: Plan | null,
): Proposal[] {
  const designs = designsOf(stored)
  if (designs.length === 0) return []

  const proposals: Proposal[] = []
  for (const block of roomBlocks(model)) {
    for (const space of block.spaces) {
      const room = space.name?.trim() || space.kind?.trim() || ''
      if (!room || !Array.isArray(space.loop) || space.loop.length < 3) continue

      // Latest wins: a specific render added after the fallback should dress
      // and furnish its room, not be shadowed by the first generic bedroom.
      const design = [...designs]
        .reverse()
        .find((candidate) => roomNameMatches(designRoomName(candidate), room))
      if (!design || design.furniture.length === 0) continue

      const polygon = space.loop.map(([x, y]) => ({
        x: x + block.shift[0],
        y: y + block.shift[1],
      }))

      const takenFloor: Slot[] = []
      const takenWall: Slot[] = []
      const takenCeiling: Slot[] = []
      const emitted = new Set<string>()
      const edges = attachmentEdges(block, space, polygon)
      for (const observed of design.furniture) {
        const found = fromLabel(observed.item)
        const item = found ? BY_ID.get(found.item.id) : undefined
        if (item && !roomAllowsItem(room, item.id)) continue
        const duplicateKey = `${room.toLowerCase()}|${item?.id ?? observed.item.toLowerCase()}`
        if (emitted.has(duplicateKey)) continue
        if (!item || item.placement === 'in-wall') {
          // Inventory is still valuable when the catalogue cannot place it:
          // bespoke joinery, a one-off lamp, and render-only decor must be
          // visible in review rather than silently disappearing.
          proposals.push({
            item: `unresolved:${observed.item.trim() || 'unknown item'}`,
            position: centroid(polygon),
            rotation: 0,
            room: space.name ?? space.kind ?? null,
            storey: block.storey,
            storeyName: block.title ?? undefined,
            designKey: designFurnitureKey(design),
            evidence: 'unresolved',
            reviewOnly: true,
            observedItem: observed.item,
            placementContext: { polygon, edges },
            hubQuery: [observed.item, observed.style, design.style]
              .filter(Boolean)
              .join(' ')
              .trim(),
            confidence: Math.min(0.7, Math.max(0.35, design.confidence ?? 0.55)),
            because: `seen in the ${designRoomName(design) || room} render; no safe catalogue asset or attachment target is available yet`,
          })
          emitted.add(duplicateKey)
          continue
        }

        // Stronger evidence suppresses only its attachment class. A drawn sofa
        // should stop guessed floor furniture, but it must not erase the
        // painting or pendant visible in the architect's render.
        if (occupiedByCad(model, block.storey, polygon, room, item.placement) ||
            occupiedByPlan(plan, block.storey, polygon, item.placement)) continue

        const placed = item.placement === 'floor'
          ? freeSpot(item, polygon, takenFloor)
          : item.placement === 'wall'
            ? wallSpot(item, polygon, edges, takenWall)
            : ceilingSpot(item, polygon, takenCeiling)
        if (!placed) continue
        proposals.push({
          item: item.id,
          position: placed.position,
          rotation: placed.rotation,
          room: space.name ?? space.kind ?? null,
          storey: block.storey,
          storeyName: block.title ?? undefined,
          designKey: designFurnitureKey(design),
          evidence: 'rendered',
          confidence: Math.min(0.75, Math.max(0.45, design.confidence ?? 0.6)),
          because: `seen in the ${designRoomName(design) || room} render; arranged inside the measured ${room} boundary`,
        })
        emitted.add(duplicateKey)
        if (item.id !== 'rug') {
          const target = item.placement === 'floor'
            ? takenFloor : item.placement === 'wall' ? takenWall : takenCeiling
          target.push({ centre: placed.position, width: placed.width, depth: placed.depth })
        }
      }
    }
  }
  return proposals
}

function roomAllowsItem(room: string, itemId: string): boolean {
  const name = room.toLowerCase()
  const kitchen = ['counter', 'island', 'kitchen-cabinet', 'kitchen-stove', 'sink'].includes(itemId)
  const bath = ['bathtub', 'toilet', 'bidet', 'basin'].includes(itemId)
  const balcony = /balcony|terrace|veranda|deck|corridor|hall|landing/.test(name)
  if (kitchen) return /kitchen|utility|pantry/.test(name)
  if (bath) return /bath|toilet|wc|powder|ensuite/.test(name)
  if (balcony && (itemId === 'coffee-table' || itemId === 'dining-table-6')) return false
  return true
}

/**
 * Place a reviewed catalogue template against the same measured room geometry
 * used by recognized render furniture.
 *
 * No occupancy is assumed here: this resolves one review row. Existing scene
 * objects remain visible immediately after placement and can be moved; the
 * important invariant at this seam is that wall/ceiling items receive a real
 * attachment point rather than the unresolved row's room centroid.
 */
export function placeInMeasuredRoom(
  item: CatalogueItem,
  context: ProposalPlacementContext,
  attachmentIndex?: number,
): MeasuredRoomPlacement | null {
  if (context.polygon.length < 3 || item.placement === 'in-wall') return null
  if (item.placement === 'wall') {
    const edge = attachmentIndex === undefined ? null : context.edges[attachmentIndex]
    return edge ? wallSpot(item, context.polygon, [edge], []) : null
  }
  if (item.placement === 'ceiling') {
    return attachmentIndex === undefined
      ? null
      : ceilingSpot(item, context.polygon, [], attachmentIndex)
  }
  return freeSpot(item, context.polygon, [])
}

/** Reviewer-visible measured targets for the selected attachment template. */
export function measuredPlacementChoices(
  item: CatalogueItem,
  context: ProposalPlacementContext,
): MeasuredPlacementChoice[] {
  if (item.placement === 'wall') {
    return context.edges.flatMap((edge, index) => {
      const length = edgeLength(edge)
      return length >= item.size.width + 0.1
        ? [{ index, label: `Wall ${index + 1} (${length.toFixed(2)} m)` }]
        : []
    })
  }
  if (item.placement === 'ceiling') {
    const bounds = polygonBounds(context.polygon)
    return CEILING_POINTS.flatMap((candidate, index) => {
      const position = pointAt(bounds, candidate.fx, candidate.fy)
      return contains(context.polygon, position)
        ? [{ index, label: candidate.label }]
        : []
    })
  }
  return []
}

function roomBlocks(model: CadModel): RoomBlock[] {
  const storeys = model.elements?.storeys ?? []
  if (storeys.length > 0) {
    return storeys.map((block) => ({
      storey: block.storey,
      title: block.title ?? null,
      shift: block.shift ?? [0, 0],
      spaces: block.spaces ?? [],
      walls: block.walls ?? [],
    }))
  }
  return [{
    storey: 0,
    title: null,
    shift: [0, 0],
    spaces: model.elements?.spaces ?? [],
    walls: model.elements?.walls ?? [],
  }]
}

function occupiedByCad(
  model: CadModel,
  storey: number,
  polygon: Vec2[],
  room: string,
  placement: CatalogueItem['placement'],
): boolean {
  return (model.elements?.fixtures ?? []).some((fixture) => {
    if ((fixture.storey ?? 0) !== storey || !fixture.item) return false
    const item = BY_ID.get(fixture.item)
    if (!item || item.placement !== placement) return false
    if (fixture.room && roomNameMatches(fixture.room, room)) return true
    const block = model.elements?.storeys?.find((candidate) => candidate.storey === storey)
    const [shiftX, shiftY] = block?.shift ?? [0, 0]
    return contains(polygon, {
      x: fixture.position.x + shiftX,
      y: fixture.position.y + shiftY,
    })
  })
}

function occupiedByPlan(
  plan: Plan | null | undefined,
  storey: number,
  polygon: Vec2[],
  placement: CatalogueItem['placement'],
): boolean {
  const floor = plan?.floors[storey]
  return floor
    ? Object.values(floor.objects ?? {}).some((object) =>
      BY_ID.get(object.item)?.placement === placement && contains(polygon, object.position))
    : false
}

function attachmentEdges(block: RoomBlock, space: CadSpace, polygon: Vec2[]): AttachmentEdge[] {
  const measured = (space.boundedBy ?? [])
    .map((index) => block.walls[index])
    .filter((wall): wall is CadWall => Boolean(wall))
    .map((wall) => ({
      a: { x: wall.a.x + block.shift[0], y: wall.a.y + block.shift[1] },
      b: { x: wall.b.x + block.shift[0], y: wall.b.y + block.shift[1] },
      thickness: wall.thickness,
    }))
  if (measured.length > 0) return measured
  return polygon.map((point, index) => ({
    a: point,
    b: polygon[(index + 1) % polygon.length],
    // Raster and older reconstruction records have no wall list. This is only
    // the mounting offset, never reported as a measured wall thickness.
    thickness: 0.115,
  }))
}

function wallSpot(
  item: CatalogueItem,
  polygon: Vec2[],
  edges: AttachmentEdge[],
  taken: Slot[],
): { position: Vec2; rotation: number; width: number; depth: number } | null {
  const ranked = [...edges].sort((a, b) => edgeLength(b) - edgeLength(a))
  for (const edge of ranked) {
    const length = edgeLength(edge)
    if (length < item.size.width + 0.1) continue
    const dx = (edge.b.x - edge.a.x) / length
    const dy = (edge.b.y - edge.a.y) / length
    const centre = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 }
    const offset = edge.thickness / 2 + item.size.depth / 2 + 0.002
    const left = { x: centre.x - dy * offset, y: centre.y + dx * offset }
    const right = { x: centre.x + dy * offset, y: centre.y - dx * offset }
    const position = contains(polygon, left) ? left : contains(polygon, right) ? right : null
    if (!position) continue
    const rotation = Math.atan2(dy, dx)
    const footprint = footprintAt(item, position, rotation)
    const slot = { centre: position, width: footprint.width, depth: footprint.depth }
    if (taken.some((other) => collides(slot, other))) continue
    return { position, rotation, width: footprint.width, depth: footprint.depth }
  }
  return null
}

function ceilingSpot(
  item: CatalogueItem,
  polygon: Vec2[],
  taken: Slot[],
  attachmentIndex?: number,
): { position: Vec2; rotation: number; width: number; depth: number } | null {
  const bounds = polygonBounds(polygon)
  const candidates = attachmentIndex === undefined
    ? CEILING_POINTS
    : CEILING_POINTS.filter((_, index) => index === attachmentIndex)
  for (const candidate of candidates) {
    const position = pointAt(bounds, candidate.fx, candidate.fy)
    if (!contains(polygon, position)) continue
    const slot = { centre: position, width: item.size.width, depth: item.size.depth }
    if (taken.some((other) => collides(slot, other))) continue
    return { position, rotation: 0, width: item.size.width, depth: item.size.depth }
  }
  return null
}

function polygonBounds(polygon: Vec2[]) {
  const xs = polygon.map((point) => point.x)
  const ys = polygon.map((point) => point.y)
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  }
}

function pointAt(
  bounds: ReturnType<typeof polygonBounds>,
  fx: number,
  fy: number,
): Vec2 {
  return {
    x: bounds.minX + (bounds.maxX - bounds.minX) * fx,
    y: bounds.minY + (bounds.maxY - bounds.minY) * fy,
  }
}

function edgeLength(edge: AttachmentEdge): number {
  return Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y)
}

function centroid(polygon: Vec2[]): Vec2 {
  return {
    x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
    y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
  }
}

function freeSpot(
  item: CatalogueItem,
  polygon: Vec2[],
  taken: Slot[],
): { position: Vec2; rotation: number; width: number; depth: number } | null {
  const xs = polygon.map((point) => point.x)
  const ys = polygon.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const margin = 0.1

  const wallCandidates = [
    candidate(centre.x, minY, Math.PI, item, 'min-y', margin),
    candidate(centre.x, maxY, 0, item, 'max-y', margin),
    candidate(minX, centre.y, -Math.PI / 2, item, 'min-x', margin),
    candidate(maxX, centre.y, Math.PI / 2, item, 'max-x', margin),
  ]
  const central = [{ position: centre, rotation: 0 }]
  const grid: { position: Vec2; rotation: number }[] = []
  for (const fy of [0.25, 0.5, 0.75]) {
    for (const fx of [0.25, 0.5, 0.75]) {
      grid.push({ position: { x: minX + (maxX - minX) * fx, y: minY + (maxY - minY) * fy }, rotation: 0 })
    }
  }

  const centreFirst = ['rug', 'coffee-table', 'dining-table-6', 'island'].includes(item.id)
  const candidates = centreFirst
    ? [...central, ...wallCandidates, ...grid]
    : [...wallCandidates, ...grid, ...central]

  for (const value of candidates) {
    const footprint = footprintAt(item, value.position, value.rotation)
    if (!footprint.corners.every((point) => contains(polygon, point))) continue
    const slot = { centre: value.position, width: footprint.width, depth: footprint.depth }
    if (item.id !== 'rug' && taken.some((other) => collides(slot, other))) continue
    return { ...value, width: footprint.width, depth: footprint.depth }
  }
  return null
}

function candidate(
  x: number,
  y: number,
  rotation: number,
  item: CatalogueItem,
  edge: 'min-x' | 'max-x' | 'min-y' | 'max-y',
  margin: number,
) {
  const swapped = Math.abs(Math.sin(rotation)) > 0.5
  const halfX = (swapped ? item.size.depth : item.size.width) / 2
  const halfY = (swapped ? item.size.width : item.size.depth) / 2
  return {
    position: {
      x: edge === 'min-x' ? x + halfX + margin : edge === 'max-x' ? x - halfX - margin : x,
      y: edge === 'min-y' ? y + halfY + margin : edge === 'max-y' ? y - halfY - margin : y,
    },
    rotation,
  }
}

function footprintAt(item: CatalogueItem, centre: Vec2, rotation: number) {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const halfW = item.size.width / 2
  const halfD = item.size.depth / 2
  const corners = [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ].map(([x, y]) => ({
    x: centre.x + x * cos - y * sin,
    y: centre.y + x * sin + y * cos,
  }))
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return {
    corners,
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...ys) - Math.min(...ys),
  }
}

function collides(a: Slot, b: Slot): boolean {
  return (
    Math.abs(a.centre.x - b.centre.x) < (a.width + b.width) / 2 + 0.05 &&
    Math.abs(a.centre.y - b.centre.y) < (a.depth + b.depth) / 2 + 0.05
  )
}

function contains(polygon: Vec2[], point: Vec2): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > point.y !== b.y > point.y) {
      const crossing = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)
      if (point.x < crossing) inside = !inside
    }
  }
  return inside
}
