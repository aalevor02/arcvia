import type { BimLearningCorpus } from './learningCorpus'
import type { BimLearningExample } from './learningDataset'
import type { BimAnalysisElementFeatures } from './analytics'

export const BIM_BASELINE_FEATURE_NAMES = [
  'geometry.length', 'geometry.width', 'geometry.depth', 'geometry.thickness',
  'geometry.height', 'geometry.elevation', 'geometry.vertices', 'geometry.triangles',
  'representation.parametric', 'representation.mesh', 'representation.bounds',
  'relation.host', 'relation.openingFill', 'relation.container', 'relation.type',
  'relation.parent', 'relation.groups', 'relation.connections', 'relation.spaces',
  'quantity.length', 'quantity.area', 'quantity.volume', 'quantity.count',
  'quantity.mass', 'quantity.time', 'materials.assignments', 'materials.layers',
  'materials.thickness',
] as const

export interface BimBaselineClassMetric {
  label: string
  support: number
  predicted: number
  precision: number
  recall: number
  f1: number
}

export interface BimBaselinePartitionEvaluation {
  split: 'validation' | 'test'
  exampleCount: number
  accuracy: number
  macroF1: number
  classes: BimBaselineClassMetric[]
  confusion: Array<{ actual: string; predicted: string; count: number }>
  predictions: Array<{
    exampleId: string
    actual: string
    predicted: string
    marginScore: number
  }>
}

export interface BimBaselineEvaluation {
  version: 1
  modelId: string
  corpusId: string
  method: 'standardized-nearest-centroid-v1'
  featurePolicy: {
    names: string[]
    excludesNativeClass: true
    excludesSemanticLabelEvidence: true
    excludesRawProperties: true
  }
  training: {
    exampleCount: number
    excludedUnknownLabels: number
    classCounts: Array<{ label: string; count: number }>
    means: number[]
    scales: number[]
    centroids: Array<{
      label: string
      count: number
      values: number[]
      maxTrainingDistance: number
    }>
  }
  validation: BimBaselinePartitionEvaluation
  test: BimBaselinePartitionEvaluation
}

export interface BimBaselineScore {
  predicted: string
  nearestDistance: number
  allowedDistance: number
  marginScore: number
  ranked: Array<{ label: string; distance: number }>
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function magnitude(value: number | undefined): number {
  return Math.log1p(Math.abs(finite(value)))
}

function quantity(features: BimAnalysisElementFeatures, dimension: string): number {
  return magnitude(features.quantities
    .filter((item) => item.dimension === dimension)
    .reduce((total, item) => total + item.valueSI, 0))
}

/** Numeric inputs intentionally exclude native class and semantic evidence. */
export function bimBaselineFeatureVector(features: BimAnalysisElementFeatures): number[] {
  const geometry = features.geometry
  const relations = features.relations
  const materials = features.materials
  return [
    magnitude(geometry.lengthSI),
    magnitude(geometry.widthSI),
    magnitude(geometry.depthSI),
    magnitude(geometry.thicknessSI),
    magnitude(geometry.heightSI),
    magnitude(geometry.elevationSI),
    magnitude(geometry.vertexCount),
    magnitude(geometry.triangleCount),
    geometry.representation === 'parametric' ? 1 : 0,
    geometry.representation === 'mesh' ? 1 : 0,
    geometry.representation === 'bounds' ? 1 : 0,
    relations.hasHost ? 1 : 0,
    relations.hasOpeningFill ? 1 : 0,
    relations.hasContainer ? 1 : 0,
    relations.hasType ? 1 : 0,
    relations.hasParent ? 1 : 0,
    magnitude(relations.groupCount),
    magnitude(relations.connectedCount),
    magnitude(relations.spaceCount),
    quantity(features, 'length'),
    quantity(features, 'area'),
    quantity(features, 'volume'),
    quantity(features, 'count'),
    quantity(features, 'mass'),
    quantity(features, 'time'),
    magnitude(materials.length),
    magnitude(materials.reduce((total, material) => total + material.layerCount, 0)),
    magnitude(materials.reduce((total, material) =>
      total + (material.totalThicknessSI ?? 0), 0)),
  ]
}

function standardization(vectors: number[][]): { means: number[]; scales: number[] } {
  const means = BIM_BASELINE_FEATURE_NAMES.map((_, index) =>
    vectors.reduce((total, item) => total + item[index], 0) / vectors.length)
  const scales = BIM_BASELINE_FEATURE_NAMES.map((_, index) => {
    const variance = vectors.reduce((total, item) =>
      total + (item[index] - means[index]) ** 2, 0) / vectors.length
    const deviation = Math.sqrt(variance)
    return deviation > 1e-12 ? deviation : 1
  })
  return { means, scales }
}

function normalize(values: number[], means: number[], scales: number[]): number[] {
  return values.map((value, index) => (value - means[index]) / scales[index])
}

function distance(left: number[], right: number[]): number {
  return Math.sqrt(left.reduce((total, value, index) =>
    total + (value - right[index]) ** 2, 0))
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function rankedCentroids(
  features: BimAnalysisElementFeatures,
  model: Pick<BimBaselineEvaluation, 'training'>,
): Array<{ label: string; distance: number }> {
  const values = normalize(
    bimBaselineFeatureVector(features),
    model.training.means,
    model.training.scales,
  )
  return model.training.centroids.map((centroid) => ({
    label: centroid.label,
    distance: distance(values, centroid.values),
  })).sort((left, right) => left.distance - right.distance
    || left.label.localeCompare(right.label))
}

/** Score one element with the exact rounded parameters stored in the model artifact. */
export function scoreBimBaselineFeatures(
  model: BimBaselineEvaluation,
  features: BimAnalysisElementFeatures,
  maxDistanceMultiplier = 1.25,
): BimBaselineScore {
  if (!Number.isFinite(maxDistanceMultiplier) || maxDistanceMultiplier < 1) {
    throw new Error('The inference distance multiplier must be at least 1.')
  }
  const ranked = rankedCentroids(features, model)
  const best = ranked[0]
  if (!best) throw new Error('The baseline model has no trained classes.')
  const second = ranked[1]
  const centroid = model.training.centroids.find((item) => item.label === best.label)
  if (!centroid) throw new Error('The baseline model is internally inconsistent.')
  const margin = second
    ? Math.max(0, Math.min(1, 1 - best.distance / Math.max(second.distance, 1e-12)))
    : 1
  return {
    predicted: best.label,
    nearestDistance: rounded(best.distance),
    allowedDistance: rounded(centroid.maxTrainingDistance * maxDistanceMultiplier),
    marginScore: rounded(margin),
    ranked: ranked.map((item) => ({ ...item, distance: rounded(item.distance) })),
  }
}

function evaluatePartition(
  split: 'validation' | 'test',
  examples: BimLearningExample[],
  means: number[],
  scales: number[],
  centroids: Array<{ label: string; count: number; values: number[] }>,
): BimBaselinePartitionEvaluation {
  const selected = examples.filter((example) => example.split === split)
  const predictions = selected.map((example) => {
    const values = normalize(bimBaselineFeatureVector(example.features), means, scales)
    const ranked = centroids.map((centroid) => ({
      label: centroid.label,
      distance: distance(values, centroid.values),
    })).sort((left, right) => left.distance - right.distance
      || left.label.localeCompare(right.label))
    const best = ranked[0]
    const second = ranked[1]
    const margin = second
      ? Math.max(0, Math.min(1, 1 - best.distance / Math.max(second.distance, 1e-12)))
      : 1
    return {
      exampleId: example.id,
      actual: example.label,
      predicted: best.label,
      marginScore: rounded(margin),
    }
  }).sort((left, right) => left.exampleId.localeCompare(right.exampleId))
  const labels = [...new Set(predictions.flatMap((item) => [item.actual, item.predicted]))].sort()
  const classes = labels.map((label) => {
    const support = predictions.filter((item) => item.actual === label).length
    const predicted = predictions.filter((item) => item.predicted === label).length
    const truePositive = predictions.filter((item) =>
      item.actual === label && item.predicted === label).length
    const precision = predicted > 0 ? truePositive / predicted : 0
    const recall = support > 0 ? truePositive / support : 0
    return {
      label,
      support,
      predicted,
      precision: rounded(precision),
      recall: rounded(recall),
      f1: precision + recall > 0 ? rounded(2 * precision * recall / (precision + recall)) : 0,
    }
  })
  const confusionMap = new Map<string, number>()
  for (const item of predictions) {
    const key = `${item.actual}\u0000${item.predicted}`
    confusionMap.set(key, (confusionMap.get(key) ?? 0) + 1)
  }
  const confusion = [...confusionMap].map(([key, count]) => {
    const [actual, predicted] = key.split('\u0000')
    return { actual, predicted, count }
  }).sort((left, right) => left.actual.localeCompare(right.actual)
    || left.predicted.localeCompare(right.predicted))
  const correct = predictions.filter((item) => item.actual === item.predicted).length

  return {
    split,
    exampleCount: predictions.length,
    accuracy: predictions.length > 0 ? rounded(correct / predictions.length) : 0,
    macroF1: classes.length > 0
      ? rounded(classes.reduce((total, item) => total + item.f1, 0) / classes.length)
      : 0,
    classes,
    confusion,
    predictions,
  }
}

function modelHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Train on train buildings only, then evaluate without refitting on validation/test. */
export function evaluateBimBaseline(corpus: BimLearningCorpus): BimBaselineEvaluation {
  if (!corpus.trainingReady) throw new Error('Resolve blocking corpus issues before training.')
  const allTraining = corpus.examples.filter((example) => example.split === 'train')
  const training = allTraining.filter((example) => example.label !== 'unknown')
  if (training.length === 0) throw new Error('The corpus has no labelled training examples.')
  const rawVectors = training.map((example) => bimBaselineFeatureVector(example.features))
  const rawStandardization = standardization(rawVectors)
  const means = rawStandardization.means.map(rounded)
  const scales = rawStandardization.scales.map(rounded)
  const normalized = training.map((example, index) => ({
    label: example.label,
    values: normalize(rawVectors[index], means, scales),
  }))
  const labels = [...new Set(training.map((example) => example.label))].sort()
  const centroidValues = labels.map((label) => {
    const rows = normalized.filter((item) => item.label === label)
    return {
      label,
      count: rows.length,
      values: BIM_BASELINE_FEATURE_NAMES.map((_, index) => rounded(
        rows.reduce((total, row) => total + row.values[index], 0) / rows.length,
      )),
    }
  })
  const centroids = centroidValues.map((centroid) => ({
    ...centroid,
    maxTrainingDistance: rounded(Math.max(...normalized
      .filter((item) => item.label === centroid.label)
      .map((item) => distance(item.values, centroid.values)))),
  }))

  return {
    version: 1,
    modelId: `arcvia-baseline-${modelHash(`${corpus.corpusId}\u0000${training.length}`)}`,
    corpusId: corpus.corpusId,
    method: 'standardized-nearest-centroid-v1',
    featurePolicy: {
      names: [...BIM_BASELINE_FEATURE_NAMES],
      excludesNativeClass: true,
      excludesSemanticLabelEvidence: true,
      excludesRawProperties: true,
    },
    training: {
      exampleCount: training.length,
      excludedUnknownLabels: allTraining.length - training.length,
      classCounts: labels.map((label) => ({
        label,
        count: training.filter((example) => example.label === label).length,
      })),
      means,
      scales,
      centroids,
    },
    validation: evaluatePartition('validation', corpus.examples, means, scales, centroids),
    test: evaluatePartition('test', corpus.examples, means, scales, centroids),
  }
}

function numberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

/** Runtime guard for locally loaded model/evaluation JSON. */
export function isBimBaselineEvaluation(value: unknown): value is BimBaselineEvaluation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BimBaselineEvaluation>
  const training = candidate.training
  if (candidate.version !== 1 || candidate.method !== 'standardized-nearest-centroid-v1'
    || typeof candidate.modelId !== 'string' || typeof candidate.corpusId !== 'string'
    || !training || !candidate.featurePolicy) return false
  if (candidate.featurePolicy.names.length !== BIM_BASELINE_FEATURE_NAMES.length
    || !candidate.featurePolicy.names.every((name, index) =>
      name === BIM_BASELINE_FEATURE_NAMES[index])) return false
  if (!numberArray(training.means, BIM_BASELINE_FEATURE_NAMES.length)
    || !numberArray(training.scales, BIM_BASELINE_FEATURE_NAMES.length)
    || training.scales.some((scale) => scale <= 0)
    || !Array.isArray(training.centroids) || training.centroids.length === 0) return false
  return training.centroids.every((centroid) =>
    typeof centroid.label === 'string' && centroid.label.length > 0
    && Number.isInteger(centroid.count) && centroid.count > 0
    && numberArray(centroid.values, BIM_BASELINE_FEATURE_NAMES.length)
    && typeof centroid.maxTrainingDistance === 'number'
    && Number.isFinite(centroid.maxTrainingDistance)
    && centroid.maxTrainingDistance >= 0)
}
