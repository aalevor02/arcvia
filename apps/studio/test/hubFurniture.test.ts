import { CATALOGUE } from '../src/catalogue/items'
import { buildObject } from '../src/catalogue/build'
import type { AssetModel } from '../src/catalogue/types'
import { emptyPlan } from '../src/plan/planStore'
import { placeFurniture } from '../src/plan/placeFurniture'
import { resolveHubFurniture } from '../src/plan/hubFurniture'
import type { Proposal } from '../src/plan/furnish'

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

const unresolved: Proposal = {
  item: 'unresolved:sculptural chair',
  position: { x: 2.5, y: 3 },
  rotation: 0,
  room: 'LIVING',
  storey: 0,
  storeyName: 'Ground Floor',
  designKey: 'room:living|page:2|index:0',
  reviewOnly: true,
  observedItem: 'sculptural chair',
  hubQuery: 'sculptural chair boucle',
  evidence: 'unresolved',
  confidence: 0.55,
  because: 'seen in the living render; no safe catalogue asset exists yet',
}

const model: AssetModel = {
  url: 'http://localhost:3000/hub/conditioned/chair--5000.glb',
  licence: 'CC Attribution 4.0',
  author: 'Example Artist',
  source: 'https://example.com/chair',
  triangles: 4800,
  yaw: 90,
  upAxis: 'y',
}

const floor = CATALOGUE.find((item) => item.id === 'armchair')!
const wall = CATALOGUE.find((item) => item.placement === 'wall')!
const ceiling = CATALOGUE.find((item) => item.placement === 'ceiling')!
const inWall = CATALOGUE.find((item) => item.placement === 'in-wall')!
const resolved = resolveHubFurniture(unresolved, floor, model, 'Boucle Chair')

check('a reviewed Hub choice becomes actionable', resolved?.reviewOnly === false)
check('the catalogue template supplies the placeable item id', resolved?.item === floor.id)
check('the conditioned model and full attribution travel together',
  resolved?.customModel?.author === 'Example Artist' &&
  resolved.customModel.licence === 'CC Attribution 4.0')
check('the render wording becomes the object label', resolved?.label === 'sculptural chair')
check('the measured proposal position and storey survive resolution',
  resolved?.position.x === 2.5 && resolved.position.y === 3 && resolved.storey === 0)
check('wall templates are refused without a measured attachment target',
  resolveHubFurniture(unresolved, wall, model, 'Painting') === null)
const measured: Proposal = {
  ...unresolved,
  placementContext: {
    polygon: [
      { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 },
    ],
    edges: [
      { a: { x: 0, y: 0 }, b: { x: 6, y: 0 }, thickness: 0.23 },
      { a: { x: 6, y: 0 }, b: { x: 6, y: 4 }, thickness: 0.23 },
      { a: { x: 6, y: 4 }, b: { x: 0, y: 4 }, thickness: 0.23 },
      { a: { x: 0, y: 4 }, b: { x: 0, y: 0 }, thickness: 0.23 },
    ],
  },
}
check('measured wall context still requires an explicit reviewer target',
  resolveHubFurniture(measured, wall, model, 'Bespoke Painting') === null)
const resolvedWall = resolveHubFurniture(measured, wall, model, 'Bespoke Painting', 0)
check('a wall template resolves against a measured room face',
  Boolean(resolvedWall) && resolvedWall!.position.y > 0.11 && resolvedWall!.position.y < 0.5,
  JSON.stringify(resolvedWall?.position))
check('the wall template supplies its attachment class and catalogue dimensions',
  resolvedWall?.item === wall.id && resolvedWall.rotation === 0)
check('measured ceiling context still requires an explicit reviewer target',
  resolveHubFurniture(measured, ceiling, model, 'Bespoke Pendant') === null)
const resolvedCeiling = resolveHubFurniture(measured, ceiling, model, 'Bespoke Pendant', 0)
check('a ceiling template resolves to a measured in-room point',
  resolvedCeiling?.item === ceiling.id &&
  resolvedCeiling.position.x === 3 && resolvedCeiling.position.y === 2)
check('in-wall templates stay blocked because they require an actual opening',
  resolveHubFurniture(measured, inWall, model, 'Door') === null)
check('an ordinary proposal cannot be replaced through the unresolved-item seam',
  resolveHubFurniture({ ...unresolved, reviewOnly: false }, floor, model, 'Chair') === null)
check('missing licence provenance is refused',
  resolveHubFurniture(unresolved, floor, { ...model, author: '' }, 'Chair') === null)

const plan = placeFurniture(emptyPlan(), resolved ? [resolved] : [])
const placed = Object.values(plan.floors[0].objects)[0]
check('acceptance persists the conditioned model on the plan object',
  placed?.customModel?.url === model.url)
check('acceptance persists the reviewed label', placed?.label === 'sculptural chair')

const built = placed ? buildObject(placed, 0) : null
check('the 3D upgrade loads the reviewed Hub URL',
  built?.userData.modelUrl === model.url)
check('the 3D upgrade preserves the conditioned model facing',
  built?.userData.modelYaw === 90 && built.userData.modelUpAxis === 'y')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
