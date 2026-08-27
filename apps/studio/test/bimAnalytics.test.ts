import { analysePlanBim } from '../src/bim/analytics'
import { activeFloor, addObject, addWall, emptyPlan } from '../src/plan/planStore'
import type { BimEntitySnapshot } from '../src/bim/semantics'

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

const wallData: BimEntitySnapshot = {
  kind: 'wall',
  confidence: 1,
  evidence: [{ basis: 'schema-class', value: 'IfcWall', kind: 'wall', confidence: 1 }],
  conflicts: [],
  relations: { containerId: 'storey-1' },
  quantities: [{
    name: 'NetVolume',
    dimension: 'volume',
    sourceValue: 2.4,
    sourceUnit: 'm³',
    valueSI: 2.4,
    unitSI: 'm³',
  }],
  materials: [{
    sourceId: 'material-1',
    name: 'Wall build-up',
    layers: [{
      sourceId: 'layer-1',
      name: 'Concrete',
      sourceThickness: 300,
      sourceUnit: 'mm',
      thicknessSI: 0.3,
    }],
  }],
  properties: { FireRating: '2 h' },
}

let plan = emptyPlan()
plan = {
  ...plan,
  bimSource: {
    source: 'ifc',
    sourceName: 'analysis.ifc',
    schema: 'IFC4',
    sourceOrigin: { x: 0, z: 0, elevation: 0 },
    recordCount: 3,
    qualityCounts: { error: 0, warning: 0, info: 0 },
  },
}
plan = addWall(plan, { x: 0, y: 0 }, { x: 4, y: 0 }, {
  bimSource: { source: 'ifc', sourceId: 'wall-1', sourceClass: 'IfcWall' },
  bimData: wallData,
})
// This crossing splits the source wall into two editable segments.
plan = addWall(plan, { x: 2, y: -1 }, { x: 2, y: 1 })
plan = addObject(plan, {
  item: 'door',
  position: { x: 1, y: 0 },
  rotation: 0,
  bimSource: { source: 'ifc', sourceId: 'door-1', sourceClass: 'IfcDoor' },
  bimData: {
    kind: 'door',
    confidence: 0.6,
    evidence: [],
    conflicts: [{
      basis: 'name-fallback', value: 'opening', kind: 'opening', confidence: 0.35,
    }],
    relations: { hostId: 'wall-1', containerId: 'storey-1' },
    quantities: [{
      name: 'Width', dimension: 'length', sourceValue: 900, sourceUnit: 'unknown',
    }],
    materials: [],
    properties: {},
  },
})
plan = {
  ...plan,
  floors: plan.floors.map((floor) => floor.id === plan.activeFloorId ? {
    ...floor,
    bimComponents: {
      beam: {
        id: 'beam',
        sourceId: 'beam-1',
        sourceClass: 'IfcBeam',
        kind: 'beam',
        representation: 'mesh',
        mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
        position: { x: 0, y: 0 },
        elevation: 0,
        size: { width: 1, depth: 0.2, height: 0.2 },
        quantities: [],
        relations: {},
        bimData: {
          kind: 'beam',
          confidence: 1,
          evidence: [],
          conflicts: [],
          relations: { containerId: 'storey-1' },
          quantities: [],
          materials: [],
          properties: {},
        },
      },
      proxy: {
        id: 'proxy',
        sourceId: 'proxy-1',
        sourceClass: 'IfcBuildingElementProxy',
        kind: 'proxy',
        representation: 'bounds',
        position: { x: 3, y: 0 },
        elevation: 0,
        size: { width: 1, depth: 1, height: 1 },
        quantities: [],
        relations: {},
      },
    },
  } : floor),
}

const report = analysePlanBim(plan)
check('split walls count as one unique native source element',
  report.totals.uniqueSourceElements === 4)
check('editable instances retain the split wall count',
  report.totals.editableInstances === 5)
check('wall quantities are aggregated once despite graph splitting',
  report.quantities.find((quantity) => quantity.name === 'NetVolume')?.value === 2.4
  && report.quantities.find((quantity) => quantity.name === 'NetVolume')
    ?.sourceElementCount === 1)
check('analysis groups unique source elements by semantic kind',
  report.byKind.find((entry) => entry.name === 'wall')?.count === 1
  && report.byKind.find((entry) => entry.name === 'door')?.count === 1
  && report.byKind.find((entry) => entry.name === 'beam')?.count === 1)
check('exact mesh and bounds fallback coverage are reported',
  report.totals.exactMeshes === 1 && report.totals.boundsFallbacks === 1)
check('host and containment relationships are counted',
  report.totals.relationshipLinks === 4)
check('material takeoff is source-deduplicated across split wall segments',
  report.materials.find((material) => material.name === 'Concrete')
    ?.sourceElementCount === 1
  && report.materials.find((material) => material.name === 'Concrete')
    ?.totalThicknessSI === 0.3)
check('low confidence, conflicts and unresolved units become findings',
  report.findings.some((finding) => finding.code === 'low-confidence')
  && report.findings.some((finding) => finding.code === 'classification-conflict')
  && report.findings.some((finding) => finding.code === 'unresolved-quantity')
  && report.findings.some((finding) => finding.code === 'missing-semantic-snapshot')
  && report.findings.some((finding) => finding.code === 'bounds-fallback'))
check('analysis is deterministic and JSON serializable',
  JSON.stringify(report) === JSON.stringify(analysePlanBim(plan)))
check('manual geometry is excluded from BIM source totals',
  Object.keys(activeFloor(plan).walls).length === 4
  && report.totals.uniqueSourceElements === 4)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
