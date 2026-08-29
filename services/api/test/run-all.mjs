/**
 * Run every API test file, and report what actually ran.
 *
 * ── The failure this replaces ──────────────────────────────────────────────
 * `npm test` was a 29-long `&&` chain. A chain stops at its first non-zero
 * exit, so ONE crashing file silently removes every file after it from the
 * run — and the only trace is that npm prints the whole chain back at you in
 * an error block, which reads like noise rather than like "twenty suites did
 * not run".
 *
 * That is not hypothetical. A second process bound :8787 mid-run (Windows lets
 * a second binder win, quietly), the chain died on ECONNRESET at file 9, and
 * the run reported 158 assertions against a board figure of 485. The shortfall
 * was the only signal, and reading it required knowing the expected total.
 *
 * ── What this reports, and why each part is there ──────────────────────────
 * Per file: the exit code, the file's own "N passed, M failed" line, and one
 * of four outcomes. The repository's own rule is that a summary with only
 * pass/fail cannot express "did not run", so it says the nearest thing, and
 * the nearest thing is green. These are the four answers that rule needs:
 *
 *   ok       exit 0, and the file printed a summary saying nothing failed.
 *   failed   exit non-zero, or the file's own summary names failures.
 *   blocked  exit 3 — a dependency this machine does not have. Never a pass.
 *   silent   exit 0 and NO summary line at all. Reported separately from `ok`
 *            because a file that asserts nothing exits 0 exactly like a file
 *            that asserted forty things. referral-and-reset.mjs sat in this
 *            state with thirteen assertions that could not fail.
 *
 * ── Every file runs, even after a failure ──────────────────────────────────
 * A failing file no longer hides the ones behind it. The exit code is still
 * non-zero if anything failed or was silent, so CI behaviour is unchanged in
 * the only direction that matters.
 *
 * ── An unlisted file is a finding, not a default ───────────────────────────
 * ORDER below is explicit rather than a glob, because these files are not all
 * independent — the queue suites bind fixed ports and want to run one at a
 * time in a known sequence. But a glob has one property the old chain lacked:
 * it notices a NEW test file. So this does both. It runs ORDER, then compares
 * against what is on disk and reports anything missing from the list, because
 * a test nobody runs is the same defect in a different disguise.
 *
 * Files named `seed-*.mjs` are fixtures a human runs by hand to populate a
 * dev database, not tests. They are excluded by name and listed as such, so
 * the exclusion is visible rather than a silent gap in the count.
 *
 * Most files need the API running: `npm run dev:api`.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Explicit, ordered, and the same sequence the `&&` chain used. */
const ORDER = [
  'store-durability.mjs',
  'delivery.mjs',
  'origins-production.mjs',
  'production-config.mjs',
  'static-urls.mjs',
  'publications.mjs',
  'sqlite-store.mjs',
  'comments.mjs',
  'render-partial.mjs',
  'scene-patch.mjs',
  'render-idempotency.mjs',
  'refunds.mjs',
  'referral-and-reset.mjs',
  'uploads.mjs',
  'detect.mjs',
  'detect-storage-key.mjs',
  'bake.mjs',
  'access-code.mjs',
  'protected-assets.mjs',
  'cad.mjs',
  'cad-roof-options.mjs',
  'cad-patches.mjs',
  'cad-cancel.mjs',
  'camera-orientation.mjs',
  'share-card.mjs',
  'scene-slugs.mjs',
  'org-members.mjs',
  'render-capture-ssrf.mjs',
  'rate-limit.mjs',
  'render-script-path.mjs',
  'render-assets.mjs',
  'render-concurrency.mjs',
  'queue-persistence.mjs',
  'queue-lanes.mjs',
  'storage-put.mjs',
  'storage-s3.mjs',
  'asset-hub.mjs',
  'held-credits.mjs',
  'realtime.mjs',
]

/** Fixtures, not tests — run by hand to populate a dev database. */
const NOT_TESTS = (name) => name.startsWith('seed-') || name === 'run-all.mjs'

// A file's own summary is the authority on its assertion counts. Reading it
// back rather than re-counting PASS lines keeps one source of truth: a file
// that says "17 passed, 11 failed" is failing even if its exit code says 0.
const SUMMARY = /^(\d+) passed, (\d+) failed/m

const results = []
for (const name of ORDER) {
  const run = spawnSync(process.execPath, [join(HERE, name)], {
    cwd: join(HERE, '..'),
    encoding: 'utf8',
    // Inherit stderr so a crash's stack trace still reaches the operator; the
    // stdout we capture, because we need its summary line.
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const stdout = run.stdout ?? ''
  process.stdout.write(stdout)

  const match = stdout.match(SUMMARY)
  const passed = match ? Number(match[1]) : 0
  const failed = match ? Number(match[2]) : 0
  const code = run.status

  let outcome
  if (code === 3) outcome = 'blocked'
  else if (code !== 0 || failed > 0) outcome = 'failed'
  else if (!match) outcome = 'silent'
  else outcome = 'ok'

  results.push({ name, code, passed, failed, outcome, summary: match?.[0] ?? null })
}

// ---- What is on disk but not in ORDER --------------------------------------
const onDisk = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !NOT_TESTS(f))
const unlisted = onDisk.filter((f) => !ORDER.includes(f))
const missing = ORDER.filter((f) => !onDisk.includes(f))

// ---- Report ----------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length))
console.log('\n' + '='.repeat(width + 34))
console.log('API suite — per file')
console.log('='.repeat(width + 34))
for (const r of results) {
  const mark = { ok: ' ok     ', failed: ' FAILED ', blocked: ' BLOCKED', silent: ' SILENT ' }[r.outcome]
  const detail = r.summary ?? 'no summary line — asserted nothing it could report'
  console.log(`${mark}  ${r.name.padEnd(width)}  exit ${String(r.code).padStart(3)}  ${detail}`)
}

const total = (key) => results.reduce((n, r) => n + r[key], 0)
const count = (o) => results.filter((r) => r.outcome === o).length

console.log('-'.repeat(width + 34))
console.log(
  `${results.length} files: ${count('ok')} ok, ${count('failed')} failed, ` +
    `${count('blocked')} blocked, ${count('silent')} silent`,
)
console.log(`${total('passed')} assertions passed, ${total('failed')} failed`)

const seeds = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && NOT_TESTS(f) && f !== 'run-all.mjs')
if (seeds.length) console.log(`excluded as fixtures, not tests: ${seeds.join(', ')}`)
if (unlisted.length) {
  console.log(`\n⚠  ${unlisted.length} test file(s) on disk are NOT in this runner's list and did NOT run:`)
  for (const f of unlisted) console.log(`     ${f}`)
  console.log('   Add them to ORDER in test/run-all.mjs, or rename them seed-* if they are fixtures.')
}
if (missing.length) {
  console.log(`\n⚠  ${missing.length} file(s) in ORDER do not exist on disk: ${missing.join(', ')}`)
}

// Silent counts as a failure of the harness. So does an unlisted file: it is a
// test nobody runs, which is the defect this runner exists to surface.
const bad = count('failed') + count('silent') + unlisted.length + missing.length
process.exit(bad ? 1 : 0)
