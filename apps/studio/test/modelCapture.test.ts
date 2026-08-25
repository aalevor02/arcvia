import { modelCaptureSource, needsModelCapture } from '../src/plan/modelCapture'

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

const baked = modelCaptureSource({
  hasBakedAtlas: true,
  planHasWalls: true,
  hasViewerModel: true,
})
check('a baked atlas keeps its bake-time model and UV layout', baked === 'preserve-baked', baked)
check('a baked model is never recaptured before a still', !needsModelCapture(baked), baked)

const plan = modelCaptureSource({
  hasBakedAtlas: false,
  planHasWalls: true,
  hasViewerModel: true,
})
check('a measured plan is rebuilt with export ceilings', plan === 'capture-plan', plan)
check('a measured plan is captured before downstream work', needsModelCapture(plan), plan)

const hybrid = modelCaptureSource({
  hasBakedAtlas: false,
  planHasWalls: false,
  hasViewerModel: true,
})
check('an imported or hybrid scene captures the composed viewer model', hybrid === 'capture-viewer', hybrid)
check('the composed viewer model is persisted before rendering', needsModelCapture(hybrid), hybrid)

const unloaded = modelCaptureSource({
  hasBakedAtlas: false,
  planHasWalls: false,
  hasViewerModel: false,
})
check('an unloaded model-only scene preserves its stored building', unloaded === 'preserve-stored', unloaded)
check('an empty plan cannot overwrite an unloaded stored model', !needsModelCapture(unloaded), unloaded)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
