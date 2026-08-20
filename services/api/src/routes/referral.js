import { randomBytes } from 'node:crypto'
import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { publicSiteOrigin } from '../lib/origins.js'
import plansConfig from '@arcvia/brand/plans'

const { billingEnabled } = plansConfig

/**
 * Referral programme.
 *
 * The reference product pays 10% of every referred subscription, monthly, with
 * no cap. That is a *billing* feature: it cannot pay out a percentage of
 * revenue that does not exist. So this module splits the idea in two.
 *
 *   TRACKING  — always on. A code is attached to every organisation at signup,
 *               new accounts can arrive carrying one, and the join is recorded.
 *               This costs nothing and is the part that is expensive to
 *               retrofit, because a referral you failed to record at signup is
 *               gone forever.
 *
 *   EARNINGS  — gated on `billingEnabled`. While the product is free the API
 *               reports `earnings: null` and the UI says so plainly, rather
 *               than showing ₹0 and implying the programme is broken.
 *
 * Turning the payouts on later is a flag flip plus a rate, not a schema change.
 */

/** Share of a referred account's subscription paid to the referrer. */
export const REFERRAL_RATE = 0.1

/**
 * The alphabet referral codes are drawn from.
 *
 * Not nanoid's default, and not A-Z0-9 either. A referral code is read aloud
 * over a phone, typed off a WhatsApp screenshot, and printed on a card — so
 * every character that has a lookalike or a keyboard variant has been removed:
 *
 *   - and _   punctuation survives copy-paste badly and is often "corrected"
 *             to an en-dash by messaging apps
 *   0 and O   indistinguishable in most sans-serif faces
 *   1, I, l   likewise
 *
 * What is left is 32 characters that cannot be confused with each other. Eight
 * of them is 32^8 ≈ 1.1 × 10^12 codes, which is ample.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** A fresh, unambiguous referral code. */
export function generateReferralCode(length = 8) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return out
}

/**
 * Codes are stored uppercase and compared uppercase.
 *
 * People retype these from WhatsApp messages and business cards, and they do
 * not preserve case. A code that only works in the casing it was generated in
 * is a support ticket, not a security boundary.
 */
function canonical(code) {
  return String(code ?? '')
    .trim()
    .toUpperCase()
}

/**
 * Resolve a referral code to the organisation that owns it.
 *
 * Exported because registration needs it *before* the new account exists, and
 * duplicating the lookup there is how the two drift apart.
 */
export async function organisationForCode(code) {
  const wanted = canonical(code)
  if (!wanted) return null
  return db.findOne('organisations', (o) => canonical(o.referralCode) === wanted)
}

/**
 * Record that `userId` signed up through `code`.
 *
 * Silently does nothing when the code is unknown, or when it belongs to the
 * signer-up's own organisation. Self-referral is the first thing anyone tries,
 * and a referral programme that pays for it is a money printer pointed at the
 * wrong person.
 *
 * Returns the referral record, or null if it was not credited.
 */
export async function recordReferral(userId, organisationId, code) {
  const referrer = await organisationForCode(code)
  if (!referrer) return null
  if (referrer.id === organisationId) return null

  return db.insert('referrals', {
    code: canonical(code),
    referrerOrgId: referrer.id,
    referredUserId: userId,
    referredOrgId: organisationId,
    // Set when the referred account first pays for something. Stays null for
    // the whole life of a free product, which is exactly the point: the record
    // is complete enough to pay out retroactively if that day comes.
    convertedAt: null,
  })
}

export async function registerReferralRoutes(app) {
  // ---- The signed-in user's own code and stats ---------------------------
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    if (!user) return reply.status(404).send({ message: 'User not found.' })

    const org = user.organisationId
      ? await db.findOne('organisations', (o) => o.id === user.organisationId)
      : null

    if (!org) {
      return reply
        .status(404)
        .send({ message: 'No organisation is attached to this account.' })
    }

    const referrals = await db.find(
      'referrals',
      (r) => r.referrerOrgId === org.id,
    )

    // Names, not just a count. "3 referrals" is a number; "Meridian Studio
    // joined on 4 March" is something the referrer can act on.
    const joined = await Promise.all(
      referrals.map(async (r) => {
        const referredOrg = await db.findOne(
          'organisations',
          (o) => o.id === r.referredOrgId,
        )
        return {
          organisation: referredOrg?.name ?? 'Unknown',
          joinedAt: r.createdAt,
          converted: Boolean(r.convertedAt),
        }
      }),
    )

    return {
      code: canonical(org.referralCode),
      // Built server-side so one implementation serves the page, an email
      // and anything else that needs to hand out this link.
      link: `${publicSiteOrigin(request)}/register/?ref=${canonical(org.referralCode)}`,
      total: referrals.length,
      converted: referrals.filter((r) => r.convertedAt).length,
      joined: joined.sort((a, b) => b.joinedAt.localeCompare(a.joinedAt)),
      rate: REFERRAL_RATE,
      // null, not 0 — see the module comment. Zero would read as "you have
      // earned nothing", which is a different claim from "nothing is billed
      // yet, so there is nothing to share".
      earnings: billingEnabled ? computeEarnings(referrals) : null,
      payoutsEnabled: billingEnabled,
    }
  })

  // ---- Is this code real? -------------------------------------------------
  //
  // Used by the register form to confirm a pasted code before submitting, so a
  // typo surfaces while the field is still on screen rather than after the
  // account exists and the referral has already been silently dropped.
  app.get('/validate/:code', async (request) => {
    const org = await organisationForCode(request.params.code)
    return {
      valid: Boolean(org),
      // The organisation name, so the person can see they are crediting who
      // they meant to. Nothing else about the org is exposed.
      organisation: org?.name ?? null,
    }
  })
}

function computeEarnings(referrals) {
  // Placeholder shape for when billing is on: the ledger of what was actually
  // charged is the source of truth, not this function. Kept so the response
  // shape does not change on the day payouts are enabled.
  return {
    currency: 'INR',
    pending: 0,
    paid: 0,
    convertedCount: referrals.filter((r) => r.convertedAt).length,
  }
}
