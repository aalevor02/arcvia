import { activeFloor, addFloor, addObject, addWall, emptyPlan, setActiveFloor } from '../plan/planStore'
import type { BimReferenceComponent, Floor, Plan, Vec2 } from '../plan/types'
import type { IfcMetadataResult } from './ifcMetadata'
import type {
  BimElementKind,
  BimElementSemantic,
  BimEntitySnapshot,
  BimSource,
} from './semantics'

export interface IfcProposedWall {
  sourceId: string
  source: BimSource
  sourceClass?: string
  bimData: BimEntitySnapshot
  storeyId: string
  from: Vec2
  to: Vec2
  thickness: number
  height: number
}

export interface IfcProposedOpening {
  sourceId: string
  source: BimSource
  sourceClass?: string
  bimData: BimEntitySnapshot
  hostSourceId: string
  storeyId: string
  kind: 'door' | 'window'
  position: Vec2
  rotation: number
  width: number
  depth: number
  height: number
  elevation: number
}

export interface IfcProposedComponent {
  sourceId: string
  sourceClass?: string
  storeyId: string
  kind: BimElementKind
  position: Vec2
  elevation: number
  size: BimReferenceComponent['size']
  mesh?: BimReferenceComponent['mesh']
  quantities: BimReferenceComponent['quantities']
  relations: BimReferenceComponent['relations']
  bimData: BimEntitySnapshot
}

export interface IfcProposedStorey {
  sourceId: string
  name: string
  elevation: number
  walls: IfcProposedWall[]
  openings: IfcProposedOpening[]
  components: IfcProposedComponent[]
}

export interface IfcPlanProposal {
  sourceName: string
  source: BimSource
  sourceSchema: string
  sourceRecordCount: number
  qualityCounts: IfcMetadataResult['quality']['counts']
  /** IFC world-space X/Z point subtracted before entering Arcvia coordinates. */
  sourceOrigin: { x: number; z: number; elevation: number }
  storeys: IfcProposedStorey[]
  skipped: {
    wallsWithoutAxis: number
    openingsWithoutGeometry: number
    openingsWithoutHost: number
  }
}

function midpoint(element: BimElementSemantic): { x: number; y: number; z: number } | null {
  const bounds = element.geometry?.bounds
  if (!bounds) return null
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  }
}

function storeyId(element: BimElementSemantic, host?: BimElementSemantic): string {
  return element.relations.containerId ?? host?.relations.containerId ?? 'unassigned'
}

function semanticSnapshot(element: BimElementSemantic): BimEntitySnapshot {
  return {
    kind: element.kind,
    confidence: element.confidence,
    evidence: element.evidence.map((entry) => ({ ...entry })),
    conflicts: element.conflicts.map((entry) => ({ ...entry })),
    relations: {
      ...element.relations,
      groupIds: element.relations.groupIds && [...element.relations.groupIds],
      connectedIds: element.relations.connectedIds && [...element.relations.connectedIds],
      spaceIds: element.relations.spaceIds && [...element.relations.spaceIds],
    },
    quantities: element.quantities.map((quantity) => ({ ...quantity })),
    materials: (element.materials ?? []).map((material) => ({
      ...material,
      layers: material.layers.map((layer) => ({ ...layer })),
    })),
    properties: structuredClone(element.properties),
  }
}

/**
 * Convert measured IFC semantics into a reviewable Arcvia proposal.
 *
 * IFC/web-ifc uses X/Z as the floor plane and Y as up. Arcvia's plan uses X/Y,
 * with plan Y negated so rebuilding in Three.js returns to the source Z axis.
 * A local origin keeps georeferenced models numerically stable while the
 * original offset remains recorded on the proposal.
 */
export function createIfcPlanProposal(
  result: IfcMetadataResult,
  sourceName = 'Imported IFC',
): IfcPlanProposal {
  const wallElements = result.elements.filter(
    (element) => element.kind === 'wall' || element.kind === 'curtain-wall',
  )
  const measurableWalls = wallElements.filter((element) => element.geometry?.planAxis)
  const measuredElements = result.elements.filter((element) => element.geometry)
  const allGeometryPoints = measuredElements.flatMap((element) => {
    const bounds = element.geometry!.bounds
    return [
      { x: bounds.min.x, z: bounds.min.z },
      { x: bounds.max.x, z: bounds.max.z },
    ]
  })
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const point of allGeometryPoints) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }
  const originX = allGeometryPoints.length ? (minX + maxX) / 2 : 0
  const originZ = allGeometryPoints.length ? (minZ + maxZ) / 2 : 0
  let baseElevation = Infinity
  for (const element of measuredElements) {
    baseElevation = Math.min(baseElevation, element.geometry!.bounds.min.y)
  }
  if (!Number.isFinite(baseElevation)) baseElevation = 0

  const toPlan = (point: { x: number; y: number }): Vec2 => ({
    x: point.x - originX,
    y: -(point.y - originZ),
  })
  const wallsById = new Map(wallElements.map((element) => [element.sourceId, element]))
  const recordNames = new Map(
    result.records.flatMap((entry) => {
      const name = entry.properties.name
      return typeof name === 'string' && name.trim()
        ? [[entry.sourceId, name.trim()] as const]
        : []
    }),
  )
  const storeys = new Map<string, IfcProposedStorey>()
  const ensureStorey = (id: string, elevation: number): IfcProposedStorey => {
    const current = storeys.get(id)
    if (current) {
      current.elevation = Math.min(current.elevation, elevation)
      return current
    }
    const created: IfcProposedStorey = {
      sourceId: id,
      name: id === 'unassigned'
        ? 'Unassigned BIM storey'
        : recordNames.get(id) ?? `BIM Storey ${id}`,
      elevation,
      walls: [],
      openings: [],
      components: [],
    }
    storeys.set(id, created)
    return created
  }

  for (const element of measurableWalls) {
    const axis = element.geometry!.planAxis!
    const id = storeyId(element)
    ensureStorey(id, element.geometry!.bounds.min.y - baseElevation).walls.push({
      sourceId: element.sourceId,
      source: element.source,
      sourceClass: element.sourceClass,
      bimData: semanticSnapshot(element),
      storeyId: id,
      from: toPlan(axis.from),
      to: toPlan(axis.to),
      thickness: axis.thickness,
      height: axis.height,
    })
  }

  let openingsWithoutGeometry = 0
  let openingsWithoutHost = 0
  for (const element of result.elements) {
    if (element.kind !== 'door' && element.kind !== 'window') continue
    const elementGeometry = element.geometry
    const axis = elementGeometry?.planAxis
    const centre = midpoint(element)
    if (!axis || !centre) {
      openingsWithoutGeometry++
      continue
    }
    const hostId = element.relations.hostId
    const host = hostId ? wallsById.get(hostId) : undefined
    if (!hostId || !host?.geometry?.planAxis) {
      openingsWithoutHost++
      continue
    }
    const id = storeyId(element, host)
    ensureStorey(id, host.geometry.bounds.min.y - baseElevation).openings.push({
      sourceId: element.sourceId,
      source: element.source,
      sourceClass: element.sourceClass,
      bimData: semanticSnapshot(element),
      hostSourceId: hostId,
      storeyId: id,
      position: { x: centre.x - originX, y: -(centre.z - originZ) },
      rotation: Math.atan2(-(axis.to.y - axis.from.y), axis.to.x - axis.from.x),
      width: axis.length,
      depth: axis.thickness,
      height: axis.height,
      elevation: Math.max(0, elementGeometry.bounds.min.y - host.geometry.bounds.min.y),
      kind: element.kind,
    })
  }

  const componentKinds = new Set<BimElementKind>([
    'slab', 'roof', 'column', 'beam', 'stair', 'railing', 'furniture', 'equipment',
    'foundation', 'chimney', 'plate', 'ramp', 'covering', 'proxy',
  ])
  for (const element of measuredElements) {
    if (!componentKinds.has(element.kind) || !element.geometry) continue
    const bounds = element.geometry.bounds
    const centreX = (bounds.min.x + bounds.max.x) / 2
    const centreZ = (bounds.min.z + bounds.max.z) / 2
    const id = storeyId(element)
    ensureStorey(id, bounds.min.y - baseElevation).components.push({
      sourceId: element.sourceId,
      sourceClass: element.sourceClass,
      storeyId: id,
      kind: element.kind,
      position: {
        x: centreX - originX,
        y: -(centreZ - originZ),
      },
      elevation: bounds.min.y - baseElevation,
      size: {
        width: bounds.max.x - bounds.min.x,
        depth: bounds.max.z - bounds.min.z,
        height: bounds.max.y - bounds.min.y,
      },
      mesh: element.geometry.mesh && {
        positions: element.geometry.mesh.positions.map((value, index) => {
          if (index % 3 === 0) return value - centreX
          if (index % 3 === 1) return value - bounds.min.y
          return value - centreZ
        }),
        indices: [...element.geometry.mesh.indices],
      },
      quantities: element.quantities,
      relations: element.relations,
      bimData: semanticSnapshot(element),
    })
  }
  for (const storey of storeys.values()) {
    for (const component of storey.components) component.elevation -= storey.elevation
  }

  return {
    sourceName,
    source: result.elements[0]?.source ?? result.records[0]?.source ?? 'ifc',
    sourceSchema: result.schema,
    sourceRecordCount: result.records.length,
    qualityCounts: { ...result.quality.counts },
    sourceOrigin: { x: originX, z: originZ, elevation: baseElevation },
    storeys: [...storeys.values()].sort((left, right) => left.elevation - right.elevation),
    skipped: {
      wallsWithoutAxis: wallElements.length - measurableWalls.length,
      openingsWithoutGeometry,
      openingsWithoutHost,
    },
  }
}

function closestPoint(point: Vec2, from: Vec2, to: Vec2): { point: Vec2; distance: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
    : 0
  const projected = { x: from.x + dx * t, y: from.y + dy * t }
  return { point: projected, distance: Math.hypot(point.x - projected.x, point.y - projected.y) }
}

function hostedWallAt(
  floor: Floor,
  opening: IfcProposedOpening,
  sourceWall: IfcProposedWall,
): { wallId: string; point: Vec2 } | null {
  const sourceDx = sourceWall.to.x - sourceWall.from.x
  const sourceDy = sourceWall.to.y - sourceWall.from.y
  const sourceLength = Math.hypot(sourceDx, sourceDy)
  if (sourceLength < 0.02) return null

  let best: { wallId: string; point: Vec2; distance: number } | null = null
  for (const wall of Object.values(floor.walls)) {
    const from = floor.vertices[wall.a]
    const to = floor.vertices[wall.b]
    if (!from || !to) continue
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length < 0.02) continue
    const parallel = Math.abs((dx * sourceDx + dy * sourceDy) / (length * sourceLength))
    if (parallel < 0.995) continue
    const sourceDistance = closestPoint(
      { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      sourceWall.from,
      sourceWall.to,
    ).distance
    if (sourceDistance > Math.max(0.025, sourceWall.thickness * 0.25)) continue
    const hit = closestPoint(opening.position, from, to)
    if (hit.distance <= Math.max(0.3, opening.depth * 2) && (!best || hit.distance < best.distance)) {
      best = { wallId: wall.id, point: hit.point, distance: hit.distance }
    }
  }
  return best ? { wallId: best.wallId, point: best.point } : null
}

/** Build a new editable Arcvia plan after the user accepts an IFC proposal. */
export function planFromIfcProposal(proposal: IfcPlanProposal): Plan {
  if (proposal.storeys.length === 0) return emptyPlan()
  let plan = emptyPlan()

  for (let index = 0; index < proposal.storeys.length; index++) {
    const storey = proposal.storeys[index]
    if (index > 0) plan = addFloor(plan, storey.name)
    const floorId = plan.activeFloorId
    plan = {
      ...plan,
      floors: plan.floors.map((floor) =>
        floor.id === floorId
          ? { ...floor, name: storey.name, elevation: storey.elevation }
          : floor,
      ),
    }
    for (const wall of storey.walls) {
      plan = addWall(plan, wall.from, wall.to, {
        thickness: wall.thickness,
        height: wall.height,
        snapRadius: 0.03,
        bimSource: {
          source: wall.source,
          sourceId: wall.sourceId,
          sourceClass: wall.sourceClass,
        },
        bimData: wall.bimData,
      })
    }
    const sourceWalls = new Map(storey.walls.map((wall) => [wall.sourceId, wall]))
    for (const opening of storey.openings) {
      const sourceWall = sourceWalls.get(opening.hostSourceId)
      const hit = sourceWall
        ? hostedWallAt(activeFloor(plan), opening, sourceWall)
        : null
      if (!hit) continue
      plan = addObject(plan, {
        item: opening.kind,
        position: hit.point,
        rotation: opening.rotation,
        wallId: hit.wallId,
        elevation: opening.elevation,
        size: {
          width: opening.width,
          depth: opening.depth,
          height: opening.height,
        },
        bimSource: {
          source: opening.source,
          sourceId: opening.sourceId,
          sourceClass: opening.sourceClass,
        },
        bimData: opening.bimData,
      })
    }
    const bimComponents = Object.fromEntries(storey.components.map((component) => {
      const id = `bim-${component.sourceId}`
      return [id, {
        id,
        sourceId: component.sourceId,
        sourceClass: component.sourceClass,
        kind: component.kind,
        representation: component.mesh ? 'mesh' as const : 'bounds' as const,
        mesh: component.mesh,
        bimData: component.bimData,
        position: component.position,
        elevation: component.elevation,
        size: component.size,
        quantities: component.quantities,
        relations: component.relations,
      }]
    }))
    plan = {
      ...plan,
      floors: plan.floors.map((floor) =>
        floor.id === plan.activeFloorId ? { ...floor, bimComponents } : floor),
    }
  }

  return setActiveFloor({
    ...plan,
    bimSource: {
      source: proposal.source,
      sourceName: proposal.sourceName,
      schema: proposal.sourceSchema,
      sourceOrigin: { ...proposal.sourceOrigin },
      recordCount: proposal.sourceRecordCount,
      qualityCounts: { ...proposal.qualityCounts },
    },
  }, plan.floors[0].id)
}
