import brand from '@arcvia/brand'

/**
 * Where the sibling apps live.
 *
 * `brand.config.mjs` holds the production domains, and while the brand name is
 * still a placeholder those are `*.arcvia.example` — a domain that resolves
 * nowhere. Sending someone there from a dev machine is a dead end, and it is
 * the exact link people click most ("Open the studio").
 *
 * So: an explicit env var wins, a real configured domain is used as-is, and a
 * placeholder falls back to the same host on the studio's dev port. That last
 * branch is also what makes the flow work from a phone on the LAN, where
 * `localhost` would mean the phone.
 */

const STUDIO_DEV_PORT = 5173

/** True for the placeholder domains shipped before a real one is chosen. */
const isPlaceholder = (url: string) => !url || /\.example(\/|$)/.test(url)

export function studioUrl(): string {
  const configured = import.meta.env.PUBLIC_STUDIO_URL
  if (configured) return String(configured).replace(/\/$/, '')

  if (!isPlaceholder(brand.domains.studio)) return brand.domains.studio

  if (typeof window === 'undefined') return `http://localhost:${STUDIO_DEV_PORT}`
  return `${window.location.protocol}//${window.location.hostname}:${STUDIO_DEV_PORT}`
}

/**
 * The link to use for "Open the studio".
 *
 * Not `studioUrl()` directly. The studio is a separate origin and therefore has
 * a separate localStorage, so a session created on the site is invisible to it
 * — following the bare URL lands a signed-in user on a sign-in screen.
 *
 * `/handoff/` sits in between: it mints a single-use ticket from the current
 * session and forwards it. See that page, and `/auth/handoff` in the API.
 */
export function openStudioUrl(): string {
  return `/handoff/?to=${encodeURIComponent(studioUrl())}`
}
