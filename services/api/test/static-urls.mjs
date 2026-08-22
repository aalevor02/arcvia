/**
 * `resolveUrl` on the URLs the studio actually stores.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 * A scene stores `hdriUrl: '/env/midday.hdr'`. That is a real URL to the
 * browser — the studio serves its own `public/` — so the viewer shows the sky
 * and the editor looks entirely correct. The render worker is not a browser: it
 * takes whatever `resolveUrl` returns and hands it to `Path(...).resolve()`.
 *
 * Before `/env/` was a known prefix the URL fell through untouched, resolved
 * against the current drive root, and reached Blender as `A:\env\midday.hdr`.
 * Verified against a real render, which failed with
 *
 *     ARCVIA_ERROR:Error: Cannot read 'A:\env\midday.hdr': No such file or directory
 *
 * The failure is split across the two halves of the product — preview right,
 * render wrong — which is the expensive kind to diagnose. So the mapping is
 * pinned here, along with the containment guard, because a static prefix that
 * resolves *somewhere* is easy to add and hard to notice when it resolves
 * somewhere wrong.
 *
 * No server: this is a pure function and the test should stay runnable when
 * nothing is listening.
 */

import { existsSync } from 'node:fs'
import { resolveUrl } from '../src/lib/storage.js'

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

// ---- Environments resolve to files that exist -------------------------------

// Not a fixture: these are the maps the generated catalogue actually names, so
// a rename in tools/asset-ingest/environments.mjs that forgot the files would
// fail here rather than at render time.
const environment = resolveUrl('/env/midday.hdr')

ok('/env/ resolves to an absolute path', typeof environment === 'string' && environment !== '/env/midday.hdr', String(environment))
ok('/env/ resolves to a file that exists', typeof environment === 'string' && existsSync(environment))
ok('/env/ keeps the .hdr extension', String(environment).endsWith('.hdr'))

// ---- The guard --------------------------------------------------------------

ok(
  'traversal out of the environment directory is refused',
  resolveUrl('/env/../../../../etc/passwd') === null,
  String(resolveUrl('/env/../../../../etc/passwd')),
)
ok(
  'a traversal that only looks like one stays inside',
  !existsSync(String(resolveUrl('/env/..%2F..%2Fsecret'))),
)

// ---- Everything else is unchanged ------------------------------------------

const upload = resolveUrl('/uploads/scenes/someone/abc.glb')
ok('uploads still resolve into the storage root', typeof upload === 'string' && upload.includes('uploads'), String(upload))
ok('an absolute URL passes through', resolveUrl('http://example.test/x.hdr') === 'http://example.test/x.hdr')
ok('null in, null out', resolveUrl(null) === null)
ok('an unknown prefix is left alone', resolveUrl('/somewhere/else.glb') === '/somewhere/else.glb')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
