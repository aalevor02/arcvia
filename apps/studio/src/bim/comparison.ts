import type { BimAnalysisElement, BimPlanAnalysis } from './analytics'

export interface BimElementModification {
  key: string
  sourceId: string
  sourceClass?: string
  geometryChanged: boolean
  semanticsChanged: boolean
  storeyChanged: boolean
  kindChanged: boolean
  nativeClassChanged: boolean
  instanceCountChanged: boolean
}

export interface BimAnalysisComparison {
  version: 1
  beforeSource: BimPlanAnalysis['source']
  afterSource: BimPlanAnalysis['source']
  added: BimAnalysisElement[]
  removed: BimAnalysisElement[]
  modified: BimElementModification[]
  unchanged: number
}

export function isBimPlanAnalysis(value: unknown): value is BimPlanAnalysis {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BimPlanAnalysis>
  return candidate.version === 1
    && Array.isArray(candidate.elements)
    && candidate.elements.every((element) =>
      Boolean(element)
      && typeof element.key === 'string'
      && typeof element.sourceId === 'string'
      && typeof element.semanticFingerprint === 'string'
      && typeof element.geometryFingerprint === 'string')
}

/** Compare two local analysis exports using stable native source identity. */
export function compareBimAnalyses(
  before: BimPlanAnalysis,
  after: BimPlanAnalysis,
): BimAnalysisComparison {
  const beforeByKey = new Map(before.elements.map((element) => [element.key, element]))
  const afterByKey = new Map(after.elements.map((element) => [element.key, element]))
  const added = after.elements.filter((element) => !beforeByKey.has(element.key))
  const removed = before.elements.filter((element) => !afterByKey.has(element.key))
  const modified: BimElementModification[] = []
  let unchanged = 0

  for (const afterElement of after.elements) {
    const beforeElement = beforeByKey.get(afterElement.key)
    if (!beforeElement) continue
    const change: BimElementModification = {
      key: afterElement.key,
      sourceId: afterElement.sourceId,
      sourceClass: afterElement.sourceClass,
      geometryChanged: beforeElement.geometryFingerprint !== afterElement.geometryFingerprint,
      semanticsChanged: beforeElement.semanticFingerprint !== afterElement.semanticFingerprint,
      storeyChanged: beforeElement.storeys.join('\u0000') !== afterElement.storeys.join('\u0000'),
      kindChanged: beforeElement.kind !== afterElement.kind,
      nativeClassChanged: beforeElement.sourceClass !== afterElement.sourceClass,
      instanceCountChanged:
        beforeElement.editableInstanceCount !== afterElement.editableInstanceCount,
    }
    if (
      change.geometryChanged
      || change.semanticsChanged
      || change.storeyChanged
      || change.kindChanged
      || change.nativeClassChanged
      || change.instanceCountChanged
    ) modified.push(change)
    else unchanged++
  }

  return {
    version: 1,
    beforeSource: before.source,
    afterSource: after.source,
    added,
    removed,
    modified: modified.sort((left, right) => left.key.localeCompare(right.key)),
    unchanged,
  }
}
