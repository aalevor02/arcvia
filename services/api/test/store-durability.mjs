/**
 * The datastore under the failures that actually happen to files.
 *
 * Every user, scene, publication and credit record this product has lives in
 * one JSON file. Three properties keep that from being terrifying, and each
 * one existed as a bug first:
 *
 *   1. A corrupt db.json REFUSES to boot, quarantining the damage. It used to
 *      boot as an empty database and then overwrite the evidence on first
 *      flush — data loss dressed as tolerance.
 *   2. Writes are atomic (write-aside + rename). In-place writeFile truncates
 *      first, so a crash mid-write left a torn file for property 1 to eat.
 *   3. One failed write does not poison the queue. The old chain kept the
 *      rejection forever, so the first disk hiccup made every later write
 *      fail with the first one's error until restart.
 *
 * Each case spawns a fresh node process, because the store caches its cache
 * and its DB_PATH at module load — the failure being tested is a boot-time
 * behaviour, and only a real boot exercises it.
 *
 * Run: node test/store-durability.mjs
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

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

/** Run a snippet against the store in a fresh process, with DB_PATH set. */
async function boot(dbPath, code) {
  try {
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '-e', `import { db } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)}\n${code}`],
      { env: { ...process.env, DB_PATH: dbPath }, timeout: 30000 },
    )
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

const dir = await mkdtemp(join(tmpdir(), 'arcvia-store-'))

try {
  // ---- 1. A fresh install starts empty and writes a valid file -------------
  const fresh = join(dir, 'fresh', 'db.json')
  const boot1 = await boot(fresh, `
    const u = await db.insert('users', { email: 'a@b.c' })
    console.log(JSON.stringify({ id: u.id }))
  `)
  ok('a missing file is a fresh install, not an error', boot1.ok, boot1.stderr.slice(0, 200))
  const written = JSON.parse(await readFile(fresh, 'utf8'))
  ok('the insert reached disk as valid JSON', written.users?.length === 1)
  ok('no .tmp file is left behind',
     !(await readdir(join(dir, 'fresh'))).some((f) => f.endsWith('.tmp')))

  // ---- 2. A corrupt file refuses to boot and is quarantined ----------------
  const hurtDir = join(dir, 'hurt')
  await mkdir(hurtDir, { recursive: true })
  const hurt = join(hurtDir, 'db.json')
  // The exact shape a torn in-place write produces: a prefix of real JSON.
  await writeFile(hurt, '{"users":[{"id":"u1","email":"real@person', 'utf8')

  const boot2 = await boot(hurt, `
    const users = await db.find('users')
    console.log('BOOTED with', users.length, 'users')
  `)
  ok('a corrupt database refuses to boot', !boot2.ok)
  ok('and never reports itself as empty', !boot2.stdout.includes('BOOTED'))
  ok('the error says where the damage is preserved',
     /corrupt/.test(boot2.stderr), boot2.stderr.split('\n')[0]?.slice(0, 120))
  const kept = (await readdir(hurtDir)).filter((f) => f.includes('.corrupt-'))
  ok('the damaged file is quarantined, not overwritten', kept.length === 1, kept[0])
  ok('the quarantine holds the original bytes',
     (await readFile(join(hurtDir, kept[0]), 'utf8')).includes('real@person'))

  // ---- 3. A failed write does not poison the queue -------------------------
  // Forcing one failure without fault injection: a DIRECTORY squatting on the
  // .tmp path makes the write-aside fail; removing it lets the next one
  // through. The record from the failed write must still reach disk then,
  // because it never left the cache.
  const flakyDir = join(dir, 'flaky')
  const flaky = join(flakyDir, 'db.json')
  await mkdir(join(flakyDir, 'db.json.tmp'), { recursive: true })

  const boot3 = await boot(flaky, `
    import { rm } from 'node:fs/promises'
    let firstFailed = false
    try {
      await db.insert('leads', { name: 'first' })
    } catch {
      firstFailed = true
    }
    await rm(${JSON.stringify(join(flakyDir, 'db.json.tmp'))}, { recursive: true, force: true })
    await db.insert('leads', { name: 'second' })
    console.log(JSON.stringify({ firstFailed }))
  `)
  ok('the blocked write fails loudly at its caller',
     boot3.ok && JSON.parse(boot3.stdout).firstFailed === true,
     boot3.stderr.slice(0, 200))
  const after = JSON.parse(await readFile(flaky, 'utf8'))
  ok('the queue recovers: the next write succeeds', after.leads?.length >= 1)
  ok('and carries the failed write\'s record with it — nothing was lost',
     after.leads?.length === 2 && after.leads.some((l) => l.name === 'first'),
     `leads on disk: ${after.leads?.map((l) => l.name).join(', ')}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
