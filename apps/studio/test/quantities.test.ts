import { normaliseIfcQuantities } from '../src/bim/quantities'

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

const sets = [{
  expressID: 1,
  Name: { value: 'Qto_TestBaseQuantities' },
  Quantities: [
    { expressID: 2, Name: { value: 'Length' }, LengthValue: { _representationValue: 1200 } },
    { expressID: 3, Name: { value: 'Area' }, AreaValue: { value: 2.5 } },
    { expressID: 4, Name: { value: 'Count' }, CountValue: { value: 4 } },
    { expressID: 5, Name: { value: 'Broken' }, LengthValue: { value: 'not-a-number' } },
  ],
}]

const quantities = normaliseIfcQuantities(sets, {
  length: { toSI: 0.001, sourceUnit: 'mm', unitSI: 'm' },
  area: { toSI: 1, sourceUnit: 'm²', unitSI: 'm²' },
  count: { toSI: 1, sourceUnit: 'count', unitSI: 'count' },
})

check('valid IFC quantities are extracted', quantities.length === 3)
check('dimension-specific scale converts millimetres', quantities[0].valueSI === 1.2)
check('source value and source unit are preserved',
  quantities[0].sourceValue === 1200 && quantities[0].sourceUnit === 'mm')
check('quantity-set provenance is preserved',
  quantities[0].setName === 'Qto_TestBaseQuantities' && quantities[0].sourceQuantityId === '2')
check('area uses its own scale', quantities[1].valueSI === 2.5 && quantities[1].unitSI === 'm²')
check('counts remain dimensionless', quantities[2].valueSI === 4)

const unresolved = normaliseIfcQuantities(sets, {})
check('unknown units never fabricate an SI value',
  unresolved[0].valueSI === undefined && unresolved[0].sourceUnit === undefined)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
