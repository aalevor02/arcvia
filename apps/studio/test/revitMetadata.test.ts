import { readRevitExport } from '../src/bim/revitMetadata'
import { createIfcPlanProposal, planFromIfcProposal } from '../src/bim/ifcPlanProposal'

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

const result = readRevitExport({
  format: 'arcvia-revit-export',
  version: 1,
  source: 'revit-api',
  units: 'm',
  coordinateSystem: 'revit-xyz',
  document: { title: 'Office', revitVersion: '2026' },
  elements: [
    {
      uniqueId: 'wall-uid',
      elementId: 42,
      runtimeClass: 'Autodesk.Revit.DB.Wall',
      builtInCategory: 'OST_Walls',
      type: 'Basic Wall',
      levelUniqueId: 'level-1',
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0.2, z: 3 } },
      planAxis: {
        from: { x: 0, y: 0.1, z: 0 },
        to: { x: 4, y: 0.1, z: 0 },
        thickness: 0.2,
        height: 3,
      },
      parameters: { FireRating: '2 h' },
      materials: [{
        uniqueId: 'material-concrete',
        name: 'Concrete - Cast in Situ',
        category: 'Structure',
        thickness: 0.2,
      }],
      quantities: [{
        name: 'Volume', dimension: 'volume', sourceValue: 2.4,
        sourceUnit: 'm³', valueSI: 2.4, unitSI: 'm³', parameterId: 'HOST_VOLUME_COMPUTED',
      }],
    },
    {
      uniqueId: 'door-uid',
      runtimeClass: 'Autodesk.Revit.DB.FamilyInstance',
      builtInCategory: 'OST_Doors',
      family: 'Single-Flush',
      hostUniqueId: 'wall-uid',
      levelUniqueId: 'level-1',
      bounds: { min: { x: 1.5, y: 0.05, z: 0 }, max: { x: 2.5, y: 0.15, z: 2.1 } },
      planAxis: {
        from: { x: 1.5, y: 0.1, z: 0 },
        to: { x: 2.5, y: 0.1, z: 0 },
        thickness: 0.1,
        height: 2.1,
      },
    },
  ],
})

check('authorized Revit envelope is recognized', result.schema.includes('REVIT-EXPORT-1'))
check('Revit categories map to canonical wall and door',
  result.elements.some((element) => element.kind === 'wall')
  && result.elements.some((element) => element.kind === 'door'))
check('Revit host relationship is retained',
  result.elements.find((element) => element.kind === 'door')?.relations.hostId === 'wall-uid')
check('Revit Z-up bounds convert to Arcvia Y-up',
  result.elements.find((element) => element.kind === 'wall')?.geometry?.bounds.max.y === 3)
check('connector-derived wall axis is retained without an AABB guess',
  result.elements.find((element) => element.kind === 'wall')?.geometry?.planAxis?.length === 4)
check('Revit parameters and quantities retain provenance',
  result.elements.find((element) => element.kind === 'wall')?.properties.parameters !== undefined
  && result.elements.find((element) => element.kind === 'wall')?.quantities[0].sourceQuantityId
    === 'HOST_VOLUME_COMPUTED')
check('authorized Revit materials normalize with SI layer thickness',
  result.elements.find((element) => element.kind === 'wall')
    ?.materials[0]?.name === 'Concrete - Cast in Situ'
  && result.elements.find((element) => element.kind === 'wall')
    ?.materials[0]?.layers[0]?.thicknessSI === 0.2)
const proposal = createIfcPlanProposal(result, 'office.arcvia-revit.json')
check('authorized Revit wall becomes an editable plan proposal',
  proposal.storeys[0]?.walls.length === 1)
check('authorized hosted Revit door becomes an opening proposal',
  proposal.storeys[0]?.openings.length === 1)
const plan = planFromIfcProposal(proposal)
check('authorized Revit proposal becomes an editable Arcvia plan',
  Object.keys(plan.floors[0].walls).length === 1
  && Object.keys(plan.floors[0].objects).length === 1)
check('editable Revit geometry retains UniqueId and runtime class',
  Object.values(plan.floors[0].walls)[0]?.bimSource?.sourceId === 'wall-uid'
  && Object.values(plan.floors[0].walls)[0]?.bimSource?.sourceClass
    === 'Autodesk.Revit.DB.Wall'
  && Object.values(plan.floors[0].objects)[0]?.bimSource?.sourceId === 'door-uid')
check('editable Revit geometry retains parameters, quantities and host topology',
  Object.values(plan.floors[0].walls)[0]?.bimData?.properties.parameters !== undefined
  && Object.values(plan.floors[0].walls)[0]?.bimData?.quantities[0]?.sourceQuantityId
    === 'HOST_VOLUME_COMPUTED'
  && Object.values(plan.floors[0].objects)[0]?.bimData?.relations.hostId === 'wall-uid')
check('editable Revit walls retain normalized material data',
  Object.values(plan.floors[0].walls)[0]?.bimData?.materials[0]?.sourceId
    === 'material-concrete')

let rejected = false
try {
  readRevitExport({ format: 'arcvia-revit-export', version: 1, units: 'ft', elements: [] })
} catch {
  rejected = true
}
check('ambiguous/non-SI connector exports are rejected', rejected)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
