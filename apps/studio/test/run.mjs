import { build } from 'esbuild'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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
      'test/detectedOpenings.test.ts',
      'test/objects.test.ts',
      'test/lightmapUV.test.ts',
      'test/credits.test.ts',
      'test/surfaces.test.ts',
      'test/environments.test.ts',
      'test/compose.test.ts',
      'test/wallTypes.test.ts',
      'test/railing.test.ts',
      'test/railingChain.test.ts',
      'test/roomFinish.test.ts',
      'test/options.test.ts',
      'test/tones.test.ts',
      'test/history.test.ts',
      'test/sun.test.ts',
      'test/presentation.test.ts',
      'test/detectionQuality.test.ts',
      'test/furnish.test.ts',
      'test/cadFurnish.test.ts',
      'test/cadPlan.test.ts',
      'test/cadReview.test.ts',
      'test/deckDesign.test.ts',
      'test/roomAssignment.test.ts',
      'test/designFurnish.test.ts',
      'test/hubFurniture.test.ts',
      'test/modelCapture.test.ts',
      'test/thumbnail.test.ts',
      'test/floors.test.ts',
      'test/realtime-roster.test.ts',

      // The BIM and IFC side. These existed and passed for some time while
      // being in NO runner's list, so `npm test` reported green over 244
      // assertions it never executed and `validate.mjs js:studio` reported
      // the same. (validate's `bim` family runs test_plangraph.py, which is
      // Python and unrelated.) Found by the check above the moment it was
      // written. Nothing here was broken -- that is the point: a silent skip
      // is invisible precisely while everything passes.
      'test/bimAnalytics.test.ts',
      'test/bimBaselineClassifier.test.ts',
      'test/bimComparison.test.ts',
      'test/bimInference.test.ts',
      'test/bimLearningCorpus.test.ts',
      'test/bimLearningDataset.test.ts',
      'test/bimQuality.test.ts',
      'test/bimSemantics.test.ts',
      'test/ifcCorpus.test.ts',
      'test/ifcMetadata.test.ts',
      'test/ifcPlanProposal.test.ts',
      'test/materials.test.ts',
      'test/quantities.test.ts',
      'test/revitMetadata.test.ts',
    ]

// A hand-written list is deliberate — order is meaningful and a stray file in
// test/ should not become a test run. But a list also means a NEW test file
// runs nowhere and says nothing about it, which is the same failure as a
// caught-and-skipped parse: the suite reports green over work it never
// executed. (Found by adding detectedOpenings.test.ts and watching the total
// stay at 889.) So the omission is named out loud instead.
if (!entries.length) {
  const onDisk = (await readdir('test')).filter((name) => name.endsWith('.test.ts'))
  const missing = onDisk.filter((name) => !targets.includes(`test/${name}`))
  if (missing.length) {
    console.error(
      `\n${missing.length} test file(s) exist but are not in the list in` +
        ` test/run.mjs, so they did not run:\n  ${missing.join('\n  ')}\n` +
        'Add them to `targets`, or delete them.',
    )
    process.exit(1)
  }
}

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
