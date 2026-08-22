/**
 * put() writes a whole file, and never trusts a torn one.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * put() skipped the write whenever the content-addressed path merely EXISTED
 * (`try { await stat(path) } catch { write }`). `stat` succeeds for a
 * half-written file, so an upload SIGKILLed mid-write left a truncated file,
 * and every later upload of the same bytes hashed to the same key, found the
 * stub, skipped the write, and answered 201 with the full byte count.
 * uploads.js then served those short bytes under `Cache-Control: immutable` —
 * a poisoned key that re-uploading could not fix.
 *
 * The fix: skip only when the existing file is the RIGHT SIZE (the key is a
 * content hash, so right size == identical bytes), and write via a temp file +
 * rename so a crash mid-write can never leave a torn key in the first place.
 *
 * Runs against an isolated UPLOAD_DIR in a fresh process, so the store's
 * module-load ROOT points at a temp directory.
 *
 * Run: node test/storage-put.mjs
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const STORAGE = fileURLToPath(new URL('../src/lib/storage.js', import.meta.url))

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

const dir = await mkdtemp(join(tmpdir(), 'arcvia-put-'))

/**
 * Drive put() in a child process (so ROOT resolves to our temp dir), returning
 * whatever the snippet prints as JSON. The snippet gets `put`, `pathFor`-free —
 * it recomputes the key the same way the module does — and node's fs.
 */
async function inStore(snippet) {
  const src = `
    import { put } from ${JSON.stringify('file:///' + STORAGE.replace(/\\/g, '/'))}
    import { createHash } from 'node:crypto'
    import { writeFile, readFile, mkdir, stat } from 'node:fs/promises'
    import { join, dirname } from 'node:path'
    const ROOT = process.env.UPLOAD_DIR
    const keyPath = (buf, ext) => join(ROOT, createHash('sha256').update(buf).digest('hex').slice(0, 32) + ext)
    ${snippet}
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, UPLOAD_DIR: dir },
    timeout: 30000,
  })
  return JSON.parse(stdout.trim().split('\n').pop())
}

try {
  // ---- A clean write, then an identical re-upload is skipped --------------
  const clean = await inStore(`
    const buf = Buffer.from('a full and complete PNG'.repeat(50))
    const a = await put(buf, 'image/png')
    const stat1 = await stat(keyPath(buf, '.png'))
    // Re-upload the identical bytes: must be a no-op that keeps the mtime.
    await new Promise((r) => setTimeout(r, 20))
    const b = await put(buf, 'image/png')
    const stat2 = await stat(keyPath(buf, '.png'))
    console.log(JSON.stringify({
      sameKey: a.key === b.key,
      sizeRight: stat2.size === buf.length,
      mtimeStable: stat1.mtimeMs === stat2.mtimeMs,
    }))
  `)
  ok('an identical re-upload is skipped and keeps its mtime',
     clean.sameKey && clean.sizeRight && clean.mtimeStable, JSON.stringify(clean))

  // ---- The torn-file case: a truncated file at the key is REPAIRED ---------
  const torn = await inStore(`
    const buf = Buffer.from('the whole drawing, every byte of it'.repeat(100))
    const path = keyPath(buf, '.png')
    await mkdir(dirname(path), { recursive: true })
    // Simulate an upload SIGKILLed mid-write: the key exists but is short.
    await writeFile(path, buf.subarray(0, 10))
    const before = (await stat(path)).size
    // The old code skipped because stat() succeeds; the new code sees the wrong
    // size and rewrites.
    const result = await put(buf, 'image/png')
    const after = await readFile(path)
    console.log(JSON.stringify({
      startedTruncated: before === 10,
      repairedToFull: after.length === buf.length,
      bytesMatch: after.equals(buf),
      reportedFullBytes: result.bytes === buf.length,
    }))
  `)
  ok('a truncated key is detected and rewritten whole',
     torn.startedTruncated && torn.repairedToFull && torn.bytesMatch,
     JSON.stringify(torn))
  ok('and the caller is told the real (full) byte count', torn.reportedFullBytes)

  // ---- No .tmp files are left behind --------------------------------------
  const leftovers = await inStore(`
    import { readdir } from 'node:fs/promises'
    const buf = Buffer.from('leaves no scratch behind'.repeat(30))
    await put(buf, 'image/png')
    const files = await readdir(ROOT)
    console.log(JSON.stringify({ tmp: files.filter((f) => f.endsWith('.tmp')) }))
  `)
  ok('the atomic write leaves no .tmp file behind', leftovers.tmp.length === 0,
     leftovers.tmp.join(', '))
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
