/**
 * `/p/<slug>/` — the client-facing address, served with its own share card.
 *
 * ── What this fixes ─────────────────────────────────────────────────────────
 * `apps/visualisation` serves any published project and fills in the title,
 * description and Open Graph tags from whichever one loads. That is correct for
 * anybody looking at the page and useless for anybody sharing it, because
 * **a crawler does not run JavaScript**. WhatsApp, Slack, iMessage and Twitter
 * fetch the HTML and read what is in the file — so every project shipped the
 * same neutral card, and before that, one client's.
 *
 * The visualisation app's own comment records that these pages "get shared by
 * WhatsApp more than by any other route". The commonest path was the broken
 * one.
 *
 * So the tags are injected here, before the HTML leaves the server, from the
 * publication the slug actually names.
 *
 * ── Why the API and not the static host ─────────────────────────────────────
 * Because the answer depends on the database. A CDN or bucket can serve one
 * file fast; it cannot look up which project `riverside-villas` is. Anything
 * that can do that lookup is this service. Putting it here also means the
 * heading matches what `main.ts` puts on the document a moment later — one
 * source for the wording, so the card and the tab cannot disagree.
 *
 * ── The escaping is the load-bearing part ───────────────────────────────────
 * Project names, places and taglines are typed by users into the studio. They
 * land inside HTML attributes here. A name containing a double quote would end
 * the attribute, and a name containing `<script>` would do considerably more
 * than that — on a page served to a client, from their developer's own link.
 * `escapeHtml` runs on every interpolated value with no exceptions, and the
 * test suite asserts it against both.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { db } from '../store.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the built app shell lives.
 *
 * `dist/` first because that is what is deployed; the source `index.html` is
 * the fallback so the route works in a checkout nobody has built yet, which is
 * the state every test run and most dev sessions are in. `ARCVIA_APP_SHELL`
 * overrides both, for a deployment that puts the app somewhere else.
 */
const SHELL_CANDIDATES = process.env.ARCVIA_APP_SHELL
  ? [process.env.ARCVIA_APP_SHELL]
  : [
      resolve(HERE, '../../../../apps/visualisation/dist/index.html'),
      resolve(HERE, '../../../../apps/visualisation/index.html'),
    ]

/** Neutral wording, used when the slug names nothing published. */
const NEUTRAL_TITLE = 'Project walkthrough'
const NEUTRAL_DESCRIPTION = 'An interactive presentation of a residential project.'

/**
 * HTML-escape a value bound for an attribute.
 *
 * `>` is escaped as well as `<`. It is not strictly required inside a quoted
 * attribute, but `setMetaContent` below matches with `[^>]*`, so a raw `>` in a
 * value would truncate the match and corrupt the tag rather than escape it.
 * The two have to agree, and this is the cheaper half to make safe.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Replace the `content` of one `<meta>`, matched by attribute and value. */
function setMetaContent(html, attribute, name, value) {
  // `[^>]*` spans newlines in JS, which matters: the shell wraps og:description
  // across three lines. Anchoring on the tag rather than the line is what makes
  // that work, and what makes reformatting the shell not break this.
  const pattern = new RegExp(
    `(<meta\\s[^>]*${attribute}="${name}"[^>]*content=")([^"]*)(")`,
    'i',
  )
  return html.replace(pattern, `$1${escapeHtml(value)}$3`)
}

/**
 * The wording, kept identical to `apps/visualisation/src/main.ts`.
 *
 * A crawler never sees a hash route, so this is deliberately the wording for
 * the project's own front page rather than for a section of it.
 */
function cardFor(project) {
  const name = project?.name || NEUTRAL_TITLE
  const place = project?.place
  return {
    title: place ? `${name} — ${place}` : name,
    description: project?.tagline || `An interactive presentation of ${name}.`,
  }
}

/**
 * A share image, only when one can be stated truthfully.
 *
 * Project images are stored as whatever the composer put there, which may be a
 * storage key rather than a URL. Resolving a key against this service's own
 * origin would produce a confident link to nothing, and a card with a broken
 * image reads worse than a card with none — the preview renders as a grey box
 * with the site's name under it. So only an already-absolute http(s) URL is
 * emitted.
 */
function shareImage(project) {
  const candidates = [
    project?.sections?.[0]?.image,
    project?.sitePlan?.image,
    project?.gallery?.[0]?.image,
  ]
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value))
}

/** The address this page was reached at, for `og:url`. */
function canonicalUrl(request, slug) {
  const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http'
  const host = request.headers['x-forwarded-host'] || request.headers.host
  if (!host) return null
  return `${String(proto).split(',')[0]}://${host}/p/${encodeURIComponent(slug)}/`
}

async function loadShell() {
  for (const candidate of SHELL_CANDIDATES) {
    try {
      // Read per request rather than cached at boot. This route is a handful of
      // hits per shared link, the file is about two kilobytes, and a cached
      // shell means a rebuilt app keeps serving the old one until someone
      // restarts the API — a stale-asset bug that presents as "the deploy did
      // not go out".
      return await readFile(candidate, 'utf8')
    } catch {
      continue
    }
  }
  return null
}

export async function registerShareRoutes(app) {
  async function handler(request, reply) {
    const shell = await loadShell()
    if (!shell) {
      // A deployment fault, not a caller fault. Saying which file was looked
      // for is the difference between a one-minute fix and an afternoon.
      request.log.error({ candidates: SHELL_CANDIDATES }, 'share: no app shell found')
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('The walkthrough app is not built on this server.')
    }

    const slug = request.params.slug
    const publication = await db.findOne(
      'publications',
      (p) => p.slug === slug && p.published,
    )

    // An unknown or unpublished slug gets the NEUTRAL card, never another
    // project's. The page is still served, because the app renders its own
    // "no project at this address" screen and a visitor reading that is better
    // served than one reading the API's JSON 404.
    const project = publication?.project ?? null
    const { title, description } = project ? cardFor(project) : {
      title: NEUTRAL_TITLE,
      description: NEUTRAL_DESCRIPTION,
    }

    let html = shell
      .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    html = setMetaContent(html, 'name', 'description', description)
    html = setMetaContent(html, 'property', 'og:title', title)
    html = setMetaContent(html, 'property', 'og:description', description)

    // Tags the shell does not carry. Injected rather than added to the static
    // file because two of the three only have a value once the slug is known.
    const extra = []
    const url = canonicalUrl(request, slug)
    if (url) extra.push(`<meta property="og:url" content="${escapeHtml(url)}" />`)
    const image = project ? shareImage(project) : undefined
    if (image) {
      extra.push(`<meta property="og:image" content="${escapeHtml(image)}" />`)
      // Twitter shows a bare link without this, even with valid og: tags.
      extra.push('<meta name="twitter:card" content="summary_large_image" />')
    } else {
      extra.push('<meta name="twitter:card" content="summary" />')
    }
    if (extra.length) {
      html = html.replace(/<\/head>/i, `  ${extra.join('\n    ')}\n  </head>`)
    }

    return reply
      .status(publication ? 200 : 404)
      .type('text/html; charset=utf-8')
      // Short, because a project renamed in the studio should not keep showing
      // its old name in previews for a day. Long enough that a link pasted into
      // a busy channel is not re-rendered for every reader.
      .header('cache-control', 'public, max-age=300')
      .send(html)
  }

  // Registered both ways deliberately. Published links carry the trailing slash
  // (`POST /publish` returns `/p/<slug>/`), people paste them without it, and
  // Fastify treats the two as different routes.
  app.get('/p/:slug', handler)
  app.get('/p/:slug/', handler)
}
