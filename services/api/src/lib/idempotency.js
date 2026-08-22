import { createHash } from 'node:crypto'

import { db } from '../store.js'

/**
 * Recognising a submission that has already been made.
 *
 * ── Why this is shared rather than written twice ────────────────────────────
 * Both job routes charge before queueing, so both had the same hole: a
 * double-clicked button sends two identical requests, and each one charges. The
 * user pays twice and gets two identical outputs, so the only visible trace is
 * the balance.
 *
 * `/render/jobs` was fixed first and `/cad/jobs` was going to receive a copy of
 * it. Two copies of a rule that must agree is the defect this codebase has spent
 * a day cataloguing — a duplication measure computed on one basis and read on
 * another, a thickness constant asserted in two places, an environment intensity
 * written as a literal twice. They agree until one is edited.
 *
 * So the rule lives here once, and each route supplies only the thing that
 * genuinely differs: what makes ITS submission distinct.
 *
 * ── The two mechanisms, which answer different questions ────────────────────
 *   Idempotency-Key   the caller states "this is the same submission". The right
 *                     primitive, and what a client retrying after a dropped
 *                     response needs. Honoured regardless of age and regardless
 *                     of whether the body changed — a key is a statement about
 *                     the submission, not about the payload.
 *   fingerprint       a backstop for callers sending no key, which is all of
 *                     them today. Same user, same inputs, inside a short window.
 */

/**
 * How long an identical submission is treated as the same submission.
 *
 * Short deliberately. Two identical requests seconds apart are a double-click.
 * The same two a minute apart may be a deliberate re-run after the first looked
 * stuck, and collapsing THOSE is its own silent failure — the user asks for two,
 * gets one, and nothing says so. The guard has to be narrower than the mistake
 * it prevents is wide.
 */
export const IDEMPOTENCY_WINDOW_MS = Number(process.env.RENDER_IDEMPOTENCY_MS ?? 15_000)

/**
 * The fingerprint of a submission: everything that makes it a distinct request.
 *
 * `parts` must include every input that changes the OUTPUT. Leaving one out
 * merges two submissions that are genuinely different, which is the failure
 * direction that loses a user's work rather than their credits.
 */
export function fingerprintOf(userId, parts) {
  return createHash('sha256').update(JSON.stringify([userId, ...parts])).digest('hex')
}

/**
 * The job this submission duplicates, or null.
 *
 * Both keys are read from the persisted job rather than an in-memory map, so
 * the guard survives a restart — which is exactly when a user is most likely to
 * click twice, because the first click appeared to do nothing.
 */
/**
 * Statuses a duplicate may point at.
 *
 * ── The retry this excludes ─────────────────────────────────────────────────
 * A failed or cancelled job is not a result anybody wants handed back. The first
 * version matched on fingerprint alone, so a render that failed and a user who
 * immediately clicked again — which is precisely what a person does when
 * something fails — would be told "this is a duplicate", handed the failed job,
 * and left unable to retry at all until the window expired.
 *
 * That is worse than the double charge it was written to prevent: a duplicate
 * charge costs a credit, an unretryable failure costs the work. A failed job has
 * already been refunded by `settleRefund`, so charging the retry is correct.
 */
const DEDUPLICABLE = new Set(['queued', 'rendering', 'done'])

export async function findDuplicate({ userId, key, fingerprint, now = Date.now() }) {
  const since = now - IDEMPOTENCY_WINDOW_MS

  return db.findOne('renderJobs', (job) => {
    if (job.ownerId !== userId) return false
    if (!DEDUPLICABLE.has(job.status)) return false

    // A key is authoritative in both directions: with one, only a matching key
    // counts as a duplicate, so a caller that supplies keys never has two
    // distinct submissions merged by coincidence of timing.
    if (key) return job.idempotencyKey === key

    return job.fingerprint === fingerprint && Date.parse(job.createdAt ?? 0) >= since
  })
}

/**
 * Everything a route needs: the duplicate if there is one, and the two fields to
 * persist on the job it is about to create if there is not.
 *
 * Returned together on purpose. A route that looked up a duplicate but forgot to
 * store the fingerprint would work perfectly on the first submission of every
 * pair and never on the second, which is a bug that passes a casual test.
 */
export async function checkSubmission(request, parts) {
  const header = request.headers['idempotency-key']
  const key = typeof header === 'string' && header.trim() ? header.trim() : null
  const fingerprint = fingerprintOf(request.auth.userId, parts)

  const existing = await findDuplicate({ userId: request.auth.userId, key, fingerprint })

  return { existing, fields: { idempotencyKey: key, fingerprint } }
}
