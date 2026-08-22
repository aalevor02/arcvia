import { classifyRoom, composeProject, emptyProject, slugify } from '../src/publish/compose'
import type { ComposableScene } from '../src/publish/compose'
import type { Floor, Plan } from '../src/plan/types'

/**
 * Composing the project a client opens.
 *
 * ── Why this is tested hard ─────────────────────────────────────────────────
 * Everything this produces ends up on a page a buyer reads, and most of it is a
 * number. A wrong room count looks like a plan. A wrong area looks like an
 * area. Nothing downstream can tell that a schedule was derived incorrectly,
 * because there is nothing to compare it against — the drawing is the only
 * source and this is the only reader of it.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// ---- A plan with known dimensions --------------------------------------------

/**
 * Two rooms side by side, sharing a wall.
 *
 * Vertices are wall endpoints, so the room polygons run along centrelines and
 * the areas below are exact by construction: 6 x 4 and 4 x 4.
 *
 *   (0,0) ---- (6,0) ---- (10,0)
 *     |          |           |
 *   (0,4) ---- (6,4) ---- (10,4)
 */
function twoRoomFloor(names: Record<string, string> = {}): Floor {
  // Deliberately built with no `as` casts. The first version of this fixture
  // gave walls `from`/`to` instead of `a`/`b` and a cast hid it from tsc, so it
  // typechecked cleanly and detected zero rooms. A cast in a fixture disables
  // the one check that would have said the fixture was not a Floor.
  const vertices: Floor['vertices'] = {
    a: { id: 'a', x: 0, y: 0 },
    b: { id: 'b', x: 6, y: 0 },
    c: { id: 'c', x: 10, y: 0 },
    d: { id: 'd', x: 0, y: 4 },
    e: { id: 'e', x: 6, y: 4 },
    f: { id: 'f', x: 10, y: 4 },
  }

  let n = 0
  const wall = (a: string, b: string): [string, Floor['walls'][string]] => {
    const id = `w${n++}`
    return [id, { id, a, b, thickness: 0.23, height: 3 }]
  }
  const walls: Floor['walls'] = Object.fromEntries([
    wall('a', 'b'), wall('b', 'c'),
    wall('d', 'e'), wall('e', 'f'),
    wall('a', 'd'), wall('b', 'e'), wall('c', 'f'),
  ])

  return {
    id: 'ground',
    name: 'Ground',
    elevation: 0,
    vertices,
    walls,
    roomNames: names,
    objects: {},
    underlay: null,
  }
}

const planWith = (floors: Floor[]): Plan => ({
  version: 1,
  floors,
  activeFloorId: floors[0]?.id ?? '',
})

const scene = (plan: Plan | null, extra: Partial<ComposableScene> = {}): ComposableScene => ({
  id: 's1',
  plan,
  ...extra,
})

// ---- Areas and rooms ---------------------------------------------------------

{
  const floor = twoRoomFloor()
  const { project, warnings } = composeProject('Test Project', [{ scene: scene(planWith([floor])), name: 'Type A' }])
  const type = project.villaTypes[0]

  check('one unit type is composed', project.villaTypes.length === 1)
  check('with one floor', type?.floors.length === 1)
  check('and both rooms found', type?.floors[0].rooms.length === 2, String(type?.floors[0].rooms.length))

  // 6x4 = 24 and 4x4 = 16, measured at centrelines.
  check('the floor area is the sum of the rooms', type?.floors[0].area === 40, String(type?.floors[0].area))
  check('and totalSbua is the sum of the floors', type?.totalSbua === 40, String(type?.totalSbua))

  const [largest, smallest] = type!.floors[0].rooms
  check('rooms are ordered largest first', largest.width === 6 && smallest.width === 4, `${largest.width} then ${smallest.width}`)
  check('and carry their extents', largest.depth === 4 && smallest.depth === 4)

  // ── The assertion that matters most on a sales page ──────────────────────
  // A measured centreline area is not a certified SBUA, and the composer must
  // never let that number reach a buyer unremarked.
  check(
    'the SBUA figure is flagged as measured, not certified',
    warnings.some((w) => /not a certified/i.test(w) && /Type A/.test(w)),
    warnings.find((w) => /certified/i.test(w)),
  )
}

// ---- Unnamed rooms are reported, not silently numbered ------------------------

{
  const { warnings } = composeProject('P', [{ scene: scene(planWith([twoRoomFloor()])), name: 'Type A' }])
  check(
    'an unnamed room is reported',
    warnings.filter((w) => /unnamed/i.test(w)).length === 2,
    String(warnings.filter((w) => /unnamed/i.test(w)).length),
  )
}

// ---- Classification ----------------------------------------------------------

check('a bedroom is habitable', classifyRoom('Bedroom 1') === 'habitable')
check('a toilet is service', classifyRoom('Toilet 02') === 'service')
check('a foyer is circulation', classifyRoom('Foyer') === 'circulation')
check('a balcony is outdoor', classifyRoom('Balcony') === 'outdoor')

// Outdoor is checked before the others deliberately: these two names contain a
// habitable and a service word respectively and are outdoor all the same.
check('an "Office Patio" is outdoor, not a study', classifyRoom('Office Patio') === 'outdoor')
check('a "Pool Deck" is outdoor, not plant', classifyRoom('Pool Deck') === 'outdoor')

// Whole words only. The substring defect has been recorded three times in this
// repo and this is the fourth place it could happen.
check('"Bedside" is not a bedroom', classifyRoom('Bedside') === undefined, String(classifyRoom('Bedside')))
check('"Restore" is not a store', classifyRoom('Restore') === undefined, String(classifyRoom('Restore')))
check('an unrecognised name is left unclassified', classifyRoom('Snug') === undefined)
check('and unclassified is not guessed as habitable', classifyRoom('Zone 4') === undefined)

// ---- The walkthrough ---------------------------------------------------------

{
  const withModel = composeProject('P', [
    {
      name: 'Type A',
      scene: scene(planWith([twoRoomFloor()]), {
        modelUrl: '/uploads/scenes/x/abc.glb',
        hdriUrl: '/env/golden-hour.hdr',
        views: [{ id: 'v1', name: 'Living', position: [1, 1.6, 1], rotation: [0, 0] }],
      }),
    },
  ])
  const walk = withModel.project.villaTypes[0]?.walkthrough
  check('a scene with a model gets a walkthrough', Boolean(walk))
  check('carrying the model url', walk?.model === '/uploads/scenes/x/abc.glb')
  check('and the chosen environment', walk?.environment === '/env/golden-hour.hdr')
  check('and its named views', walk?.views.length === 1)
  // Shared with the editor's own walk controller. A walkthrough standing at a
  // different height from the editor is a different building.
  check('at standing eye height', walk?.eyeHeight === 1.6)

  const withoutModel = composeProject('P', [{ scene: scene(planWith([twoRoomFloor()])), name: 'Type A' }])
  check('a scene with no model gets no walkthrough', withoutModel.project.villaTypes[0]?.walkthrough === undefined)
  check('and says so', withoutModel.warnings.some((w) => /no saved model/i.test(w)))
}

// ---- Refusals and collisions -------------------------------------------------

{
  const { project, warnings } = composeProject('P', [{ scene: scene(null), name: 'Type A' }])
  check('a scene with no plan is excluded', project.villaTypes.length === 0)
  check('and says why', warnings.some((w) => /no plan/i.test(w)))
  check('and says the project has nothing to show', warnings.some((w) => /nothing for a visitor/i.test(w)))
}

{
  const floor = twoRoomFloor()
  const { warnings } = composeProject('P', [
    { scene: scene(planWith([floor])), name: 'Type A' },
    { scene: scene(planWith([floor])), name: 'Type  A' },
  ])
  // Both slugify to "type-a": the second becomes unreachable and the page still
  // renders, so nothing but this would report it.
  check('two types sharing an address are reported', warnings.some((w) => /share the address/i.test(w)))
}

// ---- The authored half -------------------------------------------------------

{
  const { project, warnings } = composeProject(
    'P',
    [{ scene: scene(planWith([twoRoomFloor()])), name: 'Type A' }],
    { developer: 'Fair Green', rera: 'PRGO123', disclaimer: 'Indicative only.', tagline: 'A place' },
  )
  check('authored copy is kept', project.developer === 'Fair Green' && project.tagline === 'A place')
  check('and does not trigger its warning', !warnings.some((w) => /RERA number has not been written/i.test(w)))

  const bare = composeProject('P', [{ scene: scene(planWith([twoRoomFloor()])), name: 'Type A' }])
  check('a missing RERA number is named', bare.warnings.some((w) => /RERA number/i.test(w)))
  check('a missing developer is named', bare.warnings.some((w) => /developer/i.test(w)))
  check('a missing disclaimer is named', bare.warnings.some((w) => /disclaimer/i.test(w)))
  check('and having nobody to contact is named', bare.warnings.some((w) => /nobody to contact/i.test(w)))

  // Authored copy must never replace a derived schedule.
  const overridden = composeProject(
    'P',
    [{ scene: scene(planWith([twoRoomFloor()])), name: 'Type A' }],
    { villaTypes: [] },
  )
  check('authored villaTypes cannot overwrite the derived ones', overridden.project.villaTypes.length === 1)
}

// ---- Shape -------------------------------------------------------------------

{
  const empty = emptyProject('A Name')
  // The published page indexes into these without guarding, which is correct
  // for a hand-written file and fatal for a generated one.
  check('every array a page reads exists', Array.isArray(empty.gallery) && Array.isArray(empty.contacts) && Array.isArray(empty.sitePlan.units) && Array.isArray(empty.sections))
  check('and the nested objects too', Boolean(empty.intro && empty.locationMap && empty.sitePlan))
  check('slugify makes a usable address', slugify('Type A1 — Ground') === 'type-a1-ground')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
