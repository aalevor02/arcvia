import { furnishFromCad, cadStoreys, type CadFixture, type CadModel } from '../src/plan/cadFurnish'
import { CATALOGUE } from '../src/catalogue/items'

/**
 * CAD fixtures into furniture proposals.
 *
 * The quiet failures this guards: a re-transformed position (the double-shift
 * that already bit the engine's own probes — a bed half a building away from
 * its bedroom), a block the classifier could not name arriving as a guess, a
 * bundled wardrobe-run block imported at its drawn four-metre footprint, and a
 * second storey's furniture landing on the ground floor.
 *
 * The sample placements are lifted from the villa's real building.json —
 * positions in the 90–120 / 300–335 m window because that is where frame 0
 * genuinely sits on the sheet, and the identity transform is the contract.
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

const fixture = (overrides: Partial<CadFixture>): CadFixture => ({
  block: 'double bed',
  position: { x: 97.7773, y: 331.9263 },
  rotation: 1.5708,
  room: 'BED ROOM',
  footprint: { w: 2.1, d: 1.8 },
  label: 'fixture',
  item: 'bed-queen',
  confidence: { score: 0.7357, margin: 0.4716 },
  needsReview: false,
  ...overrides,
})

const model = (fixtures: CadFixture[]): CadModel => ({ elements: { fixtures } })

// ---- The straight case ------------------------------------------------------
{
  const [bed] = furnishFromCad(model([fixture({})]))

  check('a classified block becomes a proposal', bed !== undefined)
  check('the catalogue item carries through', bed.item === 'bed-queen')
  check(
    'the position is the identity — no re-transform',
    bed.position.x === 97.7773 && bed.position.y === 331.9263,
    `${bed.position.x}, ${bed.position.y}`,
  )
  check('rotation passes through in radians', bed.rotation === 1.5708)
  check('the drawn footprint is kept when sane', bed.size?.width === 2.1 && bed.size?.depth === 1.8)
  check(
    'the height comes from the catalogue, not the drawing',
    bed.size?.height === CATALOGUE.find((i) => i.id === 'bed-queen')?.size.height,
  )
  check('a drawn block is labelled evidence', bed.evidence === 'labelled')
  check('the room name rides along', bed.room === 'BED ROOM')
  check('the block name is the explanation', bed.because.includes('double bed'))
}

// ---- What is dropped, and what is kept flagged ------------------------------
{
  const proposals = furnishFromCad(
    model([
      fixture({}),
      // The engine tried name, layer, footprint and room and named nothing —
      // a manhole cover must not become furniture by arriving here.
      fixture({ block: 'mh cover', item: null }),
      // An id the engine knows but this catalogue does not (version skew) is
      // a drop, not a crash.
      fixture({ block: 'mystery', item: 'no-such-item' }),
      // Doors are real classifications and wrong furniture: they are in-wall
      // items, already present in the model as hosted openings. The villa
      // proposed eight of them before this filter existed.
      fixture({ block: 'D750', item: 'door' }),
    ]),
  )
  check('an unclassified block is dropped, not guessed', proposals.length === 1)
  check('an in-wall item never becomes floor furniture', !proposals.some((p) => p.item === 'door'))

  const [flagged] = furnishFromCad(
    model([fixture({ needsReview: true, confidence: { score: 0.41, margin: 0.02 } })]),
  )
  check('a needsReview placement is kept', flagged !== undefined)
  check('…with its low confidence carried through', flagged.confidence === 0.41)
  check('…and the review is told to look', flagged.because.includes('unsure'))
}

// ---- The footprint guard ----------------------------------------------------
{
  // A block bundling a whole wardrobe run: 4.2 x 0.6 m against a catalogue
  // wardrobe of 1.2 x 0.6. Drawn size lies; catalogue size stands in.
  const [run] = furnishFromCad(
    model([fixture({ block: 'wardrobe run', item: 'wardrobe', footprint: { w: 4.2, d: 0.6 } })]),
  )
  check('a bundled-run footprint falls back to the catalogue', run.size === undefined)

  const [zero] = furnishFromCad(
    model([fixture({ footprint: { w: 0, d: 0 } })]),
  )
  check('a zero footprint falls back to the catalogue', zero.size === undefined)
}

// ---- Storeys ----------------------------------------------------------------
{
  const twoFloors = model([
    fixture({}),
    fixture({ block: 'sofa', item: 'sofa-3', storey: 1, position: { x: 99, y: 320 } }),
  ])

  check('storeys are listed', cadStoreys(twoFloors).join(',') === '0,1')
  check('the ground floor gets only its own furniture', furnishFromCad(twoFloors).length === 1)
  check(
    'a storey can be asked for by number',
    furnishFromCad(twoFloors, { storey: 1 })[0]?.item === 'sofa-3',
  )
  check('a fixture with no storey field is storey 0', furnishFromCad(model([fixture({})])).length === 1)
}

// ---- The multi-storey registration shift ------------------------------------
{
  // The villa's real numbers: the Lower Ground frame sits 17.578 m up the
  // sheet from where its geometry stacks, and skipping the shift stood every
  // basement bed outside the building.
  const shifted: CadModel = {
    elements: {
      fixtures: [fixture({ storey: 0 }), fixture({ block: 'sofa', item: 'sofa-3', storey: 1, position: { x: 99, y: 320 } })],
      storeys: [
        { storey: 0, shift: [0, -17.578] },
        { storey: 1, shift: [0, 0] },
      ],
    },
  }
  const [bed] = furnishFromCad(shifted, { storey: 0 })
  check('the storey shift is applied', Math.abs(bed.position.y - (331.9263 - 17.578)) < 1e-9, String(bed.position.y))
  const [sofa] = furnishFromCad(shifted, { storey: 1 })
  check('a zero shift is the identity', sofa.position.y === 320)
  const [plain] = furnishFromCad(model([fixture({})]))
  check('no storey blocks means no shift — the single-frame contract', plain.position.y === 331.9263)
}

// ---- Degenerate input -------------------------------------------------------
{
  check('an empty model proposes nothing', furnishFromCad({}).length === 0)
  check('a model with no fixtures proposes nothing', furnishFromCad({ elements: {} }).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
