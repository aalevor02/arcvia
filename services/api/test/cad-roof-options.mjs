import { cadRoofOptions } from '../src/routes/cad.js'

let passed = 0
let failed = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const omitted = cadRoofOptions({})
ok('roof geometry stays off when the reviewer makes no choice',
  omitted.ok && !omitted.withRoof && omitted.roofStyle === 'flat')

const flat = cadRoofOptions({ roofStyle: 'flat' })
ok('an explicit flat roof is preserved', flat.ok && flat.withRoof && flat.roofStyle === 'flat')

const gable = cadRoofOptions({ roofStyle: 'gable', roofPitchDegrees: 32.5 })
ok('a reviewed gable keeps its measured pitch',
  gable.ok && gable.withRoof && gable.roofStyle === 'gable'
    && gable.roofPitchDegrees === 32.5)

ok('a gable without pitch is refused',
  !cadRoofOptions({ roofStyle: 'gable' }).ok)
ok('a gable below the safe pitch range is refused',
  !cadRoofOptions({ roofStyle: 'gable', roofPitchDegrees: 4.9 }).ok)
ok('a gable above the safe pitch range is refused',
  !cadRoofOptions({ roofStyle: 'gable', roofPitchDegrees: 60.1 }).ok)
ok('a pitch cannot be smuggled onto a flat roof',
  !cadRoofOptions({ roofStyle: 'flat', roofPitchDegrees: 30 }).ok)
ok('unknown roof forms are refused',
  !cadRoofOptions({ roofStyle: 'hip', roofPitchDegrees: 30 }).ok)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
