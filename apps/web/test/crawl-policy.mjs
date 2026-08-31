/**
 * What the built site tells search engines — checked against the bytes it
 * ships, not against the source that produced them.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * `linkcheck.mjs` crawls the site and reported "no broken internal links",
 * correctly, while the 2026-08-30 build was submitting a sitemap of 18 URLs of
 * which **7 were pages carrying `noindex`**: /handoff/, /login/, /register/,
 * /reset-password/, /team/, /verify/ and /view/. Link integrity and crawl
 * integrity are different properties and only the first one was being checked.
 *
 * A sitemap is a submission — "these are my canonical pages, index them". A
 * page carrying `noindex` refuses. Doing both to one URL is a contradiction the
 * site states about itself, and Search Console reports each one as a coverage
 * error ("Submitted URL marked 'noindex'"). The worst of the seven was
 * `/view/`, the route that serves client deliverables.
 *
 * ── Why it reads `dist/` and imports nothing from `src/` ────────────────────
 * The fix put both decisions behind one module, `src/lib/routes.mjs`. A test
 * that imported that module would be asking the policy whether it agrees with
 * itself, and would pass just as happily if the sitemap integration silently
 * stopped calling it, if the layout stopped emitting the tag, or if a page like
 * `/view/` — which writes its own head and never touches the layout — drifted.
 *
 * So this compares two artifacts that are produced independently of each other
 * and read back off disk: the `<meta name="robots">` in each emitted HTML file,
 * and the `<loc>` entries in the emitted sitemap. Agreement between those two
 * is the actual claim.
 *
 * Run: npm run build --workspace=apps/web && node test/crawl-policy.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(HERE, '..', 'dist')

let passed = 0
let failed = 0

function ok(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok    ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

// ---- The build must exist -------------------------------------------------
//
// Deliberately an error and not a skip. A suite that goes quiet when its input
// is missing reports green having checked nothing, which is the failure mode
// this repo has been bitten by more than once.
try {
  await stat(DIST)
} catch {
  console.error(
    `No build at ${DIST}.\n\n` +
      `This suite reads the emitted site, because the sitemap only exists in a\n` +
      `build. Produce one first:\n\n` +
      `  npm run build --workspace=apps/web\n`,
  )
  process.exit(2)
}

// ---- Read every emitted page ----------------------------------------------

/** @returns {Promise<string[]>} every .html file under dist */
async function htmlFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await htmlFiles(full)))
    else if (entry.name.endsWith('.html')) found.push(full)
  }
  return found
}

/**
 * `dist/login/index.html` → `/login/`, `dist/index.html` → `/`,
 * `dist/404.html` → `/404`. Mirrors `trailingSlash: 'always'` +
 * `build.format: 'directory'` from astro.config.mjs.
 */
function urlPathOf(file) {
  const rel = relative(DIST, file).split(sep).join('/')
  if (rel === 'index.html') return '/'
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`
  return `/${rel.replace(/\.html$/, '')}`
}

/** True when the emitted HTML tells crawlers not to index it. */
function declaresNoindex(html) {
  const tag = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i)
  return tag ? /noindex/i.test(tag[0]) : false
}

const files = await htmlFiles(DIST)
const pages = new Map() // url path -> { noindex }
for (const file of files) {
  pages.set(urlPathOf(file), { noindex: declaresNoindex(await readFile(file, 'utf8')) })
}

const noindexPages = [...pages].filter(([, p]) => p.noindex).map(([u]) => u).sort()

// ---- Read the emitted sitemap ---------------------------------------------

const sitemapIndex = await readFile(join(DIST, 'sitemap-index.xml'), 'utf8').catch(() => null)
const sitemapBody = await readFile(join(DIST, 'sitemap-0.xml'), 'utf8').catch(() => null)

ok('a sitemap is emitted', Boolean(sitemapIndex && sitemapBody))
if (!sitemapBody) {
  console.log(`\n${passed} passed, ${failed + 1} failed`)
  process.exit(1)
}

const submitted = [...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const submittedPaths = submitted.map((u) => new URL(u).pathname).sort()

// ---- The contradiction this suite was written for -------------------------

const contradictions = submittedPaths.filter((p) => pages.get(p)?.noindex)
ok(
  'the sitemap submits no page that refuses indexing',
  contradictions.length === 0,
  contradictions.length ? contradictions.join(', ') : `${submittedPaths.length} URLs, 0 noindex`,
)

// The same rule stated from the other side, which catches the opposite drift:
// a filter that is too eager and quietly drops a real marketing page out of
// the sitemap. That failure is invisible from the page itself — the page looks
// perfect and simply never gets submitted.
//
// `/404` is exempt because `@astrojs/sitemap` never emits it whatever the
// filter says, so requiring it would assert a thing the tool cannot do.
const missing = [...pages]
  .filter(([url, p]) => !p.noindex && url !== '/404' && !submittedPaths.includes(url))
  .map(([url]) => url)
ok(
  'every indexable page is in the sitemap',
  missing.length === 0,
  missing.length ? `not submitted: ${missing.join(', ')}` : `${submittedPaths.length} submitted`,
)

// A sitemap entry with no page behind it is a 404 handed to a crawler.
const phantom = submittedPaths.filter((p) => !pages.has(p))
ok('every sitemap URL has a page behind it', phantom.length === 0, phantom.join(', '))

// ---- robots.txt ------------------------------------------------------------

const robots = await readFile(join(DIST, 'robots.txt'), 'utf8').catch(() => null)
ok('robots.txt is emitted', robots !== null)

if (robots !== null) {
  const sitemapLine = robots.match(/^\s*Sitemap:\s*(\S+)\s*$/im)
  ok(
    'robots.txt names the sitemap',
    Boolean(sitemapLine),
    'without this, nothing on the site points at the sitemap',
  )

  ok(
    'the sitemap reference is absolute',
    Boolean(sitemapLine && /^https?:\/\//i.test(sitemapLine[1])),
    // A relative Sitemap: line is ignored, and ignored without complaint.
    sitemapLine ? sitemapLine[1] : '(none)',
  )

  ok(
    'the reference points at the sitemap that was actually built',
    Boolean(sitemapLine && sitemapLine[1].endsWith('/sitemap-index.xml')),
    sitemapLine ? sitemapLine[1] : '(none)',
  )

  // ⚠ The one that is easy to get backwards. `Disallow` stops a crawler
  // fetching the page, so it never reads the `noindex` tag — and the URL can
  // still be listed as a bare link ("Indexed, though blocked by robots.txt").
  // Applying both to one URL produces the outcome you were preventing.
  const disallowed = [...robots.matchAll(/^\s*Disallow:\s*(\S+)\s*$/gim)]
    .map((m) => m[1])
    .filter((rule) => rule !== '')
  const defeated = noindexPages.filter((url) =>
    disallowed.some((rule) => url.startsWith(rule.replace(/\*$/, ''))),
  )
  ok(
    'no noindex route is also Disallowed',
    defeated.length === 0,
    defeated.length
      ? `${defeated.join(', ')} — Disallow hides the noindex tag from the crawler`
      : `${disallowed.length} Disallow rules`,
  )
}

// ---- Quantities, not just a status ----------------------------------------
//
// COORDINATION.md R6: this codebase's signature failure is a plausible-looking
// result with no error. Print what was examined so a suite that silently stops
// finding pages is visible as a number rather than as a green tick.
console.log(
  `\n  ${pages.size} pages built · ${noindexPages.length} noindex · ` +
    `${submittedPaths.length} submitted to search engines`,
)
if (noindexPages.length) console.log(`  kept out of the index: ${noindexPages.join(', ')}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
