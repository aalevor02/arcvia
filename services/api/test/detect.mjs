import { deflateSync, crc32 } from 'node:zlib'

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

/**
 * A synthetic floor plan: a white sheet with a black rectangle drawn twice,
 * inner and outer, so it has two wall faces like a real drawing.
 *
 * Generated rather than committed as a fixture, and generated *large enough to
 * be a plausible drawing* — the detector rejects tiny images outright, so an
 * 8x8 placeholder only ever exercises the failure path.
 */
const WIDTH = 400
const HEIGHT = 300

function png() {
  const pixels = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1), 0xff)

  // Each scanline is prefixed with a filter-type byte, and it must be 0 (None).
  // Filling the whole buffer with 0xff sets it to 255, which is not a valid
  // filter type — the file then decodes as corrupt and the detector rejects it,
  // which looks exactly like a product bug and is not one.
  for (let y = 0; y < HEIGHT; y++) pixels[y * (WIDTH * 3 + 1)] = 0

  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
    const offset = y * (WIDTH * 3 + 1) + 1 + x * 3
    pixels[offset] = 0
    pixels[offset + 1] = 0
    pixels[offset + 2] = 0
  }

  // Two nested rectangles 6 px apart: the two faces of a wall.
  for (const inset of [40, 46]) {
    for (let x = inset; x < WIDTH - inset; x++) {
      set(x, inset)
      set(x, HEIGHT - inset)
    }
    for (let y = inset; y < HEIGHT - inset; y++) {
      set(inset, y)
      set(WIDTH - inset, y)
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const call = (path, opts = {}) =>
  fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

// ---- Session and an uploaded drawing ---------------------------------------
const account = await call('/auth/register', {
  method: 'POST',
  body: {
    name: 'Detect Tester',
    email: `detect${stamp}@example.com`,
    organisation: `Detect Co ${stamp}`,
    password: 'password123',
  },
})
const token = account.json.token
ok('registered', Boolean(token))

const form = new FormData()
form.append('file', new Blob([png()], { type: 'image/png' }), 'plan.png')
const upload = await fetch(`${BASE}/uploads/floorplan`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
}).then((r) => r.json())
ok('uploaded a drawing', Boolean(upload.url), upload.url)

// ---- Health -----------------------------------------------------------------
const health = await call('/detect/health')
ok('health always answers', health.status === 200)
ok('health reports availability as a boolean',
  typeof health.json.available === 'boolean', String(health.json.available))

// ---- Auth --------------------------------------------------------------------
const anon = await call('/detect/', { method: 'POST', body: { url: upload.url } })
ok('detection requires a session', anon.status === 401, String(anon.status))

// ---- Input validation: only our own storage ---------------------------------
// The route resolves a key locally and never fetches a caller-supplied URL.
// Without that this is a server-side request forgery hole.
for (const [label, url] of [
  ['an absolute external URL', 'http://169.254.169.254/latest/meta-data/'],
  ['a file URL', 'file:///etc/passwd'],
  ['a path outside the upload prefix', '/etc/passwd'],
  ['a different host with a matching path', 'http://evil.example/uploads/x.png'],
]) {
  const res = await call('/detect/', { method: 'POST', body: { url }, token })
  ok(`refused: ${label}`, res.status === 400 || res.status === 404, String(res.status))
}

const missing = await call('/detect/', { method: 'POST', body: {}, token })
ok('refused: no url at all', missing.status === 400, String(missing.status))

const unknown = await call('/detect/', {
  method: 'POST',
  body: { url: '/uploads/floorplans/nobody/deadbeef.png' },
  token,
})
ok('refused: a key we do not hold', unknown.status === 404, String(unknown.status))

// ---- The happy path, if the detector is running -----------------------------
const run = await call('/detect/', { method: 'POST', body: { url: upload.url }, token })

if (health.json.available) {
  ok('detection returns a result', run.status === 200, String(run.status))
  ok('result carries image dimensions',
    run.json.width === WIDTH && run.json.height === HEIGHT,
    `${run.json.width}x${run.json.height}`)
  ok('result carries wall and object arrays',
    Array.isArray(run.json.walls) && Array.isArray(run.json.objects))
  ok('it found the rectangle we drew', (run.json.walls?.length ?? 0) >= 4,
    String(run.json.walls?.length))
} else {
  // The detector is a separate Python process. When it is not running the API
  // must say so plainly rather than reporting a generic failure.
  ok('a stopped detector gives 503, not 500', run.status === 503, String(run.status))
  ok('with an actionable message',
    /not running|floor-plan reader/i.test(run.json.message ?? ''), run.json.message)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
