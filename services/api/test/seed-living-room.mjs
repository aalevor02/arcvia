/**
 * Seed a furnished living room, for judging how real the output looks.
 *
 * The empty-box scene is the right size for checking that a bake completes; it
 * is useless for judging realism, because most of what makes an interior read
 * as photographed is things an empty box has none of — daylight arriving
 * through a window opening, furniture casting contact shadows onto a floor,
 * objects at different heights occluding one another.
 *
 *   node test/seed-living-room.mjs
 */

const BASE = process.env.API_URL ?? 'http://localhost:8787'
const STUDIO = process.env.STUDIO_URL ?? 'http://localhost:5173'
const stamp = Date.now()

const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Realism Check',
    email: `realism+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Arcvia',
  }),
}).then((r) => r.json())

if (!account.token) {
  console.error('Could not register:', account)
  process.exit(1)
}

const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }

// A 6.4m x 4.6m living room — a real proportion, not a square. Counter-
// clockwise, so `detectRooms` reads a positive signed area and calls it an
// interior rather than an outer boundary.
const W = 6.4
const D = 4.6

const corner = [
  { id: 'v1', x: 0, y: 0 },
  { id: 'v2', x: W, y: 0 },
  { id: 'v3', x: W, y: D },
  { id: 'v4', x: 0, y: D },
]

const walls = Object.fromEntries(
  corner.map((v, i) => {
    const next = corner[(i + 1) % corner.length]
    const id = `w${i + 1}`
    return [id, { id, a: v.id, b: next.id, thickness: 0.23, height: 3 }]
  }),
)

// Wall ids, by which edge they are, so the placements below read as intent
// rather than as indices:  w1 south (y=0), w2 east, w3 north (y=D), w4 west.
const object = (id, item, position, rotation, extra = {}) => [
  id,
  { id, item, position, rotation, ...extra },
]

const objects = Object.fromEntries([
  // Daylight. Two openings on the long south wall — the single biggest
  // difference between a lit box and a room, because it puts a hard bright
  // shape on the floor and leaves the corners in shade.
  object('o1', 'window-wide', { x: 1.8, y: 0 }, 0, { wallId: 'w1' }),
  object('o2', 'window-wide', { x: 4.6, y: 0 }, 0, { wallId: 'w1' }),
  // A way in, on the west wall.
  object('o3', 'door', { x: 0, y: 3.6 }, Math.PI / 2, { wallId: 'w4' }),

  // Seating grouped around a rug, facing the television — furniture arranged
  // the way a room is arranged, not scattered, because clearances and sight
  // lines are half of what makes a render look plausible.
  object('o4', 'rug', { x: 3.2, y: 2.5 }, 0),
  object('o5', 'sofa-3', { x: 3.2, y: 3.7 }, Math.PI),
  object('o6', 'armchair', { x: 1.5, y: 2.3 }, Math.PI / 2),
  object('o7', 'coffee-table', { x: 3.2, y: 2.4 }, 0),
  object('o8', 'tv-unit', { x: 3.2, y: 1.1 }, 0),
  object('o9', 'tv', { x: 3.2, y: 0.14 }, 0, { wallId: 'w1' }),
  object('o10', 'bookshelf', { x: 5.9, y: 2.6 }, -Math.PI / 2),
  object('o11', 'plant', { x: 5.9, y: 4.1 }, 0),
  object('o12', 'side-table', { x: 4.9, y: 3.7 }, 0),

  // Ceiling and wall lights: geometry, but also the thing a viewer looks for
  // to explain where the light is coming from.
  object('o13', 'pendant', { x: 3.2, y: 2.4 }, 0),
  object('o14', 'painting', { x: 3.2, y: 4.46 }, Math.PI, { wallId: 'w3' }),
  object('o15', 'curtain', { x: 1.8, y: 0.16 }, 0, { wallId: 'w1' }),
  object('o16', 'curtain', { x: 4.6, y: 0.16 }, 0, { wallId: 'w1' }),
])

const plan = {
  version: 1,
  activeFloorId: 'f1',
  floors: [
    {
      id: 'f1',
      name: 'Ground',
      elevation: 0,
      vertices: Object.fromEntries(corner.map((v) => [v.id, v])),
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
  body: JSON.stringify({ name: `Living room ${stamp}` }),
})
  .then((r) => r.json())
  .then((r) => r.scene)

await fetch(`${BASE}/scenes/${scene.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ plan }),
})

console.log('token   ', account.token)
console.log('sceneId ', scene.id)
console.log('url     ', `${STUDIO}/?scene=${scene.id}`)
console.log('objects ', Object.keys(objects).length)
