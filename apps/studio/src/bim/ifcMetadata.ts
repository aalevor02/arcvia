import {
  classifyBimElement,
  type BimElementGeometry,
  type BimPoint3,
  type BimElementInput,
  type BimElementSemantic,
  type BimRelations,
} from './semantics'
import {
  normaliseIfcQuantities,
  type IfcUnitScale,
  type IfcUnitScales,
} from './quantities'
import { analyseBimQuality, type BimQualityReport } from './quality'
import { normaliseIfcMaterials } from './materials'

interface IfcVector<T> {
  get(index: number): T
  size(): number
}

interface IfcPropertyReader {
  getPropertySets(
    modelID: number,
    elementID?: number,
    recursive?: boolean,
    includeTypeProperties?: boolean,
  ): Promise<unknown[]>
  getTypeProperties(modelID: number, elementID?: number, recursive?: boolean): Promise<unknown[]>
  getMaterialsProperties(
    modelID: number,
    elementID?: number,
    recursive?: boolean,
    includeTypeMaterials?: boolean,
  ): Promise<unknown[]>
}

interface IfcPlacedGeometry {
  geometryExpressID: number
  flatTransformation: Array<number>
}

interface IfcFlatMesh {
  geometries: IfcVector<IfcPlacedGeometry>
}

interface IfcGeometry {
  GetVertexData(): number
  GetVertexDataSize(): number
  GetIndexData(): number
  GetIndexDataSize(): number
  delete(): void
}

/** The small API surface needed by the extractor, kept injectable for tests. */
export interface IfcMetadataApi {
  properties?: IfcPropertyReader
  GetModelSchema(modelID: number): string
  GetIfcEntityList(modelID: number): number[]
  GetNameFromTypeCode(type: number): string
  GetTypeCodeFromName(typeName: string): number
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): IfcVector<number>
  GetLine(modelID: number, expressID: number, flatten?: boolean, inverse?: boolean): unknown
  GetFlatMesh?(modelID: number, expressID: number): IfcFlatMesh
  GetGeometry?(modelID: number, geometryExpressID: number): IfcGeometry
  GetVertexArray?(ptr: number, size: number): Float32Array
  GetIndexArray?(ptr: number, size: number): Uint32Array
}

export interface IfcMetadataOptions {
  /** Property sets, type properties and materials can be expensive on large models. */
  includeProperties?: boolean
  /** Measure transformed mesh bounds and wall axes. */
  includeGeometry?: boolean
  /** Retain exact triangle meshes for supported non-wall components. */
  includeMeshes?: boolean
  /** Maximum transformed vertices retained across the entire model. */
  meshVertexBudget?: number
}

export interface IfcMetadataResult {
  schema: string
  /** Declared project-unit conversion factors used for quantity normalization. */
  units: IfcUnitScales
  /** Every IFC entity type, including relationships and geometry primitives. */
  typeCounts: Record<string, number>
  /** Building elements that currently map into Arcvia's canonical taxonomy. */
  elements: BimElementSemantic[]
  /**
   * Every IFC object definition, including unsupported products, spatial
   * structure, systems and reusable types. Nothing here is inferred or dropped.
   */
  records: BimElementSemantic[]
  relationCounts: Record<string, number>
  warnings: string[]
  quality: BimQualityReport
}

type IfcRecord = Record<string, unknown>

function record(value: unknown): IfcRecord | null {
  return value !== null && typeof value === 'object' ? value as IfcRecord : null
}

function wrappedValue(value: unknown): unknown {
  const object = record(value)
  return object && 'value' in object ? object.value : value
}

function text(value: unknown): string | undefined {
  const unwrapped = wrappedValue(value)
  return typeof unwrapped === 'string' && unwrapped.length > 0 ? unwrapped : undefined
}

function reference(value: unknown): string | undefined {
  const unwrapped = wrappedValue(value)
  return typeof unwrapped === 'number' && unwrapped > 0 ? String(unwrapped) : undefined
}

function references(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(reference).filter((item): item is string => item !== undefined)
}

function vectorValues(vector: IfcVector<number>): number[] {
  const values: number[] = []
  for (let index = 0; index < vector.size(); index++) {
    const value = vector.get(index)
    if (value > 0) values.push(value)
  }
  return values
}

const SI_PREFIX: Readonly<Record<string, number>> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
  HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3,
  MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
}

function siUnitScale(line: IfcRecord): [keyof IfcUnitScales, IfcUnitScale] | null {
  const unitType = text(line.UnitType)?.toUpperCase()
  const prefixName = text(line.Prefix)?.toUpperCase()
  const prefix = prefixName ? SI_PREFIX[prefixName] : 1
  const name = text(line.Name)?.toUpperCase()
  if (!unitType || !name) return null

  if (unitType === 'LENGTHUNIT' && name === 'METRE') {
    return ['length', {
      toSI: prefix,
      sourceUnit: prefixName === 'MILLI' ? 'mm' : prefixName === 'CENTI' ? 'cm' : 'm',
      unitSI: 'm',
    }]
  }
  if (unitType === 'AREAUNIT' && name === 'SQUARE_METRE') {
    return ['area', {
      toSI: prefix ** 2,
      sourceUnit: prefixName === 'MILLI' ? 'mm²' : prefixName === 'CENTI' ? 'cm²' : 'm²',
      unitSI: 'm²',
    }]
  }
  if (unitType === 'VOLUMEUNIT' && name === 'CUBIC_METRE') {
    return ['volume', {
      toSI: prefix ** 3,
      sourceUnit: prefixName === 'MILLI' ? 'mm³' : prefixName === 'CENTI' ? 'cm³' : 'm³',
      unitSI: 'm³',
    }]
  }
  if (unitType === 'MASSUNIT' && name === 'GRAM') {
    return ['mass', {
      toSI: prefix / 1000,
      sourceUnit: prefixName === 'KILO' ? 'kg' : 'g',
      unitSI: 'kg',
    }]
  }
  if (unitType === 'TIMEUNIT' && name === 'SECOND') {
    return ['time', { toSI: prefix, sourceUnit: 's', unitSI: 's' }]
  }
  return null
}

const CONVERSION_UNITS: Readonly<Record<string, [keyof IfcUnitScales, IfcUnitScale]>> = {
  FOOT: ['length', { toSI: 0.3048, sourceUnit: 'ft', unitSI: 'm' }],
  FEET: ['length', { toSI: 0.3048, sourceUnit: 'ft', unitSI: 'm' }],
  INCH: ['length', { toSI: 0.0254, sourceUnit: 'in', unitSI: 'm' }],
  INCHES: ['length', { toSI: 0.0254, sourceUnit: 'in', unitSI: 'm' }],
  'SQUARE FOOT': ['area', { toSI: 0.09290304, sourceUnit: 'ft²', unitSI: 'm²' }],
  'SQUARE FEET': ['area', { toSI: 0.09290304, sourceUnit: 'ft²', unitSI: 'm²' }],
  'CUBIC FOOT': ['volume', { toSI: 0.028316846592, sourceUnit: 'ft³', unitSI: 'm³' }],
  'CUBIC FEET': ['volume', { toSI: 0.028316846592, sourceUnit: 'ft³', unitSI: 'm³' }],
}

function readUnitScales(api: IfcMetadataApi, modelID: number): IfcUnitScales {
  const scales: IfcUnitScales = {
    count: { toSI: 1, sourceUnit: 'count', unitSI: 'count' },
  }
  const scan = (className: string, visit: (line: IfcRecord) => void) => {
    const type = api.GetTypeCodeFromName(className)
    if (!type) return
    const ids = vectorValues(api.GetLineIDsWithType(modelID, type, true))
    for (const id of ids) {
      const line = record(api.GetLine(modelID, id, true))
      if (line) visit(line)
    }
  }
  scan('IFCSIUNIT', (line) => {
    const parsed = siUnitScale(line)
    if (parsed) scales[parsed[0]] = parsed[1]
  })
  scan('IFCCONVERSIONBASEDUNIT', (line) => {
    const parsed = CONVERSION_UNITS[text(line.Name)?.trim().toUpperCase() ?? '']
    if (parsed) scales[parsed[0]] = parsed[1]
  })
  return scales
}

function transformPoint(
  matrix: Array<number>,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  }
}

function measuredPlanLoop(
  triangles: Array<[BimPoint3, BimPoint3, BimPoint3]>,
): Array<{ x: number; y: number }> | undefined {
  if (triangles.length === 0) return undefined
  const ys = triangles.flatMap((triangle) => triangle.map((point) => point.y))
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const tolerance = Math.max(0.002, (maxY - minY) * 0.002)
  const horizontal = (plane: number) => triangles.filter((triangle) =>
    triangle.every((point) => Math.abs(point.y - plane) <= tolerance))
  const faces = horizontal(minY).length ? horizontal(minY) : horizontal(maxY)
  if (faces.length === 0) return undefined

  const pointByKey = new Map<string, { x: number; y: number }>()
  const edges = new Map<string, { a: string; b: string; count: number }>()
  const pointKey = (point: BimPoint3) => `${Math.round(point.x * 10000)},${Math.round(point.z * 10000)}`
  const addEdge = (from: BimPoint3, to: BimPoint3) => {
    const a = pointKey(from)
    const b = pointKey(to)
    if (a === b) return
    pointByKey.set(a, { x: from.x, y: from.z })
    pointByKey.set(b, { x: to.x, y: to.z })
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const current = edges.get(key)
    if (current) current.count++
    else edges.set(key, { a, b, count: 1 })
  }
  for (const [a, b, c] of faces) {
    addEdge(a, b)
    addEdge(b, c)
    addEdge(c, a)
  }

  const boundary = [...edges.values()].filter((edge) => edge.count === 1)
  const neighbours = new Map<string, string[]>()
  for (const edge of boundary) {
    neighbours.set(edge.a, [...(neighbours.get(edge.a) ?? []), edge.b])
    neighbours.set(edge.b, [...(neighbours.get(edge.b) ?? []), edge.a])
  }
  const unused = new Set(boundary.map((edge) => edge.a < edge.b
    ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`))
  const loops: Array<Array<{ x: number; y: number }>> = []
  for (const first of boundary) {
    const firstEdge = first.a < first.b ? `${first.a}|${first.b}` : `${first.b}|${first.a}`
    if (!unused.has(firstEdge)) continue
    const keys = [first.a]
    let previous = first.a
    let current = first.b
    unused.delete(firstEdge)
    for (let step = 0; step <= boundary.length; step++) {
      if (current === keys[0]) break
      keys.push(current)
      const next = (neighbours.get(current) ?? []).find((candidate) => {
        if (candidate === previous) return false
        const edge = current < candidate ? `${current}|${candidate}` : `${candidate}|${current}`
        return unused.has(edge)
      })
      if (!next) break
      const edge = current < next ? `${current}|${next}` : `${next}|${current}`
      unused.delete(edge)
      previous = current
      current = next
    }
    if (current === keys[0] && keys.length >= 3) {
      loops.push(keys.map((key) => pointByKey.get(key)!).filter(Boolean))
    }
  }
  const area = (loop: Array<{ x: number; y: number }>) => Math.abs(loop.reduce((sum, point, index) => {
    const next = loop[(index + 1) % loop.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0) / 2)
  return loops.sort((left, right) => area(right) - area(left))[0]
}

function measureGeometry(
  api: IfcMetadataApi,
  modelID: number,
  expressID: number,
  includePlanAxis: boolean,
  includePlanLoop: boolean,
  includeMesh: boolean,
  meshBudget: { remainingVertices: number },
): BimElementGeometry | undefined {
  if (!api.GetFlatMesh || !api.GetGeometry || !api.GetVertexArray) return undefined

  const mesh = api.GetFlatMesh(modelID, expressID)
  const points: Array<{ x: number; y: number; z: number }> = []
  const meshPositions: number[] = []
  const meshIndices: number[] = []
  const planTriangles: Array<[BimPoint3, BimPoint3, BimPoint3]> = []
  let meshValid = includeMesh && Boolean(api.GetIndexArray)
  let meshOmittedReason: BimElementGeometry['meshOmittedReason']
  if (includeMesh && !api.GetIndexArray) meshOmittedReason = 'unavailable'
  let partCount = 0

  for (let partIndex = 0; partIndex < mesh.geometries.size(); partIndex++) {
    const placed = mesh.geometries.get(partIndex)
    if (placed.flatTransformation.length !== 16) continue
    const geometry = api.GetGeometry(modelID, placed.geometryExpressID)
    try {
      const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize())
      const partVertexCount = Math.floor(vertices.length / 6)
      const vertexOffset = meshPositions.length / 3
      if (meshValid && vertexOffset + partVertexCount > meshBudget.remainingVertices) {
        meshValid = false
        meshOmittedReason = 'budget'
        meshPositions.length = 0
        meshIndices.length = 0
      }
      const partPoints: BimPoint3[] = []
      // web-ifc interleaves XYZ position and XYZ normal.
      for (let index = 0; index + 2 < vertices.length; index += 6) {
        const point = transformPoint(
          placed.flatTransformation,
          vertices[index],
          vertices[index + 1],
          vertices[index + 2],
        )
        points.push(point)
        partPoints.push(point)
        if (meshValid) meshPositions.push(point.x, point.y, point.z)
      }
      const indices = api.GetIndexArray
        ? api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize())
        : undefined
      if (includePlanLoop && indices) {
        for (let index = 0; index + 2 < indices.length; index += 3) {
          const a = partPoints[indices[index]]
          const b = partPoints[indices[index + 1]]
          const c = partPoints[indices[index + 2]]
          if (a && b && c) planTriangles.push([a, b, c])
        }
      }
      if (meshValid && indices) {
        for (const index of indices) {
          if (index >= partVertexCount) {
            meshValid = false
            meshOmittedReason = 'invalid'
            meshPositions.length = 0
            meshIndices.length = 0
            break
          }
          meshIndices.push(vertexOffset + index)
        }
      }
      if (vertices.length > 0) partCount++
    } finally {
      geometry.delete()
    }
  }

  if (points.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let sumX = 0
  let sumZ = 0
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    minZ = Math.min(minZ, point.z)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
    maxZ = Math.max(maxZ, point.z)
    sumX += point.x
    sumZ += point.z
  }
  const geometry: BimElementGeometry = {
    bounds: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
    vertexCount: points.length,
    partCount,
  }
  if (includeMesh) {
    if (meshValid && meshPositions.length > 0 && meshIndices.length >= 3) {
      geometry.mesh = { positions: meshPositions, indices: meshIndices }
      meshBudget.remainingVertices -= meshPositions.length / 3
    } else {
      geometry.meshOmittedReason = meshOmittedReason ?? 'unavailable'
    }
  }

  if (includePlanLoop) geometry.planLoop = measuredPlanLoop(planTriangles)
  if (!includePlanAxis) return geometry

  const meanX = sumX / points.length
  const meanZ = sumZ / points.length
  let xx = 0
  let zz = 0
  let xz = 0
  for (const point of points) {
    const dx = point.x - meanX
    const dz = point.z - meanZ
    xx += dx * dx
    zz += dz * dz
    xz += dx * dz
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz)
  const axis = { x: Math.cos(angle), y: Math.sin(angle) }
  const normal = { x: -axis.y, y: axis.x }
  let minAlong = Infinity
  let maxAlong = -Infinity
  let minAcross = Infinity
  let maxAcross = -Infinity
  for (const point of points) {
    const along = point.x * axis.x + point.z * axis.y
    const across = point.x * normal.x + point.z * normal.y
    minAlong = Math.min(minAlong, along)
    maxAlong = Math.max(maxAlong, along)
    minAcross = Math.min(minAcross, across)
    maxAcross = Math.max(maxAcross, across)
  }
  const centreAcross = (minAcross + maxAcross) / 2
  const length = maxAlong - minAlong
  const thickness = maxAcross - minAcross
  const height = geometry.bounds.max.y - geometry.bounds.min.y

  // Near-square footprints do not define a reliable longitudinal direction.
  if (length > 0.05 && length > thickness * 1.25 && thickness > 0.01 && height > 0.05) {
    geometry.planAxis = {
      from: {
        x: axis.x * minAlong + normal.x * centreAcross,
        y: axis.y * minAlong + normal.y * centreAcross,
      },
      to: {
        x: axis.x * maxAlong + normal.x * centreAcross,
        y: axis.y * maxAlong + normal.y * centreAcross,
      },
      length,
      thickness,
      height,
    }
  }
  return geometry
}

/** Convert web-ifc wrapper objects to cloneable data and stop pathological cycles. */
function serialise(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > 12) return '[depth limit]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => serialise(item, seen, depth + 1))

  const result: Record<string, unknown> = {}
  for (const [name, child] of Object.entries(value)) {
    if (typeof child !== 'function') result[name] = serialise(child, seen, depth + 1)
  }
  return result
}

interface RelationIndex {
  byElement: Map<string, BimRelations>
  materialsByElement: Map<string, unknown[]>
  counts: Record<string, number>
  warnings: string[]
}

function relationsFor(index: RelationIndex, elementId: string): BimRelations {
  const current = index.byElement.get(elementId)
  if (current) return current
  const created: BimRelations = {}
  index.byElement.set(elementId, created)
  return created
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  return values?.includes(value) ? values : [...(values ?? []), value]
}

function indexRelationships(api: IfcMetadataApi, modelID: number): RelationIndex {
  const index: RelationIndex = {
    byElement: new Map(),
    materialsByElement: new Map(),
    counts: {},
    warnings: [],
  }

  const scan = (className: string, visit: (line: IfcRecord) => void) => {
    const type = api.GetTypeCodeFromName(className)
    if (!type) return
    const ids = vectorValues(api.GetLineIDsWithType(modelID, type, false))
    index.counts[className] = ids.length
    for (const id of ids) {
      const line = record(api.GetLine(modelID, id, false))
      if (line) visit(line)
    }
  }

  scan('IFCRELVOIDSELEMENT', (line) => {
    const hostId = reference(line.RelatingBuildingElement)
    const openingId = reference(line.RelatedOpeningElement)
    if (hostId && openingId) relationsFor(index, openingId).hostId = hostId
  })

  scan('IFCRELFILLSELEMENT', (line) => {
    const openingId = reference(line.RelatingOpeningElement)
    const fillingId = reference(line.RelatedBuildingElement)
    if (openingId && fillingId) {
      const filling = relationsFor(index, fillingId)
      filling.fillsOpeningId = openingId
      const openingHostId = index.byElement.get(openingId)?.hostId
      if (openingHostId) filling.hostId = openingHostId
    }
  })

  scan('IFCRELCONTAINEDINSPATIALSTRUCTURE', (line) => {
    const containerId = reference(line.RelatingStructure)
    if (!containerId) return
    for (const elementId of references(line.RelatedElements)) {
      relationsFor(index, elementId).containerId = containerId
    }
  })

  scan('IFCRELDEFINESBYTYPE', (line) => {
    const typeId = reference(line.RelatingType)
    if (!typeId) return
    for (const elementId of references(line.RelatedObjects)) {
      relationsFor(index, elementId).typeId = typeId
    }
  })

  scan('IFCRELAGGREGATES', (line) => {
    const parentId = reference(line.RelatingObject)
    if (!parentId) return
    for (const childId of references(line.RelatedObjects)) {
      relationsFor(index, childId).parentId = parentId
    }
  })

  scan('IFCRELASSIGNSTOGROUP', (line) => {
    const groupId = reference(line.RelatingGroup)
    if (!groupId) return
    for (const objectId of references(line.RelatedObjects)) {
      const relations = relationsFor(index, objectId)
      relations.groupIds = appendUnique(relations.groupIds, groupId)
    }
  })

  scan('IFCRELNESTS', (line) => {
    const parentId = reference(line.RelatingObject)
    if (!parentId) return
    for (const childId of references(line.RelatedObjects)) {
      relationsFor(index, childId).parentId ??= parentId
    }
  })

  scan('IFCRELCONNECTSELEMENTS', (line) => {
    const relatingId = reference(line.RelatingElement)
    const relatedId = reference(line.RelatedElement)
    if (!relatingId || !relatedId) return
    const relating = relationsFor(index, relatingId)
    const related = relationsFor(index, relatedId)
    relating.connectedIds = appendUnique(relating.connectedIds, relatedId)
    related.connectedIds = appendUnique(related.connectedIds, relatingId)
  })

  scan('IFCRELSPACEBOUNDARY', (line) => {
    const spaceId = reference(line.RelatingSpace)
    const elementId = reference(line.RelatedBuildingElement)
    if (!spaceId || !elementId) return
    const element = relationsFor(index, elementId)
    element.spaceIds = appendUnique(element.spaceIds, spaceId)
  })

  scan('IFCRELASSOCIATESMATERIAL', (line) => {
    const materialId = reference(line.RelatingMaterial)
    if (!materialId) return
    let material: unknown
    try {
      material = api.GetLine(modelID, Number(materialId), true)
    } catch (error) {
      index.warnings.push(
        `Material #${materialId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    for (const elementId of references(line.RelatedObjects)) {
      index.materialsByElement.set(elementId, [
        ...(index.materialsByElement.get(elementId) ?? []),
        material,
      ])
    }
  })

  return index
}

async function sourceProperties(
  api: IfcMetadataApi,
  modelID: number,
  expressID: number,
  line: IfcRecord,
  includeProperties: boolean,
  warn: (detail: string) => void,
): Promise<{ properties: Readonly<Record<string, unknown>>; propertySets: unknown[] }> {
  const properties: Record<string, unknown> = {
    expressId: expressID,
    globalId: text(line.GlobalId),
    name: text(line.Name),
    longName: text(line.LongName),
    elevation: typeof wrappedValue(line.Elevation) === 'number'
      ? wrappedValue(line.Elevation)
      : undefined,
    description: text(line.Description),
    objectType: text(line.ObjectType),
    tag: text(line.Tag),
    predefinedType: text(line.PredefinedType),
  }

  let propertySets: unknown[] = []
  if (includeProperties && api.properties) {
    const scans = await Promise.allSettled([
      api.properties.getPropertySets(modelID, expressID, true, false),
      api.properties.getTypeProperties(modelID, expressID, true),
      api.properties.getMaterialsProperties(modelID, expressID, true, true),
    ])
    const names = ['property sets', 'type properties', 'materials'] as const
    const keys = ['propertySets', 'typeProperties', 'materials'] as const
    scans.forEach((scan, index) => {
      if (scan.status === 'fulfilled') {
        properties[keys[index]] = serialise(scan.value)
        if (index === 0) propertySets = scan.value
      }
      else warn(`${names[index]}: ${scan.reason instanceof Error ? scan.reason.message : String(scan.reason)}`)
    })
  }

  return { properties, propertySets }
}

function objectDefinitionIds(api: IfcMetadataApi, modelID: number): Set<number> {
  const rootType = api.GetTypeCodeFromName('IFCOBJECTDEFINITION')
  if (!rootType) return new Set()
  return new Set(vectorValues(api.GetLineIDsWithType(modelID, rootType, true)))
}

/** Read a model that is already open in web-ifc. */
export async function extractOpenIfcMetadata(
  api: IfcMetadataApi,
  modelID: number,
  options: IfcMetadataOptions = {},
): Promise<IfcMetadataResult> {
  const includeProperties = options.includeProperties ?? true
  const includeGeometry = options.includeGeometry ?? false
  const includeMeshes = options.includeMeshes ?? false
  const meshBudget = {
    remainingVertices: Math.max(0, Math.floor(options.meshVertexBudget ?? 100_000)),
  }
  const meshKinds = new Set([
    'slab', 'roof', 'column', 'beam', 'stair', 'railing', 'furniture', 'equipment',
    'foundation', 'chimney', 'plate', 'ramp', 'covering', 'proxy',
  ])
  const typeCounts: Record<string, number> = {}
  const elements: BimElementSemantic[] = []
  const records: BimElementSemantic[] = []
  const warnings: string[] = []
  const relationIndex = indexRelationships(api, modelID)
  warnings.push(...relationIndex.warnings)
  const recordIds = objectDefinitionIds(api, modelID)
  const units = readUnitScales(api, modelID)

  for (const type of api.GetIfcEntityList(modelID)) {
    const className = api.GetNameFromTypeCode(type)
    const ids = vectorValues(api.GetLineIDsWithType(modelID, type, false))
    typeCounts[className] = ids.length

    const probe = classifyBimElement({ source: 'ifc', sourceId: 'probe', sourceClass: className })

    for (const expressID of ids) {
      const preserveRecord = recordIds.has(expressID)
      if (!preserveRecord && probe.kind === 'unknown') continue
      try {
        const line = record(api.GetLine(modelID, expressID, false)) ?? {}
        let geometry: BimElementGeometry | undefined
        if (includeGeometry && preserveRecord && probe.kind !== 'unknown') {
          try {
            geometry = measureGeometry(
              api,
              modelID,
              expressID,
              ['wall', 'curtain-wall', 'door', 'window', 'opening'].includes(probe.kind),
              probe.kind === 'space',
              includeMeshes && meshKinds.has(probe.kind),
              meshBudget,
            )
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            warnings.push(`#${expressID} ${className} geometry: ${detail}`)
          }
        }
        const source = await sourceProperties(
          api,
          modelID,
          expressID,
          line,
          includeProperties,
          (detail) => warnings.push(`#${expressID} ${className} ${detail}`),
        )
        const input: BimElementInput = {
          source: 'ifc',
          sourceId: String(expressID),
          sourceClass: className,
          name: text(line.Name),
          type: text(line.ObjectType),
          relations: relationIndex.byElement.get(String(expressID)),
          geometry,
          quantities: normaliseIfcQuantities(source.propertySets, units),
          materials: normaliseIfcMaterials(
            relationIndex.materialsByElement.get(String(expressID)) ?? [],
            units.length,
          ),
          properties: source.properties,
        }
        const semantic = classifyBimElement(input)
        if (preserveRecord) records.push(semantic)
        if (semantic.kind !== 'unknown') elements.push(semantic)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        warnings.push(`#${expressID} ${className}: ${detail}`)
      }
    }
  }

  return {
    schema: api.GetModelSchema(modelID),
    units,
    typeCounts,
    elements,
    records,
    relationCounts: relationIndex.counts,
    warnings,
    quality: analyseBimQuality(records, elements),
  }
}
