import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Refund settlement.
 *
 * The bug this pins down: `finish()` in renderQueue.js updated a job's status
 * and returned, so every failure under RENDER_MODE=local kept the user's
 * credits. The live database had 29 failed jobs against 6 refunds when this
 * was written — and because a lost credit produces no error, nothing surfaced
 * it. A test is the only thing that would have.
 *
 * Runs against a throwaway database, so no server and no Blender.
 */

const dir = await mkdtemp(join(tmpdir(), 'arcvia-refund-'))
const dbPath = join(dir, 'db.json')
await writeFile(dbPath, JSON.stringify({ users: [], renderJobs: [], creditLedger: [] }), 'utf8')

// Must be set before the store module is first imported — it reads the path once.
process.env.DB_PATH = dbPath

const { db } = await import('../src/store.js')
const { settleRefund, declineRefund } = await import('../src/lib/refunds.js')
const { creditCost } = await import('../src/lib/credits.js')

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

const balance = async (id) => (await db.findOne('users', (u) => u.id === id))?.credits ?? 0
const ledgerFor = async (jobId) =>
  (await db.find('creditLedger', (e) => e.meta?.jobId === jobId))

async function seed({ credits = 1000, charged, action = 'previewRender', status = 'rendering' }) {
  const user = await db.insert('users', { email: `t${Math.random()}@x`, credits })
  const job = await db.insert('renderJobs', {
    ownerId: user.id,
    preset: 'preview',
    action,
    status,
    creditsCharged: charged,
  })
  return { user, job }
}

// ---- The recorded charge is what comes back, not today's price ------------
// This is the second defect: refund() priced from creditCost[action], so moving
// a price silently misprices every refund. 99 is deliberately nothing like the
// previewRender tariff, so a tariff-priced refund cannot accidentally pass.
{
  const { user, job } = await seed({ credits: 500, charged: 99 })
  ok('the tariff is not 99, so this test can tell them apart', creditCost.previewRender !== 99,
    `tariff=${creditCost.previewRender}`)

  const given = await settleRefund(job.id, 'render-failed')
  ok('the refund returns the recorded charge', given === 99, String(given))
  ok('the balance rises by the recorded charge', (await balance(user.id)) === 599,
    String(await balance(user.id)))

  const entries = await ledgerFor(job.id)
  ok('one ledger line is written', entries.length === 1)
  ok('the ledger line is labelled a refund', entries[0]?.reason === 'refund:previewRender',
    entries[0]?.reason)
  ok('the ledger delta matches the charge', entries[0]?.delta === 99, String(entries[0]?.delta))
}

// ---- Settling twice pays once --------------------------------------------
// A job can fail in the queue, be swept by restart reconciliation, and be
// reported failed by a worker callback. All three call this.
{
  const { user, job } = await seed({ credits: 0, charged: 12 })
  await settleRefund(job.id, 'render-failed')
  await settleRefund(job.id, 'restart')
  const third = await settleRefund(job.id, 'worker-reported-failure')

  ok('a repeat settlement returns nothing', third === 0, String(third))
  ok('the balance reflects exactly one refund', (await balance(user.id)) === 12,
    String(await balance(user.id)))
  ok('exactly one ledger line exists', (await ledgerFor(job.id)).length === 1)
}

// ---- Cancelling a running job closes the decision without paying ----------
// The killed process reports a failure moments later. Without the stamp, that
// failure refunds work the machine really did.
{
  const { user, job } = await seed({ credits: 0, charged: 40 })
  await declineRefund(job.id, 'cancelled-while-rendering')
  const after = await settleRefund(job.id, 'render-failed')

  ok('the declined job pays nothing', after === 0, String(after))
  ok('the balance is untouched', (await balance(user.id)) === 0, String(await balance(user.id)))
  ok('no ledger line is written', (await ledgerFor(job.id)).length === 0)

  const stored = await db.findOne('renderJobs', (j) => j.id === job.id)
  ok('the decision is recorded on the job', stored?.refund?.settled === true)
  ok('and says why', stored?.refund?.reason === 'cancelled-while-rendering', stored?.refund?.reason)
}

// ---- A free job is stamped, not paid -------------------------------------
// Stamping matters: without it a later path could price this from a tariff
// that is no longer zero and pay out for something that cost nothing.
{
  const { user, job } = await seed({ credits: 7, charged: 0 })
  const given = await settleRefund(job.id, 'render-failed')

  ok('a zero-charge job refunds nothing', given === 0, String(given))
  ok('the balance is untouched', (await balance(user.id)) === 7)
  const stored = await db.findOne('renderJobs', (j) => j.id === job.id)
  ok('but the decision is still closed', stored?.refund?.settled === true)
}

// ---- An unregistered preset still refunds --------------------------------
// reconcileRenderJobs used to guard on `PRESETS[job.preset]`, so a job whose
// preset had been renamed kept the user's credits with no error anywhere.
{
  const { user, job } = await seed({ credits: 0, charged: 25, action: 'lightmapBake' })
  await db.update('renderJobs', job.id, { preset: 'a-preset-that-no-longer-exists' })
  const given = await settleRefund(job.id, 'restart', undefined)

  ok('a job with an unknown preset is still refunded', given === 25, String(given))
  ok('using the action recorded on the job', (await ledgerFor(job.id))[0]?.reason === 'refund:lightmapBake',
    (await ledgerFor(job.id))[0]?.reason)
  ok('and the balance rises', (await balance(user.id)) === 25)
}

// ---- A job that never existed is survivable ------------------------------
{
  const given = await settleRefund('no-such-job', 'render-failed')
  ok('settling a missing job is a no-op, not a throw', given === 0)
}

await rm(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
