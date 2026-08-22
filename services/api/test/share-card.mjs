/**
 * `/p/<slug>/` — the HTML a link preview actually reads.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * The visualisation app sets its title and Open Graph tags from JavaScript,
 * which is right for a reader and worthless for a crawler. WhatsApp and Slack
 * fetch the file and read what is in it. So the only test that means anything
 * here is one that fetches the HTML and looks at the bytes — asserting on a
 * rendered DOM would pass against the very bug this route fixes.
 *
 * Two clients are published, because "the card is right" is not the claim. The
 * claim is that client B's link never shows client A's development, and that
 * needs two.
 *
 * The escaping assertions are the ones to keep. Names, places and taglines are
 * typed by users into the studio and land inside HTML attributes on a page
 * served to that user's clients.
 *
 * Spawns its own server on its own port and database, like publications.mjs,
 * so it cannot collide with a session using the real one.
 *
 * Run: node test/share-card.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8813
const BASE = `http://127.0.0.1:${PORT}`

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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-share-'))

// A stand-in for the built app shell. Deliberately shaped like the real one —
// including og:description wrapped across three lines, because that is what
// makes the tag-anchored matching in share.js necessary rather than optional.
const shell = join(dir, 'shell.html')
await writeFile(
  shell,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Project walkthrough</title>
    <meta name="description" content="An interactive presentation of a residential project." />
    <meta property="og:title" content="Project walkthrough" />
    <meta
      property="og:description"
      content="An interactive presentation of a residential project."
    />
    <meta property="og:type" content="website" />
  </head>
  <body><div id="app"></div></body>
</html>
`,
  'utf8',
)

const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(dir, 'db.json'),
    ARCVIA_APP_SHELL: shell,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (c) => (serverLog += c))
server.stderr.on('data', (c) => (serverLog += c))

async function ready(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await fetch(`${BASE}/publications/public/nothing-here`)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return false
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

/** The raw bytes, which is the whole point of this file. */
async function page(path) {
  const response = await fetch(`${BASE}${path}`)
  return { status: response.status, type: response.headers.get('content-type'), html: await response.text() }
}

const meta = (html, attribute, name) =>
  html.match(new RegExp(`<meta\\s[^>]*${attribute}="${name}"[^>]*content="([^"]*)"`, 'i'))?.[1]
const title = (html) => html.match(/<title>([^<]*)<\/title>/i)?.[1]

/** Publish a project and return its slug. */
async function publish(token, name, project) {
  const created = await call('/publications', { method: 'POST', token, body: { name } })
  const id = created.payload.publication.id
  await call(`/publications/${id}`, { method: 'PATCH', token, body: { project } })
  const done = await call(`/publications/${id}/publish`, { method: 'POST', token })
  return done.payload.url
}

try {
  if (!(await ready())) {
    console.log('FAIL  the test server started')
    console.log(serverLog.slice(-2000))
    process.exit(1)
  }
  ok('the test server started', true, `port ${PORT}`)

  const stamp = Date.now()
  const alice = await call('/auth/register', {
    method: 'POST',
    body: { email: `alice-${stamp}@test.local`, password: 'correct-horse-1', name: 'Alice' },
  })
  const bob = await call('/auth/register', {
    method: 'POST',
    body: { email: `bob-${stamp}@test.local`, password: 'correct-horse-2', name: 'Bob' },
  })
  const aliceToken = alice.payload.token
  const bobToken = bob.payload.token

  const base = { script: 'S', villaTypes: [], gallery: [] }

  const urlA = await publish(aliceToken, 'Riverside Villas', {
    ...base,
    slug: 'riverside-villas',
    name: 'Riverside Villas',
    place: 'Alibaug',
    tagline: 'Twelve homes on the estuary.',
    sections: [{ id: 's', kicker: '', heading: '', body: [], image: 'https://cdn.test/river.jpg' }],
  })
  const urlB = await publish(bobToken, 'Hill Court', {
    ...base,
    slug: 'hill-court',
    name: 'Hill Court',
    place: 'Lonavala',
    tagline: 'Nine terraced houses.',
  })
  ok('two projects publish', urlA === '/p/riverside-villas/' && urlB === '/p/hill-court/', `${urlA} ${urlB}`)

  // ---- The card names the project the link names --------------------------
  const a = await page(urlA)
  ok('the page is served as HTML', a.status === 200 && /text\/html/.test(a.type ?? ''), `${a.status} ${a.type}`)
  ok('the title is the project, in the FILE', title(a.html) === 'Riverside Villas — Alibaug', title(a.html))
  ok('og:title matches', meta(a.html, 'property', 'og:title') === 'Riverside Villas — Alibaug')
  ok('og:description is the tagline', meta(a.html, 'property', 'og:description') === 'Twelve homes on the estuary.',
     meta(a.html, 'property', 'og:description'))
  ok('description is set too', meta(a.html, 'name', 'description') === 'Twelve homes on the estuary.')

  // The three-line og:description in the shell is why this is asserted apart
  // from og:title: a line-anchored replacement gets one and misses the other.
  ok('the multi-line meta was rewritten, not skipped',
     !a.html.includes('An interactive presentation of a residential project.'))

  // ---- The claim that matters ---------------------------------------------
  const b = await page(urlB)
  ok("client B's link never mentions client A",
     !/Riverside|Alibaug|estuary/i.test(b.html), 'no cross-project leak')
  ok("and carries B's own card", title(b.html) === 'Hill Court — Lonavala', title(b.html))

  // ---- Escaping: user-typed text inside an HTML attribute -----------------
  const urlX = await publish(aliceToken, 'Quote Test', {
    ...base,
    slug: 'quote-test',
    name: 'The "Grand" Estate',
    place: 'Pune & Nashik',
    tagline: '<script>alert(1)</script> luxury',
  })
  const x = await page(urlX)
  ok('a double quote cannot end the attribute',
     meta(x.html, 'property', 'og:title') === 'The &quot;Grand&quot; Estate — Pune &amp; Nashik',
     meta(x.html, 'property', 'og:title'))
  ok('a script tag is escaped, not embedded', !/<script>alert/.test(x.html))
  ok('and survives as text in the description',
     (meta(x.html, 'property', 'og:description') ?? '').startsWith('&lt;script&gt;'),
     meta(x.html, 'property', 'og:description'))
  ok('the ampersand is escaped once, not twice', !/&amp;amp;/.test(x.html))

  // ---- Images: truthful or absent -----------------------------------------
  ok('an absolute image URL is offered', meta(a.html, 'property', 'og:image') === 'https://cdn.test/river.jpg')
  ok('and upgrades the Twitter card', meta(a.html, 'name', 'twitter:card') === 'summary_large_image')
  ok('a project with no absolute image offers none', meta(b.html, 'property', 'og:image') === undefined)
  ok('and falls back to the small card', meta(b.html, 'name', 'twitter:card') === 'summary')

  const keyed = await publish(bobToken, 'Keyed Images', {
    ...base, slug: 'keyed', name: 'Keyed', place: 'X',
    sections: [{ id: 's', kicker: '', heading: '', body: [], image: 'renders/abc123.png' }],
  })
  ok('a storage key is NOT passed off as a URL',
     meta((await page(keyed)).html, 'property', 'og:image') === undefined)

  // ---- og:url --------------------------------------------------------------
  ok('og:url is the address it was reached at',
     meta(a.html, 'property', 'og:url') === `${BASE}/p/riverside-villas/`,
     meta(a.html, 'property', 'og:url'))

  // ---- Slugs that name nothing --------------------------------------------
  const missing = await page('/p/no-such-project/')
  ok('an unknown slug is 404', missing.status === 404, String(missing.status))
  ok('but still serves the app', missing.html.includes('id="app"'))
  ok('with the NEUTRAL card, not the last project served',
     title(missing.html) === 'Project walkthrough' && !/Riverside|Hill Court/.test(missing.html),
     title(missing.html))

  // Unpublishing keeps the slug; the card must stop naming the project.
  const list = await call('/publications', { token: bobToken })
  const hill = list.payload.publications.find((p) => p.slug === 'hill-court')
  await call(`/publications/${hill.id}/unpublish`, { method: 'POST', token: bobToken })
  const gone = await page('/p/hill-court/')
  ok('an unpublished project stops sharing its name',
     gone.status === 404 && !/Hill Court|Lonavala/.test(gone.html), String(gone.status))

  // ---- Both spellings of the address --------------------------------------
  const noSlash = await page('/p/riverside-villas')
  ok('the address works without the trailing slash',
     noSlash.status === 200 && title(noSlash.html) === 'Riverside Villas — Alibaug',
     `${noSlash.status} ${title(noSlash.html)}`)

  // ---- A renamed project must not keep its old card -----------------------
  ok('the response is cacheable but briefly',
     /max-age=([1-9]\d{0,2}|[1-2]\d{3})\b/.test(
       (await fetch(`${BASE}${urlA}`)).headers.get('cache-control') ?? ''),
     (await fetch(`${BASE}${urlA}`)).headers.get('cache-control'))
} finally {
  server.kill()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
