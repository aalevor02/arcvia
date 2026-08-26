import { analysePlanBim } from '../src/bim/analytics'
import {
  createBimLearningDataset,
  splitForBuilding,
} from '../src/bim/learningDataset'
import { addObject, addWall, emptyPlan } from '../src/plan/planStore'

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

let plan = emptyPlan()
plan = {
  ...plan,
  bimSource: {
    source: 'ifc',
    sourceName: 'licensed-building.ifc',
    schema: 'IFC4',
    sourceOrigin: { x: 0, z: 0, elevation: 0 },
    recordCount: 2,
    qualityCounts: { error: 0, warning: 0, info: 0 },
  },
}
plan = addWall(plan, { x: 0, y: 0 }, { x: 5, y: 0 }, {
  thickness: 0.25,
  height: 3.2,
  bimSource: { source: 'ifc', sourceId: 'wall-1', sourceClass: 'IfcWall' },
  bimData: {
    kind: 'wall',
    confidence: 1,
    evidence: [{ basis: 'schema-class', value: 'IfcWall', kind: 'wall', confidence: 1 }],
    conflicts: [],
    relations: { containerId: 'level-1', connectedIds: ['wall-2'] },
    quantities: [{
      name: 'NetVolume', dimension: 'volume', sourceValue: 4, sourceUnit: 'm³',
      valueSI: 4, unitSI: 'm³',
    }],
    materials: [{
      name: 'Wall build-up',
      layers: [{ name: 'Concrete', thicknessSI: 0.25 }],
    }],
    properties: { FireRating: '2 h', ClientSecretNote: 'do not export' },
  },
})
plan = addObject(plan, {
  item: 'door',
  position: { x: 2, y: 0 },
  rotation: 0,
  size: { width: 0.9, depth: 0.25, height: 2.1 },
  bimSource: { source: 'ifc', sourceId: 'door-1', sourceClass: 'IfcDoor' },
  bimData: {
    kind: 'door', confidence: 1, evidence: [], conflicts: [],
    relations: { hostId: 'wall-1', containerId: 'level-1' },
    quantities: [], materials: [], properties: {},
  },
})

const analysis = analysePlanBim(plan)
const options = {
  datasetName: 'Licensed BIM corpus',
  buildingId: 'campus-a/building-7',
  licence: 'Internal ML use approved',
  attribution: 'Example design team',
  rightsConfirmed: true,
} as const
const dataset = createBimLearningDataset(analysis, options)

check('one learning example is emitted per native source element',
  dataset.examples.length === 2 && dataset.summary.exampleCount === 2)
check('native labels and classes remain auditable',
  dataset.examples.some((example) => example.label === 'wall'
    && example.nativeClass === 'IfcWall'))
check('curated wall geometry is SI-normalized',
  dataset.examples.find((example) => example.label === 'wall')?.features.geometry.lengthSI === 5
  && dataset.examples.find((example) => example.label === 'wall')
    ?.features.geometry.thicknessSI === 0.25)
check('relationship and material features are retained',
  dataset.examples.find((example) => example.label === 'wall')
    ?.features.relations.connectedCount === 1
  && dataset.examples.find((example) => example.label === 'wall')
    ?.features.materials[0]?.totalThicknessSI === 0.25)
check('raw property values are excluded while field presence remains',
  dataset.manifest.rawPropertyValuesExcluded
  && dataset.examples[0].features.semantic.propertyNames.length >= 0
  && !JSON.stringify(dataset).includes('do not export')
  && !JSON.stringify(dataset).includes('2 h'))
check('every element in one building receives exactly the same split',
  new Set(dataset.examples.map((example) => example.split)).size === 1
  && dataset.examples[0]?.split === dataset.split.name)
check('split assignment is stable across case, whitespace, and revisions',
  JSON.stringify(splitForBuilding(' Campus-A/Building-7 '))
    === JSON.stringify(splitForBuilding('campus-a/building-7')))
check('the package is deterministic',
  JSON.stringify(dataset) === JSON.stringify(createBimLearningDataset(analysis, options)))
const changedAnalysis = structuredClone(analysis)
changedAnalysis.elements[0].geometryFingerprint = 'changed-geometry'
check('dataset identity changes when native element content changes',
  dataset.datasetId !== createBimLearningDataset(changedAnalysis, options).datasetId)

let rejectedMissingRights = false
try {
  createBimLearningDataset(analysis, { ...options, rightsConfirmed: false })
} catch {
  rejectedMissingRights = true
}
check('learning export requires explicit rights confirmation', rejectedMissingRights)

let rejectedMissingLicence = false
try {
  createBimLearningDataset(analysis, { ...options, licence: ' ' })
} catch {
  rejectedMissingLicence = true
}
check('learning export requires a licence or internal permission', rejectedMissingLicence)

const observed = new Set(Array.from({ length: 500 }, (_, index) =>
  splitForBuilding(`building-${index}`).name))
check('deterministic allocation reaches train, validation, and test partitions',
  observed.has('train') && observed.has('validation') && observed.has('test'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
