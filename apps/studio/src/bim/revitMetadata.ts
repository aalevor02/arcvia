import type { IfcMetadataResult } from './ifcMetadata'
import { analyseBimQuality } from './quality'
import {
  classifyBimElement,
  type BimElementGeometry,
  type BimQuantity,
  type BimQuantityDimension,
  type BimSource,
} from './semantics'
import { normaliseRevitMaterials } from './materials'

interface RevitPoint {
  x: number
  y: number
  z: number
}

export interface RevitExportElement {
  uniqueId: string
  elementId?: number
  runtimeClass?: string
  builtInCategory?: string
  category?: string
  family?: string
  type?: string
  name?: string
  hostUniqueId?: string
  levelUniqueId?: string
  typeUniqueId?: string
  bounds?: { min: RevitPoint; max: RevitPoint }
  /** Connector-derived longitudinal axis in Revit XY, avoiding mesh/AABB guesses. */
  planAxis?: {
    from: RevitPoint
    to: RevitPoint
    thickness: number
    height: number
  }
  parameters?: Readonly<Record<string, unknown>>
  materials?: unknown[]
  quantities?: Array<{
    name: string
    dimension: BimQuantityDimension
    sourceValue: number
    sourceUnit?: string
    valueSI?: number
    unitSI?: BimQuantity['unitSI']
    parameterId?: string
  }>
}

export interface RevitExportEnvelope {
  format: 'arcvia-revit-export'
  version: 1
  source: Extract<BimSource, 'revit-api' | 'autodesk-aps'>
  /** Connector contract requires SI coordinates. */
  units: 'm'
  coordinateSystem: 'revit-xyz'
  document: {
    title?: string
    path?: string
    centralModelGuid?: string
    revitVersion?: string
  }
  elements: RevitExportElement[]
}

function finitePoint(point: RevitPoint): boolean {
  return [point.x, point.y, point.z].every(Number.isFinite)
}

function geometry(element: RevitExportElement): BimElementGeometry | undefined {
  const bounds = element.bounds
  if (!bounds || !finitePoint(bounds.min) || !finitePoint(bounds.max)) return undefined
  // Revit is Z-up; Arcvia's BIM geometry contract is Y-up.
  const result: BimElementGeometry = {
    bounds: {
      min: { x: bounds.min.x, y: bounds.min.z, z: bounds.min.y },
      max: { x: bounds.max.x, y: bounds.max.z, z: bounds.max.y },
    },
    vertexCount: 0,
    partCount: 1,
  }
  const axis = element.planAxis
  if (axis && finitePoint(axis.from) && finitePoint(axis.to)) {
    const length = Math.hypot(axis.to.x - axis.from.x, axis.to.y - axis.from.y)
    if (length > 0.01 && axis.thickness > 0.001 && axis.height > 0.01) {
      result.planAxis = {
        from: { x: axis.from.x, y: axis.from.y },
        to: { x: axis.to.x, y: axis.to.y },
        length,
        thickness: axis.thickness,
        height: axis.height,
      }
    }
  }
  return result
}

function quantities(element: RevitExportElement): BimQuantity[] {
  return (element.quantities ?? [])
    .filter((quantity) => Number.isFinite(quantity.sourceValue))
    .map((quantity) => ({
      name: quantity.name,
      dimension: quantity.dimension,
      sourceValue: quantity.sourceValue,
      sourceUnit: quantity.sourceUnit,
      valueSI: quantity.valueSI,
      unitSI: quantity.unitSI,
      setName: 'Revit parameters',
      sourceQuantityId: quantity.parameterId,
    }))
}

/** Parse an authorized connector export; this function never opens or scrapes RVT files. */
export function readRevitExport(value: unknown): IfcMetadataResult {
  const envelope = value as Partial<RevitExportEnvelope>
  if (
    envelope?.format !== 'arcvia-revit-export'
    || envelope.version !== 1
    || (envelope.source !== 'revit-api' && envelope.source !== 'autodesk-aps')
    || envelope.units !== 'm'
    || envelope.coordinateSystem !== 'revit-xyz'
    || !Array.isArray(envelope.elements)
  ) {
    throw new Error('Unsupported Revit export. Use Arcvia Revit Export version 1 in SI metres.')
  }

  const warnings: string[] = []
  const records = envelope.elements.map((element) => {
    if (!element.uniqueId) warnings.push('A Revit record has no UniqueId.')
    return classifyBimElement({
      source: envelope.source!,
      sourceId: element.uniqueId || `missing-${element.elementId ?? 'id'}`,
      sourceClass: element.runtimeClass,
      category: element.builtInCategory ?? element.category,
      family: element.family,
      type: element.type,
      name: element.name,
      relations: {
        hostId: element.hostUniqueId,
        containerId: element.levelUniqueId,
        typeId: element.typeUniqueId,
      },
      geometry: geometry(element),
      quantities: quantities(element),
      materials: normaliseRevitMaterials(element.materials ?? []),
      properties: {
        uniqueId: element.uniqueId,
        globalId: element.uniqueId,
        elementId: element.elementId,
        runtimeClass: element.runtimeClass,
        builtInCategory: element.builtInCategory,
        category: element.category,
        family: element.family,
        type: element.type,
        name: element.name,
        parameters: element.parameters,
        materials: element.materials,
      },
    })
  })
  const elements = records.filter((record) => record.kind !== 'unknown')
  const typeCounts: Record<string, number> = {}
  for (const record of records) {
    const key = record.sourceClass ?? 'Unknown Revit class'
    typeCounts[key] = (typeCounts[key] ?? 0) + 1
  }

  return {
    schema: `REVIT-EXPORT-1${envelope.document?.revitVersion ? ` / ${envelope.document.revitVersion}` : ''}`,
    units: {
      length: { toSI: 1, sourceUnit: 'm', unitSI: 'm' },
      area: { toSI: 1, sourceUnit: 'm²', unitSI: 'm²' },
      volume: { toSI: 1, sourceUnit: 'm³', unitSI: 'm³' },
      mass: { toSI: 1, sourceUnit: 'kg', unitSI: 'kg' },
      time: { toSI: 1, sourceUnit: 's', unitSI: 's' },
      count: { toSI: 1, sourceUnit: 'count', unitSI: 'count' },
    },
    typeCounts,
    records,
    elements,
    relationCounts: {},
    warnings,
    quality: analyseBimQuality(records, elements),
  }
}
