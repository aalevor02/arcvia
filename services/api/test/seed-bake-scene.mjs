/**
 * Seed a scene for verifying the bake round trip by hand.
 *
 * Deliberately the smallest thing that is still a room: four walls, one derived
 * floor, no furniture. Cycles runs on the CPU on machines without a CUDA or HIP
 * device, and `RENDER_TIMEOUT_MS` kills a job at ten minutes — a furnished room
 * does not finish inside that, so a first end-to-end check should not use one.
 *
 * Prints a studio URL and a token to paste into localStorage.
 *
 *   node test/seed-bake-scene.mjs
 */

const BASE = process.env.API_URL ?? 'http://localhost:8787'
const STUDIO = process.env.STUDIO_URL ?? 'http://localhost:5173'
const stamp = Date.now()

const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Bake Verifier',
    email: `bake-verify+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Bake Co',
  }),
}).then((r) => r.json())

if (!account.token) {
  console.error('Could not register:', account)
  process.exit(1)
}

const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }

// A 5m x 4m room. Vertices go counter-clockwise in plan space, which is what
// `detectRooms` needs to see a positive signed area and call it an interior.
const corner = [
  { id: 'v1', x: 0, y: 0 },
  { id: 'v2', x: 5, y: 0 },
  { id: 'v3', x: 5, y: 4 },
  { id: 'v4', x: 0, y: 4 },
]

const plan = {
  version: 1,
  activeFloorId: 'f1',
  floors: [
    {
      id: 'f1',
      name: 'Ground',
      elevation: 0,
      vertices: Object.fromEntries(corner.map((v) => [v.id, v])),
      walls: Object.fromEntries(
        corner.map((v, i) => {
          const next = corner[(i + 1) % corner.length]
          return [`w${i + 1}`, { id: `w${i + 1}`, a: v.id, b: next.id, thickness: 0.23, height: 3 }]
        }),
      ),
      roomNames: {},
      objects: {},
      underlay: null,
    },
  ],
}

const scene = await fetch(`${BASE}/scenes/`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: `Bake check ${stamp}` }),
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
console.log()
console.log('In the studio tab, before loading:')
console.log(`  localStorage.setItem('arcvia.token', ${JSON.stringify(account.token)})`)
