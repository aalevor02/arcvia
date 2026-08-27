import { analysePlanBim } from '../src/bim/analytics'
import {
  buildBimLearningCorpus,
  isBimLearningDataset,
} from '../src/bim/learningCorpus'
import {
  createBimLearningDataset,
  splitForBuilding,
  type BimDatasetSplit,
  type BimLearningDataset,
} from '../src/bim/learningDataset'
import { addWall, emptyPlan } from '../src/plan/planStore'

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

function buildingFor(split: BimDatasetSplit): string {
  for (let index = 0; index < 10_000; index++) {
    const id = `${split}-building-${index}`
    if (splitForBuilding(id).name === split) return id
  }
  throw new Error(`Could not find deterministic ${split} building fixture.`)
}

function dataset(buildingId: string, sourceId: string, length: number): BimLearningDataset {
  let plan = emptyPlan()
  plan = {
    ...plan,
    bimSource: {
      source: 'ifc', sourceName: `${buildingId}.ifc`, schema: 'IFC4',
      sourceOrigin: { x: 0, z: 0, elevation: 0 }, recordCount: 1,
      qualityCounts: { error: 0, warning: 0, info: 0 },
    },
  }
  plan = addWall(plan, { x: 0, y: 0 }, { x: length, y: 0 }, {
    bimSource: { source: 'ifc', sourceId, sourceClass: 'IfcWall' },
    bimData: {
      kind: 'wall', confidence: 1,
      evidence: [{ basis: 'schema-class', value: 'IfcWall', kind: 'wall', confidence: 1 }],
      conflicts: [], relations: { containerId: 'level-1' },
      quantities: [{
        name: 'Length', dimension: 'length', sourceValue: length, sourceUnit: 'm',
        valueSI: length, unitSI: 'm',
      }],
      materials: [{ name: 'Concrete', layers: [{ name: 'Concrete', thicknessSI: 0.23 }] }],
      properties: { LoadBearing: true },
    },
  })
  return createBimLearningDataset(analysePlanBim(plan), {
    datasetName: `${buildingId} package`, buildingId,
    licence: 'CC BY 4.0', rightsConfirmed: true,
  })
}

const train = dataset(buildingFor('train'), 'wall-train', 4)
const validation = dataset(buildingFor('validation'), 'wall-validation', 5)
const test = dataset(buildingFor('test'), 'wall-test', 6)
const corpus = buildBimLearningCorpus([test, train, validation])

check('valid governed dataset packages pass the runtime contract',
  [train, validation, test].every(isBimLearningDataset))
check('unsigned or privacy-unsafe packages fail the runtime contract',
  !isBimLearningDataset({
    ...train,
    manifest: { ...train.manifest, rightsConfirmed: false },
  }))
check('corpus combines one example from each building',
  corpus.summary.datasetCount === 3
  && corpus.summary.buildingCount === 3
  && corpus.summary.exampleCount === 3)
check('building and example split totals are independently reported',
  corpus.summary.bySplit.every((entry) => entry.buildings === 1 && entry.examples === 1))
check('label and source coverage are aggregated',
  corpus.summary.byLabel[0]?.name === 'wall'
  && corpus.summary.byLabel[0]?.count === 3
  && corpus.summary.bySource[0]?.name === 'ifc')
check('feature coverage includes geometry, quantities, materials and property fields',
  corpus.summary.examplesWithGeometry === 3
  && corpus.summary.examplesWithQuantities === 3
  && corpus.summary.examplesWithMaterials === 3
  && corpus.summary.propertyFieldCoverage[0]?.name === 'LoadBearing')
check('a clean multi-building corpus is training ready', corpus.trainingReady)
check('corpus output is deterministic regardless of package order',
  JSON.stringify(corpus) === JSON.stringify(buildBimLearningCorpus([validation, test, train])))
const contentChanged = structuredClone(train)
contentChanged.examples[0].semanticFingerprint = 'changed-semantic-content'
check('corpus identity changes when element content changes under the same package ID',
  buildBimLearningCorpus([train]).corpusId
    !== buildBimLearningCorpus([contentChanged]).corpusId)

const duplicateCorpus = buildBimLearningCorpus([train, structuredClone(train)])
check('duplicate datasets and examples block training readiness',
  !duplicateCorpus.trainingReady
  && duplicateCorpus.issues.some((issue) => issue.code === 'duplicate-dataset')
  && duplicateCorpus.issues.some((issue) => issue.code === 'duplicate-example'))
check('duplicate examples are excluded from aggregate counts',
  duplicateCorpus.summary.exampleCount === 1)

const wrongSplit = structuredClone(train)
wrongSplit.split.name = train.split.name === 'train' ? 'test' : 'train'
check('tampered building splits are rejected',
  !buildBimLearningCorpus([wrongSplit]).trainingReady
  && buildBimLearningCorpus([wrongSplit]).issues
    .some((issue) => issue.code === 'invalid-building-split'))

const leaked = structuredClone(train)
leaked.datasetId += '-leaked'
leaked.manifest.buildingId = validation.manifest.buildingId
leaked.split = structuredClone(validation.split)
leaked.examples[0].id = `${validation.manifest.buildingId}:ifc:leaked-wall`
leaked.examples[0].buildingId = validation.manifest.buildingId
leaked.examples[0].split = validation.split.name
leaked.examples[0].sourceId = 'leaked-wall'
check('exact geometry crossing train/evaluation splits blocks training',
  !buildBimLearningCorpus([train, leaked]).trainingReady
  && buildBimLearningCorpus([train, leaked]).issues
    .some((issue) => issue.code === 'cross-split-geometry-duplicate'))

const wrongExample = structuredClone(train)
wrongExample.examples[0].buildingId = 'another-building'
wrongExample.examples[0].split = 'test'
check('example/package boundary violations are rejected',
  buildBimLearningCorpus([wrongExample]).issues
    .some((issue) => issue.code === 'example-building-mismatch')
  && buildBimLearningCorpus([wrongExample]).issues
    .some((issue) => issue.code === 'example-split-mismatch'))

const conflict = structuredClone(train)
conflict.datasetId += '-conflict'
conflict.examples[0].label = 'door'
check('conflicting labels for one native element are rejected',
  buildBimLearningCorpus([train, conflict]).issues
    .some((issue) => issue.code === 'label-conflict'))

check('malformed nested feature contracts are rejected before corpus assembly',
  !isBimLearningDataset({
    ...train,
    examples: [{ ...train.examples[0], features: {} }],
  }))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
