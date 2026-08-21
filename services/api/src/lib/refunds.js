import { db } from '../store.js'
import { refund } from './credits.js'

/**
 * Settling the refund on a render job.
 *
 * ── Why this is not just `await refund(...)` at each failure site ────────────
 * Refunding a job is a decision that must be made exactly once, and the paths
 * that reach it do not know about each other. A job can fail in the local
 * queue, fail via the worker callback, be cancelled by its owner, and be swept
 * up by restart reconciliation — and cancelling a *running* job deliberately
 * does NOT refund, because the CPU time was really spent. Without a single
 * place recording that the decision has been made, those paths either refund
 * twice or, as happened here, not at all.
 *
 * The live database when this was written: 29 failed jobs, 6 refunds. Every
 * local-mode failure kept the user's credits, because `finish()` in
 * renderQueue.js only ever called `db.update`.
 *
 * ── Refund the recorded charge, never the current tariff ────────────────────
 * `refund(userId, action)` prices from `creditCost[action]`, which is today's
 * price rather than the one the user actually paid. Move a price and every
 * historical refund silently misprices — over-refunding if it went down,
 * short-changing if it went up. `job.creditsCharged` is what was taken, so it
 * is what goes back. The tariff is only a fallback for jobs written before
 * `creditsCharged` existed.
 *
 * Both functions here are safe to call on any job in any state. That is the
 * point: callers state what happened and this decides what it means.
 */

/** The stamp left on a job once its refund decision has been made. */
function settlement(amount, reason) {
  return { settled: true, amount, reason, at: new Date().toISOString() }
}

/**
 * Give the credits back, once.
 *
 * @param {string} jobId
 * @param {string} reason        why — lands in the ledger meta and on the job
 * @param {string} [fallbackAction]  ledger label for jobs with no stored action
 * @returns {Promise<number>} credits actually returned; 0 if already settled
 */
export async function settleRefund(jobId, reason, fallbackAction) {
  const job = await db.findOne('renderJobs', (j) => j.id === jobId)
  if (!job) return 0

  // Already decided — by an earlier failure, a cancel, or a previous restart
  // sweep. Re-running reconciliation after two crashes must not pay out twice.
  if (job.refund?.settled) return 0

  const amount = job.creditsCharged ?? 0
  const action = job.action ?? fallbackAction ?? 'render'

  if (amount > 0) {
    await refund(job.ownerId, action, { jobId: job.id, reason }, { amount })
  }

  // Stamped even when the amount is zero, so a free job cannot later be
  // refunded at some non-zero tariff by a path that guessed at the price.
  await db.update('renderJobs', job.id, { refund: settlement(amount, reason) })
  return amount
}

/**
 * Record that this job is deliberately NOT refunded, and close the decision.
 *
 * Cancelling a job that is already rendering is the case this exists for: the
 * user gets no image, but the machine really did the work, and the published
 * policy says that is chargeable. Without this stamp the cancel would be
 * followed moments later by the killed process reporting a failure, and the
 * failure path would refund it after all.
 */
export async function declineRefund(jobId, reason) {
  const job = await db.findOne('renderJobs', (j) => j.id === jobId)
  if (!job || job.refund?.settled) return

  await db.update('renderJobs', job.id, { refund: settlement(0, reason) })
}
