import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TONE_SURFACE } from '../src/catalogue/build'
import { SURFACE_KINDS } from '../src/plan/materials'

/**
 * Every tone a builder passes must resolve to a real surface.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * `material()` falls back to fabric for an unknown tone — right for an uploaded
 * model with a tone the catalogue never heard of, and catastrophic as a typo
 * catcher, because the fallback is shared: the pool's tank passed 'floor-tile'
 * before that key existed, landed on the SAME material instance as every sofa,
 * and the surface upgrade painted it grey woven upholstery. Nothing errored.
 * The harness that rendered the pool did not catch it either, because the
 * procedural fabric fallback is grey-ish and the tank looked plausible.
 *
 * So the source is scanned: every string literal handed to block(), cylinder()
 * or material() must be a TONE_SURFACE key. A tone added to a builder without a
 * mapping fails HERE, by name, instead of shipping as upholstery.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// From cwd, like surfaces.test.ts and for the same reason: run.mjs bundles
// tests into a temp directory, so a path relative to this module finds nothing.
const source = readFileSync(join(process.cwd(), 'src/catalogue/build.ts'), 'utf8')

const literals = new Set<string>()
for (const match of source.matchAll(/(?:block\(g,\s*|cylinder\(g,\s*|material\()'([a-z-]+)'/g)) {
  literals.add(match[1])
}

check('the scan finds tones at all', literals.size >= 8, `${literals.size} distinct`)
check("the pool's tank tone is among them", literals.has('floor-tile'))
check("water is among them", literals.has('water'))

for (const tone of [...literals].sort()) {
  check(`'${tone}' is a TONE_SURFACE key`, tone in TONE_SURFACE)
}

// And the mapping itself must point at surfaces that exist — a key mapping to
// a kind materials.ts never heard of falls back to plaster just as silently.
for (const [tone, kind] of Object.entries(TONE_SURFACE)) {
  check(
    `'${tone}' maps to a real surface`,
    (SURFACE_KINDS as readonly string[]).includes(kind),
    kind,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
