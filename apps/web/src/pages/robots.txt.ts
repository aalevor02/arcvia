import type { APIRoute } from 'astro'

/**
 * Emitted at build time to /robots.txt.
 *
 * The site had none. `@astrojs/sitemap` writes `sitemap-index.xml` but does
 * not write a robots.txt, and nothing else did either — so the sitemap shipped
 * with nothing pointing at it. The `Sitemap:` line here is the only discovery
 * route a crawler gets that does not require a person to register the site by
 * hand in Search Console.
 *
 * ⚠ The `noindex` routes in `lib/routes.mjs` are deliberately NOT listed as
 * `Disallow`, and that is the load-bearing decision in this file.
 *
 * `Disallow` and `noindex` are mutually defeating. `Disallow` stops a crawler
 * fetching the page at all — so it never reads the `noindex` meta tag, and the
 * URL can still surface in results as a bare link with no title or snippet
 * (Google reports exactly this as "Indexed, though blocked by robots.txt").
 * Applying both to one URL gets you the outcome you were trying to prevent,
 * reached by a path that is much harder to diagnose than the original.
 *
 * Pick one per URL:
 *   - keep it out of the index  → allow crawling, serve `noindex`  ← what we do
 *   - keep it off the server    → `Disallow`, and do not rely on a meta tag
 *
 * `/view/` is the case that settles it. A client's walkthrough link gets shared
 * — the repo's own notes record WhatsApp as its commonest route — so a slug can
 * end up linked from a public page. Crawlable-plus-noindex means the crawler
 * fetches it and honours the tag. `Disallow` would mean it never reads the tag
 * and may list the bare URL anyway.
 *
 * The routes themselves are not enumerated below on purpose: a public file
 * captioned "here is everything private" is a map, and it would buy nothing —
 * the `noindex` tag is what does the work, and it is served on the page.
 */
export const GET: APIRoute = ({ site }) => {
  // `site` is `brand.domains.marketing`, set in astro.config.mjs. A sitemap
  // reference must be absolute; a relative one is ignored, and silently.
  const sitemapUrl = site ? new URL('sitemap-index.xml', site).href : null

  const body = [
    '# Arcvia — marketing site',
    '#',
    '# Pages that must stay out of search results serve a noindex meta tag and',
    '# are deliberately left crawlable so that tag can be read. See',
    '# src/pages/robots.txt.ts for why Disallow would defeat it.',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    ...(sitemapUrl ? [`Sitemap: ${sitemapUrl}`, ''] : []),
  ].join('\n')

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
