import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  identify,
  identifyCadBlock,
  fromLabel,
  fromSize,
  roomItems,
  ITEM_FOR_WORD,
  ROOM_RECIPES,
} from '../src/catalogue/recognise'
import { CATALOGUE } from '../src/catalogue/items'
import { proposeFurniture, summariseFurniture } from '../src/plan/furnish'
import type { DetectionResult, DetectedRoom } from '../src/plan/detections'
import type { Underlay } from '../src/plan/types'

/**
 * Reading furniture off a drawing.
 *
 * The failures worth testing here are all quiet ones. Identifying a bed as a
 * dining table produces a model that loads, renders and is the wrong object;
 * orienting a sofa into a wall produces a room that looks broken without any
 * error; and furnishing a room the architect already furnished doubles up the
 * bed without complaint.
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

// ---- Identification from a label -------------------------------------------
{
  check('a labelled wardrobe is a wardrobe', fromLabel('WARDROBE')?.item.id === 'wardrobe')
  check('an almirah is the same cupboard', fromLabel('ALMIRAH')?.item.id === 'wardrobe')
  check('LUGGAGE is storage', fromLabel('LUGGAGE')?.item.id === 'chest')
  check('SWING CHAIR is seating', fromLabel('SWING CHAIR')?.item.id === 'armchair')
  check('a label reports itself as evidence', fromLabel('DRESSER')?.evidence === 'labelled')
  check('and says what it read', (fromLabel('DRESSER')?.because ?? '').includes('DRESSER'))
  check('an unknown word identifies nothing', fromLabel('XYZZY') === null)
  check('a hyphenated wall light resolves to its attachment asset',
    fromLabel('wall-light')?.item.id === 'wall-light')
  check('a pendant resolves to the ceiling attachment asset',
    fromLabel('pendant')?.item.id === 'pendant')

  // A room name is not a fixture. TOILET is both, which is the trap.
  check('TOILET as a room label is not a WC',
    fromLabel('TOILET', { isRoomLabel: true }) === null)
  check('but TOILET on a fitting is a WC', fromLabel('TOILET')?.item.id === 'wc')
}

// ---- Identification from size ----------------------------------------------
{
  // What the room contributes: the same rectangle is read differently, or not
  // at all, depending on which room it was drawn in. A 1.8 x 0.95 m outline is
  // a six-seat dining table; in a bedroom it is not any of the things bedrooms
  // contain, and saying nothing is the right answer there.
  const asTable = fromSize(1.8, 0.95, 'Dining')
  const sameInBedroom = fromSize(1.8, 0.95, 'Bedroom')
  check('1.8 x 0.95 in a dining room is a dining table',
    asTable?.item.id.startsWith('dining-table') === true, String(asTable?.item.id))
  check('the same rectangle in a bedroom is not',
    asTable?.item.id !== sameInBedroom?.item.id,
    `${asTable?.item.id} vs ${sameInBedroom?.item.id}`)

  const inBedroom = fromSize(1.5, 2.0, 'Bedroom')
  check('1.5 x 2.0 in a bedroom is a bed', inBedroom?.item.id.startsWith('bed') === true,
    String(inBedroom?.item.id))

  check('a measurement reports itself as such', inBedroom?.evidence === 'measured')
  check('and quotes the measurement', (inBedroom?.because ?? '').includes('2.00'))

  // Nothing in the catalogue is this shape.
  check('an implausible footprint identifies nothing', fromSize(0.05, 0.05, 'Bedroom') === null)
  check('and so does a huge one', fromSize(9, 9, 'Bedroom') === null)

  // Log-space comparison: half-size and double-size must be equally wrong.
  const half = fromSize(1.0, 0.8, 'Bedroom')
  const double = fromSize(4.0, 3.2, 'Bedroom')
  check('scoring does not favour large items', !(half && double && half.item.id === double.item.id),
    `${half?.item.id} vs ${double?.item.id}`)
}

// ---- Evidence ordering ------------------------------------------------------
{
  // A label must beat a measurement, even a measurement that fits something else
  // perfectly. The architect wrote it down.
  const both = identify({ label: 'WARDROBE', width: 2.0, depth: 1.6, room: 'Bedroom' })
  check('a written label outranks a measurement', both?.item.id === 'wardrobe', String(both?.item.id))
  check('and is reported as the stronger evidence', both?.evidence === 'labelled')
  check('a measurement is used when there is no label',
    identify({ width: 2.0, depth: 1.6, room: 'Bedroom' })?.evidence === 'measured')
}

// ---- Room recipes -----------------------------------------------------------
{
  check('a bedroom implies a bed', (roomItems('Bedroom') ?? [])[0]?.startsWith('bed') === true)
  check('BEDROOM-2 matches on the word', roomItems('Bedroom-2') !== null)
  check('a toilet implies a WC', (roomItems('Toilet-01') ?? []).includes('wc'))
  check('a lawn implies nothing', roomItems('Lawn') === null)
}

// ---- Placement --------------------------------------------------------------
const underlay: Underlay = {
  url: '', width: 1000, height: 1000,
  origin: { x: 0, y: 0 }, scale: 0.01, // 1000px * 0.01 = 10 m across
  opacity: 1, invert: false, locked: true,
}

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

const room = (name: string, box: number[], area = 0.2): DetectedRoom => ({
  polygon: rect(box[0], box[1], box[2], box[3]),
  area, name, kind: 'room', size: null, also: [],
})

const fitting = (name: string | null, box: number[]): DetectedRoom => ({
  polygon: rect(box[0], box[1], box[2], box[3]),
  area: 0.02, name, kind: 'fitting', size: null, also: [],
})

const result = (rooms: DetectedRoom[]): DetectionResult => ({
  backend: 'heuristic', width: 1000, height: 1000,
  walls: [], objects: [], rooms, scale: null, low_confidence: false,
})

{
  // A bedroom 0..4 m with a labelled wardrobe drawn against its left wall.
  const detection = result([
    room('Bedroom', [0, 0, 0.4, 0.4]),
    fitting('WARDROBE', [0.02, 0.1, 0.08, 0.3]),
  ])
  const proposals = proposeFurniture(detection, underlay)

  check('a drawn fitting becomes a proposal', proposals.length === 1, String(proposals.length))
  check('identified from its label', proposals[0]?.item === 'wardrobe')
  check('attributed to its room', proposals[0]?.room === 'Bedroom')
  check('placed where it was drawn',
    Math.abs(proposals[0].position.x - 0.5) < 0.2 && Math.abs(proposals[0].position.y - 2.0) < 0.3,
    JSON.stringify(proposals[0].position))

  // Against the left wall, so it must face right: rotation -PI/2.
  check('turned to face into the room',
    Math.abs(proposals[0].rotation - -Math.PI / 2) < 0.01, String(proposals[0].rotation))

  check('sized from the drawing, not the catalogue', proposals[0].size !== undefined)
}

{
  // Nothing drawn: the room type is the only evidence there is.
  const detection = result([room('Bedroom', [0, 0, 0.4, 0.4])])

  check('nothing is assumed by default', proposeFurniture(detection, underlay).length === 0)

  const assumed = proposeFurniture(detection, underlay, { assume: true })
  check('with assume on, the room is furnished', assumed.length > 0, String(assumed.length))
  check('and every item is flagged as a guess',
    assumed.every((p) => p.evidence === 'typical'))
  check('a bed is among them', assumed.some((p) => p.item.startsWith('bed')))
  check('and it says why', (assumed[0]?.because ?? '').includes('usually'))
}

{
  // The architect already furnished this room. Adding to it is not help.
  const detection = result([
    room('Bedroom', [0, 0, 0.4, 0.4]),
    fitting(null, [0.1, 0.1, 0.3, 0.26]), // a bed-sized rectangle, unlabelled
  ])
  const proposals = proposeFurniture(detection, underlay, { assume: true })

  check('a drawn room is not furnished again',
    proposals.every((p) => p.evidence !== 'typical'),
    JSON.stringify(proposals.map((p) => `${p.item}:${p.evidence}`)))
  check('the drawn item is still identified', proposals.length >= 1)
  check('as a bed, from its size and its room',
    proposals[0]?.item.startsWith('bed') === true, String(proposals[0]?.item))
}

{
  // Two rooms, one fitting in each, so containment has to pick the right one.
  const detection = result([
    room('Bedroom', [0, 0, 0.4, 0.4], 0.3),
    room('Toilet', [0.5, 0, 0.8, 0.2], 0.1),
    fitting('WARDROBE', [0.05, 0.05, 0.12, 0.25]),
    fitting('BASIN', [0.55, 0.05, 0.65, 0.1]),
  ])
  const proposals = proposeFurniture(detection, underlay)

  const wardrobe = proposals.find((p) => p.item === 'wardrobe')
  const basin = proposals.find((p) => p.item === 'basin')
  check('each fitting is attributed to the room it sits in',
    wardrobe?.room === 'Bedroom' && basin?.room === 'Toilet',
    `${wardrobe?.room} / ${basin?.room}`)
}

{
  const summary = summariseFurniture([
    { item: 'bed-queen', position: { x: 0, y: 0 }, rotation: 0, room: 'Bedroom', evidence: 'labelled', confidence: 0.9, because: '' },
    { item: 'wardrobe', position: { x: 0, y: 0 }, rotation: 0, room: 'Bedroom', evidence: 'typical', confidence: 0.4, because: '' },
  ])
  check('the summary separates drawn from assumed',
    summary.drawn === 1 && summary.rendered === 0 && summary.assumed === 1, JSON.stringify(summary))
  check('and counts rooms', summary.rooms === 1)
}


// ---- Catalogue drift --------------------------------------------------------
/**
 * Every item id either vocabulary names must exist in the catalogue.
 *
 * The two tables live in different languages — the plain-word one here, the
 * drafting-shorthand one in `services/floorplan-ai/cad.py` — and both point at
 * catalogue ids by string. Renaming an item is a one-line change that breaks
 * them silently: nothing throws, the mapping simply stops resolving, and
 * furniture quietly disappears from imports of drawings that used to work.
 *
 * Reading the Python file from a TypeScript test is unusual and is the point:
 * the coupling is real, so the check has to cross the same boundary the bug
 * would.
 */
{
  const ids = new Set(CATALOGUE.map((item) => item.id))

  const written = [...new Set(Object.values(ITEM_FOR_WORD))]
  const unknownWritten = written.filter((id) => !ids.has(id))
  check('every written-word mapping names a real item', unknownWritten.length === 0,
    unknownWritten.join(', '))

  const recipeIds = [...new Set(Object.values(ROOM_RECIPES).flat())]
  const unknownRecipe = recipeIds.filter((id) => !ids.has(id))
  check('every room recipe names real items', unknownRecipe.length === 0,
    unknownRecipe.join(', '))

  // Resolved from the working directory, not `import.meta.url`: the runner
  // bundles each test to a temporary file, so a path relative to the module
  // points into the temp directory rather than the repository.
  const cad = readFileSync(
    join(process.cwd(), '../../services/floorplan-ai/cad.py'),
    'utf8',
  )
  const hints = cad.slice(cad.indexOf('_BLOCK_HINTS'), cad.indexOf('def guess_item'))
  // The second element of each tuple: (("sofa", ...), "sofa-3")
  const cadIds = [...new Set([...hints.matchAll(/\),\s*"([a-z0-9-]+)"\)/g)].map((m) => m[1]))]

  check('the CAD vocabulary was read', cadIds.length > 10, `${cadIds.length} ids`)
  const unknownCad = cadIds.filter((id) => !ids.has(id))
  check('every CAD block mapping names a real item', unknownCad.length === 0,
    unknownCad.join(', '))
}

// ---- CAD blocks fall back to the written vocabulary -------------------------
{
  check('a block the shorthand mapped keeps that mapping',
    identifyCadBlock({ name: '3 ST SOFA', item: 'sofa-3' })?.item.id === 'sofa-3')

  // The case the fallback exists for: a drawing whose blocks are named plainly.
  check('an unmapped block is read as plain words',
    identifyCadBlock({ name: 'Wardrobe', item: null })?.item.id === 'wardrobe')

  check('a block naming nothing identifies nothing',
    identifyCadBlock({ name: 'XREF-01', item: null }) === null)

  // A stale mapping must not swallow a readable name.
  check('a mapping to a deleted item still reads the name',
    identifyCadBlock({ name: 'Wardrobe', item: 'no-such-item' })?.item.id === 'wardrobe')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
