import { db } from '../store.js'
import plansConfig from '@arcvia/brand/plans'

const { creditCost, planFor, billingEnabled } = plansConfig

/**
 * Credit metering.
 *
 * Credits exist to bound GPU spend, not to extract money — billing is off. A
 * single runaway scene queueing thousands of bakes is the failure mode this
 * guards against, and that risk is identical whether or not anyone is paying.
 *
 * Every deduction is written to `creditLedger` rather than only decrementing a
 * counter. An append-only ledger means you can always answer "where did 400
 * credits go?", which a bare counter cannot.
 */

export { creditCost }

export async function balanceFor(userId) {
  const user = await db.findOne('users', (u) => u.id === userId)
  if (!user) return 0
  return user.credits ?? 0
}

export async function monthlyAllocation(user) {
  return planFor(user.planId).creditsPerSeat
}

/**
 * Record a credit movement. `delta` is negative for spend, positive for grant.
 */
export async function recordLedger(userId, delta, reason, meta = {}) {
  return db.insert('creditLedger', {
    userId,
    delta,
    reason,
    meta,
    at: new Date().toISOString(),
  })
}

export class InsufficientCredits extends Error {
  constructor(required, available) {
    super(`This action needs ${required} credits; you have ${available}.`)
    this.name = 'InsufficientCredits'
    this.statusCode = 402
    this.required = required
    this.available = available
  }
}

/**
 * Decide whether `userId` may perform `action`, and deduct if so.
 *
 * ── This is the decision that shapes how the product feels ───────────────────
 *
 * The naive implementation is: `if (balance < cost) throw`. It is also the one
 * that produces the worst moment in the product — an architect finishes a scene
 * at 11pm before a client meeting, hits Render, and is told no.
 *
 * The realistic options, and what each costs you:
 *
 *   1. HARD BLOCK — refuse below zero. Perfectly predictable GPU spend. Also
 *      the option most likely to make someone abandon the tool mid-project.
 *
 *   2. SOFT OVERDRAFT — allow the balance to go negative up to some floor
 *      (say -25), then block. The user finishes what they started; you cap the
 *      damage. Costs you a bounded amount of GPU time per user per month.
 *
 *      Note the interaction with `lightmapBake` at 25 credits: an overdraft
 *      floor below one bake's cost means a bake can never overdraft at all,
 *      which quietly makes the whole policy a hard block for the one action
 *      that most needs it. Pick the floor with the action costs in view.
 *
 *   3. DEGRADE, DON'T REFUSE — when short, silently drop the job to lower
 *      quality (fewer samples, smaller output) and charge the lower price. The
 *      user always gets *something*. More code, and you must tell them clearly
 *      that quality was reduced or it reads as a bug.
 *
 *   4. QUEUE UNTIL RESET — accept the job, hold it, run it when credits
 *      refresh. Great for batch work, terrible for someone waiting.
 *
 * There is no default right answer — it depends on whether your users are
 * mostly working to a deadline (favours 2 or 3) or running bulk output
 * (favours 4). You know your customers; I don't.
 *
 * @param {string} userId
 * @param {keyof typeof creditCost} action
 * @param {object} [meta] recorded on the ledger entry for later auditing
 * @returns {Promise<{ charged: number, remaining: number, degraded?: boolean }>}
 */
export async function spend(userId, action, meta = {}) {
  const cost = creditCost[action]
  if (cost === undefined) throw new Error(`Unknown metered action: ${action}`)

  const user = await db.findOne('users', (u) => u.id === userId)
  if (!user) throw new Error('User not found')

  const available = user.credits ?? 0

  // Free actions still get a ledger line — usage data is worth having even when
  // the price is zero, because it tells you what to charge for later.
  if (cost === 0) {
    await recordLedger(userId, 0, action, meta)
    return { charged: 0, remaining: available }
  }

  // TODO(you): choose and implement the enforcement policy.
  //
  // The block below is option 1 — a hard block — because it is the only one
  // that is obviously correct without knowing your users. Replace it with
  // whichever of the four above you want. Whatever you pick, keep writing to
  // the ledger, and keep returning `remaining` so the UI can warn people before
  // they hit the wall rather than at it.
  if (available < cost) {
    throw new InsufficientCredits(cost, available)
  }

  const remaining = available - cost
  await db.update('users', userId, { credits: remaining })
  await recordLedger(userId, -cost, action, meta)

  return { charged: cost, remaining }
}

/** Refund a spend when the work it paid for failed. */
export async function refund(userId, action, meta = {}) {
  const cost = creditCost[action] ?? 0
  if (cost === 0) return

  const user = await db.findOne('users', (u) => u.id === userId)
  if (!user) return

  await db.update('users', userId, { credits: (user.credits ?? 0) + cost })
  await recordLedger(userId, cost, `refund:${action}`, meta)
}

/**
 * Top up to the plan allocation. Unused credits carry forward, so this adds the
 * monthly grant rather than resetting the balance to it.
 */
export async function grantMonthly(userId) {
  const user = await db.findOne('users', (u) => u.id === userId)
  if (!user) return

  const grant = planFor(user.planId).creditsPerSeat
  await db.update('users', userId, { credits: (user.credits ?? 0) + grant })
  await recordLedger(userId, grant, 'monthly-grant', { billingEnabled })
}
