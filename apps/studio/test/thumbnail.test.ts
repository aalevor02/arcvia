import { CATALOGUE } from '../src/catalogue/items'
import { clearThumbnailCache, thumbnailFor } from '../src/catalogue/thumbnail'

/**
 * Thumbnails: what happens when one cannot be rendered.
 *
 * ── Why this can be tested in Node at all ───────────────────────────────────
 * The rendering half needs WebGL and belongs in a browser. The CACHING half is
 * pure, and it is the half that had the bug — so this exercises exactly the
 * path a failure takes. Node has no `document`, so `ensureRenderer` returns
 * false and every render fails, which is the same shape as a lost context or a
 * model that would not download.
 *
 * The bug: failures were cached for the life of the page. `render` returns null
 * for transient reasons as much as permanent ones — `upgradeModels` fetches
 * real GLBs over the network, and a WebGL context can be lost when the GPU
 * process restarts or another tab takes the last of the ~16 the browser allows.
 * One bad moment removed that item's picture until the next reload, and
 * reloading was what brought it back. The symptom was a catalogue with
 * thumbnails on one load and not the next, and nothing in the console either
 * time.
 */

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

const item = CATALOGUE.find((i) => i.id === 'sofa-3') ?? CATALOGUE[0]

check('there is an item to photograph', Boolean(item), item?.id)

clearThumbnailCache()

// Without a document there is no renderer, so this is the failure path.
const first = thumbnailFor(item)
check('no WebGL yields null rather than throwing', (await first) === null)

// THE ASSERTION THAT PINS THE FIX, and it has to compare the PROMISES rather
// than their values — both are null either way, so a value comparison passes
// against the bug. If the failure were still cached, `thumbnailFor` would hand
// back the very same settled promise for the rest of the page's life.
const retry = thumbnailFor(item)
check(
  'a settled failure is retried, not remembered',
  retry !== first,
  retry === first ? 'same promise: the null was cached' : 'a fresh attempt',
)
check('and the retry runs the same failure path', (await retry) === null)

// Concurrent callers must still not each start their own render — they share
// one renderer and one scene, so two at once would photograph each other.
clearThumbnailCache()
const a = thumbnailFor(item)
const b = thumbnailFor(item)
check('concurrent callers share one in-flight attempt', a === b)
await a

// A success must still be cached forever; there is nothing to invalidate.
// Verified by shape rather than by rendering, which needs a browser: only the
// null branch deletes, so a non-null result leaves the entry in place.
clearThumbnailCache()
const settled = thumbnailFor(item)
await settled
check('the cache is empty again after a failure', thumbnailFor(item) !== settled)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
