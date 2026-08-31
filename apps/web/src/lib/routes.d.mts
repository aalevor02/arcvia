/**
 * Types for the crawl policy.
 *
 * The policy itself stays plain `.mjs` for the reason `packages/brand` gives:
 * the Astro config and the plain-Node test both import it without a compile
 * step. This file gives the TypeScript side the same shape.
 */

/** Routes that must never appear in search results. Prefix match. */
export declare const PRIVATE_ROUTES: readonly string[]

/**
 * True when a page may be indexed. Accepts a pathname (`/login/`) or an
 * absolute URL — `@astrojs/sitemap` passes the latter.
 */
export declare function isIndexable(pathnameOrUrl: string): boolean
