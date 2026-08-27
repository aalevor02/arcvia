import { analysePlanBim } from '../src/bim/analytics'
import { compareBimAnalyses, isBimPlanAnalysis } from '../src/bim/comparison'
import { activeFloor, addObject, addWall, emptyPlan, updateWall } from '../src/plan/planStore'
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
  evidence: [],
  conflicts: [],
  relations: { containerId: 'level-1' },
  quantities: [],
  materials: [],
  properties: { FireRating: '2 h' },
}

let beforePlan = emptyPlan()
beforePlan = {
  ...beforePlan,
  bimSource: {
    source: 'ifc',
    sourceName: 'revision-a.ifc',
    schema: 'IFC4',
    sourceOrigin: { x: 0, z: 0, elevation: 0 },
    recordCount: 2,
    qualityCounts: { error: 0, warning: 0, info: 0 },
  },
}
beforePlan = addWall(beforePlan, { x: 0, y: 0 }, { x: 4, y: 0 }, {
  bimSource: { source: 'ifc', sourceId: 'wall-1', sourceClass: 'IfcWall' },
  bimData: wallData,
})
beforePlan = {
  ...beforePlan,
  floors: beforePlan.floors.map((floor) => ({
    ...floor,
    bimComponents: {
      oldBeam: {
        id: 'oldBeam',
        sourceId: 'beam-old',
        sourceClass: 'IfcBeam',
        kind: 'beam',
        representation: 'bounds',
        position: { x: 1, y: 1 },
        elevation: 2,
        size: { width: 3, depth: 0.2, height: 0.3 },
        quantities: [],
        relations: {},
        bimData: {
          kind: 'beam', confidence: 1, evidence: [], conflicts: [],
          relations: {}, quantities: [], materials: [], properties: {},
        },
      },
    },
  })),
}

const before = analysePlanBim(beforePlan)
check('analysis exports one fingerprint record per native source element',
  before.elements.length === 2
  && before.elements.every((element) =>
    element.semanticFingerprint.length === 8 && element.geometryFingerprint.length === 8))
check('analysis export passes the comparison contract guard', isBimPlanAnalysis(before))
check('aggregate-only legacy JSON is rejected for element comparison',
  !isBimPlanAnalysis({ version: 1, totals: {} }))

let afterPlan = structuredClone(beforePlan)
const wallId = Object.values(activeFloor(afterPlan).walls)[0].id
afterPlan = updateWall(afterPlan, wallId, { thickness: 0.3 })
afterPlan = {
  ...afterPlan,
  bimSource: { ...afterPlan.bimSource!, sourceName: 'revision-b.ifc' },
  floors: afterPlan.floors.map((floor) => ({
    ...floor,
    walls: Object.fromEntries(Object.entries(floor.walls).map(([id, wall]) => [
      id,
      wall.bimData ? {
        ...wall,
        bimData: { ...wall.bimData, properties: { FireRating: '3 h' } },
      } : wall,
    ])),
    bimComponents: {},
  })),
}
afterPlan = addObject(afterPlan, {
  item: 'door',
  position: { x: 2, y: 0 },
  rotation: 0,
  bimSource: { source: 'ifc', sourceId: 'door-new', sourceClass: 'IfcDoor' },
  bimData: {
    kind: 'door', confidence: 1, evidence: [], conflicts: [],
    relations: { hostId: 'wall-1' }, quantities: [], materials: [], properties: {},
  },
})

const comparison = compareBimAnalyses(before, analysePlanBim(afterPlan))
check('version comparison identifies additions and removals by native identity',
  comparison.added[0]?.sourceId === 'door-new'
  && comparison.removed[0]?.sourceId === 'beam-old')
const wallChange = comparison.modified.find((change) => change.sourceId === 'wall-1')
check('geometry and semantic changes are reported independently',
  wallChange?.geometryChanged === true && wallChange.semanticsChanged === true)
check('unchanged native elements are counted', comparison.unchanged === 0)

const identical = compareBimAnalyses(before, analysePlanBim(structuredClone(beforePlan)))
check('identical analyses report only unchanged elements',
  identical.modified.length === 0
  && identical.added.length === 0
  && identical.removed.length === 0
  && identical.unchanged === 2)

const jittered = structuredClone(beforePlan)
const jitteredFloor = activeFloor(jittered)
const jitteredWall = Object.values(jitteredFloor.walls)[0]
jitteredFloor.vertices[jitteredWall.a].x += 0.0000004
check('sub-micrometre numeric noise does not create a geometry change',
  compareBimAnalyses(before, analysePlanBim(jittered)).modified.length === 0)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
