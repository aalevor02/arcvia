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
  'Appliances',
  'Bathroom',
  'Doors & windows',
  'Lighting',
  'Decor',
  'Outdoor',
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
    model: {
      url: '/models/sofa-3.glb',
      licence: 'CC Attribution 4.0',
      author: 'fafzie',
      source:
        'https://sketchfab.com/3d-models/sofa-three-seater-aa9d48102f894cb8b38df184bed8e92d',
      triangles: 1664,
      yaw: 180,
    },
  },
  {
    id: 'sofa-2',
    name: 'Sofa, 2 seat',
    category: 'Seating',
    placement: 'floor',
    size: { width: 1.5, depth: 0.9, height: 0.82 },
    shape: 'sofa',
    tone: 'fabric',
    model: {
      url: '/models/sofa-2.glb',
      licence: 'CC Attribution 4.0',
      author: 'Salehin Sajid',
      source:
        'https://sketchfab.com/3d-models/modern-sofa-set-134ed79242174c0897588b7360d59ac1',
      triangles: 5000,
    },
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'Seating',
    placement: 'floor',
    size: { width: 0.85, depth: 0.85, height: 0.82 },
    shape: 'sofa',
    tone: 'fabric',
    model: {
      url: '/models/armchair.glb',
      licence: 'CC Attribution 4.0',
      author: 'OLEKSO',
      source:
        'https://sketchfab.com/3d-models/macys-modern-accent-armchair-29201f422b9c417cb86225a16b0efad9',
      triangles: 3998,
    },
  },
  {
    id: 'dining-chair',
    name: 'Dining chair',
    category: 'Seating',
    placement: 'floor',
    size: { width: 0.45, depth: 0.5, height: 0.9 },
    shape: 'chair',
    tone: 'wood',
    model: {
      url: '/models/dining-chair.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'MadeByYeshe',
      source:
        'https://sketchfab.com/3d-models/wooden-dining-chair-61837ea5c8924eb0babc89e68c1dce66',
      triangles: 3000,
      yaw: 180,
    },
  },
  {
    id: 'bench',
    name: 'Bench',
    category: 'Seating',
    placement: 'floor',
    size: { width: 1.4, depth: 0.4, height: 0.45 },
    shape: 'box',
    tone: 'wood',
    model: {
      url: '/models/bench.glb',
      licence: 'CC Attribution 4.0',
      author: 'Hed1n',
      source:
        'https://sketchfab.com/3d-models/church-wooden-bench-seat-48cfb57f2dae4145ad556620e5cd6b8f',
      triangles: 4822,
    },
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
    model: {
      url: '/models/dining-table-6.glb',
      licence: 'CC Attribution 4.0',
      author: 'bezope',
      source:
        'https://sketchfab.com/3d-models/modern-wooden-dining-table-cb2e355c72464b5ea1d3b9e9d94b97f3',
      triangles: 1842,
      // Measured: its plan proportions match the slot only turned a quarter.
      yaw: 90,
    },
  },
  {
    id: 'dining-table-4',
    name: 'Dining table, 4 seat',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.2, depth: 0.8, height: 0.75 },
    shape: 'table',
    tone: 'wood',
    model: {
      url: '/models/dining-table-4.glb',
      licence: 'CC Attribution 4.0',
      author: 'KOREA HERITAGE SERVICE [KHS]',
      source:
        'https://sketchfab.com/3d-models/small-dining-table-31c5cc998f1043ebb16883cac05c49f3',
      triangles: 1212,
    },
  },
  {
    id: 'coffee-table',
    name: 'Coffee table',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.1, depth: 0.6, height: 0.42 },
    shape: 'table',
    tone: 'wood',
    model: {
      url: '/models/coffee-table.glb',
      licence: 'CC Attribution 4.0',
      author: 'm31odyr',
      source:
        'https://sketchfab.com/3d-models/wooden-coffee-table-fc8a0589c58b4016b4968ad743e8639d',
      triangles: 4632,
    },
  },
  {
    id: 'side-table',
    name: 'Side table',
    category: 'Tables',
    placement: 'floor',
    size: { width: 0.45, depth: 0.45, height: 0.55 },
    shape: 'table',
    tone: 'wood',
    model: {
      url: '/models/side-table.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'Rico Cilliers',
      source: 'https://polyhaven.com/a/side_table_01',
      triangles: 2756,
    },
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'Tables',
    placement: 'floor',
    size: { width: 1.4, depth: 0.7, height: 0.75 },
    shape: 'table',
    tone: 'wood',
    model: {
      url: '/models/desk.glb',
      licence: 'CC Attribution 4.0',
      author: 'bretzel44',
      source:
        'https://sketchfab.com/3d-models/desk-luxe-9c843e63770c44019fe33e065d17fcff',
      triangles: 5000,
    },
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
    model: {
      url: '/models/bed-king.glb',
      licence: 'CC Attribution 4.0',
      author: 'kane_sk06',
      source:
        'https://sketchfab.com/3d-models/large-king-size-bed-5cbdfeb2136849acb15ca8694ab16c72',
      triangles: 5000,
      yaw: 180,
      // A bed's slot is a real measurement, and width is the one dimension a
      // plan exists to check: under the uniform fit this king drew 0.91 m —
      // a single. Measured before/after in tools/measure-fit.mjs.
      fitFootprint: true,
    },
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
    model: {
      url: '/models/bed-queen.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'Francesco Coldesina',
      source:
        'https://sketchfab.com/3d-models/double-bed-c505ffffc1524865ba63af837346f1f7',
      triangles: 5000,
      yaw: 270,
      fitFootprint: true,
    },
  },
  {
    id: 'bed-single',
    name: 'Bed, single',
    category: 'Beds',
    placement: 'floor',
    size: { width: 0.91, depth: 1.9, height: 0.6 },
    shape: 'bed',
    tone: 'fabric',
    model: {
      url: '/models/bed-single.glb',
      licence: 'CC Attribution 4.0',
      author: 'rhcreations',
      source:
        'https://sketchfab.com/3d-models/single-bed-2-81ada0e24e1647d8a0d6d0708a696f84',
      triangles: 3554,
      fitFootprint: true,
    },
  },
  {
    id: 'bedside',
    name: 'Bedside table',
    category: 'Beds',
    placement: 'floor',
    size: { width: 0.45, depth: 0.4, height: 0.55 },
    shape: 'cabinet',
    tone: 'wood',
    model: {
      url: '/models/bedside.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'patriciu',
      source:
        'https://sketchfab.com/3d-models/bedside-table-ba32c03d924943c982ece9043e9ae9cb',
      triangles: 2000,
    },
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
    model: {
      url: '/models/wardrobe.glb',
      licence: 'CC Attribution 4.0',
      author: 'BraveShadingCreations',
      source:
        'https://sketchfab.com/3d-models/wardrobecloset-in-low-poly-ab04fc9439554f5c94fa33bc6bbdd230',
      triangles: 2876,
    },
  },
  {
    id: 'wardrobe-small',
    name: 'Wardrobe, single',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.6, height: 2.1 },
    shape: 'cabinet',
    tone: 'wood',
    model: {
      url: '/models/wardrobe-small.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'Joel.del.Val',
      source:
        'https://sketchfab.com/3d-models/small-wardrobe-6240391fb70c4759bcc8cb5915dfb8d2',
      triangles: 2040,
    },
  },
  {
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.32, height: 1.8 },
    shape: 'shelf',
    tone: 'wood',
    model: {
      url: '/models/bookshelf.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'Rico Cilliers',
      source: 'https://polyhaven.com/a/Shelf_01',
      triangles: 182,
    },
  },
  {
    id: 'tv-unit',
    name: 'TV unit',
    category: 'Storage',
    placement: 'floor',
    size: { width: 1.6, depth: 0.4, height: 0.5 },
    shape: 'cabinet',
    tone: 'wood',
    model: {
      url: '/models/tv-unit.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'Jorge Camacho',
      source: 'https://polyhaven.com/a/chinese_console_table',
      triangles: 6000,
    },
  },
  {
    id: 'chest',
    name: 'Chest of drawers',
    category: 'Storage',
    placement: 'floor',
    size: { width: 0.9, depth: 0.45, height: 0.85 },
    shape: 'cabinet',
    tone: 'wood',
    model: {
      url: '/models/chest.glb',
      licence: 'CC Attribution 4.0',
      author: 'Nathan Pedreño',
      source:
        'https://sketchfab.com/3d-models/chest-of-drawers-dresser-b73634a9b9724d4b8e2f68cc76f2c895',
      triangles: 1268,
    },
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
    model: {
      url: '/models/counter.glb',
      licence: 'CC Attribution 4.0',
      author: 'jimbogies',
      source:
        'https://sketchfab.com/3d-models/basic-kitchen-cabinets-and-counter-d2918a9d978144f38012973b28eea9f6',
      triangles: 5000,
      yaw: 270,
    },
  },
  {
    id: 'island',
    name: 'Kitchen island',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 1.8, depth: 0.9, height: 0.9 },
    shape: 'counter',
    tone: 'stone',
    model: {
      url: '/models/island.glb',
      licence: 'CC Attribution 4.0',
      author: 's_ebo_l',
      source:
        'https://sketchfab.com/3d-models/island-kitchen-f1fb9cfb220d4b04aeda6c4e33335ac5',
      triangles: 5000,
    },
  },
  {
    id: 'sink-unit',
    name: 'Sink unit',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 1.2, depth: 0.6, height: 0.9 },
    shape: 'sink',
    tone: 'metal',
    model: {
      url: '/models/sink-unit.glb',
      licence: 'CC Attribution 4.0',
      author: 'GrillPork',
      source:
        'https://sketchfab.com/3d-models/kitchen-cabinet-with-sink-a6792027730c4ac6bf13accc31f717f8',
      triangles: 1422,
      yaw: 180,
    },
  },
  {
    id: 'fridge',
    name: 'Fridge',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 0.7, depth: 0.7, height: 1.8 },
    shape: 'appliance',
    tone: 'metal',
    model: {
      url: '/models/fridge.glb',
      licence: 'CC Attribution 4.0',
      author: 're1monsen',
      source:
        'https://sketchfab.com/3d-models/heavy-duty-fridge-refrigerator-freezer-85d9e19e35bf4060a1cdb4cc132bcfa3',
      triangles: 5000,
    },
  },
  {
    id: 'hob',
    name: 'Hob & oven',
    category: 'Kitchen',
    placement: 'floor',
    size: { width: 0.6, depth: 0.6, height: 0.9 },
    shape: 'appliance',
    tone: 'metal',
    model: {
      url: '/models/hob.glb',
      licence: 'CC Attribution 4.0',
      author: 'keepiteasy',
      source:
        'https://sketchfab.com/3d-models/kitchen-stove-bc2003a5497a42c79c0c6097995a1971',
      triangles: 5000,
    },
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
    model: {
      url: '/models/overhead.glb',
      licence: 'CC Attribution 4.0',
      author: 'NRJohnson',
      source:
        'https://sketchfab.com/3d-models/kitchen-cabinets-east-wall-814d9a58e9a44288a37e78b5c3d3d776',
      triangles: 5000,
    },
  },

  // ---- Appliances ----------------------------------------------------------
  //
  // Added 2026-08-28 because a census of the catalogue found these missing
  // entirely rather than merely unfilled — and all three are in essentially
  // every Indian residential room this product will ever draw. A bedroom
  // rendered without a ceiling fan does not read as an Indian bedroom.
  //
  // Sizes are the standards, not round numbers: a ceiling fan is sold by its
  // SWEEP and 1200 mm is the domestic default; a split AC indoor unit is about
  // a metre of wall at high level; a front-load washer is the 600 mm cube the
  // plumbing is roughed in for.
  {
    id: 'ceiling-fan',
    name: 'Ceiling fan',
    category: 'Appliances',
    placement: 'ceiling',
    // Drop to the blades. Indian ceilings are typically 3.0–3.2 m and a fan
    // hangs on a downrod, which is why this is not flush like a ceiling light.
    mountHeight: 0.3,
    size: { width: 1.2, depth: 1.2, height: 0.35 },
    shape: 'pendant',
    tone: 'metal',
    note: '1200 mm sweep, the domestic standard',
    model: {
      url: '/models/ceiling-fan.glb',
      licence: 'CC Attribution 4.0',
      author: 'lucaboechat',
      source:
        'https://sketchfab.com/3d-models/ceiling-fan-7fe2a7dd27b2467da79c935a32de0eb2',
      triangles: 3926,
      fitFootprint: true,
    },
  },
  {
    id: 'ac-split',
    name: 'Air conditioner, split',
    category: 'Appliances',
    placement: 'wall',
    // High level, above door head. 2.1 m is the door, so the unit sits clear.
    mountHeight: 2.2,
    size: { width: 1.0, depth: 0.22, height: 0.3 },
    shape: 'box',
    tone: 'white',
    model: {
      url: '/models/ac-split.glb',
      licence: 'CC Attribution 4.0',
      author: 'Auspicious Art and Graphics (AAG)',
      source:
        'https://sketchfab.com/3d-models/ac-air-conditioner-7d6b5831b43546c0ac82b878a78f8434',
      triangles: 3808,
      fitFootprint: true,
      // The author modelled the unit running along its own Y rather than X, so
      // it was conditioned in that orientation — scaling it into a
      // width-major box would have produced a 5 cm air conditioner, since the
      // fit is uniform and the wrong axis binds. A quarter turn puts its face
      // into the room.
      yaw: 90,
    },
  },
  {
    id: 'washing-machine',
    name: 'Washing machine',
    category: 'Appliances',
    placement: 'floor',
    size: { width: 0.6, depth: 0.6, height: 0.85 },
    shape: 'appliance',
    tone: 'white',
    model: {
      url: '/models/washing-machine.glb',
      licence: 'CC Attribution 4.0',
      author: 'sixpence',
      source:
        'https://sketchfab.com/3d-models/washing-machine-4949ac257c7848c7a6c9149218ecfaae',
      triangles: 3390,
      fitFootprint: true,
    },
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
    model: {
      url: '/models/wc.glb',
      licence: 'CC Attribution 4.0',
      author: 'Ekbercg',
      source:
        'https://sketchfab.com/3d-models/toilet-2b7d5c96159c42589dd970d81e877668',
      triangles: 4999,
      yaw: 270,
    },
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
    model: {
      url: '/models/basin.glb',
      licence: 'CC Attribution-ShareAlike 4.0',
      author: 'Yaiyeondurising',
      source:
        'https://sketchfab.com/3d-models/memoirs-washbasinsink-579df71336a9493f8f52ddc815d2fc39',
      triangles: 4999,
      // Measured: its plan proportions match the slot only turned a quarter.
      yaw: 90,
    },
  },
  {
    id: 'bathtub',
    name: 'Bathtub',
    category: 'Bathroom',
    placement: 'floor',
    size: { width: 1.7, depth: 0.75, height: 0.55 },
    shape: 'tub',
    tone: 'white',
    model: {
      url: '/models/bathtub.glb',
      licence: 'CC Attribution 4.0',
      author: '3ddominator',
      source:
        'https://sketchfab.com/3d-models/bathtub-3350f81025974c53808a2efd2b31d4fd',
      triangles: 5000,
    },
  },
  {
    id: 'shower',
    name: 'Shower enclosure',
    category: 'Bathroom',
    placement: 'floor',
    size: { width: 0.9, depth: 0.9, height: 2.0 },
    shape: 'shower',
    tone: 'glass',
    model: {
      url: '/models/shower.glb',
      licence: 'CC Attribution 4.0',
      author: 'allenbranch',
      source:
        'https://sketchfab.com/3d-models/dream-line-french-corner-shower-enclosure-c48c05b0877a4ebf89ca92615519640c',
      triangles: 414,
    },
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
    model: {
      url: '/models/ceiling-light.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'Mark Peters',
      source:
        'https://sketchfab.com/3d-models/bar-ceiling-light-2048px2-2ba27702aabe4d37822956a2b7bf43d8',
      triangles: 1500,
    },
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
    model: {
      url: '/models/pendant.glb',
      licence: 'CC Attribution 4.0',
      author: 'LowKenEn',
      source:
        'https://sketchfab.com/3d-models/ikea-hektar-pendant-lamp-58e6e6f5fb7447489c1a8f3c6dd5f7ec',
      triangles: 1499,
    },
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
    model: {
      url: '/models/wall-light.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'dibyaranjanswain.42005',
      source:
        'https://sketchfab.com/3d-models/art-deco-wall-sconce-light-3eb947de8c9246debdef3ce43cd5ffcf',
      triangles: 1860,
    },
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
    // Twelve faces, and the texture is the whole object — which is the right
    // shape for a rug and the reason the popular results were unusable: ranked
    // by likes they are photogrammetry scans at 600,000 triangles for something
    // that is geometrically a rectangle.
    model: {
      url: '/models/rug.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'ChoboiAssets',
      source: 'https://sketchfab.com/3d-models/persian-carpet-4592468c03784f0d895876ec670de1cd',
      triangles: 12,
    },
  },
  {
    id: 'plant',
    name: 'Plant',
    category: 'Decor',
    placement: 'floor',
    size: { width: 0.55, depth: 0.55, height: 1.3 },
    shape: 'plant',
    tone: 'plant',
    model: {
      url: '/models/plant.glb',
      licence: 'CC Attribution 4.0',
      author: 'ouadierifi',
      source:
        'https://sketchfab.com/3d-models/bird-of-paradise-plant-potted-indoor-plant-63355803f8ec4f4e84ebae2fb7d7265a',
      triangles: 4000,
    },
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
    model: {
      url: '/models/tv.glb',
      licence: 'CC Attribution 4.0',
      author: 'HippoStance',
      source:
        'https://sketchfab.com/3d-models/flat-screen-television-f90d4fb91dd34b6791e8d66d00f96591',
      triangles: 1499,
    },
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
    model: {
      url: '/models/painting.glb',
      licence: 'CC Attribution 4.0',
      author: 'Palmart Productions',
      source:
        'https://sketchfab.com/3d-models/framed-picture-for-halloween-ad676fd8116f42e5acd2a5f580f74998',
      triangles: 624,
    },
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
    model: {
      url: '/models/mirror.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'arch.lxt',
      source:
        'https://sketchfab.com/3d-models/classic-oval-wall-frame-61fd4acfd95f40efa2627a2c7ee6746f',
      triangles: 1967,
    },
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
    model: {
      url: '/models/curtain.glb',
      // Measured: its own proportions match the catalogue only when Z is up.
      upAxis: 'z',
      licence: 'CC Attribution 4.0',
      author: 'Tesnime Ben Salah',
      source:
        'https://sketchfab.com/3d-models/curtains-3d-model-window-drapes-9056923c75684d9285e94f110d2c8a88',
      triangles: 2000,
    },
  },
  // ---- Outdoor -------------------------------------------------------------
  //
  // ── Why a residential tool needs these at all ─────────────────────────────
  // More than half the site on the villa this engine was measured against is
  // outdoor: 125.11 m² indoor against 127.64 m² of lawn, pool, patio and
  // balcony. Until now the catalogue could furnish the smaller half and nothing
  // could be placed on the larger one.
  //
  // Sizes are real. A lap pool is 12 m because that is what people build; a
  // parasol is 2.7 m across because that is the common size; a lounger is
  // 1.98 m long because a person is.
  {
    id: 'pool',
    name: 'Swimming pool',
    category: 'Outdoor',
    placement: 'floor',
    // 8 × 4 is the commonest private pool. `height` is the DEPTH of the tank,
    // and 1.4 m is a standard constant-depth domestic pool — deep enough to
    // swim, shallow enough to stand in, which is why it is the default built.
    size: { width: 8, depth: 4, height: 1.4 },
    shape: 'pool',
    tone: 'water',
    note: 'Height is the depth of the tank. Lay paving around it, not under it — a slab across the top hides the water.',
  },
  {
    id: 'pool-plunge',
    name: 'Plunge pool',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 4, depth: 2.4, height: 1.25 },
    shape: 'pool',
    tone: 'water',
    note: 'For a courtyard or a terrace. Lay paving around it, not under it.',
  },
  {
    id: 'pool-lap',
    name: 'Lap pool',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 12, depth: 2.5, height: 1.35 },
    shape: 'pool',
    tone: 'water',
    note: 'Long and narrow, for swimming rather than sitting in. Lay paving around it, not under it.',
  },
  {
    id: 'deck',
    name: 'Timber deck',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 4, depth: 3, height: 0.12 },
    shape: 'slab',
    tone: 'wood',
  },
  {
    id: 'paving',
    name: 'Paved terrace',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 5, depth: 4, height: 0.06 },
    shape: 'slab',
    tone: 'paving',
  },
  {
    id: 'lawn',
    name: 'Lawn',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 8, depth: 6, height: 0.04 },
    shape: 'slab',
    tone: 'grass',
    note: 'A planted area. Drop it under a pool or a terrace to show the setting.',
  },
  {
    id: 'tree',
    name: 'Tree',
    category: 'Outdoor',
    placement: 'floor',
    // A semi-mature garden tree: 4.5 m crown, 6 m tall. Big enough to shade a
    // terrace, which is the question anybody placing one is asking.
    size: { width: 4.5, depth: 4.5, height: 6 },
    shape: 'tree',
    tone: 'plant',
    model: {
      url: '/models/tree.glb',
      licence: 'CC Attribution 4.0',
      author: 'Daniel',
      source:
        'https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc',
      triangles: 9000,
      yaw: 180,
    },
  },
  {
    id: 'tree-small',
    name: 'Ornamental tree',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 2.4, depth: 2.4, height: 3.2 },
    shape: 'tree',
    tone: 'plant',
  },
  {
    id: 'hedge',
    name: 'Hedge',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 3, depth: 0.6, height: 1.5 },
    shape: 'hedge',
    tone: 'plant',
    note: 'Stretch it along a boundary. 1.5 m screens a seated terrace.',
  },
  {
    id: 'shrub',
    name: 'Shrub',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 0.9, depth: 0.9, height: 0.8 },
    shape: 'hedge',
    tone: 'plant',
    model: {
      url: '/models/shrub.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'Rico Cilliers',
      source:
        'https://polyhaven.com/a/shrub_03',
      triangles: 2999,
      yaw: 270,
    },
  },
  {
    id: 'planter-outdoor',
    name: 'Planter',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 0.9, depth: 0.45, height: 1.1 },
    shape: 'planter',
    tone: 'stone',
    model: {
      url: '/models/planter-outdoor.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'The Base Mesh',
      source:
        'https://www.thebasemesh.com/asset/concrete-round-planter',
      triangles: 2712,
    },
  },
  {
    id: 'lounger',
    name: 'Sun lounger',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 0.7, depth: 1.98, height: 0.62 },
    shape: 'lounger',
    tone: 'fabric',
    model: {
      url: '/models/lounger.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'The Base Mesh',
      source:
        'https://www.thebasemesh.com/asset/deck-chair',
      triangles: 1978,
    },
  },
  {
    id: 'parasol',
    name: 'Parasol',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 2.7, depth: 2.7, height: 2.4 },
    shape: 'parasol',
    tone: 'fabric',
    model: {
      url: '/models/parasol.glb',
      licence: 'CC Attribution 4.0',
      author: 'k3v1nc0',
      source:
        'https://sketchfab.com/3d-models/floating-parasol-sunshade-patio-umbrella-280a65bca20b425e96617b0dd78cce21',
      triangles: 2500,
    },
  },
  {
    id: 'pergola',
    name: 'Pergola',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 4, depth: 3, height: 2.4 },
    shape: 'pergola',
    tone: 'wood',
    note: 'Slatted, so it casts the striped shade that is the point of building one.',
    model: {
      url: '/models/pergola.glb',
      licence: 'CC Attribution 4.0',
      author: 'DELTAHEDRA',
      source:
        'https://sketchfab.com/3d-models/wooden-garden-pergola-93f03897386d48f798f88e529555f665',
      triangles: 6935,
    },
  },
  {
    id: 'fence',
    name: 'Fence',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 3, depth: 0.1, height: 1.8 },
    shape: 'fence',
    tone: 'wood',
    model: {
      url: '/models/fence.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'The Base Mesh',
      source:
        'https://www.thebasemesh.com/asset/rounded-picket-fence',
      triangles: 498,
    },
  },
  {
    id: 'outdoor-table',
    name: 'Outdoor dining table',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 1.8, depth: 0.9, height: 0.75 },
    shape: 'table',
    tone: 'wood',
    model: {
      url: '/models/outdoor-table.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'The Base Mesh',
      source:
        'https://www.thebasemesh.com/asset/picnic-table-01',
      triangles: 532,
    },
  },
  {
    id: 'outdoor-chair',
    name: 'Outdoor chair',
    category: 'Outdoor',
    placement: 'floor',
    size: { width: 0.55, depth: 0.56, height: 0.85 },
    shape: 'chair',
    tone: 'wood',
    model: {
      url: '/models/outdoor-chair.glb',
      licence: 'CC0 1.0 Public Domain',
      author: 'The Base Mesh',
      source:
        'https://www.thebasemesh.com/asset/folding-chair-01',
      triangles: 2340,
    },
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
