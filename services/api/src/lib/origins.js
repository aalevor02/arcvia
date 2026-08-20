/**
 * Which origins may talk to this API, and where the public site lives.
 *
 * Extracted from `server.js` once a route needed `isOriginAllowed` too:
 * importing it from `server.js` would have made the module graph circular
 * (server → route → server), and a circular import into a module whose top
 * level calls `app.listen()` is the kind of thing that works until the day it
 * does not. Both sides now import this leaf module instead.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// Origins allowed to call this API. One list, one place — as opposed to the
// eight separate CORS configurations the reference architecture needed.
export const ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  'http://localhost:4321,http://localhost:5173,http://localhost:5174,http://localhost:5175'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Loopback, or an RFC1918 private LAN address. */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/

/**
 * Decide whether an Origin may call this API.
 *
 * Outside production we accept any origin on the local machine or the local
 * network. The reason is practical: testing "works on any device" means opening
 * the site from a phone, which arrives as `http://192.168.x.x:4321` — an origin
 * nobody thought to allowlist, and whose IP changes whenever DHCP feels like it.
 * Pinning the list to `localhost` makes every cross-device test fail with what
 * looks like a server outage.
 *
 * In production this is strictly the configured list. No pattern matching.
 */
export function isOriginAllowed(origin) {
  if (ORIGINS.includes(origin)) return true
  if (IS_PRODUCTION) return false

  try {
    const { hostname, protocol } = new URL(origin)
    return protocol === 'http:' && PRIVATE_HOST.test(hostname)
  } catch {
    return false
  }
}

/**
 * The origin the *marketing site* is served from — which is not this server.
 *
 * Getting this wrong is not cosmetic. A referral link is the entire output of
 * that feature: it goes into WhatsApp messages and email signatures, and a
 * wrong host makes every one of them dead. The first version derived it from
 * `request.headers.host`, which is the API — so links came out as
 * `http://192.168.1.36:8787/register/?ref=…`, pointing at a server with no
 * `/register/` page at all. It was caught by opening the page, not by a test,
 * because the string looked entirely plausible.
 *
 * Order of preference:
 *
 *   1. PUBLIC_SITE_URL — explicit, and what production sets.
 *   2. The request's `Origin` header — the browser states which site made the
 *      call, and it is vetted against the same allowlist CORS uses, so it
 *      cannot be an attacker-chosen host that we then paste into a link.
 *   3. This server's own host — last resort, and wrong often enough that it
 *      warns rather than failing silently.
 */
export function publicSiteOrigin(request) {
  const configured = process.env.PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, '')

  const origin = request.headers.origin
  if (origin && isOriginAllowed(origin)) return origin.replace(/\/$/, '')

  request.log?.warn(
    'public link built from the API host — set PUBLIC_SITE_URL so shared links point at the site',
  )
  return `${request.protocol}://${request.headers.host}`
}
