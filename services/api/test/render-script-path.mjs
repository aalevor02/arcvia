/**
 * The render script resolves to the same real file from any start directory.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * renderQueue.js did `resolve('../../services/render-worker/render.py')` with
 * no base, i.e. relative to process.cwd(). The API is started from the repo
 * root (docs/deploy.md), from services/api (npm scripts), and from the test
 * harness — and from the repo root that path resolved to a file that does not
 * exist. Blender exits 0 on a Python traceback, so every render on a fresh
 * deploy failed with an OSError that named Python, not the deploy. The default
 * is now anchored on the module's own location.
 *
 * This test imports the module from two different working directories in
 * separate processes and asserts the resolved SCRIPT path is (a) the same and
 * (b) a real file. It cannot read SCRIPT directly (it is module-private), so it
 * asserts on the boot warning the module prints when the script is MISSING:
 * absent from a good resolution, present when we force a bad override.
 *
 * Run: node test/render-script-path.mjs
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const API_DIR = resolve(HERE, '..')
const REPO_ROOT = resolve(API_DIR, '../..')
const MODULE = resolve(API_DIR, 'src/lib/renderQueue.js')

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
 * The SCRIPT warning specifically, not "any line containing 'not found'".
 *
 * This started as a bare /not found/ over the whole of stderr, which was too
 * loose the moment the module grew a second boot warning: renderQueue now also
 * reports an unreachable Blender BINARY, whose message contains the same two
 * words, and all three "resolves from X" assertions failed on a warning that
 * had nothing to do with the script path. A test that matches more than it
 * means passes for the wrong reason until it fails for the wrong reason.
 */
const SCRIPT_WARNING = /BLENDER_SCRIPT not found/

/** Import the queue from `cwd`, with an optional BLENDER_SCRIPT override, and
 *  return whatever it wrote to stderr at boot (the missing-script warning). */
async function bootFrom(cwd, env = {}) {
  const { stderr } = await run(
    process.execPath,
    ['-e', `import(${JSON.stringify('file:///' + MODULE.replace(/\\/g, '/'))}).then(() => {})`],
    { cwd, env: { ...process.env, RENDER_MODE: 'local', ...env }, timeout: 30000 },
  )
  return stderr
}

// From the repo root — the case that was broken.
const fromRoot = await bootFrom(REPO_ROOT)
ok('resolves from the repo root with no missing-script warning',
   !SCRIPT_WARNING.test(fromRoot), fromRoot.split('\n')[0]?.slice(0, 100))

// From services/api — the npm-script case.
const fromApi = await bootFrom(API_DIR)
ok('resolves from services/api with no missing-script warning',
   !SCRIPT_WARNING.test(fromApi), fromApi.split('\n')[0]?.slice(0, 100))

// From a deep subdirectory — proves it is not accidentally cwd-relative.
const fromDeep = await bootFrom(HERE)
ok('resolves from the test directory too', !SCRIPT_WARNING.test(fromDeep))

// And the warning DOES fire for a genuinely wrong explicit override, so the
// check is not simply never triggering.
const bad = await bootFrom(REPO_ROOT, { BLENDER_SCRIPT: './does/not/exist/render.py' })
ok('a wrong explicit override is reported loudly at boot',
   SCRIPT_WARNING.test(bad),
   bad.split('\n').find((l) => SCRIPT_WARNING.test(l))?.slice(0, 100))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
