import type { BimQuantity, BimQuantityDimension } from './semantics'

export interface IfcUnitScale {
  toSI: number
  sourceUnit: string
  unitSI: NonNullable<BimQuantity['unitSI']>
}

export type IfcUnitScales = Partial<Record<BimQuantityDimension, IfcUnitScale>>

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null
}

function wrapped(value: unknown): unknown {
  const object = record(value)
  if (!object) return value
  if (typeof object._representationValue === 'number') return object._representationValue
  return 'value' in object ? object.value : value
}

function text(value: unknown): string | undefined {
  const valueText = wrapped(value)
  return typeof valueText === 'string' && valueText.length > 0 ? valueText : undefined
}

function number(value: unknown): number | undefined {
  const numeric = wrapped(value)
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric
  if (typeof numeric === 'string') {
    const parsed = Number(numeric)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const VALUE_FIELDS: ReadonlyArray<{
  field: string
  dimension: BimQuantityDimension
  unitSI: NonNullable<BimQuantity['unitSI']>
}> = [
  { field: 'LengthValue', dimension: 'length', unitSI: 'm' },
  { field: 'AreaValue', dimension: 'area', unitSI: 'm²' },
  { field: 'VolumeValue', dimension: 'volume', unitSI: 'm³' },
  { field: 'CountValue', dimension: 'count', unitSI: 'count' },
  { field: 'WeightValue', dimension: 'mass', unitSI: 'kg' },
  { field: 'TimeValue', dimension: 'time', unitSI: 's' },
]

/** Normalize IfcElementQuantity entries without discarding their source values. */
export function normaliseIfcQuantities(
  propertySets: unknown[],
  units: IfcUnitScales,
): BimQuantity[] {
  const quantities: BimQuantity[] = []
  for (const propertySetValue of propertySets) {
    const propertySet = record(propertySetValue)
    if (!propertySet || !Array.isArray(propertySet.Quantities)) continue
    const setName = text(propertySet.Name)

    for (const quantityValue of propertySet.Quantities) {
      const quantity = record(quantityValue)
      if (!quantity) continue
      const definition = VALUE_FIELDS.find(({ field }) => field in quantity)
      if (!definition) continue
      const sourceValue = number(quantity[definition.field])
      const name = text(quantity.Name)
      if (sourceValue === undefined || !name) continue

      const scale = units[definition.dimension]
      quantities.push({
        name,
        dimension: definition.dimension,
        sourceValue,
        sourceUnit: scale?.sourceUnit,
        valueSI: scale ? sourceValue * scale.toSI : undefined,
        unitSI: scale?.unitSI,
        setName,
        sourceQuantityId:
          typeof quantity.expressID === 'number' ? String(quantity.expressID) : undefined,
      })
    }
  }
  return quantities
}
