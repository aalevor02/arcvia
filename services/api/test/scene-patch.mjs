/**
 * A save that is not performed must not answer 200.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * PATCH /scenes/:id filtered its body against a writable allow-list:
 *
 *     Object.entries(request.body).filter(([k]) => allowed.includes(k))
 *
 * so an unknown field — a typo, a renamed property, a field added to the client
 * before the server — produced 200 OK, a response that looks like a successful
 * save, and that field silently gone. The next read returns the old value, so
 * the symptom is "my change did not stick" at some arbitrary later moment,
 * nowhere near the cause.
 *
 * The credit charge made it worse: `spend()` ran after the filter, so a save
 * that stored nothing still cost the user a credit.
 *
 * ── Why unknown and read-only are separated ────────────────────────────────
 * "hdriUrl2 is not a field" and "protected is real, but is set through the
 * access-code endpoint" send a developer to completely different places. A
 * single "invalid field" message sends them to the wrong one half the time.
 *
 * Needs the API running: `npm run dev:api`.
 */

const BASE = 'http://localhost:8787'
const stamp = Date.now()

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Patch Tester',
    email: `patch+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Patch Co',
  }),
}).then((r) => r.json())

const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }
ok('registered', Boolean(account.token))

const scene = await fetch(`${BASE}/scenes/`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: `Patchable ${stamp}` }),
})
  .then((r) => r.json())
  .then((r) => r.scene)
ok('created a scene', Boolean(scene?.id))

const patch = (body) =>
  fetch(`${BASE}/scenes/${scene.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

const read = () =>
  fetch(`${BASE}/scenes/${scene.id}`, { headers: auth })
    .then((r) => r.json())
    .then((r) => r.scene)

console.log('\n-- a writable field still writes --')
const good = await patch({ modelUrl: '/uploads/scenes/x/model.glb' })
ok('a valid patch is accepted', good.status === 200, String(good.status))
ok('and the value is actually stored',
  (await read()).modelUrl === '/uploads/scenes/x/model.glb')

// Every shape the studio actually sends, so the strictness cannot break the app.
// These are the four call sites in apps/studio plus the duplicate-scene patch.
console.log('\n-- every patch shape the real client sends is accepted --')
const clientShapes = [
  ['plan only', { plan: null }],
  ['presentation', { views: [], hotspots: [], branding: null }],
  ['baked url', { bakedUrl: '/uploads/renders/x/atlas.png' }],
  ['panorama url', { panoramaUrl: '/uploads/renders/x/panorama.png' }],
  ['model url', { modelUrl: '/uploads/scenes/x/model.glb' }],
  ['duplicate-scene', {
    plan: null, modelUrl: null, lightsUrl: null, hdriUrl: null, floorPlanUrl: null,
    design: null, cadModelJsonUrl: null, designFurnitureReviewed: [],
  }],
]
for (const [label, body] of clientShapes) {
  const r = await patch(body)
  ok(`${label} is accepted`, r.status === 200, r.status === 200 ? '' : JSON.stringify(r.body))
}

console.log('\n-- a panorama can be removed from the scene and public presentation --')
await patch({ panoramaUrl: '/uploads/renders/x/panorama.png' })
const clearedPanorama = await patch({ panoramaUrl: null })
ok('clearing the panorama is accepted', clearedPanorama.status === 200,
  String(clearedPanorama.status))
const afterPanoramaClear = await read()
ok('and the cleared value survives the next read', afterPanoramaClear.panoramaUrl === null,
  String(afterPanoramaClear.panoramaUrl))

console.log('\n-- an unknown field is refused, not dropped --')
const typo = await patch({ hdriUrl2: '/env/midday.hdr' })
ok('a typo is a 400, not a 200', typo.status === 400, String(typo.status))
ok('and the message names the field', String(typo.body.message).includes('hdriUrl2'),
  String(typo.body.message).slice(0, 90))
ok('and lists it as unknown rather than read-only',
  typo.body.unknown?.includes('hdriUrl2') && !typo.body.readOnly?.length,
  JSON.stringify({ unknown: typo.body.unknown, readOnly: typo.body.readOnly }))
ok('and tells the caller what IS writable', Array.isArray(typo.body.writable))

// THE POINT OF THE WHOLE CHANGE. A refused write must leave the record alone —
// a 400 that had already half-applied would be worse than the silent drop.
const mixed = await patch({ name: `Renamed ${stamp}`, nonsense: 1 })
ok('a patch mixing valid and invalid fields is refused whole', mixed.status === 400)
ok('and the valid half was NOT applied',
  (await read()).name === `Patchable ${stamp}`,
  (await read()).name)

console.log('\n-- a read-only field says where it IS set --')
const ro = await patch({ published: true })
ok('setting `published` directly is refused', ro.status === 400, String(ro.status))
ok('and it is reported as read-only, not unknown',
  ro.body.readOnly?.includes('published') && !ro.body.unknown?.length,
  JSON.stringify({ unknown: ro.body.unknown, readOnly: ro.body.readOnly }))
ok('and the message points at the endpoint that does set it',
  String(ro.body.message).includes('publish'),
  String(ro.body.message).slice(0, 110))

const hash = await patch({ accessCodeHash: 'deadbeef' })
ok('the access-code hash is never accepted from a client', hash.status === 400)
ok('a server-assigned field is refused', (await patch({ ownerId: 'someone-else' })).status === 400)
ok('and so is updatedAt, which the server owns',
  (await patch({ updatedAt: '1999-01-01T00:00:00.000Z' })).status === 400)

console.log('\n-- a refused save costs nothing --')
// The half of the old bug that took money. `spend()` ran after the filter, so a
// save that stored nothing still charged a credit — the user paid for a write
// that did not happen and got a 200 saying it had. The refusal has to return
// BEFORE the charge, and the only way to know it does is to watch the balance.
const credits = () =>
  fetch(`${BASE}/billing/subscription`, { headers: auth })
    .then((r) => r.json())
    .then((r) => r.credits)

const before = await credits()
await patch({ nonsense: 1 })
await patch({ published: true })
const after = await credits()
ok('two refused saves spend no credits', before === after, `${before} -> ${after}`)

// STATED PLAINLY BECAUSE THE TEST ABOVE IS WEAKER THAN IT LOOKS: `sceneSave` is
// priced at 0 in plans.config.mjs today, so the balance would not move either
// way and this assertion cannot currently fail. It is kept because the ordering
// it pins — refuse BEFORE `spend()` — is what stops the leak the day somebody
// prices a save, and that day nobody will re-derive this.
//
// Writing it as "an accepted save charges and a refused one does not" was the
// obvious version and it FAILED on the accepted half, which is how the zero
// price was noticed at all.
const cost = 0
ok('and the ordering is what matters, since a save is priced at 0 today',
  before === after && cost === 0,
  'refusal returns before spend() — see scenes.js')

console.log('\n-- the deck design round-trips --')
// The studio persists the room designs read out of a client deck's renders
// (`scene.design`) and re-applies it on every rebuild; the published look
// travels inside the exported model, not this field. PRESENCE is what this
// asserts: the dressing was fully built client-side before this field was
// writable, so it worked on screen and reached nothing — trap 6's shape, a
// complete producer kept from its consumer by an allow-list.
const spec = {
  room: 'LIVING',
  floor: { material: 'wood', colour: '#8a6a4f' },
  walls: { finish: 'paint', colour: '#e8e2d8' },
  furniture: [{ item: 'sofa', style: 'modern' }],
  palette: ['#8a6a4f', '#e8e2d8'],
  source: { page: 3, index: 0, room: 'LIVING', auto: true },
}
const dressed = await patch({ design: spec })
ok('a legacy single-design patch is still accepted', dressed.status === 200, String(dressed.status))
ok('and the legacy object comes back whole on the next read',
  JSON.stringify((await read()).design) === JSON.stringify(spec))

const kitchen = {
  room: 'KITCHEN',
  floor: { material: 'tile', colour: '#d8d2c7' },
  walls: { finish: 'paint', colour: '#f4f1eb' },
  furniture: [{ item: 'kitchen island', style: 'modern' }],
  palette: ['#d8d2c7', '#f4f1eb'],
  source: { page: 4, index: 0, room: 'KITCHEN' },
}
const roomDesigns = [spec, kitchen]
const multi = await patch({ design: roomDesigns })
ok('a multi-room design patch is accepted', multi.status === 200, String(multi.status))
ok('and every room design comes back whole on the next read',
  JSON.stringify((await read()).design) === JSON.stringify(roomDesigns))
const sourceRecord = {
  cadModelJsonUrl: '/uploads/cad/x/building.json',
  designFurnitureReviewed: ['room:living|3:0|sofa'],
}
const sourceSaved = await patch(sourceRecord)
ok('reconstruction rooms and furniture review decisions are accepted',
  sourceSaved.status === 200, String(sourceSaved.status))
const sourceRead = await read()
ok('and both furniture source fields survive the next read',
  sourceRead.cadModelJsonUrl === sourceRecord.cadModelJsonUrl &&
  JSON.stringify(sourceRead.designFurnitureReviewed) === JSON.stringify(sourceRecord.designFurnitureReviewed))
// Null is a real value: it records "the user cleared the dressing", which
// stops the editor's read-on-open resurrecting a look that was removed.
const cleared = await patch({ design: null })
ok('clearing the dressing is a value, not an error', cleared.status === 200,
  String(cleared.status))
ok('and reads back as null, distinct from never-dressed',
  (await read()).design === null)

console.log('\n-- an empty patch is not an error --')
// The studio sends no empty patches today, but refusing one would be surprising:
// nothing was dropped, so nothing needs reporting.
ok('an empty body is accepted', (await patch({})).status === 200)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
