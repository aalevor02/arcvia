import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { proposeFurniture } from '../src/plan/furnish'
import { identify } from '../src/catalogue/recognise'
import { CATALOGUE } from '../src/catalogue/items'
import type { DetectionResult } from '../src/plan/detections'
import type { Underlay } from '../src/plan/types'

/**
 * End-to-end check against real drawings.
 *
 * Not a unit test — a report. The unit tests prove the rules behave as written;
 * this shows what those rules actually do to three drawings that came from
 * clients, which is the only way to see the cases nobody thought to write a
 * rule for.
 */

const DIR = process.env.VERIFY_DIR ?? '.'
const NAME = new Map(CATALOGUE.map((item) => [item.id, item.name]))

for (const plan of ['ground', 'basement', 'villa']) {
  const detection: DetectionResult = JSON.parse(
    readFileSync(join(DIR, `${plan}.json`), 'utf8'),
  )

  // The underlay the studio would have built, with the scale the drawing
  // reported. Without it every measurement is in image fractions and nothing
  // matches anything.
  const metresPerPixel = detection.scale
    ? detection.scale.metres_per_unit / detection.width
    : 0.01

  const underlay: Underlay = {
    url: '',
    width: detection.width,
    height: detection.height,
    origin: { x: 0, y: 0 },
    scale: metresPerPixel,
    opacity: 1,
    invert: false,
    locked: true,
    calibrated: true,
  }

  const regions = detection.rooms ?? []
  const rooms = regions.filter((r) => r.kind === 'room')
  const fittings = regions.filter((r) => r.kind === 'fitting')
  const drawn = proposeFurniture(detection, underlay)
  const withAssumed = proposeFurniture(detection, underlay, { assume: true })

  console.log(`\n${'='.repeat(66)}`)
  console.log(`${plan}  —  ${detection.width}x${detection.height}, ` +
    `scale ${detection.scale ? detection.scale.metres_per_unit.toFixed(1) + ' m across' : 'unknown'}`)
  console.log('='.repeat(66))

  console.log(`\nROOMS (${rooms.length})`)
  for (const room of rooms) {
    const printed = room.size ? `${room.size[0]} x ${room.size[1]} m` : ''
    const merged = room.also.length ? `  [merged with ${room.also.join(', ')}]` : ''
    console.log(`  ${(room.name ?? '(unnamed)').padEnd(22)} ${String((room.area * 100).toFixed(1)).padStart(5)}%  ${printed}${merged}`)
  }

  console.log(`\nFITTINGS DETECTED (${fittings.length}) — what each was identified as`)
  for (const fitting of fittings) {
    const xs = fitting.polygon.map((p) => p.x * detection.width * metresPerPixel)
    const ys = fitting.polygon.map((p) => p.y * detection.height * metresPerPixel)
    const w = Math.max(...xs) - Math.min(...xs)
    const d = Math.max(...ys) - Math.min(...ys)

    const found = identify({ label: fitting.name, width: w, depth: d, room: null })
    const label = fitting.name ? `"${fitting.name}"` : '(unlabelled)'
    console.log(
      `  ${label.padEnd(22)} ${w.toFixed(2)} x ${d.toFixed(2)} m  ->  ` +
        (found ? `${NAME.get(found.item.id)} (${found.evidence})` : 'NOT IDENTIFIED'),
    )
  }

  console.log(`\nPLACED FROM THE DRAWING (${drawn.length})`)
  for (const piece of drawn) {
    console.log(
      `  ${(NAME.get(piece.item) ?? piece.item).padEnd(22)} ${(piece.room ?? '—').padEnd(16)} ` +
        `${piece.evidence.padEnd(9)} ${piece.because}`,
    )
  }

  const assumed = withAssumed.filter((p) => p.evidence === 'typical')
  console.log(`\nWOULD BE ASSUMED IF ASKED (${assumed.length})`)
  const byRoom = new Map<string, string[]>()
  for (const piece of assumed) {
    const key = piece.room ?? '—'
    byRoom.set(key, [...(byRoom.get(key) ?? []), NAME.get(piece.item) ?? piece.item])
  }
  for (const [room, items] of byRoom) {
    console.log(`  ${room.padEnd(22)} ${items.join(', ')}`)
  }
}

console.log()
