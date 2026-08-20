import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Tests for the atlas checker's PNG decoder.
 *
 * The decoder is hand-written — un-filtering scanlines by hand, including
 * Paeth — because the alternative is a dependency in the render worker, and
 * that means a dependency on every machine that ever runs a bake. The cost of
 * that choice is this file: a diagnostic that quietly decodes wrong is worse
 * than no diagnostic, because it would report a healthy atlas as broken (or,
 * far worse, a broken one as healthy) and send someone hunting through Blender.
 *
 * So each PNG filter type gets exercised against an image whose correct answer
 * is known by construction.
 *
 *   node check_atlas.test.mjs
 */

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

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Build an 8-bit RGB PNG from a pixel function, using one filter type
 * throughout.
 *
 * Filters are applied here the same way an encoder would, so a decoder that
 * gets any of them wrong produces visibly wrong brightness rather than a crash
 * — which is precisely the failure worth catching.
 */
function png(width, height, pixel, filter = 0) {
  const stride = width * 3
  const rows = []
  const raw = []

  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      row[x * 3] = r
      row[x * 3 + 1] = g
      row[x * 3 + 2] = b
    }
    raw.push(row)
  }

  for (let y = 0; y < height; y++) {
    const row = raw[y]
    const above = y > 0 ? raw[y - 1] : Buffer.alloc(stride)
    const encoded = Buffer.alloc(stride + 1)
    encoded[0] = filter

    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? row[x - 3] : 0
      const up = above[x]
      const upLeft = x >= 3 ? above[x - 3] : 0
      let value

      switch (filter) {
        case 0: value = row[x]; break
        case 1: value = row[x] - left; break
        case 2: value = row[x] - up; break
        case 3: value = row[x] - ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const dl = Math.abs(p - left)
          const du = Math.abs(p - up)
          const dul = Math.abs(p - upLeft)
          value = row[x] - (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft)
          break
        }
        default: throw new Error(`bad filter ${filter}`)
      }
      encoded[x + 1] = value & 0xff
    }
    rows.push(encoded)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // non-interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dir = mkdtempSync(join(tmpdir(), 'atlas-'))

function check(bytes, objects) {
  const file = join(dir, `a${Math.random().toString(36).slice(2)}.png`)
  writeFileSync(file, bytes)
  try {
    return {
      out: execFileSync(process.execPath, ['check_atlas.mjs', file, String(objects)], {
        encoding: 'utf8',
      }),
      code: 0,
    }
  } catch (error) {
    return { out: String(error.stdout ?? ''), code: error.status }
  }
}

// ---- A correct atlas: N cells lit in a ceil(sqrt(N)) grid ------------------
// 5 objects in a 3x3 grid means cells 0-4 lit, reading left to right, top to
// bottom — the order `assignLightmapUVs` packs them in.
const SIZE = 360
const grid = 3
const cell = SIZE / grid

const litCells = (count) => (x, y) => {
  const index = Math.floor(y / cell) * grid + Math.floor(x / cell)
  // Inset, so the checker's own inset samples lit pixels and the gutters
  // between cells stay black exactly as a real bake leaves them.
  const inX = x % cell > cell * 0.1 && x % cell < cell * 0.9
  const inY = y % cell > cell * 0.1 && y % cell < cell * 0.9
  return index < count && inX && inY ? [200, 200, 200] : [0, 0, 0]
}

for (const filter of [0, 1, 2, 3, 4]) {
  const result = check(png(SIZE, SIZE, litCells(5), filter), 5)
  ok(
    `filter ${filter}: 5 lit cells read as correct`,
    result.code === 0 && result.out.includes('exactly 5 cells lit'),
    result.out.match(/lit cells: \d+/)?.[0] ?? result.out.slice(0, 80),
  )
}

// ---- The failure this diagnostic exists for --------------------------------
// Everything stacked into one cell is what all three of the classic UV bugs
// produce. It must not read as success.
{
  const result = check(png(SIZE, SIZE, litCells(1), 0), 5)
  ok(
    'objects stacked in one cell is caught',
    result.code === 1 && result.out.includes('only 1 of 5'),
    result.out.match(/lit cells: \d+/)?.[0] ?? '',
  )
}

// ---- Bleed outside the cells ----------------------------------------------
{
  const result = check(png(SIZE, SIZE, litCells(9), 0), 5)
  ok(
    'more lit cells than objects is caught',
    result.code === 1 && result.out.includes('9 cells lit but only 5'),
  )
}

// ---- The threshold is not fooled by denoiser noise -------------------------
// A cell at 1% of range is empty-but-noisy, not lit. A threshold near zero
// would call this occupied and hide a real overlap.
{
  const noisy = (x, y) => {
    const base = litCells(5)(x, y)
    return base[0] > 0 ? base : [2, 2, 2] // ~0.8% of range
  }
  const result = check(png(SIZE, SIZE, noisy, 0), 5)
  ok(
    'faint noise in empty cells is not counted as lit',
    result.code === 0 && result.out.includes('exactly 5 cells lit'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
