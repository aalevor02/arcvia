import type {
  BimAnalysisCount,
  BimAnalysisElementFeatures,
  BimPlanAnalysis,
} from './analytics'

export type BimDatasetSplit = 'train' | 'validation' | 'test'

export interface BimLearningDatasetOptions {
  datasetName: string
  /** Stable across every revision of the same building. */
  buildingId: string
  licence: string
  attribution?: string
  sourceUrl?: string
  /** Must be explicitly confirmed at the export boundary. */
  rightsConfirmed: boolean
}

export interface BimLearningExample {
  id: string
  buildingId: string
  split: BimDatasetSplit
  source: string
  sourceId: string
  nativeClass?: string
  label: string
  storeys: string[]
  editableInstanceCount: number
  semanticFingerprint: string
  geometryFingerprint: string
  features: BimAnalysisElementFeatures
}

export interface BimLearningDataset {
  version: 1
  datasetId: string
  manifest: {
    name: string
    buildingId: string
    licence: string
    attribution?: string
    sourceUrl?: string
    source: BimPlanAnalysis['source']
    rightsConfirmed: true
    units: 'SI'
    rawPropertyValuesExcluded: true
  }
  split: {
    name: BimDatasetSplit
    bucket: number
    strategy: 'whole-building-hash-v1'
    ratios: { train: 80; validation: 10; test: 10 }
  }
  summary: {
    exampleCount: number
    byLabel: BimAnalysisCount[]
    unknownLabelCount: number
  }
  examples: BimLearningExample[]
}

function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

/** Assign an entire building, including all revisions and elements, to one split. */
export function splitForBuilding(buildingId: string): {
  name: BimDatasetSplit
  bucket: number
} {
  const normalized = buildingId.trim().toLocaleLowerCase('en-US')
  if (!normalized) throw new Error('A stable building ID is required.')
  const bucket = hash32(normalized) % 100
  return {
    name: bucket < 80 ? 'train' : bucket < 90 ? 'validation' : 'test',
    bucket,
  }
}

function required(value: string, message: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(message)
  return normalized
}

/**
 * Build a deterministic, source-deduplicated learning package.
 *
 * Raw BIM property values are deliberately excluded: labels, normalized
 * measurements and structural feature presence are enough for the first
 * classifier experiments and reduce accidental disclosure of project data.
 */
export function createBimLearningDataset(
  analysis: BimPlanAnalysis,
  options: BimLearningDatasetOptions,
): BimLearningDataset {
  if (options.rightsConfirmed !== true) {
    throw new Error('Confirm that this model may be used for learning before export.')
  }
  const name = required(options.datasetName, 'A dataset name is required.')
  const buildingId = required(options.buildingId, 'A stable building ID is required.')
  const licence = required(options.licence, 'A licence or internal-use permission is required.')
  const split = splitForBuilding(buildingId)
  const counts = new Map<string, number>()
  const examples = analysis.elements.map((element) => {
    counts.set(element.kind, (counts.get(element.kind) ?? 0) + 1)
    return {
      id: `${buildingId}:${element.key}`,
      buildingId,
      split: split.name,
      source: element.source,
      sourceId: element.sourceId,
      nativeClass: element.sourceClass,
      label: element.kind,
      storeys: [...element.storeys],
      editableInstanceCount: element.editableInstanceCount,
      semanticFingerprint: element.semanticFingerprint,
      geometryFingerprint: element.geometryFingerprint,
      features: structuredClone(element.features),
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const byLabel = [...counts].map(([label, count]) => ({ name: label, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  const contentIdentity = analysis.elements.map((element) =>
    `${element.key}:${element.semanticFingerprint}:${element.geometryFingerprint}`).join('\u0000')
  const identity = `${name}\u0000${buildingId}\u0000${licence}\u0000${contentIdentity}`

  return {
    version: 1,
    datasetId: `arcvia-bim-${hash32(identity).toString(16).padStart(8, '0')}`,
    manifest: {
      name,
      buildingId,
      licence,
      attribution: options.attribution?.trim() || undefined,
      sourceUrl: options.sourceUrl?.trim() || undefined,
      source: analysis.source,
      rightsConfirmed: true,
      units: 'SI',
      rawPropertyValuesExcluded: true,
    },
    split: {
      ...split,
      strategy: 'whole-building-hash-v1',
      ratios: { train: 80, validation: 10, test: 10 },
    },
    summary: {
      exampleCount: examples.length,
      byLabel,
      unknownLabelCount: counts.get('unknown') ?? 0,
    },
    examples,
  }
}
