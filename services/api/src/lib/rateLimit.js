/**
 * A small in-memory attempt limiter for credential endpoints.
 *
 * ── Why this exists, and why in memory ──────────────────────────────────────
 * `/auth/login` and `/auth/password/forgot` had no throttle of any kind: an
 * attacker could try tens of thousands of passwords a minute against an
 * 8-character minimum, and fire the password-reset mailer as fast as the socket
 * allowed. The product ALREADY throttles a four-digit scene access code
 * (`routes/scenes.js`) and caps OTP-verify attempts — login was the omission,
 * not the policy, so this lifts that same policy into one place the auth routes
 * can share.
 *
 * In memory, per-process, resetting on deploy — the same trade the access-code
 * limiter documents and for the same reason: the job is to make bulk guessing
 * tedious and to stop a mailer being used as a weapon, not to be a distributed
 * quota. A shared store is the right answer at a scale this product is not at,
 * and adding one now would be infrastructure for a threat the in-memory version
 * already blunts.
 *
 * Keyed on whatever the caller passes — for login that is IP + normalised
 * email, so one attacker cannot lock every account by guessing against each in
 * turn, and one account is not made un-loginable from its real owner's network
 * by an attacker elsewhere. The key is the caller's decision; this only counts.
 */

const buckets = new Map()

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (now > bucket.until) buckets.delete(key)
  }
}

/**
 * A limiter with its own window and ceiling.
 *
 * `check(key)` returns `{ limited, retryAfterSeconds }` WITHOUT counting — call
 * it before doing the work, and refuse when `limited`. `fail(key)` records one
 * failed attempt. `succeed(key)` clears the bucket, so a correct login does not
 * leave a near-limit count sitting against a legitimate user.
 *
 * Note the asymmetry: only FAILURES count. A user with the right password can
 * sign in a hundred times; only wrong guesses accumulate.
 */
export function createLimiter({ limit, windowMs }) {
  return {
    check(key) {
      const now = nowMs()
      const bucket = buckets.get(key)
      if (!bucket || now > bucket.until) return { limited: false, retryAfterSeconds: 0 }
      if (bucket.count < limit) return { limited: false, retryAfterSeconds: 0 }
      return { limited: true, retryAfterSeconds: Math.ceil((bucket.until - now) / 1000) }
    },

    fail(key) {
      const now = nowMs()
      // Sweep opportunistically on writes — cheap, and it keeps a long-running
      // process from accumulating dead buckets for keys never seen again.
      if (buckets.size > 512) sweep(now)
      const bucket = buckets.get(key)
      if (!bucket || now > bucket.until) {
        buckets.set(key, { count: 1, until: now + windowMs })
      } else {
        bucket.count += 1
      }
    },

    succeed(key) {
      buckets.delete(key)
    },
  }
}

/**
 * `Date.now()` via a seam the tests can freeze — a limiter is all about the
 * passage of time, and a test that has to sleep for a real window is a slow,
 * flaky test. Production uses the real clock.
 */
let clock = () => Date.now()
function nowMs() {
  return clock()
}

/** Test-only: replace the clock. Pass no argument to restore the real one. */
export function _setClock(fn) {
  clock = fn ?? (() => Date.now())
}

/** Test-only: forget every bucket. */
export function _reset() {
  buckets.clear()
}
