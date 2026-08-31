/**
 * Which routes search engines may index — one list, read by everything on this
 * site that gets an opinion about crawling.
 *
 * Three places hold such an opinion, and before this file they held it
 * separately:
 *
 *   1. `layouts/Base.astro`  — emits `<meta name="robots" content="noindex">`
 *   2. `astro.config.mjs`    — hands page paths to `@astrojs/sitemap`
 *   3. `pages/robots.txt.ts` — tells crawlers where the sitemap is
 *
 * They disagreed. The 2026-08-30 build shipped a sitemap of 18 URLs, **7 of
 * which were pages carrying `noindex`**: /handoff/, /login/, /register/,
 * /reset-password/, /team/, /verify/ and /view/. Measured against the built
 * HTML, not inferred from the source.
 *
 * A sitemap is a submission — it says "these are my canonical pages, please
 * index them". Submitting a page that then refuses indexing is a
 * self-contradiction, and Search Console reports each one as a coverage error
 * ("Submitted URL marked 'noindex'"). The worst of the seven is `/view/`,
 * whose own head comment says the slug is the only thing keeping a client's
 * project private.
 *
 * The fix is not to remember to update two lists. It is to have one.
 *
 * Plain `.mjs` rather than `.ts`, for the reason `packages/brand` gives: the
 * Astro config and the plain-Node test in `test/` both import this without a
 * compile step. `routes.d.mts` gives the TypeScript side the same shape.
 */

/**
 * Routes that must never appear in search results. Prefix match, so `/view/`
 * covers `/view/casa-altinho/`.
 *
 * The reasons differ and are kept separate on purpose — a future reader who
 * files them all under "auth pages" will index the wrong one.
 *
 * @type {readonly string[]}
 */
export const PRIVATE_ROUTES = [
  // Client deliverables. The slug is the only thing keeping a project private,
  // so a crawler that learns one of these URLs must not be handed the rest.
  '/view/',

  // Account plumbing. Real pages, but steps in a flow rather than
  // destinations: a search result landing someone on "verify your mobile" with
  // no verification pending is a dead end.
  '/login/',
  '/reset-password/',
  '/verify/',
  '/handoff/',
  '/team/',

  // See the note below — this is the one entry that is a business decision.
  '/register/',

  // An indexed 404 competes with the real pages it exists to replace.
  '/404',
]

/**
 * ⚠ `/register/` is the only entry here that is a judgement call rather than a
 * technical fact, and it is listed as private **only because that is what the
 * site already did**. This change fixes a contradiction; it does not quietly
 * re-set anyone's SEO policy.
 *
 * For indexing it: for most SaaS the sign-up page is a legitimate landing page
 * for brand-intent searches ("arcvia sign up"), and it is the shortest path
 * from a search result to an account.
 *
 * For keeping it out: `/` already carries the same call to action with the
 * context a cold visitor needs, and the page is currently fronted by a "free
 * while in beta" offer that will not always be true.
 *
 * To flip it, delete the `'/register/'` line above. Nothing else changes — the
 * meta tag, the sitemap and robots.txt all read this list.
 */

/**
 * True when a page may be indexed.
 *
 * Accepts a pathname (`/login/`) or an absolute URL, because its two real
 * callers pass different things: `@astrojs/sitemap` hands its filter a full
 * URL, `Astro.url.pathname` is a path. A helper that silently returns the
 * wrong answer for one of its callers is worse than no helper.
 *
 * @param {string} pathnameOrUrl
 * @returns {boolean}
 */
export function isIndexable(pathnameOrUrl) {
  let path = pathnameOrUrl

  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      // An unparseable URL is not something to guess about. Treat it as
      // private: a page wrongly withheld from the index is recoverable in an
      // afternoon, a client deliverable wrongly published is not.
      return false
    }
  }

  // Normalise to a trailing slash so `/login` and `/login/` are one answer.
  // The site builds with `trailingSlash: 'always'`, but the 404 route has no
  // trailing form at all — which is why its entry above is written without one
  // and why the raw path is compared as well.
  const withSlash = path.endsWith('/') ? path : `${path}/`

  return !PRIVATE_ROUTES.some(
    (prefix) => withSlash.startsWith(prefix) || path === prefix,
  )
}
