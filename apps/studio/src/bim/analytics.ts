import type {
  BimElementKind,
  BimEntityProvenance,
  BimEntitySnapshot,
  BimQuantityDimension,
  BimSource,
  BimTriangleMesh,
  SemanticBasis,
} from './semantics'
import type { Plan } from '../plan/types'

export interface BimAnalysisCount {
  name: string
  count: number
}

export interface BimAnalysisQuantity {
  name: string
  dimension: BimQuantityDimension
  unit: string
  value: number
  sourceElementCount: number
}

export interface BimAnalysisMaterial {
  name: string
  category?: string
  sourceElementCount: number
  layerCount: number
  /** Sum of known compound-layer thicknesses across unique source elements. */
  totalThicknessSI?: number
}

export interface BimAnalysisFinding {
  severity: 'warning' | 'info'
  code: 'missing-semantic-snapshot' | 'low-confidence' | 'classification-conflict'
    | 'unresolved-quantity' | 'bounds-fallback'
  count: number
  message: string
}

export interface BimAnalysisElement {
  key: string
  source: BimSource
  sourceId: string
  sourceClass?: string
  kind: BimElementKind
  storeys: string[]
  editableInstanceCount: number
  semanticFingerprint: string
  geometryFingerprint: string
  /** Curated, SI-normalized features safe to carry into governed learning datasets. */
  features: BimAnalysisElementFeatures
}

export interface BimAnalysisElementFeatures {
  semantic: {
    confidence?: number
    evidenceBases: SemanticBasis[]
    conflictCount: number
    propertyNames: string[]
  }
  relations: {
    hasHost: boolean
    hasOpeningFill: boolean
    hasContainer: boolean
    hasType: boolean
    hasParent: boolean
    groupCount: number
    connectedCount: number
    spaceCount: number
  }
  geometry: {
    representation: 'parametric' | 'mesh' | 'bounds'
    lengthSI?: number
    widthSI?: number
    depthSI?: number
    thicknessSI?: number
    heightSI?: number
    elevationSI?: number
    vertexCount?: number
    triangleCount?: number
  }
  quantities: Array<{
    name: string
    dimension: BimQuantityDimension
    valueSI: number
    unitSI: string
  }>
  materials: Array<{
    name?: string
    category?: string
    layerCount: number
    totalThicknessSI?: number
  }>
}

export interface BimPlanAnalysis {
  version: 1
  source: Plan['bimSource']
  totals: {
    uniqueSourceElements: number
    editableInstances: number
    semanticSnapshots: number
    exactMeshes: number
    boundsFallbacks: number
    relationshipLinks: number
  }
  byKind: BimAnalysisCount[]
  byNativeClass: BimAnalysisCount[]
  byStorey: BimAnalysisCount[]
  quantities: BimAnalysisQuantity[]
  materials: BimAnalysisMaterial[]
  findings: BimAnalysisFinding[]
  /** Stable native-element signatures used for local version comparison. */
  elements: BimAnalysisElement[]
}

type AnalysisGeometry = {
  type: 'wall'
  floorElevation: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  thickness: number
  height: number
} | {
  type: 'opening'
  floorElevation: number
  item: string
  position: { x: number; y: number }
  rotation: number
  elevation?: number
  size?: { width: number; depth: number; height: number }
} | {
  type: 'component'
  floorElevation: number
  position: { x: number; y: number }
  elevation: number
  size: { width: number; depth: number; height: number }
  representation: 'mesh' | 'bounds'
  mesh?: BimTriangleMesh
}

interface AnalysisEntity {
  key: string
  floorName: string
  provenance: BimEntityProvenance
  data?: BimEntitySnapshot
  representation?: 'mesh' | 'bounds'
  geometry: AnalysisGeometry
}

function increment(map: Map<string, number>, name: string, amount = 1): void {
  map.set(name, (map.get(name) ?? 0) + amount)
}

function sortedCounts(map: Map<string, number>): BimAnalysisCount[] {
  return [...map].map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function relationshipCount(data: BimEntitySnapshot): number {
  const relations = data.relations
  return (relations.hostId ? 1 : 0)
    + (relations.fillsOpeningId ? 1 : 0)
    + (relations.containerId ? 1 : 0)
    + (relations.typeId ? 1 : 0)
    + (relations.parentId ? 1 : 0)
    + (relations.groupIds?.length ?? 0)
    + (relations.connectedIds?.length ?? 0)
    + (relations.spaceIds?.length ?? 0)
}

function sourceKey(source: BimSource, sourceId: string): string {
  return `${source}:${sourceId}`
}

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : String(value)
  }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => [name, canonical(child)]))
  }
  return value
}

function stableString(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function fingerprint(value: unknown): string {
  const input = stableString(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function elementFeatures(
  entity: AnalysisEntity,
  occurrences: AnalysisEntity[],
): BimAnalysisElementFeatures {
  const data = entity.data
  const relations = data?.relations ?? {}
  const geometry = entity.geometry
  const geometryFeatures: BimAnalysisElementFeatures['geometry'] = geometry.type === 'wall'
    ? {
      representation: 'parametric',
      lengthSI: occurrences.reduce((total, occurrence) => {
        if (occurrence.geometry.type !== 'wall') return total
        return total + Math.hypot(
          occurrence.geometry.to.x - occurrence.geometry.from.x,
          occurrence.geometry.to.y - occurrence.geometry.from.y,
        )
      }, 0),
      thicknessSI: occurrences.reduce((total, occurrence) =>
        total + (occurrence.geometry.type === 'wall' ? occurrence.geometry.thickness : 0), 0)
        / occurrences.length,
      heightSI: Math.max(...occurrences.map((occurrence) =>
        occurrence.geometry.type === 'wall' ? occurrence.geometry.height : 0)),
      elevationSI: Math.min(...occurrences.map((occurrence) =>
        occurrence.geometry.floorElevation)),
    }
    : geometry.type === 'opening'
      ? {
        representation: 'parametric',
        widthSI: geometry.size?.width,
        depthSI: geometry.size?.depth,
        heightSI: geometry.size?.height,
        elevationSI: geometry.floorElevation + (geometry.elevation ?? 0),
      }
      : {
        representation: geometry.representation,
        widthSI: geometry.size.width,
        depthSI: geometry.size.depth,
        heightSI: geometry.size.height,
        elevationSI: geometry.floorElevation + geometry.elevation,
        vertexCount: geometry.mesh ? geometry.mesh.positions.length / 3 : undefined,
        triangleCount: geometry.mesh ? geometry.mesh.indices.length / 3 : undefined,
      }

  return {
    semantic: {
      confidence: data?.confidence,
      evidenceBases: [...new Set(data?.evidence.map((item) => item.basis) ?? [])].sort(),
      conflictCount: data?.conflicts.length ?? 0,
      propertyNames: Object.keys(data?.properties ?? {}).sort(),
    },
    relations: {
      hasHost: Boolean(relations.hostId),
      hasOpeningFill: Boolean(relations.fillsOpeningId),
      hasContainer: Boolean(relations.containerId),
      hasType: Boolean(relations.typeId),
      hasParent: Boolean(relations.parentId),
      groupCount: relations.groupIds?.length ?? 0,
      connectedCount: relations.connectedIds?.length ?? 0,
      spaceCount: relations.spaceIds?.length ?? 0,
    },
    geometry: geometryFeatures,
    quantities: (data?.quantities ?? [])
      .filter((quantity): quantity is typeof quantity & { valueSI: number; unitSI: string } =>
        quantity.valueSI !== undefined && quantity.unitSI !== undefined)
      .map((quantity) => ({
        name: quantity.name,
        dimension: quantity.dimension,
        valueSI: quantity.valueSI,
        unitSI: quantity.unitSI,
      }))
      .sort((left, right) => left.dimension.localeCompare(right.dimension)
        || left.name.localeCompare(right.name)),
    materials: (data?.materials ?? []).map((material) => ({
      name: material.name,
      category: material.category,
      layerCount: material.layers.length,
      totalThicknessSI: material.layers.some((layer) => layer.thicknessSI !== undefined)
        ? material.layers.reduce((total, layer) => total + (layer.thicknessSI ?? 0), 0)
        : undefined,
    })).sort((left, right) => (left.name ?? '').localeCompare(right.name ?? '')),
  }
}

/** Deterministic, source-deduplicated BIM analysis of the current editable plan. */
export function analysePlanBim(plan: Plan): BimPlanAnalysis {
  const entities: AnalysisEntity[] = []
  const defaultSource = plan.bimSource?.source ?? 'ifc'

  for (const floor of plan.floors) {
    for (const wall of Object.values(floor.walls)) {
      if (!wall.bimSource) continue
      const a = floor.vertices[wall.a]
      const b = floor.vertices[wall.b]
      if (!a || !b) continue
      const endpoints = [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ].sort((left, right) => left.x - right.x || left.y - right.y)
      entities.push({
        key: sourceKey(wall.bimSource.source, wall.bimSource.sourceId),
        floorName: floor.name,
        provenance: wall.bimSource,
        data: wall.bimData,
        geometry: {
          type: 'wall',
          floorElevation: floor.elevation,
          from: endpoints[0],
          to: endpoints[1],
          thickness: wall.thickness,
          height: wall.height,
        },
      })
    }
    for (const object of Object.values(floor.objects ?? {})) {
      if (!object.bimSource) continue
      entities.push({
        key: sourceKey(object.bimSource.source, object.bimSource.sourceId),
        floorName: floor.name,
        provenance: object.bimSource,
        data: object.bimData,
        geometry: {
          type: 'opening',
          floorElevation: floor.elevation,
          item: object.item,
          position: object.position,
          rotation: object.rotation,
          elevation: object.elevation,
          size: object.size,
        },
      })
    }
    for (const component of Object.values(floor.bimComponents ?? {})) {
      const provenance: BimEntityProvenance = {
        source: defaultSource,
        sourceId: component.sourceId,
        sourceClass: component.sourceClass,
      }
      entities.push({
        key: sourceKey(provenance.source, provenance.sourceId),
        floorName: floor.name,
        provenance,
        data: component.bimData,
        representation: component.representation,
        geometry: {
          type: 'component',
          floorElevation: floor.elevation,
          position: component.position,
          elevation: component.elevation,
          size: component.size,
          representation: component.representation,
          mesh: component.representation === 'mesh' ? component.mesh : undefined,
        },
      })
    }
  }

  const unique = new Map<string, AnalysisEntity>()
  const grouped = new Map<string, AnalysisEntity[]>()
  for (const entity of entities) {
    grouped.set(entity.key, [...(grouped.get(entity.key) ?? []), entity])
    const current = unique.get(entity.key)
    // Prefer the occurrence carrying richer semantics or an exact representation.
    if (!current || (!current.data && entity.data)
      || (current.representation === 'bounds' && entity.representation === 'mesh')) {
      unique.set(entity.key, entity)
    }
  }

  const elementSignatures: BimAnalysisElement[] = [...unique].map(([key, entity]) => {
    const occurrences = grouped.get(key) ?? [entity]
    const geometry = occurrences.map((occurrence) => stableString(occurrence.geometry)).sort()
    return {
      key,
      source: entity.provenance.source,
      sourceId: entity.provenance.sourceId,
      sourceClass: entity.provenance.sourceClass,
      kind: entity.data?.kind ?? 'unknown',
      storeys: [...new Set(occurrences.map((occurrence) => occurrence.floorName))].sort(),
      editableInstanceCount: occurrences.length,
      semanticFingerprint: fingerprint(entity.data ?? null),
      geometryFingerprint: fingerprint(geometry),
      features: elementFeatures(entity, occurrences),
    }
  }).sort((left, right) => left.key.localeCompare(right.key))

  const byKind = new Map<string, number>()
  const byNativeClass = new Map<string, number>()
  const byStoreySets = new Map<string, Set<string>>()
  const quantityMap = new Map<string, BimAnalysisQuantity>()
  const quantitySources = new Map<string, Set<string>>()
  const materialMap = new Map<string, BimAnalysisMaterial>()
  const materialSources = new Map<string, Set<string>>()
  let semanticSnapshots = 0
  let exactMeshes = 0
  let boundsFallbacks = 0
  let relationshipLinks = 0
  let lowConfidence = 0
  let conflicts = 0
  let unresolvedQuantities = 0

  for (const entity of unique.values()) {
    const data = entity.data
    const kind: BimElementKind = data?.kind ?? 'unknown'
    increment(byKind, kind)
    increment(byNativeClass, entity.provenance.sourceClass ?? 'Unknown native class')
    const storey = byStoreySets.get(entity.floorName) ?? new Set<string>()
    storey.add(entity.key)
    byStoreySets.set(entity.floorName, storey)

    if (entity.representation === 'mesh') exactMeshes++
    if (entity.representation === 'bounds') boundsFallbacks++
    if (!data) continue

    semanticSnapshots++
    relationshipLinks += relationshipCount(data)
    if (data.confidence < 0.75) lowConfidence++
    if (data.conflicts.length > 0) conflicts++

    for (const quantity of data.quantities) {
      if (quantity.valueSI === undefined || quantity.unitSI === undefined) {
        unresolvedQuantities++
        continue
      }
      const key = `${quantity.dimension}\u0000${quantity.name}\u0000${quantity.unitSI}`
      const sources = quantitySources.get(key) ?? new Set<string>()
      sources.add(entity.key)
      quantitySources.set(key, sources)
      const current = quantityMap.get(key)
      if (current) {
        current.value += quantity.valueSI
        current.sourceElementCount = sources.size
      } else {
        quantityMap.set(key, {
          name: quantity.name,
          dimension: quantity.dimension,
          unit: quantity.unitSI,
          value: quantity.valueSI,
          sourceElementCount: sources.size,
        })
      }
    }

    const entityMaterials = new Map<string, {
      name: string
      category?: string
      layerCount: number
      totalThicknessSI?: number
    }>()
    for (const material of data.materials ?? []) {
      const contributions = material.layers.length > 0
        ? material.layers.map((layer) => ({
          name: layer.name ?? material.name,
          category: layer.category ?? material.category,
          thicknessSI: layer.thicknessSI,
          isLayer: true,
        }))
        : [{
          name: material.name,
          category: material.category,
          thicknessSI: undefined,
          isLayer: false,
        }]
      for (const contribution of contributions) {
        if (!contribution.name) continue
        const key = `${contribution.name}\u0000${contribution.category ?? ''}`
        const current = entityMaterials.get(key)
        entityMaterials.set(key, {
          name: contribution.name,
          category: contribution.category,
          layerCount: (current?.layerCount ?? 0) + (contribution.isLayer ? 1 : 0),
          totalThicknessSI: contribution.thicknessSI === undefined
            ? current?.totalThicknessSI
            : (current?.totalThicknessSI ?? 0) + contribution.thicknessSI,
        })
      }
    }
    for (const [key, contribution] of entityMaterials) {
      const sources = materialSources.get(key) ?? new Set<string>()
      sources.add(entity.key)
      materialSources.set(key, sources)
      const current = materialMap.get(key)
      materialMap.set(key, {
        name: contribution.name,
        category: contribution.category,
        sourceElementCount: sources.size,
        layerCount: (current?.layerCount ?? 0) + contribution.layerCount,
        totalThicknessSI: contribution.totalThicknessSI === undefined
          ? current?.totalThicknessSI
          : (current?.totalThicknessSI ?? 0) + contribution.totalThicknessSI,
      })
    }
  }

  const findings: BimAnalysisFinding[] = []
  const missingSnapshots = unique.size - semanticSnapshots
  if (missingSnapshots > 0) findings.push({
    severity: 'warning',
    code: 'missing-semantic-snapshot',
    count: missingSnapshots,
    message: `${missingSnapshots} source elements have identity but no retained semantic snapshot.`,
  })
  if (lowConfidence > 0) findings.push({
    severity: 'warning',
    code: 'low-confidence',
    count: lowConfidence,
    message: `${lowConfidence} source elements have semantic confidence below 75%.`,
  })
  if (conflicts > 0) findings.push({
    severity: 'warning',
    code: 'classification-conflict',
    count: conflicts,
    message: `${conflicts} source elements contain conflicting classification evidence.`,
  })
  if (unresolvedQuantities > 0) findings.push({
    severity: 'warning',
    code: 'unresolved-quantity',
    count: unresolvedQuantities,
    message: `${unresolvedQuantities} quantities could not be normalized safely.`,
  })
  if (boundsFallbacks > 0) findings.push({
    severity: 'info',
    code: 'bounds-fallback',
    count: boundsFallbacks,
    message: `${boundsFallbacks} components use measured bounds instead of exact triangles.`,
  })

  return {
    version: 1,
    source: plan.bimSource,
    totals: {
      uniqueSourceElements: unique.size,
      editableInstances: entities.length,
      semanticSnapshots,
      exactMeshes,
      boundsFallbacks,
      relationshipLinks,
    },
    byKind: sortedCounts(byKind),
    byNativeClass: sortedCounts(byNativeClass),
    byStorey: sortedCounts(new Map(
      [...byStoreySets].map(([name, keys]) => [name, keys.size]),
    )),
    quantities: [...quantityMap.values()].sort((left, right) =>
      left.dimension.localeCompare(right.dimension)
      || left.name.localeCompare(right.name)
      || left.unit.localeCompare(right.unit)),
    materials: [...materialMap.values()].sort((left, right) =>
      right.sourceElementCount - left.sourceElementCount
      || left.name.localeCompare(right.name)),
    findings,
    elements: elementSignatures,
  }
}
