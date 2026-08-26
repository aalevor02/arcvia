import { createIfcPlanProposal, planFromIfcProposal } from '../src/bim/ifcPlanProposal'
import type { IfcMetadataResult } from '../src/bim/ifcMetadata'
import { activeFloor, updateObject } from '../src/plan/planStore'

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

const result: IfcMetadataResult = {
  schema: 'IFC4',
  units: {},
  typeCounts: {},
  relationCounts: {},
  warnings: [],
  quality: { issues: [], counts: { error: 0, warning: 0, info: 0 } },
  records: [
    {
      source: 'ifc', sourceId: 'storey-1', sourceClass: 'IfcBuildingStorey',
      kind: 'unknown', confidence: 0, evidence: [], conflicts: [], relations: {},
      quantities: [], properties: { name: 'Level 12 - Offices' },
    },
  ],
  elements: [
    {
      source: 'ifc', sourceId: 'wall-1', sourceClass: 'IfcWall', kind: 'wall', confidence: 1,
      evidence: [{
        basis: 'schema-class', value: 'IfcWall', kind: 'wall', confidence: 1,
      }],
      conflicts: [],
      relations: { containerId: 'storey-1' },
      quantities: [{
        name: 'NetVolume', dimension: 'volume', sourceValue: 2.4,
        sourceUnit: 'm³', valueSI: 2.4, unitSI: 'm³',
      }],
      properties: { FireRating: '2 h', nested: { loadBearing: true } },
      geometry: {
        bounds: { min: { x: 100, y: 12, z: 200 }, max: { x: 104, y: 15, z: 200.2 } },
        vertexCount: 8, partCount: 1,
        planAxis: {
          from: { x: 100, y: 200.1 }, to: { x: 104, y: 200.1 },
          length: 4, thickness: 0.2, height: 3,
        },
      },
    },
    {
      source: 'ifc', sourceId: 'door-1', sourceClass: 'IfcDoor', kind: 'door', confidence: 1,
      evidence: [], conflicts: [],
      relations: { hostId: 'wall-1', containerId: 'storey-1' },
      quantities: [],
      properties: { OperationType: 'SINGLE_SWING_LEFT' },
      geometry: {
        bounds: { min: { x: 101.5, y: 12, z: 200.11 }, max: { x: 102.5, y: 14.1, z: 200.21 } },
        vertexCount: 8, partCount: 1,
        planAxis: {
          from: { x: 101.5, y: 200.16 }, to: { x: 102.5, y: 200.16 },
          length: 1, thickness: 0.1, height: 2.1,
        },
      },
    },
    {
      source: 'ifc', sourceId: 'wall-2', kind: 'wall', confidence: 1,
      evidence: [], conflicts: [], relations: { containerId: 'storey-1' }, quantities: [], properties: {},
      geometry: {
        bounds: { min: { x: 100, y: 12, z: 200.1 }, max: { x: 104, y: 15, z: 200.3 } },
        vertexCount: 8, partCount: 1,
        planAxis: {
          from: { x: 100, y: 200.2 }, to: { x: 104, y: 200.2 },
          length: 4, thickness: 0.2, height: 3,
        },
      },
    },
  ],
}

const proposal = createIfcPlanProposal(result, 'fixture.ifc')
check('one IFC storey is proposed', proposal.storeys.length === 1)
check('native BIM storey name is preserved',
  proposal.storeys[0].name === 'Level 12 - Offices')
check('world coordinates are centred locally',
  proposal.storeys[0].walls[0].from.x === -2 && proposal.storeys[0].walls[0].to.x === 2)
check('IFC Z is inverted into Arcvia plan Y',
  Math.abs(proposal.storeys[0].walls[0].from.y - 0.05) < 1e-9)
check('wall dimensions are preserved',
  proposal.storeys[0].walls[0].thickness === 0.2 && proposal.storeys[0].walls[0].height === 3)
check('hosted door is proposed', proposal.storeys[0].openings.length === 1)
check('source georeference is retained', proposal.sourceOrigin.x === 102)

const plan = planFromIfcProposal(proposal)
const floor = activeFloor(plan)
check('proposal becomes two editable walls', Object.keys(floor.walls).length === 2)
check('proposal becomes one hosted door', Object.values(floor.objects)[0]?.item === 'door')
check('editable walls retain IFC native identity',
  Object.values(floor.walls).every((wall) =>
    wall.bimSource?.sourceId === 'wall-1' || wall.bimSource?.sourceId === 'wall-2'))
check('editable openings retain IFC native identity',
  Object.values(floor.objects)[0]?.bimSource?.sourceId === 'door-1'
  && Object.values(floor.objects)[0]?.bimSource?.sourceClass === 'IfcDoor')
const semanticWall = Object.values(floor.walls)
  .find((wall) => wall.bimSource?.sourceId === 'wall-1')
check('editable walls retain quantities, evidence, relations and source properties',
  semanticWall?.bimData?.quantities[0]?.valueSI === 2.4
  && semanticWall.bimData.evidence[0]?.basis === 'schema-class'
  && semanticWall.bimData.relations.containerId === 'storey-1'
  && semanticWall.bimData.properties.FireRating === '2 h')
check('editable openings retain host topology and source properties',
  Object.values(floor.objects)[0]?.bimData?.relations.hostId === 'wall-1'
  && Object.values(floor.objects)[0]?.bimData?.properties.OperationType
    === 'SINGLE_SWING_LEFT')
const openingId = Object.values(floor.objects)[0]?.id
const editedPlan = openingId
  ? updateObject(plan, openingId, {
    bimSource: { source: 'ifc', sourceId: 'rewritten' },
    bimData: {
      ...Object.values(floor.objects)[0].bimData!,
      properties: { OperationType: 'rewritten' },
    },
  })
  : plan
check('opening edits cannot rewrite native BIM identity',
  openingId !== undefined
  && activeFloor(editedPlan).objects[openingId].bimSource?.sourceId === 'door-1'
  && activeFloor(editedPlan).objects[openingId].bimData?.properties.OperationType
    === 'SINGLE_SWING_LEFT')
check('door keeps measured width', Object.values(floor.objects)[0]?.size?.width === 1)
const door = Object.values(floor.objects)[0]
const doorWall = door?.wallId ? floor.walls[door.wallId] : undefined
const doorWallY = doorWall
  ? (floor.vertices[doorWall.a].y + floor.vertices[doorWall.b].y) / 2
  : -Infinity
check('door stays on its declared host when a parallel wall is closer', doorWallY > 0)
check('plan retains auditable BIM model provenance',
  plan.bimSource?.sourceName === 'fixture.ifc'
  && plan.bimSource.schema === 'IFC4'
  && plan.bimSource.recordCount === 1)

const componentOnlyProposal = createIfcPlanProposal({
  ...result,
  elements: [{ ...result.elements[0], kind: 'beam' }],
}, 'structure-only.ifc')
const componentOnlyPlan = planFromIfcProposal(componentOnlyProposal)
check('component-only BIM models still create an importable plan',
  componentOnlyProposal.storeys[0].walls.length === 0
  && Object.keys(activeFloor(componentOnlyPlan).bimComponents).length === 1)
check('reference components retain their full semantic snapshot',
  Object.values(activeFloor(componentOnlyPlan).bimComponents)[0]?.bimData
    ?.properties.FireRating === '2 h')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
