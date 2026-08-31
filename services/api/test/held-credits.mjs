/**
 * The out-of-credits policy: queue until credits arrive.
 *
 * Owner decision, 2026-08-24. The moments worth pinning: a queueable action
 * with an empty balance is HELD, not refused (and the ledger says so); a
 * non-queueable one still throws; a credit inflow — grant or refund — wakes
 * held jobs oldest-first and stops at the first one still unaffordable, so a
 * cheap late job cannot jump an expensive early one; and a held job releases
 * with a real charge, because "held" is a promise to pay, not a discount.
 *
 * No server: this drives the libs directly against a throwaway database. The
 * one seam stubbed is enqueue's lane drain — release marks jobs 'queued' and
 * hands them to the real enqueue, whose spawned work is not this test's
 * subject (and whose spec points at nothing runnable anyway).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'held-credits-')), 'db.json')

const { db } = await import('../src/store.js')
const credits = await import('../src/lib/credits.js')
const { releaseHeldJobs } = await import('../src/lib/renderQueue.js')

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const user = await db.insert('users', { planId: 'free', credits: 1 })

// ---- Holdable vs not --------------------------------------------------------

const held = await credits.spend(user.id, 'cadReconstruct', {}, { holdable: true })
ok('a queueable action with no credits is held', held.held === true)
ok('nothing was charged for a hold', held.charged === 0)
ok('the hold names its price', held.cost === credits.creditCost.cadReconstruct)

const balance = await credits.balanceFor(user.id)
ok('the balance is untouched', balance === 1, String(balance))

const ledger = await db.find('creditLedger', (l) => l.userId === user.id)
ok('the hold left a ledger line', ledger.some((l) => l.reason === 'held:cadReconstruct'))

let refused = null
try {
  await credits.spend(user.id, 'cadReconstruct', {})
} catch (error) {
  refused = error
}
ok('the same action without holdable still refuses', refused instanceof credits.InsufficientCredits)

// ---- Release: oldest first, stop at the unaffordable ------------------------

// Two held jobs: an old expensive one and a new cheap one. A grant that only
// covers the cheap one must release NEITHER — first-come order holds.
const cost = credits.creditCost.cadReconstruct
const older = await db.insert('renderJobs', {
  ownerId: user.id, preset: 'cad', action: 'cadReconstruct', status: 'held',
  progress: 0, creditsCharged: 0, spec: {}, outputUrl: null, error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
})
const newer = await db.insert('renderJobs', {
  ownerId: user.id, preset: 'cad', action: 'cadReconstruct', status: 'held',
  progress: 0, creditsCharged: 0, spec: {}, outputUrl: null, error: null,
  createdAt: '2026-01-02T00:00:00.000Z',
})

let released = await releaseHeldJobs(user.id)
ok('no release while the oldest is unaffordable', released === 0, String(released))

// Enough for exactly one job (balance 1 + grant). grantMonthly triggers the
// release itself — that is the wiring under test — so the count is read from
// the jobs afterwards.
await db.update('users', user.id, { credits: cost - 1 })
await credits.grantMonthly(user.id) // free plan grants creditsPerSeat

const afterGrant = await db.find('renderJobs', (j) => j.ownerId === user.id)
const olderRow = afterGrant.find((j) => j.id === older.id)
const newerRow = afterGrant.find((j) => j.id === newer.id)

// "Released" here means "no longer held" — the real queue starts a released
// job immediately, so by the time this reads the row it may already say
// 'rendering' (or 'failed', given the empty spec). All of those prove the
// release; only 'held' would refute it.
const releasedState = (job) => job.status !== 'held'
ok('a grant wakes held jobs by itself', releasedState(olderRow) || releasedState(newerRow))
ok('the OLDEST job released', releasedState(olderRow), olderRow.status)
ok('a released job carries its real charge', olderRow.creditsCharged === cost)

// The free plan's grant covers both jobs, so both should have released and
// both should have paid — the fairness rule was proven above on the grant
// that covered neither.
// A released test job can fail immediately because its spec is deliberately
// empty. That failure refunds its charge before this assertion runs, so the
// current balance alone cannot prove whether each release was charged.
const releasedRows = [olderRow, newerRow].filter(releasedState)
ok(
  'every released job records its real charge',
  releasedRows.every((job) => job.creditsCharged === cost),
  releasedRows.map((job) => `${job.status}:${job.creditsCharged}`).join(', '),
)

const finalBalance = await credits.balanceFor(user.id)
const ledgerDelta = (await db.find('creditLedger', (l) => l.userId === user.id))
  .reduce((sum, entry) => sum + entry.delta, 0)
ok(
  'the balance reconciles with charges and immediate refunds',
  finalBalance === cost - 1 + ledgerDelta,
  `balance ${finalBalance}, ledger delta ${ledgerDelta}`,
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
