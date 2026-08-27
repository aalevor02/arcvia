import { normaliseIfcMaterials, normaliseRevitMaterials } from '../src/bim/materials'

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

const layered = normaliseIfcMaterials([{
  expressID: 61,
  ForLayerSet: {
    expressID: 62,
    LayerSetName: { value: 'External wall build-up' },
    MaterialLayers: [{
      expressID: 63,
      Material: {
        expressID: 64,
        Name: { value: 'Mineral wool' },
        Category: { value: 'Insulation' },
      },
      LayerThickness: { _representationValue: 300 },
    }],
  },
}], { toSI: 0.001, sourceUnit: 'mm', unitSI: 'm' })

check('IFC layer-set name is retained', layered[0]?.name === 'External wall build-up')
check('IFC material name and category are retained',
  layered[0]?.layers[0]?.name === 'Mineral wool'
  && layered[0]?.layers[0]?.category === 'Insulation')
check('IFC layer thickness preserves source units and normalizes to metres',
  layered[0]?.layers[0]?.sourceThickness === 300
  && layered[0]?.layers[0]?.sourceUnit === 'mm'
  && layered[0]?.layers[0]?.thicknessSI === 0.3)

const direct = normaliseIfcMaterials([{
  expressID: 80,
  Name: { value: 'concrete_reinforced_in-situ' },
}], { toSI: 1, sourceUnit: 'm', unitSI: 'm' })
check('direct IFC material assignments are retained without fake layers',
  direct[0]?.name === 'concrete_reinforced_in-situ'
  && direct[0]?.layers.length === 0)

const unresolved = normaliseIfcMaterials([{
  MaterialLayers: [{
    Material: { Name: { value: 'Unknown board' } },
    LayerThickness: { _representationValue: 25 },
  }],
}])
check('unresolved IFC length units never fabricate SI thickness',
  unresolved[0]?.layers[0]?.sourceThickness === 25
  && unresolved[0]?.layers[0]?.thicknessSI === undefined)

const revit = normaliseRevitMaterials([{
  uniqueId: 'material-1',
  name: 'Gypsum board',
  category: 'Finish',
  thickness: 0.0125,
}])
check('authorized Revit SI materials normalize through the same contract',
  revit[0]?.sourceId === 'material-1'
  && revit[0]?.layers[0]?.thicknessSI === 0.0125)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
