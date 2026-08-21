/**
 * Seed a realistic one-bedroom flat, end to end.
 *
 * The single-room scenes were right for checking that a bake completes. They
 * are useless for judging the *product*, because everything that makes a
 * walkthrough worth paying for only appears once there is more than one room:
 * doors you move through, a view per room, light that differs between them,
 * and a plan a client would recognise as their flat.
 *
 *   node test/seed-demo-flat.mjs
 */

const BASE = process.env.API_URL ?? 'http://localhost:8787'
const STUDIO = process.env.STUDIO_URL ?? 'http://localhost:5173'
const stamp = Date.now()

const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Demo Studio',
    email: `demo+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Arcvia Demo',
  }),
}).then((r) => r.json())

if (!account.token) {
  console.error('Could not register:', account)
  process.exit(1)
}

const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }

// ── The plan ────────────────────────────────────────────────────────────────
// 9.6 x 7.2 m overall — a real one-bed footprint, not a demo box.
//
//   living/kitchen   x 0.0–5.8, full depth
//   bedroom          x 5.8–9.6, y 3.0–7.2
//   bathroom         x 5.8–9.6, y 0.0–3.0
//
// Every point where an internal wall meets another wall needs its own vertex:
// rooms are derived as cycles in the wall graph, so a wall that merely *crosses*
// another without sharing a vertex encloses nothing and the room vanishes.
const V = {
  a: { id: 'a', x: 0.0, y: 0.0 },
  b: { id: 'b', x: 5.8, y: 0.0 },
  c: { id: 'c', x: 9.6, y: 0.0 },
  d: { id: 'd', x: 9.6, y: 3.0 },
  e: { id: 'e', x: 9.6, y: 7.2 },
  f: { id: 'f', x: 5.8, y: 7.2 },
  g: { id: 'g', x: 0.0, y: 7.2 },
  h: { id: 'h', x: 5.8, y: 3.0 },
}

const EXT = { thickness: 0.23, height: 2.7 }
const INT = { thickness: 0.115, height: 2.7 }

const wallList = [
  ['w1', 'a', 'b', EXT], // south, under the living room
  ['w2', 'b', 'c', EXT], // south, under the bathroom
  ['w3', 'c', 'd', EXT], // east, bathroom
  ['w4', 'd', 'e', EXT], // east, bedroom
  ['w5', 'e', 'f', EXT], // north, bedroom
  ['w6', 'f', 'g', EXT], // north, living
  ['w7', 'g', 'a', EXT], // west
  ['w8', 'b', 'h', INT], // living | bathroom
  ['w9', 'h', 'f', INT], // living | bedroom
  ['w10', 'h', 'd', INT], // bathroom | bedroom
]

const walls = Object.fromEntries(
  wallList.map(([id, a, b, spec]) => [id, { id, a, b, ...spec }]),
)

// ── What is in it ───────────────────────────────────────────────────────────
// Kept to about thirty pieces. Every object is its own cell in the lightmap
// atlas, and a bake on CPU costs real minutes — a demo nobody waits for is not
// a demo.
const obj = (id, item, position, rotation, extra = {}) => [
  id,
  { id, item, position, rotation, ...extra },
]

const objects = Object.fromEntries([
  // ---- Daylight, and the way in ------------------------------------------
  obj('win1', 'window-wide', { x: 1.8, y: 0 }, 0, { wallId: 'w1' }),
  obj('win2', 'window-wide', { x: 4.4, y: 0 }, 0, { wallId: 'w1' }),
  obj('win3', 'window', { x: 9.6, y: 5.4 }, -Math.PI / 2, { wallId: 'w4' }),
  obj('win4', 'window', { x: 7.7, y: 7.2 }, Math.PI, { wallId: 'w5' }),
  obj('front', 'door-main', { x: 0, y: 5.6 }, Math.PI / 2, { wallId: 'w7' }),
  obj('dr1', 'door', { x: 5.8, y: 5.2 }, 0, { wallId: 'w9' }),
  obj('dr2', 'door', { x: 5.8, y: 1.4 }, 0, { wallId: 'w8' }),

  // ---- Living ------------------------------------------------------------
  obj('rug', 'rug', { x: 2.9, y: 2.3 }, 0),
  obj('sofa', 'sofa-3', { x: 2.9, y: 3.5 }, Math.PI),
  obj('chair', 'armchair', { x: 0.9, y: 2.1 }, Math.PI / 2),
  obj('coffee', 'coffee-table', { x: 2.9, y: 2.2 }, 0),
  obj('tvunit', 'tv-unit', { x: 2.9, y: 0.9 }, 0),
  obj('tv', 'tv', { x: 2.9, y: 0.14 }, 0, { wallId: 'w1' }),
  obj('shelf', 'bookshelf', { x: 5.3, y: 2.4 }, -Math.PI / 2),
  obj('plant1', 'plant', { x: 5.2, y: 0.7 }, 0),
  obj('pend1', 'pendant', { x: 2.9, y: 2.2 }, 0),
  obj('art1', 'painting', { x: 2.9, y: 7.06 }, Math.PI, { wallId: 'w6' }),
  obj('cur1', 'curtain', { x: 1.8, y: 0.16 }, 0, { wallId: 'w1' }),
  obj('cur2', 'curtain', { x: 4.4, y: 0.16 }, 0, { wallId: 'w1' }),

  // ---- Kitchen run, along the north of the living room --------------------
  obj('counter', 'counter', { x: 1.6, y: 6.9 }, Math.PI),
  obj('sink', 'sink-unit', { x: 3.4, y: 6.9 }, Math.PI),
  obj('hob', 'hob', { x: 4.4, y: 6.9 }, Math.PI),
  obj('fridge', 'fridge', { x: 5.3, y: 6.85 }, Math.PI),
  obj('over', 'overhead', { x: 2.6, y: 7.06 }, Math.PI, { wallId: 'w6' }),

  // ---- Bedroom -----------------------------------------------------------
  obj('bed', 'bed-queen', { x: 7.7, y: 5.6 }, 0),
  obj('bs1', 'bedside', { x: 6.5, y: 6.5 }, 0),
  obj('bs2', 'bedside', { x: 8.9, y: 6.5 }, 0),
  obj('ward', 'wardrobe', { x: 7.6, y: 3.35 }, 0),
  obj('pend2', 'pendant', { x: 7.7, y: 5.4 }, 0),

  // ---- Bathroom ----------------------------------------------------------
  obj('wc', 'wc', { x: 9.2, y: 0.9 }, -Math.PI / 2),
  obj('basin', 'basin', { x: 9.45, y: 2.1 }, -Math.PI / 2, { wallId: 'w3' }),
  obj('bath', 'bathtub', { x: 7.2, y: 0.6 }, 0),
  obj('mirror', 'mirror', { x: 9.5, y: 2.1 }, -Math.PI / 2, { wallId: 'w3' }),
])

const plan = {
  version: 1,
  activeFloorId: 'f1',
  floors: [
    {
      id: 'f1',
      name: 'Ground',
      elevation: 0,
      vertices: V,
      walls,
      roomNames: {},
      objects,
      underlay: null,
    },
  ],
}

const scene = await fetch(`${BASE}/scenes/`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: 'Aldworth House, Flat 4' }),
})
  .then((r) => r.json())
  .then((r) => r.scene)

await fetch(`${BASE}/scenes/${scene.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({
    plan,
    // Named views, authored in the order a client should see the flat: arrive,
    // sit down, then the rooms you are actually buying.
    views: [
      { id: 'living', name: 'Living room', position: [2.9, 1.6, -5.9], rotation: [180, -4], mode: 'fps' },
      { id: 'kitchen', name: 'Kitchen', position: [2.9, 1.6, -4.6], rotation: [0, -6], mode: 'fps' },
      { id: 'bedroom', name: 'Bedroom', position: [7.7, 1.6, -3.9], rotation: [180, -5], mode: 'fps' },
      { id: 'bathroom', name: 'Bathroom', position: [7.0, 1.6, -2.2], rotation: [-90, -8], mode: 'fps' },
    ],
    hotspots: [
      { id: 'floor', title: 'Engineered oak', body: '180 mm board, matt lacquer throughout', position: [2.9, 0.02, -2.9] },
      { id: 'glazing', title: 'Full-height glazing', body: 'Double glazed, 2.1 m wide, south facing', position: [1.8, 1.4, -0.12] },
      { id: 'kitchen', title: 'Quartz worktop', body: '20 mm, integrated sink', position: [3.4, 0.92, -6.6] },
    ],
    branding: { accent: '#b5763f' },
  }),
})

console.log('email   ', `demo+${stamp}@example.com`)
console.log('token   ', account.token)
console.log('sceneId ', scene.id)
console.log('studio  ', `${STUDIO}/?scene=${scene.id}`)
console.log('rooms   ', 3, '· objects', Object.keys(objects).length)
