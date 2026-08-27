import type { BimMaterial, BimMaterialLayer } from './semantics'
import type { IfcUnitScale } from './quantities'

type NativeRecord = Record<string, unknown>

function record(value: unknown): NativeRecord | null {
  return value !== null && typeof value === 'object' ? value as NativeRecord : null
}

function value(value: unknown): unknown {
  const object = record(value)
  if (!object) return value
  if ('value' in object) return object.value
  if (typeof object._representationValue === 'number') return object._representationValue
  return value
}

function text(valueToRead: unknown): string | undefined {
  const unwrapped = value(valueToRead)
  return typeof unwrapped === 'string' && unwrapped.trim()
    ? unwrapped.trim()
    : undefined
}

function number(valueToRead: unknown): number | undefined {
  const unwrapped = value(valueToRead)
  return typeof unwrapped === 'number' && Number.isFinite(unwrapped)
    ? unwrapped
    : undefined
}

function sourceId(object: NativeRecord): string | undefined {
  const id = number(object.expressID) ?? number(object.uniqueId) ?? number(object.elementId)
  if (id !== undefined) return String(id)
  return text(object.uniqueId) ?? text(object.id)
}

function materialLayer(
  valueToRead: unknown,
  lengthUnit?: IfcUnitScale,
): BimMaterialLayer | null {
  const layer = record(valueToRead)
  if (!layer) return null
  const material = record(layer.Material ?? layer.material) ?? layer
  const sourceThickness = number(
    layer.LayerThickness ?? layer.layerThickness ?? layer.thickness ?? layer.width,
  )
  return {
    sourceId: sourceId(material) ?? sourceId(layer),
    name: text(material.Name ?? material.name),
    category: text(material.Category ?? material.category),
    sourceThickness,
    sourceUnit: sourceThickness === undefined ? undefined : lengthUnit?.sourceUnit,
    thicknessSI: sourceThickness === undefined || !lengthUnit
      ? undefined
      : sourceThickness * lengthUnit.toSI,
  }
}

function childArray(object: NativeRecord): unknown[] | undefined {
  for (const key of [
    'MaterialLayers', 'materialLayers', 'layers',
    'MaterialProfiles', 'materialProfiles',
    'MaterialConstituents', 'materialConstituents',
    'Materials', 'materials',
  ]) {
    if (Array.isArray(object[key])) return object[key] as unknown[]
  }
  return undefined
}

function normaliseMaterial(valueToRead: unknown, lengthUnit?: IfcUnitScale): BimMaterial | null {
  const root = record(valueToRead)
  if (!root) return null
  const set = record(root.ForLayerSet ?? root.forLayerSet) ?? root
  const children = childArray(set)
  if (children) {
    const layers = children
      .map((child) => materialLayer(child, lengthUnit))
      .filter((layer): layer is BimMaterialLayer => layer !== null)
    return {
      sourceId: sourceId(set) ?? sourceId(root),
      name: text(set.LayerSetName ?? set.Name ?? set.name)
        ?? (layers.length === 1 ? layers[0].name : undefined),
      category: text(set.Category ?? set.category),
      layers,
    }
  }

  const direct = materialLayer(root, lengthUnit)
  if (!direct?.name && !direct?.sourceId) return null
  return {
    sourceId: direct.sourceId,
    name: direct.name,
    category: direct.category,
    layers: direct.sourceThickness === undefined ? [] : [direct],
  }
}

function deduplicate(materials: BimMaterial[]): BimMaterial[] {
  const seen = new Set<string>()
  return materials.filter((material) => {
    const key = JSON.stringify(material)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Normalize flattened IFC material/select entities without inventing units. */
export function normaliseIfcMaterials(
  values: unknown[],
  lengthUnit?: IfcUnitScale,
): BimMaterial[] {
  return deduplicate(values
    .map((entry) => normaliseMaterial(entry, lengthUnit))
    .filter((material): material is BimMaterial => material !== null))
}

/** Normalize the authorized Revit connector's SI material records. */
export function normaliseRevitMaterials(values: unknown[]): BimMaterial[] {
  const metre: IfcUnitScale = { toSI: 1, sourceUnit: 'm', unitSI: 'm' }
  return deduplicate(values
    .map((entry) => normaliseMaterial(entry, metre))
    .filter((material): material is BimMaterial => material !== null))
}
