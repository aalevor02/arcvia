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

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
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
// Two different answers hide behind one failed fetch, and collapsing them cost
// a real misreading: with no server running at all this file printed
// "0 passed, 0 failed" and exited 0, which is indistinguishable at a glance
// from a suite that ran. The same run with a server up reports 54. A test that
// succeeds without asserting anything is worse than one that fails.
//
//   no response at all  -> the HARNESS is wrong. Nobody started the server, so
//                          nothing here was tested and saying "0 failed" is a
//                          false green. Exit non-zero.
//   a reply saying the
//   engine is missing   -> a real skip. The Python engine is a separate
//                          install and a machine without it genuinely cannot
//                          run this. Exit zero, but say so loudly.
const health = await fetch(`${BASE}/cad/health`).then((r) => r.json()).catch(() => null)
if (health === null) {
  console.error(`FAIL  no API is listening on ${BASE} — start one before this suite:`)
  console.error('        cd services/api && node src/server.js')
  console.error('\n0 passed, 1 failed (nothing was tested)')
  process.exit(1)
}
if (!health.ok) {
  console.log(`SKIP  the reconstruction engine is not available (${health.reason ?? 'unknown reason'})`)
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

// ---- The double click -------------------------------------------------------
// A reconstruct costs 3 credits against a preview render's 1, and it takes tens
// of seconds during which the button gives no feedback — so this is the
// submission a user is most likely to click twice, and the one where doing so
// costs most. Before this guard, each click charged.
//
// Asserted here rather than in a suite of its own because the upload above is
// the expensive part and it has already happened.
const beforeDupe = await balanceOf()
const again = await post('/cad/jobs', account.token, { key, autoLayers: true })
const duplicate = await again.json()

ok('submitting the same drawing again returns 200, not 201',
  again.status === 200, String(again.status))
ok('and the same job, rather than a second reconstruction',
  duplicate.jobId === created.jobId, `${created.jobId} vs ${duplicate.jobId}`)
ok('and says it was deduplicated rather than passing an old job off as new',
  duplicate.deduplicated === true)
// Asserted on the reported charge rather than only on the balance. `balanceOf`
// returns null while billing is off, so a balance comparison here is null ===
// null and would pass however much the second click cost. The first submit
// above proves a real charge of 3; this proves the second is 0.
ok('and the second click charges nothing', duplicate.creditsCharged === 0,
  String(duplicate.creditsCharged))
ok('and the balance does not move either', (await balanceOf()) === beforeDupe,
  `${beforeDupe} -> ${await balanceOf()}`)

// What must NOT be merged. Different settings are a different reconstruction,
// and collapsing those would lose the user's work rather than their credits.
const different = await post('/cad/jobs', account.token, { key, autoLayers: false })
ok('different settings still get their own job',
  different.status === 201, String(different.status))

// `building` is the newest of those settings and the easiest to leave out of
// the fingerprint, because every other field is identical between the two
// requests: same drawing, same layers, same frame, same height. Left out, the
// second request deduplicates against the first and the reviewer is handed the
// WRONG VILLA along with a cheerful "not charged again" — a silent swap of one
// building for another, which is exactly the class of failure the fingerprint
// exists to prevent.
const buildingA = await post('/cad/jobs', account.token,
  { key, autoLayers: true, building: 0 })
const buildingB = await post('/cad/jobs', account.token,
  { key, autoLayers: true, building: 1 })
const pickedA = await buildingA.json()
const pickedB = await buildingB.json()

ok('asking for a building is a new job, not the whole-scope one',
  buildingA.status === 201 && pickedA.jobId !== created.jobId,
  `${buildingA.status} ${pickedA.jobId}`)
ok('and a DIFFERENT building is a different job again',
  buildingB.status === 201 && pickedB.jobId !== pickedA.jobId,
  `${buildingB.status} ${pickedA.jobId} vs ${pickedB.jobId}`)
ok('neither is reported as a duplicate',
  pickedA.deduplicated !== true && pickedB.deduplicated !== true)

// The mirror: the SAME building twice is still one submission. A fingerprint
// that separates everything is no fingerprint at all.
const buildingAgain = await post('/cad/jobs', account.token,
  { key, autoLayers: true, building: 0 })
const repeated = await buildingAgain.json()
ok('the same building twice deduplicates as any repeat does',
  buildingAgain.status === 200 && repeated.jobId === pickedA.jobId,
  `${buildingAgain.status} ${repeated.jobId} vs ${pickedA.jobId}`)
ok('and charges nothing the second time',
  repeated.creditsCharged === 0, String(repeated.creditsCharged))

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
  ok('and exposes the measured wall-pairing fraction',
    job.summary?.wallPairing === job.summary?.wallsPaired / job.summary?.walls,
    `${job.summary?.wallsPaired}/${job.summary?.walls} = ${job.summary?.wallPairing}`)
  ok('and settled on a unit', Boolean(job.summary?.unit), job.summary?.unit)
  ok('and recorded which layers it used', Array.isArray(job.summary?.layers),
    String(job.summary?.layers))
  ok('automatic selection refuses disproportionate and non-wall fallback layers',
    !job.summary?.layers?.includes('0') &&
      !job.summary?.layers?.includes('A6 SANITARY WARE'),
    String(job.summary?.layers))
  ok('and attributes billable and indoor wall run to source layers',
    Array.isArray(job.summary?.wallLayers) &&
      job.summary.wallLayers.length > 0 &&
      job.summary.wallLayers.every((layer) =>
        typeof layer.layer === 'string' &&
        Number.isFinite(layer.billableLength) &&
        Number.isFinite(layer.indoorLength)),
    JSON.stringify(job.summary?.wallLayers))
  ok('and exposes the verification findings for review',
    Array.isArray(job.summary?.verifyChecks), String(job.summary?.verifyChecks))
  ok('with a warning count consistent with those findings',
    job.summary?.verifyWarnings === job.summary?.verifyChecks?.filter((c) => c.level === 'warning').length,
    `${job.summary?.verifyWarnings}/${job.summary?.verifyChecks?.length}`)
  const wallRun = job.summary?.verifyChecks?.find((c) => c.name === 'wall-run-per-area')
  ok('and keeps the villa wall run inside the measured building band',
    wallRun?.level === 'info' && wallRun.value >= 0.6 && wallRun.value <= 1.6,
    JSON.stringify(wallRun))
  ok('and preserves every unhosted opening as a review target',
    Array.isArray(job.summary?.openingIssues) &&
      job.summary.openingIssues.length === job.summary.openingsUnassigned,
    `${job.summary?.openingIssues?.length}/${job.summary?.openingsUnassigned}`)
  ok('each target carries its source position and nearest modeled wall distance',
    job.summary?.openingIssues?.every((issue) =>
      typeof issue.block === 'string' &&
      Number.isFinite(issue.registeredPosition?.x) &&
      Number.isFinite(issue.registeredPosition?.y) &&
      Number.isFinite(issue.nearestWallDistance)),
    JSON.stringify(job.summary?.openingIssues))
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
