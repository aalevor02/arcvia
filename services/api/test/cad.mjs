import { readFile } from 'node:fs/promises'

/**
 * CAD reconstruction, end to end through the API.
 *
 * Uploads a real DXF, surveys it, queues a reconstruction, polls it to
 * completion and checks that a GLB came back — exercising the seam where the
 * Python engine meets the Node platform, which is the part neither side's own
 * tests can cover.
 *
 * Needs the API running (`npm run dev:api`) and the engine's virtualenv at
 * services/reconstruct/.venv. Skips cleanly if the engine is not installed,
 * because a missing Python environment is a setup fact rather than a failure.
 */

const BASE = 'http://localhost:8787'
const DRAWING = 'A:/Projects/CasaAltinho/_work/cad/dxf/DOWN VILLA -WD 22-1-24.dxf'
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

const post = (path, token, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

// ---- Is the engine even here? ----------------------------------------------
const health = await fetch(`${BASE}/cad/health`).then((r) => r.json()).catch(() => null)
if (!health?.ok) {
  console.log(`SKIP  the reconstruction engine is not available (${health?.reason ?? 'no response'})`)
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}
ok('the engine reports healthy', health.ok === true)

// ---- Sign in ---------------------------------------------------------------
const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'CAD Tester',
    email: `cad${stamp}@example.com`,
    organisation: `CAD Co ${stamp}`,
    password: 'password123',
  }),
}).then((r) => r.json())
ok('registered', Boolean(account.token))

const balanceOf = async () =>
  (await fetch(`${BASE}/billing/credits`, {
    headers: { Authorization: `Bearer ${account.token}` },
  }).then((r) => r.json().catch(() => ({})))).credits ?? null

// ---- Upload a real drawing --------------------------------------------------
const bytes = await readFile(DRAWING)
const form = new FormData()
form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'villa.dxf')

const upload = await fetch(`${BASE}/uploads/floorplan`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${account.token}` },
  body: form,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

ok('a real DXF uploads', upload.status === 201, `${upload.status} ${upload.json.message ?? ''}`)
ok('sniffed as DXF despite an octet-stream mimetype',
  upload.json.url?.endsWith('.dxf'), upload.json.url)
ok('stored under the cad prefix, not floorplans',
  String(upload.json.key).startsWith('cad/'), upload.json.key)
ok(`${(bytes.length / 1024 / 1024).toFixed(1)} MB is inside the raised limit`,
  upload.status === 201)

const key = upload.json.key

// ---- Survey: free, synchronous, and the reason it exists --------------------
const before = await balanceOf()
const survey = await post('/cad/survey', account.token, { key }).then((r) => r.json())

ok('the survey reads the drawing', Array.isArray(survey.layers), typeof survey.layers)
ok('it reports a unit', typeof survey.unit === 'string', survey.unit)
ok('and the scale candidates, because $INSUNITS lies',
  Array.isArray(survey.scaleCandidates) && survey.scaleCandidates.length > 0,
  String(survey.scaleCandidates?.length))
ok('it classifies the blocks it found',
  typeof survey.census?.byLabel === 'object', JSON.stringify(survey.census?.byLabel))
ok('the survey is free', (await balanceOf()) === before, `${before} -> ${await balanceOf()}`)

// ---- Layers: the evidence, also free ----------------------------------------
const layers = await post('/cad/layers', account.token, { key }).then((r) => r.json())
ok('the layer report scores each layer', Array.isArray(layers.scores))
ok('and names what the name heuristic would pick', Array.isArray(layers.byName))

// ---- Reconstruct: the job ---------------------------------------------------
const submit = await post('/cad/jobs', account.token, { key, autoLayers: true })
const created = await submit.json()

ok('the job is accepted', submit.status === 201, `${submit.status} ${created.message ?? ''}`)
ok('and charges for it', created.creditsCharged === 3, String(created.creditsCharged))

let job = null
const deadline = Date.now() + 300_000
while (Date.now() < deadline) {
  job = await fetch(`${BASE}/cad/jobs/${created.jobId}`, {
    headers: { Authorization: `Bearer ${account.token}` },
  }).then((r) => r.json())
  if (['done', 'failed', 'cancelled'].includes(job.status)) break
  await new Promise((r) => setTimeout(r, 2000))
}

ok('the job finishes', job?.status === 'done', `${job?.status} ${job?.error ?? ''}`)

if (job?.status === 'done') {
  ok('it produced a GLB', typeof job.outputUrl === 'string' && job.outputUrl.endsWith('.glb'),
    job.outputUrl)

  const glb = await fetch(BASE + job.outputUrl)
  ok('the GLB is served back', glb.status === 200, String(glb.status))
  ok('with a glTF content type', glb.headers.get('content-type') === 'model/gltf-binary',
    glb.headers.get('content-type'))

  const head = Buffer.from(await glb.arrayBuffer()).subarray(0, 4).toString('ascii')
  ok('and the bytes really are a GLB', head === 'glTF', head)

  // The summary is what a reviewer acts on — a percentage that has reached 100
  // tells them nothing about whether to accept the import.
  ok('the job reports what it found', typeof job.summary === 'object')
  ok('it enclosed rooms', (job.summary?.rooms ?? 0) > 0, String(job.summary?.rooms))
  ok('some of them are named', (job.summary?.named ?? 0) > 0, String(job.summary?.named))
  ok('it built walls', (job.summary?.walls ?? 0) > 0, String(job.summary?.walls))
  ok('and settled on a unit', Boolean(job.summary?.unit), job.summary?.unit)
  ok('and recorded which layers it used', Array.isArray(job.summary?.layers),
    String(job.summary?.layers))
  ok('a successful job is not refunded', !job.refunded, String(job.refunded))

  // The plan is the artefact a reviewer can actually read. It comes out of the
  // same job rather than a second one, because it costs seconds and no renderer.
  ok('it also produced a plan drawing',
    typeof job.planUrl === 'string' && job.planUrl.endsWith('.svg'), job.planUrl)

  if (job.planUrl) {
    const svg = await fetch(BASE + job.planUrl)
    ok('the plan is served back', svg.status === 200, String(svg.status))
    // An SVG can carry script and these URLs are unauthenticated and
    // same-origin, so it must never render inline in this origin.
    ok('and forced to download, never inline',
      svg.headers.get('content-disposition') === 'attachment',
      svg.headers.get('content-disposition'))
    const text = await svg.text()
    ok('it really is an svg', text.startsWith('<svg'), text.slice(0, 24))
    ok('with the poche filled solid', text.includes('#1B1E24'))
  }
}

// ---- Refusals ---------------------------------------------------------------
const notMine = await fetch(`${BASE}/cad/jobs/${created.jobId}`).then((r) => r.status)
ok('an unauthenticated poll is refused', notMine === 401, String(notMine))

const missing = await post('/cad/jobs', account.token, { key: 'cad/nobody/nope.dxf' })
ok('an unknown key is a 404, not a crash', missing.status === 404, String(missing.status))

const noKey = await post('/cad/survey', account.token, {})
ok('a missing key is a 400', noKey.status === 400, String(noKey.status))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
