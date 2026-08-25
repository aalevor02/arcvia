import { CATALOGUE } from './items'
import type { CatalogueItem } from './types'

/**
 * Working out what a shape on a drawing is.
 *
 * ── The three things a plan tells you, in order of how much they are worth ──
 * A drawing says what its contents are in three different ways, and they are
 * not equally reliable:
 *
 *   1. It writes the name down.      WARDROBE, DRESSER, SWING CHAIR.
 *   2. It draws the thing to scale.  A 2.0 x 1.6 m rectangle in a bedroom.
 *   3. It names the room.            A bedroom contains a bed.
 *
 * The first is nearly always right and is available far more often than you
 * would expect — architects label their joinery because the joiner has to build
 * it. The second is good evidence and ambiguous on its own: 2.0 x 1.6 is a
 * double bed in a bedroom and a dining table in a dining room. The third is not
 * evidence about any particular shape at all; it is a reasonable default for a
 * room that has none.
 *
 * So identification tries them in that order and reports which one answered,
 * because "the drawing says this is a wardrobe" and "rooms like this usually
 * have a wardrobe" are different claims and the user deserves to see which they
 * are being shown.
 */

export type Evidence = 'labelled' | 'measured' | 'rendered' | 'typical' | 'unresolved'

export interface Identification {
  item: CatalogueItem
  evidence: Evidence
  confidence: number
  /** What in the drawing led here — shown to the user, not used for logic. */
  because: string
}

/**
 * Words an architect writes on a plan, and what they mean in the catalogue.
 *
 * A vocabulary rather than a model, for the same reason the detector uses one:
 * the words are a small, stable set across the whole trade, and a list is
 * auditable in a way weights are not. Multiple words map to one item on purpose
 * — a plan may say ALMIRAH, WARDROBE or CLOSET and mean the same cupboard.
 */
export const ITEM_FOR_WORD: Record<string, string> = {
  // Seating
  sofa: 'sofa-3', settee: 'sofa-3', couch: 'sofa-3', loveseat: 'sofa-2',
  armchair: 'armchair', easychair: 'armchair', recliner: 'armchair',
  chair: 'dining-chair', seating: 'bench', bench: 'bench', swing: 'armchair',
  stool: 'dining-chair',

  // Tables
  table: 'dining-table-6', dining: 'dining-table-6',
  coffee: 'coffee-table', centre: 'coffee-table', center: 'coffee-table',
  side: 'side-table', end: 'side-table', console: 'side-table',
  desk: 'desk', study: 'desk', writing: 'desk',

  // Beds
  bed: 'bed-queen', cot: 'bed-single', bunk: 'bed-single',
  bedside: 'bedside', nightstand: 'bedside',

  // Storage
  wardrobe: 'wardrobe', almirah: 'wardrobe', closet: 'wardrobe',
  cupboard: 'wardrobe', armoire: 'wardrobe',
  dresser: 'chest', chest: 'chest', drawers: 'chest', luggage: 'chest',
  bookshelf: 'bookshelf', bookcase: 'bookshelf', shelf: 'bookshelf',
  shelves: 'bookshelf', shelving: 'bookshelf', storage: 'bookshelf',
  tv: 'tv-unit', television: 'tv-unit', media: 'tv-unit', sideboard: 'tv-unit',
  credenza: 'tv-unit', crockery: 'tv-unit',

  // Kitchen
  counter: 'counter', platform: 'counter', worktop: 'counter',
  island: 'island', sink: 'sink-unit', fridge: 'fridge',
  refrigerator: 'fridge', hob: 'hob', stove: 'hob', cooker: 'hob',
  cooktop: 'hob', pantry: 'counter',

  // Bathroom. `toilet` is here as the fixture; `ROOM_ONLY` is what stops a
  // region *named* Toilet from also being read as a WC standing in itself.
  wc: 'wc', commode: 'wc', toilet: 'wc', ewc: 'wc',
  basin: 'basin', washbasin: 'basin', vanity: 'basin', lavatory: 'basin',
  bathtub: 'bathtub', tub: 'bathtub', jacuzzi: 'bathtub',
  shower: 'shower',

  // Decor
  rug: 'rug', carpet: 'rug', dhurrie: 'rug',
  plant: 'plant', planter: 'plant', pot: 'plant', greens: 'plant',
  mirror: 'mirror', painting: 'painting', art: 'painting',
  artwork: 'painting', piece: 'painting', frame: 'painting',
  pendant: 'pendant', sconce: 'wall-light',
}

const ITEM_FOR_PHRASE: Record<string, string> = {
  'wall light': 'wall-light',
  'ceiling light': 'ceiling-light',
}

/**
 * Words that mean the *room*, not a thing inside it.
 *
 * TOILET is the commonest trap: it is both a room name and a fixture, and a
 * region labelled TOILET is a room containing a WC rather than a WC. The
 * detector already separates rooms from fittings, so this only guards the case
 * where a label is being read on its own with no region behind it.
 */
const ROOM_ONLY = new Set([
  'toilet', 'bathroom', 'bath', 'kitchen', 'bedroom', 'living', 'dining',
  'balcony', 'foyer', 'lobby', 'entrance', 'verandah', 'veranda', 'patio',
  'terrace', 'lawn', 'garden', 'green', 'passage', 'corridor', 'landing',
])

const BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]))

/**
 * The catalogue item a written label refers to, if any.
 *
 * `roomLabel` distinguishes a fixture from the room named after it — a label
 * reading TOILET inside a room called TOILET is the room, not a second WC.
 */
export function fromLabel(text: string, { isRoomLabel = false } = {}): Identification | null {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []

  const phraseId = ITEM_FOR_PHRASE[words.join(' ')]
  const phraseItem = phraseId ? BY_ID.get(phraseId) : undefined
  if (phraseItem) {
    return {
      item: phraseItem,
      evidence: 'labelled',
      confidence: 0.9,
      because: `the drawing says "${text.trim()}"`,
    }
  }

  for (const word of words) {
    if (isRoomLabel && ROOM_ONLY.has(word)) continue
    const id = ITEM_FOR_WORD[word]
    const item = id ? BY_ID.get(id) : undefined
    if (!item) continue

    return {
      item,
      evidence: 'labelled',
      confidence: 0.9,
      because: `the drawing says "${text.trim()}"`,
    }
  }
  return null
}

/**
 * The catalogue item a measured footprint most likely is.
 *
 * ── Why the room matters as much as the size ────────────────────────────────
 * A 2.0 x 1.6 m rectangle is a double bed in a bedroom, a dining table in a
 * dining room, and a rug in a living room. Size alone cannot separate those and
 * no amount of refining the tolerance will, because they genuinely are the same
 * size. What separates them is where the rectangle is, and the plan says that.
 *
 * So candidates are restricted to what belongs in the room first, and only then
 * ranked by fit. Without a room name the field is every floor-standing item,
 * and the confidence returned reflects that honestly.
 */
export function fromSize(
  width: number,
  depth: number,
  room: string | null,
): Identification | null {
  const long = Math.max(width, depth)
  const short = Math.min(width, depth)
  if (long <= 0.2 || long > 4) return null // smaller than a stool, larger than any single object

  const expected = room ? roomItems(room) : null
  const candidates = CATALOGUE.filter(
    (item) => item.placement === 'floor' && (!expected || expected.includes(item.id)),
  )

  let best: { item: CatalogueItem; error: number } | null = null
  for (const item of candidates) {
    const itemLong = Math.max(item.size.width, item.size.depth)
    const itemShort = Math.min(item.size.width, item.size.depth)

    // Compared in log space so being half the size counts the same as being
    // twice it. In linear space a small item can never be as wrong as a large
    // one, and the ranking quietly prefers whatever is biggest.
    const error =
      Math.abs(Math.log(long / itemLong)) + Math.abs(Math.log(short / itemShort))

    if (!best || error < best.error) best = { item, error }
  }

  // A total log error of 0.5 is roughly "within 30% on both sides". Past that
  // the nearest catalogue entry is not what was drawn, and saying nothing is
  // better than naming the least-wrong thing in the list.
  //
  // Held to a stricter standard with no room to narrow the field. A rectangle
  // measured against every floor-standing item in the catalogue will always
  // find something within 30%, and on a real plan that turned a 1.31 x 1.17 m
  // block in a walk-in into a two-seat sofa — a confident answer produced by
  // having nothing to rule anything out. Where the room is unknown the fit has
  // to be close enough that the size alone is genuinely distinctive.
  const tolerance = expected ? 0.5 : 0.25
  if (!best || best.error > tolerance) return null

  return {
    item: best.item,
    evidence: 'measured',
    // Without a room this is a weaker claim, and it says so. The review panel
    // sorts on evidence, but a user deciding whether to trust one row deserves
    // the difference between "a bed-sized rectangle in a bedroom" and "a
    // bed-sized rectangle somewhere".
    confidence: Math.max(0.35, (expected ? 0.75 : 0.5) - best.error),
    because:
      `it measures ${long.toFixed(2)} x ${short.toFixed(2)} m` +
      (room ? ` in the ${room.toLowerCase()}` : ', with no room to place it in'),
  }
}

/**
 * What a room of this kind normally contains.
 *
 * Used two ways: to narrow the field when identifying something that *was*
 * drawn, and to furnish a room where nothing was. The second is a guess and is
 * reported as one — `typical` evidence exists so the user can see at a glance
 * which items came off the drawing and which came off this table.
 *
 * Order matters. The first item is the one the room is arranged around, and the
 * placer puts it against the longest wall before anything else competes for the
 * space.
 */
export const ROOM_RECIPES: Record<string, string[]> = {
  bedroom: ['bed-queen', 'bedside', 'bedside', 'wardrobe'],
  master: ['bed-king', 'bedside', 'bedside', 'wardrobe'],
  guest: ['bed-single', 'bedside', 'wardrobe'],
  living: ['sofa-3', 'coffee-table', 'tv-unit', 'armchair'],
  drawing: ['sofa-3', 'coffee-table', 'tv-unit'],
  family: ['sofa-3', 'coffee-table', 'tv-unit'],
  lounge: ['sofa-3', 'coffee-table', 'armchair'],
  dining: ['dining-table-6', 'dining-chair', 'dining-chair', 'dining-chair', 'dining-chair'],
  kitchen: ['counter', 'sink-unit', 'hob', 'fridge'],
  pantry: ['counter', 'bookshelf'],
  study: ['desk', 'dining-chair', 'bookshelf'],
  office: ['desk', 'dining-chair', 'bookshelf'],
  toilet: ['wc', 'basin'],
  bathroom: ['wc', 'basin', 'bathtub'],
  bath: ['bathtub', 'basin'],
  shower: ['shower'],
  powder: ['wc', 'basin'],
  balcony: ['armchair', 'armchair', 'side-table'],
  sitout: ['armchair', 'armchair', 'side-table'],
  verandah: ['armchair', 'armchair', 'side-table'],
  veranda: ['armchair', 'armchair', 'side-table'],
  patio: ['armchair', 'armchair', 'side-table'],
  terrace: ['armchair', 'side-table'],
  foyer: ['side-table', 'mirror'],
  entrance: ['side-table'],
  lobby: ['sofa-2', 'side-table'],
  store: ['bookshelf'],
  storeroom: ['bookshelf'],
  utility: ['counter'],
  wardrobe: ['wardrobe'],
  walkin: ['wardrobe', 'wardrobe'],
}

/** The recipe for a room name, matching on any word in it. */
export function roomItems(room: string): string[] | null {
  for (const word of room.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ROOM_RECIPES[word]) return ROOM_RECIPES[word]
  }
  return null
}

/**
 * A CAD block, identified — falling back to the written-word vocabulary.
 *
 * ── Why there are two vocabularies and this is not duplication ──────────────
 * A DXF block is named by a draughtsman for a draughtsman: `3 ST SOFA`,
 * `SIG SF`, `N TAB`, `TLTW`, `D750`. Those are drafting shorthand and they are
 * handled where they arrive, in `cad.py`, because that is also where the
 * sized-opening convention (`D750` is a 750 mm door) has to be parsed.
 *
 * A label printed on a plan is written for a client to read: WARDROBE, SWING
 * CHAIR, LUGGAGE. Different convention, same catalogue.
 *
 * Neither list is a superset of the other, so a block the shorthand does not
 * recognise gets a second chance against the plain words — a drawing whose
 * blocks are simply called "Wardrobe" is common, and losing it to a table built
 * for abbreviations would be perverse. The reverse is not needed: nothing
 * writes `TLTW` on a plan for a human.
 */
export function identifyCadBlock(block: {
  name: string
  item?: string | null
}): Identification | null {
  if (block.item) {
    const known = BY_ID.get(block.item)
    if (known) {
      return {
        item: known,
        evidence: 'labelled',
        confidence: 0.95,
        because: `the drawing's block is called "${block.name}"`,
      }
    }
    // A mapping pointing at an id the catalogue no longer has. Falling through
    // rather than returning nothing, because the block name itself may still be
    // readable — and `catalogue drift` in the tests exists to make this loud.
  }
  return fromLabel(block.name)
}

/**
 * Identify one detected shape, using everything known about it.
 *
 * The order is the point: a label beats a measurement, and a measurement beats
 * an assumption. Each step is tried only when the one before it had nothing to
 * say, so the strongest available evidence always wins and the caller is told
 * which it was.
 */
export function identify(input: {
  label?: string | null
  width?: number
  depth?: number
  room?: string | null
}): Identification | null {
  if (input.label) {
    const named = fromLabel(input.label)
    if (named) return named
  }

  if (input.width && input.depth) {
    return fromSize(input.width, input.depth, input.room ?? null)
  }

  return null
}
