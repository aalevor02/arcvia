import { evaluateBimBaseline } from '../src/bim/baselineClassifier'
import { buildBimLearningCorpus } from '../src/bim/learningCorpus'
import {
  splitForBuilding,
  type BimDatasetSplit,
  type BimLearningDataset,
} from '../src/bim/learningDataset'

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

function buildingFor(split: BimDatasetSplit, seed: number): string {
  for (let index = seed; index < seed + 20_000; index++) {
    const id = `baseline-building-${index}`
    if (splitForBuilding(id).name === split) return id
  }
  throw new Error(`No ${split} fixture found.`)
}

function packageFor(
  split: BimDatasetSplit,
  seed: number,
  label: 'wall' | 'door' | 'unknown',
  variant: number,
): BimLearningDataset {
  const buildingId = buildingFor(split, seed)
  const assignment = splitForBuilding(buildingId)
  const isWall = label === 'wall'
  const id = `${buildingId}:ifc:item-${variant}`
  return {
    version: 1,
    datasetId: `dataset-${split}-${label}-${variant}`,
    manifest: {
      name: `${label} ${variant}`, buildingId, licence: 'CC BY 4.0', source: undefined,
      rightsConfirmed: true, units: 'SI', rawPropertyValuesExcluded: true,
    },
    split: {
      ...assignment,
      strategy: 'whole-building-hash-v1',
      ratios: { train: 80, validation: 10, test: 10 },
    },
    summary: {
      exampleCount: 1,
      byLabel: [{ name: label, count: 1 }],
      unknownLabelCount: label === 'unknown' ? 1 : 0,
    },
    examples: [{
      id,
      buildingId,
      split,
      source: 'ifc',
      sourceId: `item-${variant}`,
      // Deliberately misleading: native class must never be a model input.
      nativeClass: isWall ? 'IfcDoor' : 'IfcWall',
      label,
      storeys: ['Level 1'],
      editableInstanceCount: 1,
      semanticFingerprint: `semantic-${split}-${variant}`,
      geometryFingerprint: `geometry-${split}-${variant}`,
      features: {
        semantic: {
          confidence: 1, evidenceBases: ['schema-class'], conflictCount: 0,
          propertyNames: [isWall ? 'FireRating' : 'OperationType'],
        },
        relations: {
          hasHost: !isWall,
          hasOpeningFill: false,
          hasContainer: true,
          hasType: false,
          hasParent: false,
          groupCount: 0,
          connectedCount: isWall ? 2 : 0,
          spaceCount: 0,
        },
        geometry: isWall ? {
          representation: 'parametric', lengthSI: 4 + variant * 0.05,
          thicknessSI: 0.2, heightSI: 3,
        } : {
          representation: 'parametric', widthSI: 0.85 + variant * 0.005,
          depthSI: 0.2, heightSI: 2.1,
        },
        quantities: isWall ? [{
          name: 'Length', dimension: 'length', valueSI: 4 + variant * 0.05, unitSI: 'm',
        }] : [],
        materials: isWall ? [{ name: 'Concrete', layerCount: 1, totalThicknessSI: 0.2 }] : [],
      },
    }],
  }
}

const packages = [
  packageFor('train', 0, 'wall', 1),
  packageFor('train', 100, 'wall', 2),
  packageFor('train', 200, 'door', 3),
  packageFor('train', 300, 'door', 4),
  packageFor('train', 400, 'unknown', 5),
  packageFor('validation', 500, 'wall', 6),
  packageFor('validation', 600, 'door', 7),
  packageFor('test', 700, 'wall', 8),
  packageFor('test', 800, 'door', 9),
]
const corpus = buildBimLearningCorpus(packages)
const evaluation = evaluateBimBaseline(corpus)

check('baseline trains only on labelled training examples',
  evaluation.training.exampleCount === 4
  && evaluation.training.excludedUnknownLabels === 1)
check('native class, semantic evidence and raw properties are excluded from features',
  evaluation.featurePolicy.excludesNativeClass
  && evaluation.featurePolicy.excludesSemanticLabelEvidence
  && evaluation.featurePolicy.excludesRawProperties
  && !evaluation.featurePolicy.names.some((name) => name.includes('class')))
check('validation and test buildings are never used for fitting',
  evaluation.validation.exampleCount === 2
  && evaluation.test.exampleCount === 2
  && evaluation.training.exampleCount < corpus.summary.exampleCount)
check('separable wall and door fixtures classify correctly on validation',
  evaluation.validation.accuracy === 1 && evaluation.validation.macroF1 === 1)
check('separable wall and door fixtures classify correctly on test',
  evaluation.test.accuracy === 1 && evaluation.test.macroF1 === 1)
check('per-class precision, recall and F1 are reported',
  evaluation.test.classes.length === 2
  && evaluation.test.classes.every((metric) =>
    metric.precision === 1 && metric.recall === 1 && metric.f1 === 1))
check('confusion matrices retain actual and predicted labels',
  evaluation.test.confusion.some((item) =>
    item.actual === 'wall' && item.predicted === 'wall' && item.count === 1)
  && evaluation.test.confusion.some((item) =>
    item.actual === 'door' && item.predicted === 'door' && item.count === 1))
check('prediction margins are finite and bounded',
  evaluation.test.predictions.every((item) =>
    Number.isFinite(item.marginScore) && item.marginScore >= 0 && item.marginScore <= 1))
check('training and evaluation are deterministic',
  JSON.stringify(evaluation) === JSON.stringify(evaluateBimBaseline(corpus)))

let blocked = false
try {
  evaluateBimBaseline({ ...corpus, trainingReady: false })
} catch {
  blocked = true
}
check('corpora with blocking audit issues cannot train', blocked)

const trainingOnly = buildBimLearningCorpus(packages.filter((item) => item.split.name === 'train'))
const emptyEvaluation = evaluateBimBaseline(trainingOnly)
check('missing evaluation partitions are explicit zero-support results',
  emptyEvaluation.validation.exampleCount === 0
  && emptyEvaluation.validation.accuracy === 0
  && emptyEvaluation.test.exampleCount === 0)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
