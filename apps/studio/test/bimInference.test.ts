import type { BimAnalysisElement, BimPlanAnalysis } from '../src/bim/analytics'
import {
  BIM_BASELINE_FEATURE_NAMES,
  type BimBaselineEvaluation,
} from '../src/bim/baselineClassifier'
import { inferBimElementKinds } from '../src/bim/inference'

let passed = 0
let failed = 0
const check = (label: string, condition: boolean) => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}`)
  }
}

function features(lengthVector: number, confidence?: number): BimAnalysisElement['features'] {
  return {
    semantic: { confidence, evidenceBases: [], conflictCount: 0, propertyNames: [] },
    relations: {
      hasHost: false, hasOpeningFill: false, hasContainer: false, hasType: false,
      hasParent: false, groupCount: 0, connectedCount: 0, spaceCount: 0,
    },
    geometry: { representation: 'bounds', lengthSI: Math.expm1(lengthVector) },
    quantities: [],
    materials: [],
  }
}

function element(
  id: string,
  lengthVector: number,
  kind: BimAnalysisElement['kind'],
  confidence?: number,
): BimAnalysisElement {
  return {
    key: `ifc:${id}`,
    source: 'ifc',
    sourceId: id,
    sourceClass: 'IfcBuildingElementProxy',
    kind,
    storeys: ['Level 1'],
    editableInstanceCount: 1,
    semanticFingerprint: `semantic-${id}`,
    geometryFingerprint: `geometry-${id}`,
    features: features(lengthVector, confidence),
  }
}

function values(first: number): number[] {
  return BIM_BASELINE_FEATURE_NAMES.map((_, index) => index === 0 ? first : 0)
}

const emptyPartition = (split: 'validation' | 'test') => ({
  split,
  exampleCount: 0,
  accuracy: 0,
  macroF1: 0,
  classes: [],
  confusion: [],
  predictions: [],
})

const model: BimBaselineEvaluation = {
  version: 1,
  modelId: 'model-safe-inference',
  corpusId: 'corpus-safe-inference',
  method: 'standardized-nearest-centroid-v1',
  featurePolicy: {
    names: [...BIM_BASELINE_FEATURE_NAMES],
    excludesNativeClass: true,
    excludesSemanticLabelEvidence: true,
    excludesRawProperties: true,
  },
  training: {
    exampleCount: 8,
    excludedUnknownLabels: 0,
    classCounts: [{ label: 'wall', count: 4 }, { label: 'door', count: 4 }],
    means: values(0),
    scales: values(1).map((value, index) => index === 0 ? value : 1),
    centroids: [
      { label: 'wall', count: 4, values: values(1), maxTrainingDistance: 2 },
      { label: 'door', count: 4, values: values(3), maxTrainingDistance: 2 },
    ],
  },
  validation: emptyPartition('validation'),
  test: emptyPartition('test'),
}

const analysis: BimPlanAnalysis = {
  version: 1,
  source: { source: 'ifc', sourceName: 'inference.ifc' },
  totals: {
    uniqueSourceElements: 5,
    editableInstances: 5,
    semanticSnapshots: 5,
    exactMeshes: 0,
    boundsFallbacks: 5,
    relationshipLinks: 0,
  },
  byKind: [],
  byNativeClass: [],
  byStorey: [],
  quantities: [],
  materials: [],
  findings: [],
  elements: [
    element('unknown-wall', 1, 'unknown', 0.2),
    element('high-confidence', 3, 'door', 0.95),
    element('ambiguous', 2, 'unknown', 0.1),
    element('outlier', 10, 'unknown', 0.1),
    element('missing-confidence', 3, 'wall'),
  ],
}

const before = JSON.stringify(analysis)
const report = inferBimElementKinds(model, analysis)
const suggestedWall = report.suggestions.find((item) => item.sourceId === 'unknown-wall')
const missingConfidence = report.suggestions.find((item) => item.sourceId === 'missing-confidence')
const ambiguous = report.suggestions.find((item) => item.sourceId === 'ambiguous')
const outlier = report.suggestions.find((item) => item.sourceId === 'outlier')

check('only unknown or low-confidence elements are considered',
  report.summary.analysedElements === 5
  && report.summary.eligibleElements === 4
  && report.summary.skippedHighConfidence === 1)
check('an in-distribution unknown element receives a review suggestion',
  suggestedWall?.decision === 'suggested' && suggestedWall.predictedKind === 'wall')
check('missing confidence is eligible without reading native class labels',
  missingConfidence?.eligibility === 'missing-confidence'
  && missingConfidence.decision === 'suggested'
  && missingConfidence.predictedKind === 'door')
check('ambiguous elements abstain instead of forcing a label',
  ambiguous?.decision === 'abstained'
  && ambiguous.abstentionReason === 'ambiguous')
check('out-of-distribution elements abstain',
  outlier?.decision === 'abstained'
  && outlier.abstentionReason === 'out-of-distribution')
check('summary separates suggestions and abstentions',
  report.summary.suggestions === 2 && report.summary.abstentions === 2)
check('inference never mutates the source analysis', JSON.stringify(analysis) === before)
check('inference reports are deterministic',
  JSON.stringify(report) === JSON.stringify(inferBimElementKinds(model, analysis)))

const oneClassModel: BimBaselineEvaluation = {
  ...model,
  training: {
    ...model.training,
    classCounts: [{ label: 'wall', count: 4 }],
    centroids: [model.training.centroids[0]],
  },
}
const oneClass = inferBimElementKinds(oneClassModel, {
  ...analysis,
  elements: [element('one-class', 1, 'unknown', 0.1)],
})
check('single-class models abstain because they cannot distinguish alternatives',
  oneClass.suggestions[0]?.abstentionReason === 'insufficient-class-coverage')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
