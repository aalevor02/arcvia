/**
 * A multi-view render that finished short must not be marked done.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * `render_views.py` prints `ARCVIA_DONE:<n>/<total>`, and renderQueue's marker
 * loop already captured it — so a 22-view run that lost two views stored
 * `markers.done = "20/22"` on the job record. Nothing compared the two numbers.
 * The run exited 0, published the views that worked, and finished as `done` at
 * 100% with the evidence of its own incompleteness sitting in the record,
 * unread.
 *
 * Worse than a clean failure, because of how resuming works: `render_views.py`
 * skips a view whose PNG already exists, so a retry of a job marked `done` never
 * asks for the missing frames again. The customer keeps a complete-looking job
 * that is permanently two frames short.
 *
 * And the exit code cannot be the check. BLENDER EXITS 0 ON A PYTHON TRACEBACK —
 * measured on this repo's own `cad` and `sketch` styles, which die with an
 * AttributeError, write no PNG, and return 0.
 *
 * No server and no Blender: the rule is a decision about a string, and it was
 * untestable only because it was buried in a `close` callback. That is why it
 * went unread — nobody could have written this test against the old shape.
 *
 * Run: node test/render-partial.mjs
 */

import { viewsMissing } from '../src/lib/renderQueue.js'

let passed = 0
let failed = 0

function ok(label, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

console.log('\n-- a short run is detected --')

const short = viewsMissing({ done: '20/22' })
ok('20 of 22 views is missing work', short !== null)
ok('and it reports both numbers, so the error can name them',
  short?.done === 20 && short?.total === 22,
  JSON.stringify(short))

ok('1 of 22 is short', viewsMissing({ done: '1/22' }) !== null)
ok('0 of 22 is short', viewsMissing({ done: '0/22' }) !== null)

console.log('\n-- a complete run passes --')

ok('22 of 22 is not short', viewsMissing({ done: '22/22' }) === null)
ok('1 of 1 is not short', viewsMissing({ done: '1/1' }) === null)

console.log('\n-- silence is not failure --')
// `render.py`, the single-image path, never prints ARCVIA_DONE. Treating a
// missing marker as failure would fail every ordinary render — which would be a
// far louder bug than the one being fixed, and is the obvious way to get this
// wrong.
ok('no marker at all passes', viewsMissing({}) === null)
ok('an empty marker passes', viewsMissing({ done: '' }) === null)
ok('undefined markers pass', viewsMissing(undefined) === null)
ok('null markers pass', viewsMissing(null) === null)
ok('other markers alone pass',
  viewsMissing({ device: 'CPU', bake_cells: '16' }) === null)

console.log('\n-- a marker that cannot be read is not evidence of failure --')
// A garbled marker means the contract changed or output interleaved. That is a
// reason to look, not a reason to fail a render the user paid for — and failing
// on it would make every future change to the sentinel format an outage.
ok('garbage passes', viewsMissing({ done: 'garbage' }) === null)
ok('a partial format passes', viewsMissing({ done: '20/' }) === null)
ok('a non-numeric pair passes', viewsMissing({ done: 'a/b' }) === null)
ok('a zero total passes rather than dividing by nothing',
  viewsMissing({ done: '0/0' }) === null)
ok('more done than asked for passes — that is not MISSING work',
  viewsMissing({ done: '5/3' }) === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
