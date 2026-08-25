import { addFloor, addObject, emptyPlan, setActiveFloor } from '../src/plan/planStore'
import { furnishFromDesign } from '../src/plan/designFurnish'
import { placeFurniture } from '../src/plan/placeFurniture'
import type { CadFixture, CadModel, CadSpace } from '../src/plan/cadFurnish'
import type { DesignSpec } from '../src/plan/deckDesign'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}  ${detail}`)
  }
}

const room = (name: string, x0 = 0, y0 = 0, x1 = 6, y1 = 4): CadSpace => ({
  index: 0,
  name,
  kind: name.toLowerCase(),
  area: (x1 - x0) * (y1 - y0),
  loop: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
})

const design = (name: string, furniture: string[], page: number): DesignSpec => ({
  room: name.toLowerCase(),
  furniture: furniture.map((item) => ({ item })),
  palette: ['#eeeeee'],
  confidence: 0.8,
  source: { page, index: 0, room: `${name} Render` },
})

const baseModel = (): CadModel => ({
  elements: {
    fixtures: [],
    storeys: [
      { storey: 0, title: 'Ground Floor', shift: [0, 0], spaces: [room('LIVING')] },
      { storey: 1, title: 'First Floor', shift: [0, 10], spaces: [room('BEDROOM', 0, 0, 5, 4)] },
    ],
  },
})

const looks = [
  design('Living', ['sofa', 'table', 'lamp'], 2),
  design('Bedroom', ['bed', 'wardrobe'], 3),
]

console.log('-- observed inventory into measured rooms --')
{
  const proposals = furnishFromDesign(baseModel(), looks)
  check('known floor assets are proposed and an unsupported lamp stays reviewable',
    proposals.length === 5 && proposals.some((piece) => piece.evidence === 'unresolved'),
    proposals.map((piece) => piece.item).join(', '))
  check('unsupported render items carry an Asset Hub search phrase',
    proposals.find((piece) => piece.evidence === 'unresolved')?.hubQuery === 'lamp',
    proposals.find((piece) => piece.evidence === 'unresolved')?.hubQuery ?? '')
  check('every proposal is explicitly render evidence',
    proposals.every((piece) => piece.evidence === 'rendered' || piece.evidence === 'unresolved'))
  check('ground-floor inventory stays on storey zero',
    proposals.filter((piece) => piece.room === 'LIVING').every((piece) => piece.storey === 0))
  check('upper inventory carries its source storey and title',
    proposals.filter((piece) => piece.room === 'BEDROOM').every(
      (piece) => piece.storey === 1 && piece.storeyName === 'First Floor',
    ))
  check('the upper registration shift reaches furniture positions',
    proposals.filter((piece) => piece.storey === 1).every(
      (piece) => piece.position.y > 10 && piece.position.y < 14,
    ), JSON.stringify(proposals.filter((piece) => piece.storey === 1).map((piece) => piece.position)))
  const actionable = proposals.filter((piece) => !piece.reviewOnly)
  check('items in one room do not land on top of each other',
    new Set(actionable.map((piece) => `${piece.storey}:${piece.position.x.toFixed(2)}:${piece.position.y.toFixed(2)}`)).size === actionable.length)
  check('each proposal carries the design key that will suppress repeat review',
    proposals.every((piece) => piece.designKey?.startsWith('room:')))

  const placed = placeFurniture(emptyPlan(), actionable)
  check('acceptance creates the missing source storey automatically', placed.floors.length === 2)
  check('the source title names the created storey', placed.floors[1].name === 'First Floor')
  check('accepted objects land on their own storeys',
    Object.keys(placed.floors[0].objects).length === 2 &&
    Object.keys(placed.floors[1].objects).length === 2)
  check('acceptance restores the floor the user was editing',
    placed.activeFloorId === placed.floors[0].id)
}

console.log('\n-- stronger source furniture prevents duplicates --')
{
  const fixture: CadFixture = {
    block: '3 ST SOFA',
    position: { x: 1, y: 1 },
    rotation: 0,
    room: 'LIVING',
    footprint: { w: 2.1, d: 0.9 },
    label: 'fixture',
    item: 'sofa-3',
    confidence: { score: 0.95, margin: 0.5 },
    needsReview: false,
    storey: 0,
  }
  const model = baseModel()
  model.elements!.fixtures = [fixture]
  const proposals = furnishFromDesign(model, looks)
  check('one usable CAD fixture suppresses the whole room fallback',
    proposals.filter((piece) => !piece.reviewOnly).every((piece) => piece.room !== 'LIVING'))
  check('another empty room is still furnished',
    proposals.some((piece) => piece.room === 'BEDROOM'))
}

{
  let plan = emptyPlan()
  plan = addFloor(plan, 'First Floor')
  plan = setActiveFloor(plan, plan.floors[1].id)
  plan = addObject(plan, { item: 'bed-queen', position: { x: 2, y: 12 }, rotation: 0 })
  const proposals = furnishFromDesign(baseModel(), looks, plan)
  check('an accepted plan object suppresses that reconstructed room',
    proposals.every((piece) => piece.room !== 'BEDROOM'))
  check('plan occupancy on one storey does not suppress another',
    proposals.some((piece) => piece.room === 'LIVING'))
}

console.log('\n-- measured wall and ceiling attachments --')
{
  const model = baseModel()
  const ground = model.elements!.storeys![0]
  ground.spaces![0].boundedBy = [0, 1, 2, 3]
  ground.walls = [
    { a: { x: 0, y: 0 }, b: { x: 6, y: 0 }, thickness: 0.23 },
    { a: { x: 6, y: 0 }, b: { x: 6, y: 4 }, thickness: 0.23 },
    { a: { x: 6, y: 4 }, b: { x: 0, y: 4 }, thickness: 0.23 },
    { a: { x: 0, y: 4 }, b: { x: 0, y: 0 }, thickness: 0.23 },
  ]
  const render = design(
    'Living',
    ['sofa', 'painting', 'mirror', 'wall-light', 'pendant', 'ceiling-light', 'bespoke-kinetic-object'],
    7,
  )
  const proposals = furnishFromDesign(model, [render])
  const ids = proposals.map((piece) => piece.item)
  check('render decor resolves to real wall and ceiling catalogue assets',
    ['painting', 'mirror', 'wall-light', 'pendant', 'ceiling-light'].every((id) => ids.includes(id)),
    ids.join(', '))
  check('wall objects stand inside the measured 230 mm wall faces',
    proposals.filter((piece) => ['painting', 'mirror', 'wall-light'].includes(piece.item))
      .every((piece) => piece.position.x > 0.11 && piece.position.x < 5.89 &&
        piece.position.y > 0.11 && piece.position.y < 3.89),
    JSON.stringify(proposals.map((piece) => [piece.item, piece.position])))
  check('ceiling objects are arranged at distinct points inside the room',
    new Set(proposals.filter((piece) => ['pendant', 'ceiling-light'].includes(piece.item))
      .map((piece) => `${piece.position.x}:${piece.position.y}`)).size === 2)
  const unresolved = proposals.find((piece) => piece.observedItem === 'bespoke-kinetic-object')
  check('an unresolved item retains its measured room polygon for later review',
    unresolved?.placementContext?.polygon.length === 4)
  check('and retains the reconstruction wall faces with measured thickness',
    unresolved?.placementContext?.edges.length === 4 &&
      unresolved.placementContext.edges.every((edge) => edge.thickness === 0.23))

  const fixture: CadFixture = {
    block: 'SOFA', position: { x: 1, y: 1 }, rotation: 0, room: 'LIVING',
    footprint: { w: 2.1, d: 0.9 }, label: 'fixture', item: 'sofa-3',
    confidence: { score: 0.95, margin: 0.5 }, needsReview: false, storey: 0,
  }
  model.elements!.fixtures = [fixture]
  const withoutDuplicateFloor = furnishFromDesign(model, [render])
  check('drawn floor furniture suppresses only floor guesses, not render decor',
    !withoutDuplicateFloor.some((piece) => piece.item === 'sofa-3') &&
      withoutDuplicateFloor.some((piece) => piece.item === 'painting') &&
      withoutDuplicateFloor.some((piece) => piece.item === 'pendant'))

  const placed = placeFurniture(emptyPlan(), proposals.filter((piece) => !piece.reviewOnly))
  check('acceptance preserves every attachment object',
    Object.values(placed.floors[0].objects).filter((object) =>
      ['painting', 'mirror', 'wall-light', 'pendant', 'ceiling-light'].includes(object.item),
    ).length === 5)
}

console.log('\n-- matching and refusal --')
{
  check('an unrelated render invents no furniture',
    furnishFromDesign(baseModel(), [design('Kitchen', ['table'], 5)]).length === 0)
  check('a model without room polygons cannot fabricate positions',
    furnishFromDesign({ elements: { fixtures: [] } }, looks).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
