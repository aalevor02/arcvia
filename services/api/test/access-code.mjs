/**
 * Access codes on published walkthroughs.
 *
 * Worth testing more carefully than most of this codebase, because the failure
 * mode is not a glitch — it is handing a pre-launch property to whoever was
 * forwarded the link. Two things must hold, and neither is visible from the
 * outside if it breaks:
 *
 *   1. A protected scene gives up its name and *nothing that renders it*.
 *      Returning the URLs and hiding the page would be theatre.
 *   2. The stored hash never leaves the server, even to the owner.
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

// ---- An account with a published scene -------------------------------------
const account = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Gate Tester',
    email: `gate+${stamp}@example.com`,
    password: 'correct horse battery staple',
    organisation: 'Gate Co',
  }),
}).then((r) => r.json())

const auth = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }
// Bodyless POSTs must not claim a JSON content-type: Fastify rejects an empty
// body when one is declared. The studio's own client gets this right by only
// setting the header when there is something to send.
const bearer = { Authorization: `Bearer ${account.token}` }
ok('registered', Boolean(account.token))

const scene = await fetch(`${BASE}/scenes/`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: `Gated ${stamp}` }),
})
  .then((r) => r.json())
  .then((r) => r.scene)

await fetch(`${BASE}/scenes/${scene.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({
    modelUrl: '/uploads/scenes/x/model.glb',
    bakedUrl: '/uploads/renders/x/atlas.png',
    panoramaUrl: '/uploads/renders/x/panorama.png',
    views: [{ id: 'a', name: 'Hall', position: [0, 1.6, 0], rotation: [0, 0] }],
  }),
})

const published = await fetch(`${BASE}/scenes/${scene.id}/publish`, {
  method: 'POST',
  headers: bearer,
}).then((r) => r.json())

const slug = published.scene.publishedSlug
ok('published', Boolean(slug), slug)

const publicUrl = `${BASE}/scenes/public/${slug}`

// ---- Open, before any code is set ------------------------------------------
{
  const body = await fetch(publicUrl).then((r) => r.json())
  ok('an open scene returns its model', body.scene?.modelUrl === '/uploads/scenes/x/model.glb')
  ok('an open scene returns its panorama',
    body.scene?.panoramaUrl === '/uploads/renders/x/panorama.png')
  ok('an open scene is not marked protected', !body.scene?.protected)
}

// ---- Setting a code --------------------------------------------------------
{
  const short = await fetch(`${BASE}/scenes/${scene.id}/access-code`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: 'abc' }),
  })
  ok('a too-short code is refused', short.status === 400, String(short.status))

  const set = await fetch(`${BASE}/scenes/${scene.id}/access-code`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: 'plum-4417' }),
  })
  ok('a real code is accepted', set.status === 200, String(set.status))
}

// ---- The gate --------------------------------------------------------------
// The heart of it: everything that renders the scene must be withheld.
{
  const body = await fetch(publicUrl).then((r) => r.json())
  const s = body.scene ?? {}

  ok('a protected scene says so', s.protected === true)
  ok('the name is still given', s.name?.startsWith('Gated'), s.name)

  ok('the model is withheld', s.modelUrl === undefined, String(s.modelUrl))
  ok('the bake is withheld', s.bakedUrl === undefined, String(s.bakedUrl))
  ok('the panorama is withheld', s.panoramaUrl === undefined, String(s.panoramaUrl))
  ok('the views are withheld', s.views === undefined)
  ok('nothing in the body looks like an upload path', !JSON.stringify(s).includes('/uploads/'))
}

// ---- Unlocking -------------------------------------------------------------
{
  const wrong = await fetch(`${publicUrl}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'not-the-code' }),
  })
  ok('a wrong code is refused', wrong.status === 401, String(wrong.status))
  const wrongBody = await wrong.json()
  ok('and leaks nothing on refusal', !JSON.stringify(wrongBody).includes('/uploads/'))

  const right = await fetch(`${publicUrl}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'plum-4417' }),
  })
  ok('the right code is accepted', right.status === 200, String(right.status))

  const body = await right.json()
  ok('unlocking returns a signed model proxy',
    /^\/scenes\/public\/[^/]+\/assets\/modelUrl\?/.test(body.scene?.modelUrl ?? ''))
  ok('unlocking returns a signed bake proxy',
    /^\/scenes\/public\/[^/]+\/assets\/bakedUrl\?/.test(body.scene?.bakedUrl ?? ''))
  ok('unlocking returns a signed panorama proxy',
    /^\/scenes\/public\/[^/]+\/assets\/panoramaUrl\?/.test(
      body.scene?.panoramaUrl ?? '',
    ))
  ok('unlocking exposes no raw storage URL',
    !JSON.stringify(body.scene).includes('/uploads/'))
  ok('unlocking returns the views', body.scene?.views?.length === 1)
}

// ---- The hash never leaves --------------------------------------------------
// Even to the owner. It shows up in devtools, in logs, and in whatever the
// client persists — and a four-character code cracks offline instantly.
{
  const mine = await fetch(`${BASE}/scenes/${scene.id}`, { headers: auth }).then((r) => r.json())
  const text = JSON.stringify(mine)

  ok('the owner is told a code is set', mine.scene?.protected === true)
  ok('but never given the hash', mine.scene?.accessCodeHash === undefined)
  ok('and no scrypt material appears anywhere', !text.includes('scrypt$'), text.slice(0, 60))
}

// ---- Clearing --------------------------------------------------------------
{
  await fetch(`${BASE}/scenes/${scene.id}/access-code`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: '' }),
  })

  const body = await fetch(publicUrl).then((r) => r.json())
  ok('clearing the code reopens the scene', body.scene?.modelUrl === '/uploads/scenes/x/model.glb')
  ok('and it is no longer marked protected', !body.scene?.protected)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
