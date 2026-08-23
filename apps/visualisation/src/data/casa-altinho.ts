import type { Project, Unit } from '../types'

/**
 * Casa Altinho, Saipem, Goa.
 *
 * Every figure here is transcribed from the developer's own drawing set and
 * brochure — the type-sheet area tables, the room dimension callouts on the
 * five plan sheets, and the site plan. Nothing is estimated. Where a drawing
 * labels a space with a dimension but no name, it is listed unnamed rather
 * than guessed at.
 */

/**
 * Site plan hotspots.
 *
 * Percentages, not pixels — the plan scales to fit whatever width the page
 * gives it, and pixel coordinates captured at one size are wrong at every
 * other. Read off the 2400x1200 plan render against a 5% grid.
 *
 * Row A sits at a slight angle to the rest of the site, so those four-point
 * polygons are tilted rather than axis-aligned.
 */
const units: Unit[] = [
  // --- Row A: against the western boundary, angled with the access road ----
  { code: 'A3', typeId: 'ce', row: 'A', status: 'available', facing: 'West',
    polygon: [[15.8, 25.6], [26.6, 24.4], [26.8, 33.6], [16.0, 34.8]] },
  { code: 'A2', typeId: 'ce', row: 'A', status: 'available', facing: 'West',
    polygon: [[15.9, 36.2], [26.7, 35.0], [26.9, 44.4], [16.1, 45.6]] },
  { code: 'A1', typeId: 'a1', row: 'A', status: 'available', facing: 'West',
    polygon: [[16.0, 47.2], [26.8, 46.0], [27.0, 57.4], [16.2, 58.6]] },

  // --- Row B --------------------------------------------------------------
  { code: 'B4', typeId: 'bd', row: 'B', status: 'available', facing: 'East',
    polygon: [[29.4, 24.4], [39.0, 24.4], [39.0, 34.2], [29.4, 34.2]] },
  { code: 'B3', typeId: 'bd', row: 'B', status: 'available', facing: 'East',
    polygon: [[29.4, 35.0], [39.0, 35.0], [39.0, 45.2], [29.4, 45.2]] },
  { code: 'B2', typeId: 'bd', row: 'B', status: 'available', facing: 'East',
    polygon: [[29.4, 46.0], [39.0, 46.0], [39.0, 56.4], [29.4, 56.4]] },
  { code: 'B1', typeId: 'b1', row: 'B', status: 'available', facing: 'East',
    polygon: [[29.4, 57.2], [39.0, 57.2], [39.0, 68.0], [29.4, 68.0]] },

  // --- Row C --------------------------------------------------------------
  { code: 'C4', typeId: 'ce', row: 'C', status: 'available', facing: 'East',
    polygon: [[43.4, 22.4], [53.2, 22.4], [53.2, 32.8], [43.4, 32.8]] },
  { code: 'C3', typeId: 'ce', row: 'C', status: 'available', facing: 'East',
    polygon: [[43.4, 33.4], [53.2, 33.4], [53.2, 44.0], [43.4, 44.0]] },
  { code: 'C2', typeId: 'ce', row: 'C', status: 'available', facing: 'East',
    polygon: [[43.4, 44.8], [53.2, 44.8], [53.2, 55.8], [43.4, 55.8]] },
  { code: 'C1', typeId: 'ce', row: 'C', status: 'available', facing: 'East',
    polygon: [[43.4, 56.4], [53.2, 56.4], [53.2, 68.0], [43.4, 68.0]] },

  // --- Row D --------------------------------------------------------------
  { code: 'D5', typeId: 'bd', row: 'D', status: 'available', facing: 'East',
    polygon: [[60.4, 21.0], [70.2, 21.0], [70.2, 31.8], [60.4, 31.8]] },
  { code: 'D4', typeId: 'bd', row: 'D', status: 'available', facing: 'East',
    polygon: [[60.4, 32.4], [70.2, 32.4], [70.2, 43.0], [60.4, 43.0]] },
  { code: 'D3', typeId: 'bd', row: 'D', status: 'available', facing: 'East',
    polygon: [[60.4, 43.6], [70.2, 43.6], [70.2, 54.0], [60.4, 54.0]] },
  { code: 'D2', typeId: 'bd', row: 'D', status: 'available', facing: 'East',
    polygon: [[60.4, 54.6], [70.2, 54.6], [70.2, 65.0], [60.4, 65.0]] },
  { code: 'D1', typeId: 'bd', row: 'D', status: 'available', facing: 'East',
    polygon: [[60.4, 65.6], [70.2, 65.6], [70.2, 77.0], [60.4, 77.0]] },

  // --- Row E: the river-facing edge, E1 is the corner plot -----------------
  { code: 'E3', typeId: 'ce', row: 'E', status: 'available', facing: 'North-east',
    polygon: [[73.4, 21.0], [84.2, 21.0], [84.2, 32.0], [73.4, 32.0]] },
  { code: 'E2', typeId: 'ce', row: 'E', status: 'available', facing: 'East',
    polygon: [[73.4, 32.8], [84.2, 32.8], [84.2, 44.0], [73.4, 44.0]] },
  { code: 'E1', typeId: 'e1', row: 'E', status: 'available', facing: 'South-east',
    polygon: [[73.4, 44.8], [84.2, 44.8], [84.2, 68.4], [73.4, 68.4]] },
]

export const casaAltinho: Project = {
  slug: 'casa-altinho',
  name: 'Casa Altinho',
  script: 'Casa',
  place: 'Saipem, Goa',
  developer: 'Fair Green Ventures',
  developerNote: 'A project by',
  tagline: 'An Epitome of Luxury',
  rera: 'PRGO05232004',
  architect: "Melville D'Souza",

  intro: {
    heading: 'Nineteen villas above the Nerul river',
    body: [
      'Elegant villa projects nestled amidst the enchanting landscapes of Saipem, Goa. Discover a harmonious blend of opulence, tranquillity, and the vibrant coastal charm that defines the essence of living in this tropical paradise.',
      'Overlooking the scenic vistas of the azure river and pristine coastline lies this perfect coastal Goan gateway.',
    ],
  },

  sections: [
    {
      id: 'pools',
      kicker: 'The rooftop level',
      heading: 'Endless & extravagant views of the Nerul river from the infinity pools',
      image: 'renders/villa-a1-aerial.webp',
      body: [
        'Imagine settling in, underneath a translucent ceiling surrounded by green palms and unparalleled views of the star-studded sky. Nestled amidst lush greens and the backwaters of Saipem in Goa, Casa Altinho’s magnificence brings your dreams to life.',
        'Enjoy post-card perfect views from the various seating areas in the villa, framed by the high ceiling in the living room which folds open to an eye-level view of the magnificent infinity swimming pool.',
      ],
    },
    {
      id: 'home',
      kicker: "Amidst nature's eternal grandeur",
      heading: 'We are home',
      image: 'renders/villa-b-garden.webp',
      body: [
        'Our exclusive collection of luxurious villas at Casa Altinho promises an unparalleled lifestyle for those seeking the ultimate in sophistication and leisure.',
        'Every nook and corner of this charming abode offers a spectacular view. The outdoor private infinity pool with an adjoining deck is the perfect place to unwind while also enjoying a mesmerising view of the Nerul river.',
      ],
    },
    {
      id: 'landscape',
      kicker: 'Spaces that reflect',
      heading: 'Peace & freedom',
      image: 'renders/garden.webp',
      body: [
        'Well laid out open spaces ensure a clutter free living. The garden space is designed in consultation with reputed landscape consultants, and comprises water bodies, lush lawns, sitting areas, pathways and gardens adorned by flowering shrubs which bring harmony between the structure and nature.',
        'The lush green lawn that is enveloped in a canopy of palm trees is a great place to enjoy early morning strolls.',
      ],
    },
  ],

  stats: [
    { label: 'Villas', value: '19' },
    { label: 'Configurations', value: '5' },
    { label: 'Levels per villa', value: '4' },
    { label: 'Largest villa', value: '631.64 m²' },
    { label: 'Private pool', value: 'Every unit' },
    { label: 'Lift', value: 'Every unit' },
  ],

  sitePlan: {
    image: 'site/siteplan.webp',
    imageSmall: 'site/siteplan-sm.webp',
    units,
    labels: [
      { text: 'Gate', x: 16.5, y: 19.0 },
      { text: 'Space for service', x: 58.5, y: 18.8 },
      { text: 'Open space', x: 87.5, y: 28.0 },
    ],
  },

  villaTypes: [
    // ---------------------------------------------------------------- A-1 --
    {
      id: 'a1',
      name: 'Villa A-1',
      appliesTo: ['A1'],
      sbua: 417.99,
      summary:
        'The single A-type villa, at the head of the western row. Two bedrooms below a double-height verandah, an open stilt family lounge, and living, kitchen and pool stacked on the top level.',
      renders: ['villa-a1-aerial', 'villa-a-street', 'villa-a-living', 'villa-a-rear'],
      /**
       * Generated from the architect's 2D drawings - stilt and first come from the CAD; LOWER GROUND AND SECOND ARE TRACED FROM THE BROCHURE PLANS, because no DWG in the archive draws them. Those two levels are marked (reconstructed) in the view list and must not be presented as surveyed geometry.
       * Lighting is baked: black albedo + emissive, because glTF has no
       * lightmap channel and a bake carried as base colour would be
       * multiplied by the viewer's realtime lights and double-expose.
       * See tools/cad-to-3d/README.md.
       */
      walkthrough: {
        model: 'scenes/villa-a1.glb',
        eyeHeight: 1.6,
        views: [
          { id: 'fl_lower-ground', name: 'Lower ground (reconstructed)', position: [3.71, 1.6, -7.21], rotation: [108, -2] },
          { id: 'foyer', name: 'Foyer (stilt)', position: [5.53, 4.6, -8.35], rotation: [137, -2] },
          { id: 'master', name: 'Master bedroom (first)', position: [4.69, 7.6, -3.09], rotation: [1, -2] },
          { id: 'fl_second', name: 'Second (reconstructed)', position: [3.97, 10.6, -3.04], rotation: [39, -2] },
        ],
      },
      floors: [
        {
          id: 'lower-ground', label: 'Lower ground', area: 106.32, plan: 'plans/a1-lower-ground.webp',
          rooms: [
            { name: 'Bedroom 1', width: 3.82, depth: 4.0, kind: 'habitable' },
            { name: 'Bedroom 2', width: 3.62, depth: 5.31, kind: 'habitable' },
            { name: 'Toilet 01', width: 3.03, depth: 1.76, kind: 'service' },
            { name: 'Toilet 02', width: 1.49, depth: 3.1, kind: 'service' },
            { name: 'Walk-in', width: 1.76, depth: 2.8, kind: 'service' },
            { name: 'Foyer', width: 3.34, depth: 3.03, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
            { name: 'Verandah (double height)', width: 6.76, depth: 1.75, kind: 'outdoor' },
            { name: 'Unnamed', width: 3.03, depth: 2.51, kind: 'circulation' },
          ],
        },
        {
          id: 'stilt', label: 'Stilt', area: 90.93, plan: 'plans/a1-stilt.webp',
          rooms: [
            { name: 'Car parking', width: 3.04, depth: 4.11, kind: 'service' },
            { name: 'Open stilt (family lounge)', width: 6.76, depth: 4.0, kind: 'habitable' },
            { name: 'Foyer', width: 4.27, depth: 2.91, kind: 'circulation' },
            { name: 'Staff room', width: 2.1, depth: 2.4, kind: 'service' },
            { name: 'Staff toilet', width: 1.08, depth: 1.76, kind: 'service' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
            { name: 'Unnamed', width: 4.55, depth: 1.25, kind: 'circulation' },
          ],
        },
        {
          id: 'first', label: 'First', area: 114.08, plan: 'plans/a1-first.webp',
          rooms: [
            { name: 'Master bedroom', width: 6.76, depth: 4.0, kind: 'habitable' },
            { name: 'Bedroom 3', width: 4.83, depth: 3.66, kind: 'habitable' },
            { name: 'Master toilet', width: 2.91, depth: 2.28, kind: 'service' },
            { name: 'Toilet 3', width: 2.5, depth: 1.87, kind: 'service' },
            { name: 'Walk-in', width: 1.69, depth: 2.28, kind: 'service' },
            { name: 'Foyer', width: 1.66, depth: 1.99, kind: 'circulation' },
            { name: 'Foyer', width: 1.93, depth: 2.51, kind: 'circulation' },
            { name: 'Balcony', width: 6.76, depth: 1.75, kind: 'outdoor' },
            { name: 'Balcony', width: 4.57, depth: 1.0, kind: 'outdoor' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'second', label: 'Second', area: 106.66, plan: 'plans/a1-second.webp',
          rooms: [
            { name: 'Living', width: 6.76, depth: 3.92, kind: 'habitable' },
            { name: 'Dining', width: 5.32, depth: 3.36, kind: 'habitable' },
            { name: 'Kitchen', width: 4.11, depth: 2.87, kind: 'habitable' },
            { name: 'Swimming pool', width: 6.76, depth: 3.01, kind: 'outdoor' },
            { name: 'Deck', width: 7.22, depth: 1.47, kind: 'outdoor' },
            { name: 'Open terrace', width: 4.38, depth: 1.3, kind: 'outdoor' },
            { name: 'Balcony', width: 1.4, depth: 1.78, kind: 'outdoor' },
            { name: 'Powder room', width: 1.29, depth: 1.65, kind: 'service' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- B-1 --
    {
      id: 'b1',
      name: 'Villa B-1',
      appliesTo: ['B1'],
      sbua: 400.55,
      summary:
        'The southern end of the B row, and the only villa with a double car park at stilt level. Four bedrooms across two floors, with the living level and pool on top.',
      renders: ['villa-b-street', 'villa-b-living', 'villa-b-garden'],
      /**
       * Generated from the architect's 2D drawings - row villa - the plan leaves party walls and the garden edge open, so the slab is the convex hull of the wall network.
       * Lighting is baked: black albedo + emissive, because glTF has no
       * lightmap channel and a bake carried as base colour would be
       * multiplied by the viewer's realtime lights and double-expose.
       * See tools/cad-to-3d/README.md.
       */
      walkthrough: {
        model: 'scenes/villa-b1.glb',
        eyeHeight: 1.6,
        views: [
          { id: 'foyer', name: 'Foyer (stilt)', position: [2.54, 1.6, -8.07], rotation: [268, -2] },
          { id: 'parking', name: 'Car parking (stilt)', position: [2.67, 1.6, -3.72], rotation: [349, -2] },
          { id: 'fl_upper-ground', name: 'Upper ground', position: [4.13, 4.6, -10.78], rotation: [165, -2] },
          { id: 'fl_first', name: 'First', position: [2.16, 7.6, -6.76], rotation: [324, -2] },
          { id: 'living', name: 'Living area (second)', position: [3.23, 10.6, -2.98], rotation: [303, -2] },
          { id: 'kitchen', name: 'Kitchen (second)', position: [4.93, 10.6, -12.51], rotation: [171, -2] },
        ],
      },
      floors: [
        {
          id: 'stilt', label: 'Stilt', area: 84.15, plan: 'plans/b1-stilt.webp',
          rooms: [
            { name: 'Car parking', width: 6.23, depth: 6.3, kind: 'service' },
            { name: 'Foyer', width: 4.28, depth: 2.57, kind: 'circulation' },
            { name: 'Servant room', width: 1.84, depth: 2.57, kind: 'service' },
            { name: 'Toilet', width: 1.84, depth: 1.0, kind: 'service' },
            { name: 'Lift', width: 1.69, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'upper-ground', label: 'Upper ground', area: 109.24, plan: 'plans/b1-upper-ground.webp',
          rooms: [
            { name: 'Family room', width: 4.79, depth: 3.47, kind: 'habitable' },
            { name: 'Bedroom', width: 3.72, depth: 4.2, kind: 'habitable' },
            { name: 'Bedroom', width: 3.72, depth: 4.2, kind: 'habitable' },
            { name: 'Toilet', width: 1.84, depth: 2.57, kind: 'service' },
            { name: 'Toilet', width: 1.84, depth: 2.57, kind: 'service' },
            { name: 'Powder room', width: 2.0, depth: 1.23, kind: 'service' },
            { name: 'Balcony', width: 6.73, depth: 2.1, kind: 'outdoor' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'first', label: 'First', area: 108.36, plan: 'plans/b1-first.webp',
          rooms: [
            { name: 'Bedroom', width: 6.23, depth: 4.2, kind: 'habitable' },
            { name: 'Bedroom', width: 4.35, depth: 3.47, kind: 'habitable' },
            { name: 'Toilet', width: 2.73, depth: 2.57, kind: 'service' },
            { name: 'Toilet', width: 2.48, depth: 2.0, kind: 'service' },
            { name: 'Walk-in', width: 3.28, depth: 2.57, kind: 'service' },
            { name: 'Walk-in', width: 1.8, depth: 2.91, kind: 'service' },
            { name: 'Balcony', width: 6.23, depth: 2.1, kind: 'outdoor' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'second', label: 'Second', area: 98.8, plan: 'plans/b1-second.webp',
          rooms: [
            { name: 'Living', width: 6.23, depth: 4.14, kind: 'habitable' },
            { name: 'Kitchen / dining', width: 5.83, depth: 3.47, kind: 'habitable' },
            { name: 'Swimming pool', width: 6.23, depth: 3.0, kind: 'outdoor' },
            { name: 'Deck', width: 6.69, depth: 1.5, kind: 'outdoor' },
            { name: 'Toilet', width: 2.48, depth: 2.0, kind: 'service' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
      ],
    },

    // ------------------------------------------------------- B-2..4 / D-x --
    {
      id: 'bd',
      name: 'Villa B-2, B-3, B-4 & D-1 to D-5',
      appliesTo: ['B2', 'B3', 'B4', 'D1', 'D2', 'D3', 'D4', 'D5'],
      sbua: 438.4,
      summary:
        'The most numerous configuration on the site — eight villas share it. A private garden at stilt level, three bedrooms above, and a 6.73 m living room opening onto the pool deck.',
      renders: ['villa-b-street', 'villa-b-living', 'villa-b-garden'],
      /**
       * Generated from the architect's 2D drawings - row villa, 8 units share this drawing.
       * Lighting is baked: black albedo + emissive, because glTF has no
       * lightmap channel and a bake carried as base colour would be
       * multiplied by the viewer's realtime lights and double-expose.
       * See tools/cad-to-3d/README.md.
       */
      walkthrough: {
        model: 'scenes/villa-bd.glb',
        eyeHeight: 1.6,
        views: [
          { id: 'entrance', name: 'Entrance (stilt)', position: [3.84, 1.6, -3.16], rotation: [50, -2] },
          { id: 'parking', name: 'Car parking (stilt)', position: [3.61, 1.6, 5.24], rotation: [3, -2] },
          { id: 'living', name: 'Living area (upper ground)', position: [1.44, 4.6, -9.87], rotation: [9, -2] },
          { id: 'fl_first', name: 'First', position: [2.85, 7.6, -6.02], rotation: [224, -2] },
          { id: 'kitchen', name: 'Kitchen (second)', position: [6.45, 10.6, -11.77], rotation: [167, -2] },
          { id: 'dining', name: 'Dining area (second)', position: [6.66, 10.6, -9.4], rotation: [135, -2] },
        ],
      },
      floors: [
        {
          id: 'stilt', label: 'Stilt', area: 91.83, plan: 'plans/bd-stilt.webp',
          rooms: [
            { name: 'Car parking', width: 6.73, depth: 6.25, kind: 'service' },
            { name: 'Entrance foyer', width: 2.41, depth: 1.61, kind: 'circulation' },
            { name: 'Servant room', width: 2.0, depth: 2.47, kind: 'service' },
            { name: 'Toilet', width: 2.0, depth: 1.0, kind: 'service' },
            { name: 'Private garden', kind: 'outdoor' },
            { name: 'Lift', width: 1.69, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'upper-ground', label: 'Upper ground', area: 118.18, plan: 'plans/bd-upper-ground.webp',
          rooms: [
            { name: 'Bedroom', width: 4.0, depth: 4.5, kind: 'habitable' },
            { name: 'Bedroom', width: 4.0, depth: 4.5, kind: 'habitable' },
            { name: 'Family room', width: 3.68, depth: 4.23, kind: 'habitable' },
            { name: 'Toilet', width: 2.09, depth: 2.7, kind: 'service' },
            { name: 'Toilet', width: 2.09, depth: 2.7, kind: 'service' },
            { name: 'Powder room', width: 1.8, depth: 1.35, kind: 'service' },
            { name: 'Balcony', width: 6.73, depth: 2.1, kind: 'outdoor' },
            { name: 'Deck', width: 3.91, depth: 0.9, kind: 'outdoor' },
            { name: 'Private garden', kind: 'outdoor' },
            { name: 'Foyer', width: 3.35, depth: 1.23, kind: 'circulation' },
            { name: 'Lift', width: 1.69, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'first', label: 'First', area: 119.15, plan: 'plans/bd-first.webp',
          rooms: [
            { name: 'Master bedroom', width: 6.73, depth: 4.5, kind: 'habitable' },
            { name: 'Bedroom', width: 3.68, depth: 4.23, kind: 'habitable' },
            { name: 'Toilet', width: 3.37, depth: 2.7, kind: 'service' },
            { name: 'Toilet', width: 1.8, depth: 2.17, kind: 'service' },
            { name: 'Walk-in', width: 3.25, depth: 2.81, kind: 'service' },
            { name: 'Balcony', width: 6.73, depth: 2.1, kind: 'outdoor' },
            { name: 'Balcony', width: 3.91, depth: 1.05, kind: 'outdoor' },
            { name: 'Foyer', width: 3.35, depth: 1.23, kind: 'circulation' },
            { name: 'Lift', width: 1.69, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'second', label: 'Second', area: 109.24, plan: 'plans/bd-second.webp',
          rooms: [
            { name: 'Living', width: 6.73, depth: 5.25, kind: 'habitable' },
            { name: 'Dining', width: 3.68, depth: 2.96, kind: 'habitable' },
            { name: 'Kitchen', width: 5.6, depth: 2.17, kind: 'habitable' },
            { name: 'Swimming pool', width: 6.73, depth: 3.0, kind: 'outdoor' },
            { name: 'Deck', width: 7.19, depth: 1.55, kind: 'outdoor' },
            { name: 'Powder room', width: 1.09, depth: 1.8, kind: 'service' },
            { name: 'Lift', width: 1.69, depth: 1.65, kind: 'circulation' },
          ],
        },
      ],
    },

    // ------------------------------------------- C1-4 / E2, E3 / A2, A3 --
    {
      id: 'ce',
      name: 'Villa C1–C4, E2, E3 & A2, A3',
      appliesTo: ['C1', 'C2', 'C3', 'C4', 'E2', 'E3', 'A2', 'A3'],
      sbua: 467.97,
      summary:
        'Eight villas share this drawing set — the second most common on site and the larger of the two mainstream types. Twin bedrooms open onto a 7.20 m double-height verandah; the stilt level carries a wall feature with a water body.',
      renders: ['villa-e2', 'villa-e3', 'villa-a-street', 'villa-a-rear'],
      /**
       * Generated from the architect's 2D drawings - 8 units share this drawing; floors taken from whichever revision drew them.
       * Lighting is baked: black albedo + emissive, because glTF has no
       * lightmap channel and a bake carried as base colour would be
       * multiplied by the viewer's realtime lights and double-expose.
       * See tools/cad-to-3d/README.md.
       */
      walkthrough: {
        model: 'scenes/villa-ce.glb',
        eyeHeight: 1.6,
        views: [
          { id: 'foyer', name: 'Foyer (lower ground)', position: [6.54, 1.6, -8.6], rotation: [163, -2] },
          { id: 'verandah', name: 'Verandah (lower ground)', position: [4.47, 1.6, -0.99], rotation: [274, -2] },
          { id: 'parking', name: 'Car parking (stilt)', position: [7.48, 4.6, -11.81], rotation: [179, -2] },
          { id: 'fl_first', name: 'First', position: [8.3, 7.6, -2.27], rotation: [273, -2] },
          { id: 'fl_second', name: 'Second', position: [7.99, 10.6, -6.63], rotation: [163, -2] },
        ],
      },
      floors: [
        {
          id: 'lower-ground', label: 'Lower ground', area: 114.1, plan: 'plans/ce-lower-ground.webp',
          rooms: [
            { name: 'Bedroom 1', width: 3.54, depth: 5.6, kind: 'habitable' },
            { name: 'Bedroom 2', width: 3.54, depth: 5.6, kind: 'habitable' },
            { name: 'Toilet', width: 1.64, depth: 3.1, kind: 'service' },
            { name: 'Toilet', width: 1.66, depth: 3.1, kind: 'service' },
            { name: 'Walk-in', width: 1.64, depth: 1.88, kind: 'service' },
            { name: 'Walk-in', width: 1.66, depth: 1.88, kind: 'service' },
            { name: 'Verandah (double height)', width: 7.2, depth: 1.74, kind: 'outdoor' },
            { name: 'Utility', width: 3.62, depth: 1.65, kind: 'service' },
            { name: 'Foyer', width: 4.38, depth: 1.65, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'stilt', label: 'Stilt', area: 107.76, plan: 'plans/ce-stilt.webp',
          rooms: [
            { name: 'Car parking', width: 5.55, depth: 5.02, kind: 'service' },
            { name: 'Open stilt (family lounge)', width: 5.24, depth: 5.6, kind: 'habitable' },
            { name: 'Staff room', width: 2.62, depth: 2.1, kind: 'service' },
            { name: 'Toilet', width: 1.84, depth: 1.35, kind: 'service' },
            { name: 'Wall feature with water body', kind: 'outdoor' },
            { name: 'Terrace', kind: 'outdoor' },
            { name: 'Foyer', width: 4.2, depth: 1.88, kind: 'circulation' },
            { name: 'Unnamed', width: 1.96, depth: 3.76, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'first', label: 'First', area: 125.84, plan: 'plans/ce-first.webp',
          rooms: [
            { name: 'Master bedroom 03', width: 7.2, depth: 4.5, kind: 'habitable' },
            { name: 'Bedroom 04', width: 4.33, depth: 4.79, kind: 'habitable' },
            { name: 'Toilet', width: 3.07, depth: 2.75, kind: 'service' },
            { name: 'Toilet', width: 1.61, depth: 3.49, kind: 'service' },
            { name: 'Walk-in', width: 1.7, depth: 2.87, kind: 'service' },
            { name: 'Balcony', width: 7.2, depth: 1.74, kind: 'outdoor' },
            { name: 'Balcony', width: 6.51, depth: 1.0, kind: 'outdoor' },
            { name: 'Foyer', width: 1.27, depth: 1.99, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'second', label: 'Second', area: 120.265, plan: 'plans/ce-second.webp',
          rooms: [
            { name: 'Kitchen / dining', width: 6.05, depth: 4.6, kind: 'habitable' },
            { name: 'Living', width: 6.07, depth: 3.04, kind: 'habitable' },
            { name: 'Swimming pool', width: 6.61, depth: 3.01, kind: 'outdoor' },
            { name: 'Deck', width: 7.66, depth: 1.65, kind: 'outdoor' },
            { name: 'Powder room', width: 1.13, depth: 1.8, kind: 'service' },
            { name: 'Unnamed', width: 6.85, depth: 3.07, kind: 'habitable' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- E-1 --
    {
      id: 'e1',
      name: 'Villa E-1',
      appliesTo: ['E1'],
      sbua: 631.64,
      summary:
        'The corner plot, and the largest villa on the site by a wide margin — half as much again as the next type. Two separate car parks, a 7.23 m family lounge and reception at stilt level, four bedrooms, and an 8.00 × 3.50 m pool off a 12.57 m open deck.',
      renders: ['villa-e1', 'aerial-day', 'villa-a-living'],
      /**
       * Real PBR surfaces (CC0, Poly Haven) lit by the environment, plus CC0
       * furniture placed against the room schedule. Deliberately NOT a baked
       * lightmap: baking to emissive over black albedo renders any face the
       * atlas misses as pure black, which is what filled the view with black
       * slabs once furniture pushed the mesh past 40k polys.
       */
      walkthrough: {
        model: 'scenes/villa-e1.glb',
        // A Cycles orbit rendered offline against a real sky HDRI. Real-time
        // photoreal is not reachable from plan-derived geometry; this is.
        film: 'scenes/villa-e1.mp4',
        // A REAL captured sky, not the procedural one.
        //
        // `scenes/sky.hdr` is 512x256 generated by tools/cad-to-3d/make_sky.py,
        // and measured against a captured HDRI it has about 1,400x less
        // sun-to-sky contrast: peak 43.7 against 70,144, and a sun only 55x the
        // average direction against 79,682x. That is why make_sky's own
        // docstring says an unbaked interior "reads flat" under it — there is
        // no key light to speak of, so nothing casts a shadow worth seeing.
        //
        // Afternoon sun chosen deliberately over the alternatives: the sun sits
        // at 29 degrees, which throws a shadow 1.8x the height of what casts it
        // — warm and raking across the floor without being a sunset. Golden
        // hour (4.7 degrees) is the hero-shot light and is too low to carry a
        // whole walkthrough; midday (43.1) is bright but hard and reads cold.
        //
        // CC0, Jarod Guest and Sergej Majboroda, polyhaven.com/a/autumn_field_puresky
        environment: 'scenes/afternoon.hdr',
        eyeHeight: 1.6,
        views: [
          { id: 'living', name: 'Living area (second)', position: [3.92, 10.6, -8.42], rotation: [250, -2] },
          { id: 'dining', name: 'Dining area (second)', position: [11.63, 10.6, -5.59], rotation: [57, -2] },
          { id: 'deck', name: 'Open deck (second)', position: [12.05, 10.6, -2.42], rotation: [47, -2] },
          { id: 'kitchen', name: 'Kitchen (second)', position: [15.64, 10.6, -10.29], rotation: [90, -2] },
          { id: 'lounge', name: 'Family lounge (lower ground)', position: [8.0, 1.6, -5.01], rotation: [352, -2] },
          { id: 'master', name: 'Master bedroom (first)', position: [14.77, 7.6, -4.68], rotation: [23, -2] },
          { id: 'bed1', name: 'Bedroom 1 (lower ground)', position: [15.4, 1.6, -4.68], rotation: [85, -2] },
          { id: 'bed2', name: 'Bedroom 2 (lower ground)', position: [1.98, 1.6, -9.47], rotation: [185, -2] },
          { id: 'foyer', name: 'Foyer (lower ground)', position: [10.76, 1.6, -10.77], rotation: [158, -2] },
          { id: 'passage', name: 'Passage (lower ground)', position: [9.54, 1.6, -10.73], rotation: [172, -2] },
          { id: 'entrance', name: 'Entrance (stilt)', position: [2.01, 4.6, -10.11], rotation: [305, -2] },
          { id: 'parking', name: 'Car parking (stilt)', position: [2.07, 4.6, -8.73], rotation: [320, -2] },
          { id: 'bed3', name: 'Bedroom 3 (first)', position: [1.78, 7.6, -9.47], rotation: [266, -2] },
          { id: 'bed4', name: 'Bedroom 4 (first)', position: [8.35, 7.6, -5.69], rotation: [334, -2] },
        ],
      },
      floors: [
        {
          id: 'lower-ground', label: 'Lower ground', area: 152.9, plan: 'plans/e1-lower-ground.webp',
          rooms: [
            { name: 'Bedroom 1', width: 4.5, depth: 4.64, kind: 'habitable' },
            { name: 'Bedroom 2', width: 4.0, depth: 5.23, kind: 'habitable' },
            { name: 'Family lounge', width: 4.0, depth: 4.64, kind: 'habitable' },
            { name: 'Toilet 1', width: 2.46, depth: 2.75, kind: 'service' },
            { name: 'Toilet 2', width: 1.8, depth: 2.67, kind: 'service' },
            { name: 'Walk-in', width: 2.69, depth: 1.88, kind: 'service' },
            { name: 'Dressing table', width: 1.76, depth: 2.21, kind: 'service' },
            { name: 'Balcony', width: 7.65, depth: 3.23, kind: 'outdoor' },
            { name: 'Passage', width: 5.35, depth: 1.31, kind: 'circulation' },
            { name: 'Foyer', width: 1.45, depth: 2.78, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'stilt', label: 'Stilt', area: 146.78, plan: 'plans/e1-stilt.webp',
          rooms: [
            { name: 'Family lounge & reception area', width: 7.23, depth: 4.53, kind: 'habitable' },
            { name: 'Car parking', width: 3.84, depth: 5.53, kind: 'service' },
            { name: 'Car parking', width: 3.69, depth: 6.06, kind: 'service' },
            { name: 'Servant room', width: 2.53, depth: 3.2, kind: 'service' },
            { name: 'Servant toilet', width: 1.2, depth: 1.85, kind: 'service' },
            { name: 'Entrance', width: 2.0, depth: 0.9, kind: 'circulation' },
            { name: 'Foyer', width: 5.56, depth: 2.32, kind: 'circulation' },
            { name: 'Foyer', width: 3.6, depth: 1.42, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'first', label: 'First', area: 178.47, plan: 'plans/e1-first.webp',
          rooms: [
            { name: 'Master bedroom', width: 5.12, depth: 4.75, kind: 'habitable' },
            { name: 'Bedroom 3', width: 4.0, depth: 5.23, kind: 'habitable' },
            { name: 'Bedroom 4', width: 4.0, depth: 4.75, kind: 'habitable' },
            { name: 'Master toilet', width: 3.84, depth: 2.18, kind: 'service' },
            { name: 'Toilet 3', width: 1.8, depth: 2.67, kind: 'service' },
            { name: 'Toilet 4', width: 1.95, depth: 2.75, kind: 'service' },
            { name: 'Walk-in', width: 3.84, depth: 1.8, kind: 'service' },
            { name: 'Walk-in', width: 1.95, depth: 1.88, kind: 'service' },
            { name: 'Balcony', width: 7.65, depth: 2.83, kind: 'outdoor' },
            { name: 'Balcony', width: 5.19, depth: 1.5, kind: 'outdoor' },
            { name: 'Balcony', width: 3.61, depth: 1.5, kind: 'outdoor' },
            { name: 'Passage', width: 5.33, depth: 1.31, kind: 'circulation' },
            { name: 'Foyer', width: 1.45, depth: 2.78, kind: 'circulation' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
        {
          id: 'second', label: 'Second', area: 153.49, plan: 'plans/e1-second.webp',
          rooms: [
            { name: 'Living area', width: 5.92, depth: 5.23, kind: 'habitable' },
            { name: 'Dining area', width: 4.07, depth: 3.15, kind: 'habitable' },
            { name: 'Kitchen', width: 3.84, depth: 3.52, kind: 'habitable' },
            { name: 'Swimming pool', width: 8.0, depth: 3.5, kind: 'outdoor' },
            { name: 'Open deck', width: 12.57, depth: 2.0, kind: 'outdoor' },
            { name: 'Unnamed', width: 7.23, depth: 4.0, kind: 'habitable' },
            { name: 'Lift', width: 1.65, depth: 1.65, kind: 'circulation' },
          ],
        },
      ],
    },
  ],

  gallery: [
    { slug: 'aerial-day', caption: 'The site from the north-west', group: 'aerial' },
    { slug: 'aerial-night', caption: 'Dusk over the nineteen villas', group: 'aerial' },
    { slug: 'entrance-gate', caption: 'Entrance gate and gatehouse', group: 'exterior' },
    { slug: 'signage', caption: 'Arrival signage', group: 'exterior' },
    { slug: 'villa-a1-aerial', caption: 'Villa A-1, rooftop infinity pool', group: 'exterior' },
    { slug: 'villa-a-street', caption: 'Villa A, street elevation', group: 'exterior' },
    { slug: 'villa-a-rear', caption: 'Villa A, garden elevation at dusk', group: 'exterior' },
    { slug: 'villa-b-street', caption: 'Villa B, street elevation', group: 'exterior' },
    { slug: 'villa-b-garden', caption: 'Villa B, garden elevation', group: 'exterior' },
    { slug: 'villa-e1', caption: 'Villa E-1, the corner plot', group: 'exterior' },
    { slug: 'villa-e2', caption: 'Villa E-2', group: 'exterior' },
    { slug: 'villa-e3', caption: 'Villa E-3', group: 'exterior' },
    { slug: 'villa-a-living', caption: 'Living room opening to the pool', group: 'interior' },
    { slug: 'villa-b-living', caption: 'Living and kitchen across the pool', group: 'interior' },
    { slug: 'garden', caption: 'Terraced landscape between the rows', group: 'landscape' },
  ],

  locationMap: {
    image: 'site/location-map.webp',
    note: [
      'Nestled away in the quaint and scenic backwaters of the Nerul river, Casa Altinho is roughly 7 minutes from the beaches of North Goa. In close proximity lie the city’s top night clubs.',
      'The property is a short drive from several fine culinary establishments. Mall de Goa and the Panjim casinos are barely 15 minutes away.',
    ],
  },

  contacts: [
    { region: 'India', name: 'Srinivas Reddy Paduru', phone: '+91 99893 32555' },
    { region: 'USA', name: 'Shravan Reddy Paduru', phone: '+1 (703) 340-4700' },
  ],

  offices: [
    {
      label: 'Goa office',
      lines: [
        'H.No. 435/38, Flat A-3, First Floor',
        'Horizons Square, above Bina Punjani',
        'Chogm Road, Porvorim, Goa 403521',
      ],
    },
    {
      label: 'Registered office',
      lines: [
        'H.No. 2-1-251, Flat M1, Lahari Apartments',
        'Nallakunta Veg. Market Road',
        'Hyderabad 500044, Telangana, India',
      ],
    },
  ],

  disclaimer:
    'All illustrations are artist impressions. Images shown are indicative and representational in nature, and are only for the purpose of illustrating a possible layout. The information contained here is subject to change and cannot form part of a legal offer or contract.',
}

export default casaAltinho
