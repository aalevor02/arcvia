import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { resolveUrl } from '../src/lib/storage.js'

/**
 * The lightmap bake round trip.
 *
 * Covers the seam added for it: a scene's stored URL is a path, and the API
 * resolves that path against its own storage root before handing it to the
 * render worker. Both halves of that are worth a test — the resolution is
 * security-relevant (a scene record is user-writable through PATCH), and the
 * `prebakedUv` flag is invisible in every response, so nothing else would
 * notice if it stopped reaching the spec.
 *
 * Needs the API running: `npm run dev:api`.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const DB_PATH = resolve(process.env.DB_PATH ?? './.data/db.json')
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

// ---- resolveUrl, on its own -----------------------------------------------
// No server involved. These are the cases that decide whether a hostile
// modelUrl can make the render worker open an arbitrary file.
{
  const mine = resolveUrl('/uploads/scenes/u1/abc.glb')
  ok(
    'a stored path resolves under the upload root',
    typeof mine === 'string' && mine.includes(`uploads${sep}scenes${sep}u1`),
    mine,
  )

  ok(
    'an absolute URL passes through untouched',
    resolveUrl('https://cdn.example/x.glb') === 'https://cdn.example/x.glb',
  )

  ok('traversal out of the root is refused', resolveUrl('/uploads/../../etc/passwd') === null)

  // Percent-encoding is not decoded by `resolve`, so this stays inside the
  // root as a literal directory name rather than escaping. Asserted because
  // "it is refused" and "it is harmless" are different outcomes and the test
  // should say which one this is.
  const encoded = resolveUrl('/uploads/%2e%2e/%2e%2e/etc/passwd')
  ok('encoded traversal stays inside the root', typeof encoded === 'string' && !encoded.includes('..'))

  ok('an empty url is null', resolveUrl(null) === null && resolveUrl('') === null)
}

// ---- A minimal but genuinely valid GLB -------------------------------------
// Built here rather than checked in, so the test needs no fixture. Real
// structure, not just the four magic bytes: if sniffing ever gets stricter,
// this keeps passing for the right reason.
function glb() {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    'utf8',
  )
  // Chunks are 4-byte aligned; the JSON chunk pads with spaces.
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])

  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)

  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.write('JSON', 4, 'ascii')

  return Buffer.concat([header, chunkHeader, padded])
}

async function postScene(token, buffer, type) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type }), 'scene.glb')
  const res = await fetch(`${BASE}/uploads/scene`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// ---- Sign in ---------------------------------------------------------------
const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Bake Tester',
    email: `bake+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Bake Co',
  }),
}).then((r) => r.json())

const token = account.token
ok('registered', Boolean(token))

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ---- The upload route ------------------------------------------------------
ok('a scene upload needs a session', (await postScene(null, glb())).status === 401)

const wrongType = await postScene(
  token,
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]),
)
ok('a PNG is refused as a scene', wrongType.status === 415, String(wrongType.status))

const uploaded = await postScene(token, glb(), 'model/gltf-binary')
ok('a glb is accepted', uploaded.status === 201, uploaded.json.url ?? '')
ok(
  'stored as a path, not an absolute URL',
  Boolean(uploaded.json.url?.startsWith('/uploads/')),
  uploaded.json.url,
)
ok('stored with a .glb extension', Boolean(uploaded.json.url?.endsWith('.glb')))

// Content addressing: the same bytes twice is one file.
const again = await postScene(token, glb(), 'model/gltf-binary')
ok('identical bytes deduplicate', again.json.url === uploaded.json.url)

// ---- Through a scene, into a job -------------------------------------------
const scene = await fetch(`${BASE}/scenes/`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: `Bake ${stamp}` }),
})
  .then((r) => r.json())
  .then((r) => r.scene)
ok('scene created', Boolean(scene?.id))

// A bake before there is anything to bake.
const premature = await fetch(`${BASE}/render/jobs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sceneId: scene.id, preset: 'bake', prebakedUv: true }),
})
ok('baking an unsaved scene is refused', premature.status === 409, String(premature.status))

await fetch(`${BASE}/scenes/${scene.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ modelUrl: uploaded.json.url }),
})

const job = await fetch(`${BASE}/render/jobs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    sceneId: scene.id,
    preset: 'bake',
    prebakedUv: true,
    cameraPosition: { x: 1, y: 2, z: 3 },
  }),
})
const jobBody = await job.json()
ok('bake job accepted', job.status === 201, String(job.status))
ok('credits were charged up front', jobBody.creditsCharged > 0, String(jobBody.creditsCharged))

// ---- What actually reached the spec ----------------------------------------
// Read the store directly. Nothing on the wire exposes the spec, and that is
// exactly why it is worth checking: prebakedUv is silent everywhere else, so a
// regression would surface only as bakes that look subtly wrong.
const db = JSON.parse(await readFile(DB_PATH, 'utf8'))
const stored = db.renderJobs.find((j) => j.id === jobBody.jobId)
ok('the job persisted', Boolean(stored))
ok('prebakedUv reached the spec', stored?.spec?.prebakedUv === true)
ok(
  'inputUrl was resolved to a local path',
  typeof stored?.spec?.inputUrl === 'string' && !stored.spec.inputUrl.startsWith('/uploads/'),
  stored?.spec?.inputUrl,
)
ok('the spec is a bake, not a render', stored?.spec?.type === 'bake')
// Y-up to Z-up, done once, in the route.
ok(
  'the camera was converted to Blender axes',
  stored?.spec?.camera?.position?.y === -3 && stored?.spec?.camera?.position?.z === 2,
  JSON.stringify(stored?.spec?.camera?.position),
)

// A model that did not come from the studio must still be unwrapped by Blender.
const plain = await fetch(`${BASE}/render/jobs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ sceneId: scene.id, preset: 'bake' }),
}).then((r) => r.json())
const plainStored = JSON.parse(await readFile(DB_PATH, 'utf8')).renderJobs.find(
  (j) => j.id === plain.jobId,
)
ok('without the flag the worker unwraps its own', plainStored?.spec?.prebakedUv === false)

// ---- 360 panorama contract -----------------------------------------------
const panorama = await fetch(BASE + '/render/jobs', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    sceneId: scene.id,
    preset: 'panorama',
    cameraPosition: { x: 4, y: 5, z: 1.7 },
  }),
})
const panoramaBody = await panorama.json()
ok('panorama job accepted', panorama.status === 201, String(panorama.status))
ok('panorama charges its published tariff', panoramaBody.creditsCharged === 8,
  String(panoramaBody.creditsCharged))
const panoramaStored = JSON.parse(await readFile(DB_PATH, 'utf8')).renderJobs.find(
  (j) => j.id === panoramaBody.jobId,
)
ok('panorama is a 2:1 4096x2048 render',
  panoramaStored?.spec?.width === 4096 && panoramaStored?.spec?.height === 2048,
  String(panoramaStored?.spec?.width) + 'x' + String(panoramaStored?.spec?.height))
ok('equirectangular projection reaches the nested worker camera',
  panoramaStored?.spec?.camera?.projection === 'equirectangular',
  String(panoramaStored?.spec?.camera?.projection))
ok('projection is not stranded at the top level', panoramaStored?.spec?.projection === undefined)
ok('panorama remains a render job, not a bake', panoramaStored?.spec?.type === 'render')

// Tidy up. Both jobs are real, and a local worker will happily spend minutes
// of CPU on them; a test suite should not leave Blender running behind it.
for (const id of [jobBody.jobId, plain.jobId, panoramaBody.jobId].filter(Boolean)) {
  const cancelled = await fetch(`${BASE}/render/jobs/${id}/cancel`, {
    method: 'POST',
    // An empty request body must not be labelled as JSON. Fastify rejects an
    // empty `application/json` body before the route can cancel the job.
    headers: { Authorization: auth.Authorization },
  })
  ok(`cancelled ${id}`, cancelled.status === 200, String(cancelled.status))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
