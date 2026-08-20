import type { CatalogueItem } from './types'

/**
 * The catalogue.
 *
 * ── Where the dimensions come from ──────────────────────────────────────────
 * These are real furniture sizes, not round numbers. A three-seat sofa is
 * 2.1 m, not 2; an internal door is 0.9 × 2.1 m because that is the standard
 * leaf; a WC pan projects 700 mm. Getting these right is most of the value of
 * the catalogue — the whole point of putting a sofa in a plan is to find out
 * whether it fits, and it cannot answer that if it is 2 m because 2 is tidy.
 *
 * Indian residential practice where it differs, since that is the market this
 * is built for: 900 mm internal doors, 1050 mm main doors, 750 mm counter
 * depth.
 */

export const CATEGORIES = [
  'Seating',
  'Tables',
  'Beds',
  'Storage',
  'Kitchen',
  'Bathroom',
  'Doors & windows',
  'Lighting',
  'Decor',
] as const

export const CATALOGUE: CatalogueItem[] = [
  // ---- Seating -------------------------------------------------------------
  {
    id: 'sofa-3',
    name: 'Sofa, 3 seat',
    category: 'Seating',
    placement: 'floor',
    size: { width: 2.1, depth: 0.9, height: 0.82 },
    shape: 'sofa',
    tone: 'fabric',
  },
  {
    id: 'sofa-2',
    name: 'Sofa, 2 seat',
    category: 'Seating',
    placement: 'floor',
    size: { width: 1.5, depth: 0.9, height: 0.82 },
    shape: 'sofa',
    tone: 'fabric',
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'Seating',
    placement: 'floor',
    size: { width: 0.85, depth: 0.85, height: 0.82 },
    shape: 'sofa',
    tone: 'fabric',
  },
  {
    id: 'dining-chair',
    name: 'Dining chair',
    category: 'Seating',
    placement: 'floor',
    size: { width: 0.45, depth: 0.5, height: 0.9 },
    shape: 'chair',
    tone: 'wood',
  },
  {
    id: 'bench',
    name: 'Bench',
    category: 'Seating',
    placement: 'floor',
    size: { width: 1.4, depth: 0.4, height: 0.45 },
    shape: 'box',
    tone: 'wood',
  },

  // ---- Tables --------------------------------------------------------------
  {
    id: 'dining-table-6',
    name: 'Dining table, 6 seat',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.8, depth: 0.9, height: 0.75 },
    shape: 'table',
    tone: 'wood',
  },
  {
    id: 'dining-table-4',
    name: 'Dining table, 4 seat',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.2, depth: 0.8, height: 0.75 },
    shape: 'table',
    tone: 'wood',
  },
  {
    id: 'coffee-table',
    name: 'Coffee table',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.1, depth: 0.6, height: 0.42 },
    shape: 'table',
    tone: 'wood',
  },
  {
    id: 'side-table',
    name: 'Side table',
    category: 'Tables',
    placement: 'floor',
    size: { width: 0.45, depth: 0.45, height: 0.55 },
    shape: 'table',
    tone: 'wood',
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.4, depth: 0.7, height: 0.75 },
    shape: 'table',
    tone: 'wood',
  },

  // ---- Beds ----------------------------------------------------------------
  {
    id: 'bed-king',
    name: 'Bed, king',
    category: 'Beds',
    placement: 'floor',
    size: { width: 1.83, depth: 2.03, height: 0.6 },
    shape: 'bed',
    tone: 'fabric',
    note: '6ft × 6ft8in',
  },
  {
    id: 'bed-queen',
    name: 'Bed, queen',
    category: 'Beds',
    placement: 'floor',
    size: { width: 1.52, depth: 2.03, height: 0.6 },
    shape: 'bed',
    tone: 'fabric',
    note: '5ft × 6ft8in',
  },
  {
    id: 'bed-single',
    name: 'Bed, single',
    category: 'Beds',
    placement: 'floor',
    size: { width: 0.91, depth: 1.9, height: 0.6 },
    shape: 'bed',
    tone: 'fabric',
  },
  {
    id: 'bedside',
    name: 'Bedside table',
    category: 'Beds',
    placement: 'floor',
    size: { width: 0.45, depth: 0.4, height: 0.55 },
    shape: 'cabinet',
    tone: 'wood',
  },

  // ---- Storage -------------------------------------------------------------
  {
    id: 'wardrobe',
    name: 'Wardrobe',
    category: 'Storage',
    placement: 'floor',
    size: { width: 1.8, depth: 0.6, height: 2.1 },
    shape: 'cabinet',
    tone: 'wood',
  },
  {
    id: 'wardrobe-small',
    name: 'Wardrobe, single',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.6, height: 2.1 },
    shape: 'cabinet',
    tone: 'wood',
  },
  {
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.32, height: 1.8 },
    shape: 'shelf',
    tone: 'wood',
  },
  {
    id: 'tv-unit',
    name: 'TV unit',
    category: 'Storage',
    placement: 'floor',
    size: { width: 1.6, depth: 0.4, height: 0.5 },
    shape: 'cabinet',
    tone: 'wood',
  },
  {
    id: 'chest',
    name: 'Chest of drawers',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.45, height: 0.85 },
    shape: 'cabinet',
    tone: 'wood',
  },

  // ---- Kitchen -------------------------------------------------------------
  {
    id: 'counter',
    name: 'Kitchen counter',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 2.4, depth: 0.6, height: 0.9 },
    shape: 'counter',
    tone: 'stone',
    note: '600 mm deep, 900 mm high',
  },
  {
    id: 'island',
    name: 'Kitchen island',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 1.8, depth: 0.9, height: 0.9 },
    shape: 'counter',
    tone: 'stone',
  },
  {
    id: 'sink-unit',
    name: 'Sink unit',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 1.2, depth: 0.6, height: 0.9 },
    shape: 'sink',
    tone: 'metal',
  },
  {
    id: 'fridge',
    name: 'Fridge',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 0.7, depth: 0.7, height: 1.8 },
    shape: 'appliance',
    tone: 'metal',
  },
  {
    id: 'hob',
    name: 'Hob & oven',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 0.6, depth: 0.6, height: 0.9 },
    shape: 'appliance',
    tone: 'metal',
  },
  {
    id: 'overhead',
    name: 'Overhead units',
    category: 'Kitchen',
    placement: 'wall',
    size: { width: 1.8, depth: 0.35, height: 0.7 },
    mountHeight: 1.45,
    shape: 'box',
    tone: 'wood',
  },

  // ---- Bathroom ------------------------------------------------------------
  {
    id: 'wc',
    name: 'WC',
    category: 'Bathroom',
    placement: 'floor',
    size: { width: 0.38, depth: 0.7, height: 0.78 },
    shape: 'wc',
    tone: 'white',
  },
  {
    id: 'basin',
    name: 'Wash basin',
    category: 'Bathroom',
    placement: 'wall',
    size: { width: 0.6, depth: 0.45, height: 0.2 },
    mountHeight: 0.8,
    shape: 'basin',
    tone: 'white',
  },
  {
    id: 'bathtub',
    name: 'Bathtub',
    category: 'Bathroom',
    placement: 'floor',
    size: { width: 1.7, depth: 0.75, height: 0.55 },
    shape: 'tub',
    tone: 'white',
  },
  {
    id: 'shower',
    name: 'Shower enclosure',
    category: 'Bathroom',
    placement: 'floor',
    size: { width: 0.9, depth: 0.9, height: 2.0 },
    shape: 'shower',
    tone: 'glass',
  },

  // ---- Doors & windows -----------------------------------------------------
  // These cut the wall they sit in — see `in-wall` in types.ts.
  {
    id: 'door',
    name: 'Door',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 0.9, depth: 0.05, height: 2.1 },
    shape: 'door',
    tone: 'wood',
    note: 'Standard internal leaf',
  },
  {
    id: 'door-main',
    name: 'Main door',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.05, depth: 0.05, height: 2.1 },
    shape: 'door',
    tone: 'wood',
  },
  {
    id: 'door-double',
    name: 'Double door',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.5, depth: 0.05, height: 2.1 },
    shape: 'door-double',
    tone: 'wood',
  },
  {
    id: 'door-sliding',
    name: 'Sliding door',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.8, depth: 0.05, height: 2.1 },
    shape: 'window',
    tone: 'glass',
  },
  {
    id: 'window',
    name: 'Window',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.2, depth: 0.05, height: 1.2 },
    mountHeight: 0.9,
    shape: 'window',
    tone: 'glass',
    note: '900 mm sill',
  },
  {
    id: 'window-wide',
    name: 'Window, wide',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 2.1, depth: 0.05, height: 1.2 },
    mountHeight: 0.9,
    shape: 'window',
    tone: 'glass',
  },
  {
    id: 'window-full',
    name: 'Full-height glazing',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.8, depth: 0.05, height: 2.1 },
    shape: 'window',
    tone: 'glass',
  },
  {
    id: 'opening',
    name: 'Opening',
    category: 'Doors & windows',
    placement: 'in-wall',
    size: { width: 1.0, depth: 0.05, height: 2.1 },
    shape: 'opening',
    note: 'A hole with nothing in it',
  },

  // ---- Lighting ------------------------------------------------------------
  {
    id: 'ceiling-light',
    name: 'Ceiling light',
    category: 'Lighting',
    placement: 'ceiling',
    size: { width: 0.4, depth: 0.4, height: 0.08 },
    mountHeight: 0,
    shape: 'ceiling-light',
    tone: 'white',
  },
  {
    id: 'pendant',
    name: 'Pendant',
    category: 'Lighting',
    placement: 'ceiling',
    size: { width: 0.32, depth: 0.32, height: 0.3 },
    mountHeight: 0.7,
    shape: 'pendant',
    tone: 'metal',
    note: 'Drops 700 mm',
  },
  {
    id: 'wall-light',
    name: 'Wall light',
    category: 'Lighting',
    placement: 'wall',
    size: { width: 0.16, depth: 0.14, height: 0.24 },
    mountHeight: 1.8,
    shape: 'box',
    tone: 'metal',
  },

  // ---- Decor ---------------------------------------------------------------
  {
    id: 'rug',
    name: 'Rug',
    category: 'Decor',
    placement: 'floor',
    size: { width: 2.4, depth: 1.7, height: 0.012 },
    shape: 'rug',
    tone: 'fabric',
  },
  {
    id: 'plant',
    name: 'Plant',
    category: 'Decor',
    placement: 'floor',
    size: { width: 0.55, depth: 0.55, height: 1.3 },
    shape: 'plant',
    tone: 'plant',
  },
  {
    id: 'tv',
    name: 'Television',
    category: 'Decor',
    placement: 'wall',
    size: { width: 1.25, depth: 0.07, height: 0.72 },
    mountHeight: 1.0,
    shape: 'panel',
    tone: 'metal',
    note: '55 inch',
  },
  {
    id: 'painting',
    name: 'Painting',
    category: 'Decor',
    placement: 'wall',
    size: { width: 0.9, depth: 0.05, height: 0.7 },
    mountHeight: 1.45,
    shape: 'panel',
    tone: 'wood',
  },
  {
    id: 'mirror',
    name: 'Mirror',
    category: 'Decor',
    placement: 'wall',
    size: { width: 0.7, depth: 0.04, height: 1.0 },
    mountHeight: 1.1,
    shape: 'panel',
    tone: 'glass',
  },
  {
    id: 'curtain',
    name: 'Curtains',
    category: 'Decor',
    placement: 'wall',
    size: { width: 2.0, depth: 0.12, height: 2.3 },
    mountHeight: 0.05,
    shape: 'curtain',
    tone: 'fabric',
  },
]

const BY_ID = new Map(CATALOGUE.map((item) => [item.id, item]))

export const itemById = (id: string): CatalogueItem | undefined => BY_ID.get(id)

/**
 * Filter by category and a free-text query, for the picker.
 *
 * ── Why this ranks rather than just filters ─────────────────────────────────
 * The first version matched name, category and note equally and returned
 * catalogue order. Typing "window" then returned **Door** first, because the
 * door's category is "Doors & windows" — so the top hit for a search was an
 * item whose name does not contain the search term at all. Anyone clicking the
 * first result, which is what people do, placed the wrong thing.
 *
 * Ranking fixes it without narrowing what is findable: a name match always
 * beats a category match, and an item whose name *starts* with the query beats
 * one that merely contains it.
 */
export function searchCatalogue(query: string, category?: string): CatalogueItem[] {
  const needle = query.trim().toLowerCase()
  const inCategory = (item: CatalogueItem) => !category || item.category === category

  if (!needle) return CATALOGUE.filter(inCategory)

  const scored: { item: CatalogueItem; score: number }[] = []

  for (const item of CATALOGUE) {
    if (!inCategory(item)) continue

    const name = item.name.toLowerCase()
    let score = 0

    if (name === needle) score = 100
    else if (name.startsWith(needle)) score = 80
    else if (name.includes(needle)) score = 60
    else if ((item.note ?? '').toLowerCase().includes(needle)) score = 30
    else if (item.category.toLowerCase().includes(needle)) score = 10

    if (score > 0) scored.push({ item, score })
  }

  // Stable within a score band, so catalogue order still decides ties — which
  // keeps "Sofa, 3 seat" above "Sofa, 2 seat" rather than shuffling per keystroke.
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

/** Items that cut a hole in the wall they are placed in. */
export const isOpening = (item: CatalogueItem): boolean => item.placement === 'in-wall'
