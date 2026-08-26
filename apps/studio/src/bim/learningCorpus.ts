import type { BimAnalysisCount } from './analytics'
import {
  splitForBuilding,
  type BimDatasetSplit,
  type BimLearningDataset,
  type BimLearningExample,
} from './learningDataset'

export type BimCorpusIssueCode =
  | 'duplicate-dataset'
  | 'invalid-building-split'
  | 'example-building-mismatch'
  | 'example-split-mismatch'
  | 'duplicate-example'
  | 'label-conflict'
  | 'cross-split-geometry-duplicate'
  | 'unknown-label'
  | 'low-confidence'
  | 'missing-geometry-features'

export interface BimCorpusIssue {
  severity: 'error' | 'warning'
  code: BimCorpusIssueCode
  count: number
  message: string
}

export interface BimLearningCorpus {
  version: 1
  corpusId: string
  trainingReady: boolean
  datasets: Array<{
    datasetId: string
    buildingId: string
    name: string
    licence: string
    split: BimDatasetSplit
    exampleCount: number
  }>
  summary: {
    datasetCount: number
    buildingCount: number
    exampleCount: number
    bySplit: Array<{ name: BimDatasetSplit; buildings: number; examples: number }>
    byLabel: BimAnalysisCount[]
    bySource: BimAnalysisCount[]
    propertyFieldCoverage: BimAnalysisCount[]
    examplesWithGeometry: number
    examplesWithQuantities: number
    examplesWithMaterials: number
  }
  issues: BimCorpusIssue[]
  examples: BimLearningExample[]
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function isSplit(value: unknown): value is BimDatasetSplit {
  return value === 'train' || value === 'validation' || value === 'test'
}

/** Validate the privacy/licensing boundary before a package enters a corpus. */
export function isBimLearningDataset(value: unknown): value is BimLearningDataset {
  const candidate = object(value)
  if (!candidate || candidate.version !== 1 || typeof candidate.datasetId !== 'string') return false
  const manifest = object(candidate.manifest)
  const split = object(candidate.split)
  if (!manifest || !split || !Array.isArray(candidate.examples)) return false
  if (typeof manifest.name !== 'string' || !manifest.name.trim()
    || typeof manifest.buildingId !== 'string' || !manifest.buildingId.trim()
    || typeof manifest.licence !== 'string' || !manifest.licence.trim()
    || manifest.rightsConfirmed !== true || manifest.units !== 'SI'
    || manifest.rawPropertyValuesExcluded !== true
    || !isSplit(split.name) || typeof split.bucket !== 'number'
    || split.strategy !== 'whole-building-hash-v1') return false
  return candidate.examples.every((value) => {
    const example = object(value)
    const features = object(example?.features)
    const semantic = object(features?.semantic)
    const relations = object(features?.relations)
    const geometry = object(features?.geometry)
    return Boolean(example
      && typeof example.id === 'string'
      && typeof example.buildingId === 'string'
      && typeof example.source === 'string'
      && typeof example.sourceId === 'string'
      && typeof example.label === 'string'
      && isSplit(example.split)
      && typeof example.semanticFingerprint === 'string'
      && typeof example.geometryFingerprint === 'string'
      && Array.isArray(example.storeys)
      && typeof example.editableInstanceCount === 'number'
      && semantic && Array.isArray(semantic.evidenceBases)
      && Array.isArray(semantic.propertyNames)
      && typeof semantic.conflictCount === 'number'
      && relations && geometry
      && Array.isArray(features?.quantities)
      && Array.isArray(features?.materials))
  })
}

function hash32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function sortedCounts(map: Map<string, number>): BimAnalysisCount[] {
  return [...map].map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function hasGeometry(example: BimLearningExample): boolean {
  const geometry = example.features.geometry
  return geometry.lengthSI !== undefined
    || geometry.widthSI !== undefined
    || geometry.depthSI !== undefined
    || geometry.thicknessSI !== undefined
    || geometry.heightSI !== undefined
    || geometry.vertexCount !== undefined
    || geometry.triangleCount !== undefined
}

/** Combine local packages and audit whether the result is safe to train/evaluate on. */
export function buildBimLearningCorpus(datasets: BimLearningDataset[]): BimLearningCorpus {
  const ordered = [...datasets].sort((left, right) =>
    left.datasetId.localeCompare(right.datasetId)
    || left.manifest.buildingId.localeCompare(right.manifest.buildingId))
  const issueCounts = new Map<BimCorpusIssueCode, number>()
  const addIssue = (code: BimCorpusIssueCode, amount = 1) =>
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + amount)
  const seenDatasets = new Set<string>()
  const seenExamples = new Set<string>()
  const sourceLabels = new Map<string, string>()
  const geometrySplits = new Map<string, Set<BimDatasetSplit>>()
  const uniqueExamples: BimLearningExample[] = []
  const buildings = new Map<string, BimDatasetSplit>()

  for (const dataset of ordered) {
    if (seenDatasets.has(dataset.datasetId)) addIssue('duplicate-dataset')
    seenDatasets.add(dataset.datasetId)
    const expected = splitForBuilding(dataset.manifest.buildingId)
    if (dataset.split.name !== expected.name || dataset.split.bucket !== expected.bucket) {
      addIssue('invalid-building-split')
    }
    const knownSplit = buildings.get(dataset.manifest.buildingId)
    if (knownSplit && knownSplit !== dataset.split.name) addIssue('invalid-building-split')
    buildings.set(dataset.manifest.buildingId, dataset.split.name)

    for (const example of dataset.examples) {
      if (example.buildingId !== dataset.manifest.buildingId) {
        addIssue('example-building-mismatch')
      }
      if (example.split !== dataset.split.name) addIssue('example-split-mismatch')
      const sourceKey = `${example.buildingId}\u0000${example.source}\u0000${example.sourceId}`
      const knownLabel = sourceLabels.get(sourceKey)
      if (knownLabel && knownLabel !== example.label) addIssue('label-conflict')
      sourceLabels.set(sourceKey, example.label)
      if (seenExamples.has(example.id)) {
        addIssue('duplicate-example')
        continue
      }
      seenExamples.add(example.id)
      uniqueExamples.push(structuredClone(example))
      const splits = geometrySplits.get(example.geometryFingerprint) ?? new Set<BimDatasetSplit>()
      splits.add(example.split)
      geometrySplits.set(example.geometryFingerprint, splits)
    }
  }

  for (const splits of geometrySplits.values()) {
    if (splits.size > 1) addIssue('cross-split-geometry-duplicate')
  }

  const byLabel = new Map<string, number>()
  const bySource = new Map<string, number>()
  const propertyFields = new Map<string, number>()
  const splitExamples = new Map<BimDatasetSplit, number>([
    ['train', 0], ['validation', 0], ['test', 0],
  ])
  let geometryCount = 0
  let quantityCount = 0
  let materialCount = 0
  for (const example of uniqueExamples) {
    increment(byLabel, example.label)
    increment(bySource, example.source)
    splitExamples.set(example.split, (splitExamples.get(example.split) ?? 0) + 1)
    for (const name of example.features.semantic.propertyNames) increment(propertyFields, name)
    if (hasGeometry(example)) geometryCount++
    else addIssue('missing-geometry-features')
    if (example.features.quantities.length > 0) quantityCount++
    if (example.features.materials.length > 0) materialCount++
    if (example.label === 'unknown') addIssue('unknown-label')
    if ((example.features.semantic.confidence ?? 0) < 0.75) addIssue('low-confidence')
  }

  const issueDefinitions: Record<BimCorpusIssueCode, {
    severity: BimCorpusIssue['severity']; message: string
  }> = {
    'duplicate-dataset': { severity: 'error', message: 'Duplicate dataset packages were supplied.' },
    'invalid-building-split': { severity: 'error', message: 'A building is assigned to an invalid or inconsistent split.' },
    'example-building-mismatch': { severity: 'error', message: 'Examples disagree with their package building ID.' },
    'example-split-mismatch': { severity: 'error', message: 'Examples cross their package train/evaluation split.' },
    'duplicate-example': { severity: 'error', message: 'Duplicate native element examples were excluded.' },
    'label-conflict': { severity: 'error', message: 'The same native element has conflicting labels.' },
    'cross-split-geometry-duplicate': { severity: 'error', message: 'Identical geometry fingerprints occur across evaluation splits.' },
    'unknown-label': { severity: 'warning', message: 'Examples with unknown labels need review before supervised training.' },
    'low-confidence': { severity: 'warning', message: 'Examples with confidence below 75% need review.' },
    'missing-geometry-features': { severity: 'warning', message: 'Examples are missing measurable geometry features.' },
  }
  const issues = [...issueCounts].map(([code, count]) => ({
    code,
    count,
    ...issueDefinitions[code],
  })).sort((left, right) => left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code))
  const splitNames: BimDatasetSplit[] = ['train', 'validation', 'test']
  const examples = uniqueExamples.sort((left, right) => left.id.localeCompare(right.id))
  const datasetRows = ordered.map((dataset) => ({
    datasetId: dataset.datasetId,
    buildingId: dataset.manifest.buildingId,
    name: dataset.manifest.name,
    licence: dataset.manifest.licence,
    split: dataset.split.name,
    exampleCount: dataset.examples.length,
  }))

  const corpusIdentity = ordered.flatMap((dataset) => [
    dataset.datasetId,
    ...dataset.examples.map((example) =>
      `${example.id}:${example.label}:${example.semanticFingerprint}:${example.geometryFingerprint}`),
  ]).join('\u0000')

  return {
    version: 1,
    corpusId: `arcvia-corpus-${hash32(corpusIdentity)}`,
    trainingReady: examples.length > 0 && !issues.some((issue) => issue.severity === 'error'),
    datasets: datasetRows,
    summary: {
      datasetCount: ordered.length,
      buildingCount: buildings.size,
      exampleCount: examples.length,
      bySplit: splitNames.map((name) => ({
        name,
        buildings: [...buildings.values()].filter((split) => split === name).length,
        examples: splitExamples.get(name) ?? 0,
      })),
      byLabel: sortedCounts(byLabel),
      bySource: sortedCounts(bySource),
      propertyFieldCoverage: sortedCounts(propertyFields),
      examplesWithGeometry: geometryCount,
      examplesWithQuantities: quantityCount,
      examplesWithMaterials: materialCount,
    },
    issues,
    examples,
  }
}
