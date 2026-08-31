import { deflateSync } from 'node:zlib'
import { crc32 } from 'node:zlib'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
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

// ---- A real 1x1 PNG, built here so the test needs no fixture file ----------
function png() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function upload(token, buffer, filename, type) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type }), filename)
  const res = await fetch(`${BASE}/uploads/floorplan`, {
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
    name: 'Upload Tester',
    email: `upload${stamp}@example.com`,
    organisation: `Upload Co ${stamp}`,
    password: 'password123',
  }),
}).then((r) => r.json())

ok('registered', Boolean(account.token))

// ---- Happy path ------------------------------------------------------------
const first = await upload(account.token, png(), 'plan.png', 'image/png')
ok('png upload accepted', first.status === 201, String(first.status))
ok('returns a url under the public prefix', String(first.json.url).startsWith('/uploads/'), first.json.url)
ok('key is scoped to the user', String(first.json.key).includes('floorplans/'), first.json.key)

// The stored file must actually come back, with the right type.
const fetched = await fetch(BASE + first.json.url)
ok('stored file is served back', fetched.status === 200, String(fetched.status))
ok('served with an image content type', fetched.headers.get('content-type') === 'image/png',
  fetched.headers.get('content-type'))
ok('served with nosniff', fetched.headers.get('x-content-type-options') === 'nosniff')
ok('cached immutably', /immutable/.test(fetched.headers.get('cache-control') ?? ''))

// ---- Content addressing ----------------------------------------------------
const second = await upload(account.token, png(), 'different-name.png', 'image/png')
ok('identical bytes deduplicate to the same key', second.json.key === first.json.key,
  `${first.json.key} vs ${second.json.key}`)

// ---- Rejections ------------------------------------------------------------
const noAuth = await upload(null, png(), 'plan.png', 'image/png')
ok('upload requires a session', noAuth.status === 401, String(noAuth.status))

// A file that CLAIMS to be a png but is not. The declared type must not be
// trusted — this is the whole reason for sniffing.
const liar = await upload(
  account.token,
  Buffer.from('<html><script>alert(1)</script></html>'),
  'plan.png',
  'image/png',
)
ok('a non-image claiming to be a png is rejected', liar.status === 415, String(liar.status))

const svg = await upload(
  account.token,
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  'plan.svg',
  'image/svg+xml',
)
ok('svg is rejected (it can carry script)', svg.status === 415, String(svg.status))

// ---- Path traversal --------------------------------------------------------
for (const attempt of [
  '/uploads/../../../../.data/db.json',
  '/uploads/..%2f..%2f..%2fdb.json',
  '/uploads/floorplans/../../../package.json',
]) {
  const res = await fetch(BASE + attempt, { redirect: 'manual' })
  ok(`traversal blocked: ${attempt.slice(9, 45)}`, res.status === 404 || res.status === 400,
    String(res.status))
}

const missing = await fetch(`${BASE}/uploads/floorplans/nope/deadbeef.png`)
ok('unknown key is 404', missing.status === 404, String(missing.status))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
