import type { BimElementSemantic } from './semantics'

export type BimQualitySeverity = 'error' | 'warning' | 'info'

export interface BimQualityIssue {
  code:
    | 'duplicate-global-id'
    | 'orphan-opening'
    | 'unresolved-host'
    | 'missing-container'
    | 'invalid-bounds'
    | 'unresolved-quantity-unit'
  severity: BimQualitySeverity
  message: string
  sourceIds: string[]
}

export interface BimQualityReport {
  issues: BimQualityIssue[]
  counts: Record<BimQualitySeverity, number>
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

/** Evidence-based model diagnostics; never changes or guesses source data. */
export function analyseBimQuality(
  records: BimElementSemantic[],
  elements: BimElementSemantic[],
): BimQualityReport {
  const issues: BimQualityIssue[] = []
  const byGlobalId = new Map<string, string[]>()

  for (const record of records) {
    const globalId = record.properties.globalId
    if (typeof globalId === 'string' && globalId.length > 0) {
      byGlobalId.set(globalId, [...(byGlobalId.get(globalId) ?? []), record.sourceId])
    }
    const bounds = record.geometry?.bounds
    if (bounds && (
      ![bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z]
        .every(finite)
      || bounds.min.x > bounds.max.x
      || bounds.min.y > bounds.max.y
      || bounds.min.z > bounds.max.z
    )) {
      issues.push({
        code: 'invalid-bounds',
        severity: 'error',
        message: 'Geometry bounds are non-finite or inverted.',
        sourceIds: [record.sourceId],
      })
    }
    const unresolved = record.quantities.filter((quantity) => quantity.valueSI === undefined)
    if (unresolved.length > 0) {
      issues.push({
        code: 'unresolved-quantity-unit',
        severity: 'warning',
        message: `${unresolved.length} source quantities could not be normalized because their unit is unresolved.`,
        sourceIds: [record.sourceId],
      })
    }
  }

  for (const [globalId, sourceIds] of byGlobalId) {
    if (sourceIds.length < 2) continue
    issues.push({
      code: 'duplicate-global-id',
      severity: 'error',
      message: `IFC GlobalId ${globalId} is used by ${sourceIds.length} records.`,
      sourceIds,
    })
  }

  for (const element of elements) {
    if (element.kind === 'opening' && !element.relations.hostId) {
      issues.push({
        code: 'orphan-opening',
        severity: 'error',
        message: 'Opening has no IfcRelVoidsElement host.',
        sourceIds: [element.sourceId],
      })
    }
    if (
      (element.kind === 'door' || element.kind === 'window')
      && element.relations.fillsOpeningId
      && !element.relations.hostId
    ) {
      issues.push({
        code: 'unresolved-host',
        severity: 'warning',
        message: 'Filled opening does not resolve through to a host building element.',
        sourceIds: [element.sourceId],
      })
    }
    if (
      !['space', 'proxy'].includes(element.kind)
      && !element.relations.containerId
    ) {
      issues.push({
        code: 'missing-container',
        severity: 'info',
        message: 'Building element is not assigned to an IFC spatial container.',
        sourceIds: [element.sourceId],
      })
    }
  }

  return {
    issues,
    counts: {
      error: issues.filter((issue) => issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
      info: issues.filter((issue) => issue.severity === 'info').length,
    },
  }
}
