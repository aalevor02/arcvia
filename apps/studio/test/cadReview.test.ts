import { cadReviewChecks, cadReviewRequired, cadWallLayers } from '../src/plan/cadReview'
import type { CadSummary, CadVerifyCheck } from '../src/lib/api'

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, detail = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}  ${detail}`)
  }
}

const info: CadVerifyCheck = {
  name: 'wall-thickness',
  level: 'info',
  message: 'median wall thickness is 0.23 m',
  value: 0.23,
}
const warning: CadVerifyCheck = {
  name: 'openings-hosted',
  level: 'warning',
  message: '6 of 18 openings could not be placed on a wall',
  value: 6,
}
const blocking: CadVerifyCheck = {
  name: 'unit-plausible',
  level: 'blocking',
  message: 'the selected unit produces an implausible building',
  value: 'mm',
}
const source = [warning, info, blocking]
const summary: CadSummary = { verifyWarnings: 1, verifyChecks: source }

check('missing verification data needs no review', !cadReviewRequired(null))
check('informational measurements do not interrupt import',
  !cadReviewRequired({ verifyChecks: [info] }))
check('warning findings require an explicit review', cadReviewRequired(summary))

const required = cadReviewChecks(summary)
check('review excludes informational measurements', required.length === 2, String(required.length))
check('blocking findings sort ahead of warnings',
  required[0]?.level === 'blocking' && required[1]?.level === 'warning',
  required.map((finding) => finding.level).join(','))
check('sorting does not mutate the API payload',
  source[0] === warning && source[1] === info && source[2] === blocking)

const all = cadReviewChecks(summary, true)
check('the reviewer can inspect all measurements on demand',
  all.length === 3 && all[2]?.level === 'info', all.map((finding) => finding.level).join(','))

const layerSource: CadSummary = {
  wallLayers: [
    { layer: 'A-WALL', walls: 8, paired: 8, totalLength: 40, billableLength: 40, indoorLength: 30 },
    { layer: 'A-CEIL', walls: 20, paired: 18, totalLength: 85, billableLength: 75, indoorLength: 5 },
    { layer: 'EMPTY', walls: 1, paired: 0, totalLength: 0, billableLength: 0, indoorLength: 0 },
  ],
}
const layers = cadWallLayers(layerSource)
check('wall layers sort by indoor contribution and omit empty runs',
  layers.length === 2 && layers[0]?.layer === 'A-WALL' && layers[1]?.layer === 'A-CEIL',
  layers.map((layer) => layer.layer).join(','))
check('wall layer sorting does not mutate the API payload',
  layerSource.wallLayers?.[0]?.layer === 'A-WALL')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
