#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/**
 * Check a baked lightmap atlas for the failures that produce no error.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every way a bake goes wrong produces a file. Blender exits 0, the job is
 * marked done, the atlas loads, and the model is lit by nonsense. The three
 * known causes all look identical from outside:
 *
 *   1. `uv_layers.new()` does not unwrap — every object spans 0-1, so they all
 *      bake on top of each other in one cell.
 *   2. Blender bakes `active_render`, not `active` — the atlas is ignored and
 *      whatever UVs arrived with the model are used instead.
 *   3. Selections accumulating across the per-object loop — `smart_project`
 *      re-unwraps everything already packed, so only the last object survives.
 *
 * The signature is the same in all three: cells that should be dark are lit.
 * A correct atlas for N objects in a ceil(sqrt(N)) grid lights **exactly N**
 * cells and leaves the rest black, with black gutters between them.
 *
 *   node check_atlas.mjs <atlas.png> <objectCount>
 *
 * Written against the PNG spec directly rather than pulling in a decoder: the
 * only thing needed is per-cell mean brightness, and a dependency in the render
 * worker is a dependency on every machine that ever runs a bake.
 */

const [file, objectsArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: node check_atlas.mjs <atlas.png> [objectCount]')
  process.exit(2)
}

/**
 * Decode a non-interlaced PNG to {width, height, depth, channels, data}.
 *
 * `data` is 8-bit samples regardless of the file's depth, because everything
 * below only ever asks "how bright is this pixel".
 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')

  let width = 0
  let height = 0
  let depth = 8
  let colorType = 6
  const idat = []

  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      colorType = body[9]
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length // length + type + data + crc
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)

  const bytesPerSample = depth === 16 ? 2 : 1
  const stride = width * channels * bytesPerSample
  const raw = inflateSync(Buffer.concat(idat))

  // Un-filter. Each scanline is prefixed with a filter byte, and filters refer
  // to the pixel to the left and the scanline above — so this cannot be done
  // out of order or in parallel.
  const step = channels * bytesPerSample
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const target = out.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const left = x >= step ? target[x - step] : 0
      const up = above ? above[x] : 0
      const upLeft = above && x >= step ? above[x - step] : 0
      const value = line[x]

      switch (filter) {
        case 0: target[x] = value; break
        case 1: target[x] = (value + left) & 0xff; break
        case 2: target[x] = (value + up) & 0xff; break
        case 3: target[x] = (value + ((left + up) >> 1)) & 0xff; break
        case 4: {
          // Paeth: pick whichever neighbour the gradient predicts best.
          const p = left + up - upLeft
          const dl = Math.abs(p - left)
          const du = Math.abs(p - up)
          const dul = Math.abs(p - upLeft)
          const predicted = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft
          target[x] = (value + predicted) & 0xff
          break
        }
        default: throw new Error(`unknown filter ${filter} on row ${y}`)
      }
    }
  }

  return { width, height, depth, channels, stride, data: out }
}

const image = decodePng(readFileSync(file))
const { width, height, depth, channels, stride, data } = image

// Objects can be given, or inferred from the grid that best explains the lit
// cells. Given is better — the point is to compare against what was sent.
const objects = objectsArg ? Number(objectsArg) : null
const grid = objects ? Math.ceil(Math.sqrt(objects)) : null

/** Mean brightness of a rectangle, 0-1, sampling on a stride for speed. */
function meanBrightness(x0, y0, x1, y1) {
  const bytesPerSample = depth === 16 ? 2 : 1
  const skip = Math.max(1, Math.floor((x1 - x0) / 64))
  let total = 0
  let count = 0

  for (let y = y0; y < y1; y += skip) {
    for (let x = x0; x < x1; x += skip) {
      // High byte only for 16-bit: this is a brightness threshold, not a
      // measurement, and the low byte cannot change the answer.
      const at = y * stride + x * channels * bytesPerSample
      total += (data[at] + data[at + bytesPerSample] + data[at + 2 * bytesPerSample]) / 3
      count++
    }
  }

  return count ? total / count / 255 : 0
}

console.log(`atlas    : ${width}x${height}, ${depth}-bit, ${channels} channels`)
console.log(`overall  : mean brightness ${meanBrightness(0, 0, width, height).toFixed(3)}`)

if (!grid) {
  console.log('\nPass the object count to check cell occupancy:')
  console.log('  node check_atlas.mjs atlas.png 42')
  process.exit(0)
}

// 2% of range. Deliberately not lower: the images are denoised float output,
// so a genuinely empty cell still carries a little noise, and a threshold near
// zero counts that as "lit" — which hides exactly the overlap being looked for.
const LIT = 0.02

const cell = Math.floor(width / grid)
let lit = 0
const map = []

for (let row = 0; row < grid; row++) {
  let line = ''
  for (let column = 0; column < grid; column++) {
    // Inset, to sample the cell rather than its gutter.
    const inset = Math.floor(cell * 0.15)
    const mean = meanBrightness(
      column * cell + inset,
      row * cell + inset,
      (column + 1) * cell - inset,
      (row + 1) * cell - inset,
    )
    const isLit = mean > LIT
    if (isLit) lit++
    line += isLit ? '#' : '.'
  }
  map.push(line)
}

console.log(`grid     : ${grid}x${grid} (${grid * grid} cells) for ${objects} objects`)
console.log(`lit cells: ${lit}`)
console.log('\n' + map.join('\n') + '\n')

if (lit === objects) {
  console.log(`OK  exactly ${objects} cells lit — the atlas packed correctly.`)
  process.exit(0)
}

if (lit < objects) {
  console.log(
    `FAIL  only ${lit} of ${objects} cells are lit.\n` +
      '      Objects are baking on top of each other. Usual cause: selections\n' +
      '      accumulating across the per-object loop, so smart_project\n' +
      '      re-unwraps everything already packed and only the last survives.',
  )
} else {
  console.log(
    `FAIL  ${lit} cells lit but only ${objects} objects were sent.\n` +
      '      Something is bleeding outside its cell — check the island margin\n' +
      '      and that the packing inset is being applied.',
  )
}
process.exit(1)
