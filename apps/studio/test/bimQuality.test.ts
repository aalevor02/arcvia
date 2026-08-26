import { analyseBimQuality } from '../src/bim/quality'
import { classifyBimElement, type BimElementSemantic } from '../src/bim/semantics'

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

const wall = classifyBimElement({
  source: 'ifc', sourceId: 'wall-1', sourceClass: 'IfcWall',
  properties: { globalId: 'duplicate' },
  relations: { containerId: 'storey-1' },
})
const duplicate = classifyBimElement({
  source: 'ifc', sourceId: 'beam-1', sourceClass: 'IfcBeam',
  properties: { globalId: 'duplicate' },
  relations: { containerId: 'storey-1' },
})
const opening = classifyBimElement({
  source: 'ifc', sourceId: 'opening-1', sourceClass: 'IfcOpeningElement',
})
const window = classifyBimElement({
  source: 'ifc', sourceId: 'window-1', sourceClass: 'IfcWindow',
  relations: { fillsOpeningId: 'opening-2' },
})
const badBounds: BimElementSemantic = {
  ...classifyBimElement({ source: 'ifc', sourceId: 'slab-1', sourceClass: 'IfcSlab' }),
  geometry: {
    bounds: {
      min: { x: 2, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    },
    vertexCount: 8,
    partCount: 1,
  },
  quantities: [{
    name: 'Area', dimension: 'area', sourceValue: 25,
  }],
}

const records = [wall, duplicate, opening, window, badBounds]
const report = analyseBimQuality(records, records)

check('duplicate GlobalIds are errors',
  report.issues.some((issue) => issue.code === 'duplicate-global-id' && issue.sourceIds.length === 2))
check('orphan openings are errors',
  report.issues.some((issue) => issue.code === 'orphan-opening'))
check('filled windows with no wall host are reported',
  report.issues.some((issue) => issue.code === 'unresolved-host'))
check('invalid bounds are errors',
  report.issues.some((issue) => issue.code === 'invalid-bounds'))
check('unresolved quantity units are warnings',
  report.issues.some((issue) => issue.code === 'unresolved-quantity-unit'))
check('quality counts match issue severities',
  report.counts.error === report.issues.filter((issue) => issue.severity === 'error').length)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
