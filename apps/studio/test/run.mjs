import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Test runner for the studio's pure logic.
 *
 * ── Why a runner at all ─────────────────────────────────────────────────────
 * Node can strip TypeScript natively now, but only with explicit `.ts`
 * extensions on every import. Adopting that convention to satisfy the test
 * runner would push an unusual import style through every React component in
 * the app — the tail wagging the dog.
 *
 * esbuild is already present as a Vite dependency, so bundling the test to a
 * temporary file costs one extra step, no new dependency, and leaves the source
 * written the way the rest of the app is written.
 *
 * Only *pure* modules are testable this way: geometry, the room graph, unit
 * formatting. Anything touching the DOM or WebGL belongs in a browser test.
 */

const entries = process.argv.slice(2)
const targets = entries.length
  ? entries
  : [
      'test/rooms.test.ts',
      'test/format.test.ts',
      'test/planStore.test.ts',
      'test/buildGeometry.test.ts',
      'test/underlay.test.ts',
      'test/detections.test.ts',
      'test/objects.test.ts',
      'test/lightmapUV.test.ts',
      'test/credits.test.ts',
      'test/presentation.test.ts',
      'test/detectionQuality.test.ts',
    ]

const dir = await mkdtemp(join(tmpdir(), 'arcvia-test-'))
let failed = false

try {
  for (const entry of targets) {
    const outfile = join(dir, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'))

    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      logLevel: 'error',
    })

    console.log(`\n── ${entry} ${'─'.repeat(Math.max(0, 60 - entry.length))}`)
    try {
      await import(pathToFileURL(outfile).href)
    } catch (error) {
      // A non-zero exit inside the test module surfaces here as a thrown
      // ERR_UNHANDLED. Report it and keep going, so one failing file does not
      // hide the results of the others.
      failed = true
      console.error(error instanceof Error ? error.message : error)
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failed) process.exit(1)
