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


// ---- Presentation decks -----------------------------------------------------
/**
 * A PDF is what people actually have.
 *
 * The drawings that reach this product are almost never drawings. They are the
 * deck the architect presented: floor plans on one page, twenty captioned
 * interior renders on the rest. These cover the path from that file to a
 * traceable image, which is the difference between the product working on real
 * input and working on input we asked for.
 *
 * The fixture is built here rather than committed. A checked-in PDF would be an
 * opaque binary nobody can review, and building it in twenty lines proves the
 * reader works on a document whose contents are known exactly.
 */
function pdf(pages) {
  const chunks = []
  let length = 0
  const push = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1')
    chunks.push(buffer)
    length += buffer.length
    return length
  }

  const offsets = []
  const object = (body) => {
    const id = offsets.length + 1
    // Recorded *before* writing, because the cross-reference table stores where
    // each object begins. An xref pointing one byte past the object header is
    // the classic way to produce a file that opens in a forgiving reader and
    // fails in a strict one — which is the worst of both worlds in a test.
    offsets.push(length)
    push(`${id} 0 obj\n`)
    push(body)
    push('\nendobj\n')
    return id
  }

  push('%PDF-1.4\n')

  const pageIds = []
  const kids = []
  const bodies = []

  for (const { caption, image, width, height } of pages) {
    const compressed = deflateSync(image)
    const imageId = object(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
            `/Length ${compressed.length} >>\nstream\n`,
          'latin1',
        ),
        compressed,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    )

    const content =
      `q 840 0 0 400 60 100 cm /Im0 Do Q\n` +
      `BT /F1 18 Tf 60 60 Td (${caption.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
    const contentId = object(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    )
    bodies.push({ imageId, contentId })
  }

  const fontId = object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = offsets.length + 1 + bodies.length + 1 // pages object, after the page objects

  for (const { imageId, contentId } of bodies) {
    pageIds.push(
      object(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 960 540] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      ),
    )
  }
  kids.push(...pageIds.map((id) => `${id} 0 R`))

  const realPagesId = object(
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageIds.length} >>`,
  )
  const catalogId = object(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`)

  const xref = length
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`)
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  }
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root ${catalogId} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`,
  )

  return Buffer.concat(chunks)
}

/** A line drawing: white paper, two nested rectangles. */
function drawingPixels(width, height) {
  const pixels = Buffer.alloc(width * height * 3, 0xff)
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = (y * width + x) * 3
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
  }
  for (const inset of [30, 36]) {
    for (let x = inset; x < width - inset; x++) {
      set(x, inset)
      set(x, height - inset)
    }
    for (let y = inset; y < height - inset; y++) {
      set(inset, y)
      set(width - inset, y)
    }
  }
  return pixels
}

/** A render: continuous tone, no paper. */
function renderPixels(width, height) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let i = 0; i < pixels.length; i++) pixels[i] = 40 + ((i * 37) % 160)
  return pixels
}

const deck = pdf([
  { caption: 'Ground Floor Plan', image: drawingPixels(400, 300), width: 400, height: 300 },
  {
    caption: 'GROUND FLOOR - BEDROOM (NORTH ORIENTED)',
    image: renderPixels(400, 300),
    width: 400,
    height: 300,
  },
])

const deckForm = new FormData()
deckForm.append('file', new Blob([deck], { type: 'application/pdf' }), 'deck.pdf')
const deckUpload = await fetch(`${BASE}/uploads/floorplan`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: deckForm,
}).then((r) => r.json())
ok('a PDF uploads', Boolean(deckUpload.url), deckUpload.url ?? deckUpload.message)
ok('and is stored as a PDF', String(deckUpload.url ?? '').endsWith('.pdf'), deckUpload.url)

// A PDF can carry script and these URLs need no session, so it must never be
// served inline into this origin.
if (deckUpload.url) {
  const served = await fetch(BASE + deckUpload.url)
  ok(
    'a stored PDF is served as an attachment',
    (served.headers.get('content-disposition') ?? '').includes('attachment'),
    served.headers.get('content-disposition') ?? 'none',
  )
}

const anonOutline = await call('/detect/document', {
  method: 'POST',
  body: { url: deckUpload.url },
})
ok('reading a document requires a session', anonOutline.status === 401, String(anonOutline.status))

const foreign = await call('/detect/document', {
  method: 'POST',
  body: { url: 'http://169.254.169.254/latest/meta-data/' },
  token,
})
ok('and refuses a URL we do not hold', foreign.status === 400 || foreign.status === 404,
  String(foreign.status))

const outline = await call('/detect/document', {
  method: 'POST',
  body: { url: deckUpload.url },
  token,
})

if (health.json.available && health.json.detector?.reads_pdf) {
  ok('a deck reads', outline.status === 200, String(outline.status))
  const sheets = outline.json.sheets ?? []
  ok('both pages are found', sheets.length === 2, String(sheets.length))

  const plan = sheets.find((sheet) => sheet.kind === 'plan')
  const render = sheets.find((sheet) => sheet.kind === 'render')
  ok('the floor plan is recognised as a plan', Boolean(plan), JSON.stringify(sheets.map((s) => s.kind)))
  ok('the interior is recognised as a render', Boolean(render))

  // The association that saves a user twenty-two manual decisions.
  ok('the render knows its room', render?.room === 'Bedroom', String(render?.room))
  ok('and its floor', render?.floor === 'Ground', String(render?.floor))
  ok('and carries a palette', (render?.palette?.length ?? 0) > 0, JSON.stringify(render?.palette))

  const extracted = await call('/detect/document/page', {
    method: 'POST',
    body: { url: deckUpload.url, page: plan?.page ?? 1, index: plan?.index ?? 0 },
    token,
  })
  ok('a page extracts into storage', extracted.status === 201, String(extracted.status))
  ok('as an image, not a PDF', String(extracted.json.url ?? '').endsWith('.png'),
    extracted.json.url ?? extracted.json.message)

  // The point of extracting it: the ordinary detector can now read it.
  if (extracted.json.url) {
    const traced = await call('/detect/', {
      method: 'POST',
      body: { url: extracted.json.url },
      token,
    })
    ok('the extracted plan detects', traced.status === 200, String(traced.status))
    ok('and yields walls', (traced.json.walls?.length ?? 0) >= 4, String(traced.json.walls?.length))
  }

  const missingPage = await call('/detect/document/page', {
    method: 'POST',
    body: { url: deckUpload.url, page: 99, index: 0 },
    token,
  })
  ok('a page that is not there is a 4xx, not a 500',
    missingPage.status >= 400 && missingPage.status < 500, String(missingPage.status))
} else {
  ok('without a reader, a deck gives 503', outline.status === 503, String(outline.status))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
