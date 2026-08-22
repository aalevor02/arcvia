import './styles.css'
import { brand } from '@arcvia/brand'
import bundled from './data/casa-altinho'
import type { Project } from './types'
import { h } from './ui/dom'
import { homePage } from './pages/home'
import { masterPlanPage } from './pages/masterplan'
import { villaPage } from './pages/villa'
import { galleryPage } from './pages/gallery'

const NAV = [
  { href: '#/', label: 'Overview' },
  { href: '#/plan', label: 'Master plan' },
  { href: '#/villas', label: 'Villas' },
  { href: '#/gallery', label: 'Gallery' },
  { href: '#/contact', label: 'Enquire' },
]

const root = document.getElementById('app')!

/**
 * The project on screen.
 *
 * ── Why this is a binding and not an import ─────────────────────────────────
 * Every page function here already takes a `Project` as an argument — the app
 * was written data-driven from the start, and its type file says why: "a second
 * project is a second data file, not a second codebase". The only thing tying
 * it to one client was this module importing that file at build time.
 *
 * So it is now loaded at run time, and the bundled Casa Altinho data is the
 * development default rather than the subject.
 */
let project: Project = bundled

/**
 * Which published project to show, from the URL.
 *
 * `/p/<slug>/` is the address a client is given; `?p=<slug>` works anywhere
 * without a rewrite rule, which is what makes this testable on a static dev
 * server. No slug means the bundled project, which is what `npm run dev` gets.
 */
function requestedSlug(): string | null {
  const query = new URLSearchParams(location.search).get('p')
  if (query) return query

  const path = location.pathname.match(/\/p\/([^/]+)/)
  return path ? decodeURIComponent(path[1]) : null
}

/**
 * The API host, derived from the page rather than hard-coded.
 *
 * Hard-coding `localhost` breaks the moment the site is opened from another
 * device — on a phone, `localhost` is the phone. Same reasoning as the studio's
 * client, and deliberately the same shape.
 */
function apiBase(): string {
  const configured = import.meta.env.VITE_API_URL
  return configured
    ? String(configured).replace(/\/$/, '')
    : `${location.protocol}//${location.hostname}:8787`
}

/**
 * Put the loaded project's identity on the document itself.
 *
 * ── Why this is not just the title ──────────────────────────────────────────
 * `index.html` used to hard-code one client's title, description and share
 * card. Serving many projects from it made every one of those a leak: a visitor
 * on client B's link saw client A's name in the tab, and sharing it posted a
 * card for A's development.
 *
 * So the markup is neutral and this fills it in from whatever loaded.
 *
 * ⚠ This does NOT fix link previews. A crawler does not run JavaScript, so
 * WhatsApp and Slack read the static file and every project still shares the
 * same card. That needs `/p/<slug>/` served by something that can inject the
 * tags before the HTML leaves the server, and is recorded as an open gap.
 */
function describe(heading: string, detail: string): void {
  document.title = heading
  for (const [selector, value] of [
    ['meta[name="description"]', detail],
    ['meta[property="og:title"]', heading],
    ['meta[property="og:description"]', detail],
  ] as const) {
    document.head.querySelector<HTMLMetaElement>(selector)?.setAttribute('content', value)
  }
}

/** A failure a visitor can act on, rather than a blank page. */
function failure(heading: string, detail: string): HTMLElement {
  // Said on the document too, so a failed load does not leave the previous
  // project's name sitting in the browser tab.
  describe(heading, detail)
  return h(
    'main',
    { class: 'band' },
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'lede', style: 'margin:0 auto;text-align:center' },
        h('h2', {}, heading),
        h('p', {}, detail),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function header(): HTMLElement {
  return h(
    'header',
    { class: 'site-header' },
    h(
      'div',
      { class: 'shell' },
      h(
        'a',
        { class: 'brandmark', href: '#/' },
        h('span', { class: 'script' }, project.script),
        h('span', { class: 'word' }, project.name.replace(`${project.script} `, '')),
      ),
      h('nav', { class: 'nav' }, ...NAV.map((item) => h('a', { href: item.href }, item.label))),
    ),
  )
}

function footer(): HTMLElement {
  return h(
    'footer',
    { class: 'site-footer' },
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'footer-grid' },
        h(
          'div',
          {},
          h('h4', {}, project.developerNote),
          h('p', { style: 'font-family:var(--display);font-size:20px;color:#fff;margin:0 0 6px' }, project.developer),
          h('p', { style: 'margin:0' }, `RERA ${project.rera}`),
          h('p', { style: 'margin:6px 0 0' }, `Architect · ${project.architect}`),
        ),
        h(
          'div',
          {},
          h('h4', {}, 'Bookings & enquiries'),
          ...project.contacts.map((contact) =>
            h(
              'p',
              { style: 'margin:0 0 10px' },
              h('span', { class: 'muted' }, `${contact.region} · `),
              contact.name,
              h('br'),
              h('a', { href: `tel:${contact.phone.replace(/[^+\d]/g, '')}` }, contact.phone),
            ),
          ),
        ),
        h(
          'div',
          {},
          ...project.offices.map((office) =>
            h(
              'div',
              { style: 'margin-bottom:20px' },
              h('h4', {}, office.label),
              ...office.lines.map((line) => h('p', { style: 'margin:0' }, line)),
            ),
          ),
        ),
      ),
      h('p', { class: 'disclaimer' }, project.disclaimer),
      h(
        'div',
        { class: 'footer-base' },
        h('span', {}, `${project.name} · ${project.place}`),
        h('span', { class: 'credit' }, 'Made using ', h('strong', {}, brand.name)),
      ),
    ),
  )
}

function contactPage(): HTMLElement {
  return h(
    'main',
    { class: 'band' },
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'lede', style: 'margin:0 auto;text-align:center' },
        h('p', { class: 'kicker' }, 'Enquire'),
        h('h2', {}, 'Speak to the developer'),
        h('p', {}, `${project.developer} handles all bookings for ${project.name} directly.`),
      ),
      h(
        'div',
        { class: 'stat-row', style: 'margin-top:40px;grid-template-columns:repeat(2,1fr)' },
        ...project.contacts.map((contact) =>
          h(
            'div',
            { class: 'stat', style: 'padding:34px 20px' },
            h('div', { class: 'label' }, contact.region),
            h('div', { class: 'value', style: 'font-size:21px;margin:8px 0 4px' }, contact.name),
            h(
              'a',
              {
                href: `tel:${contact.phone.replace(/[^+\d]/g, '')}`,
                style: 'font-family:var(--mono);font-size:14px;text-decoration:none;color:var(--gold)',
              },
              contact.phone,
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'split', style: 'margin-top:56px' },
        ...project.offices.map((office) =>
          h(
            'div',
            {},
            h('p', { class: 'kicker' }, office.label),
            ...office.lines.map((line) => h('p', { style: 'margin:0;color:var(--ink-soft)' }, line)),
          ),
        ),
      ),
    ),
  )
}

function villaIndexPage(): HTMLElement {
  return h(
    'main',
    { class: 'band tight' },
    h(
      'div',
      { class: 'shell' },
      h('p', { class: 'kicker' }, 'Configurations'),
      h('h2', { style: 'font-size:34px;margin-bottom:10px' }, 'Five villa types, nineteen homes'),
      h(
        'p',
        { class: 'muted', style: 'margin-bottom:34px;max-width:640px' },
        'Each drawing set below is shared by the units listed on it. Open one for floor-by-floor plans and the full room schedule.',
      ),
      h(
        'div',
        { class: 'type-grid' },
        ...project.villaTypes.map((type) => {
          const count = project.sitePlan.units.filter((u) => u.typeId === type.id).length
          return h(
            'a',
            { class: 'type-card', href: `#/villa/${type.id}` },
            h('img', { src: `renders/${type.renders[0]}-card.webp`, alt: type.name, loading: 'lazy' }),
            h(
              'div',
              { class: 'body' },
              h('h3', {}, type.name),
              h('div', { class: 'units' }, type.appliesTo.join(' · ')),
              h('p', { class: 'muted', style: 'font-size:13px;margin:4px 0 0' },
                `${count} unit${count === 1 ? '' : 's'} · ${type.floors.length} levels`),
              h('div', { class: 'sbua' }, `${type.totalSbua.toFixed(2)} m²`),
            ),
          )
        }),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Hash routing rather than history routing.
 *
 * Published output is a folder of static files that gets dropped onto whatever
 * host the client already has. History routing needs a rewrite rule for deep
 * links; a hash needs nothing, and a URL that survives being emailed around is
 * worth more here than a clean path.
 */
/**
 * Tear-down for whatever the walkthrough module set up last.
 *
 * Held as a callback rather than an import so that nothing in this file
 * references the walkthrough module statically — one static import would pull
 * Three.js into the entry chunk and undo the lazy load below.
 */
let releaseWalkthrough: (() => void) | null = null

async function route(): Promise<void> {
  releaseWalkthrough?.()
  releaseWalkthrough = null

  const raw = location.hash.replace(/^#/, '') || '/'
  const [path, query] = raw.split('?')
  const params = new URLSearchParams(query ?? '')
  const parts = path.split('/').filter(Boolean)

  let view: HTMLElement
  switch (parts[0]) {
    case undefined:
      view = homePage(project)
      break
    case 'plan':
      view = masterPlanPage(project)
      break
    case 'villas':
      view = villaIndexPage()
      break
    case 'villa':
      view = villaPage(project, parts[1] ?? '', params.get('unit') ?? undefined)
      break
    case 'walkthrough': {
      // Three.js is half a megabyte and only this route needs it. Everything
      // else on the site is images and text, so the WebGL bundle is fetched
      // on demand rather than shipped to every visitor who opens a floor plan.
      const requested = raw
      view = h(
        'main',
        { class: 'band' },
        h('div', { class: 'shell' }, h('p', { class: 'muted' }, 'Loading the viewer…')),
      )
      void import('./pages/walkthrough').then((module) => {
        // The visitor may have navigated again while the chunk was in flight.
        if (location.hash.replace(/^#/, '') !== requested) return
        releaseWalkthrough = module.disposeWalkthrough
        view.replaceWith(module.walkthroughPage(project, parts[1] ?? ''))
      })
      break
    }
    case 'gallery':
      view = galleryPage(project)
      break
    case 'contact':
      view = contactPage()
      break
    default:
      view = homePage(project)
  }

  root.replaceChildren(header(), view, footer())

  // Mark the active nav item. Villa and walkthrough pages both belong to
  // "Villas" as far as the visitor is concerned.
  const section = parts[0] === 'walkthrough' ? 'villa' : parts[0]
  for (const link of root.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    const target = link.getAttribute('href')!.replace('#/', '')
    const match =
      (target === '' && section === undefined) ||
      (target === 'villas' && (section === 'villa' || section === 'villas')) ||
      target === section
    link.classList.toggle('active', Boolean(match))
  }

  // A fresh page should start at the top; the browser restores scroll on hash
  // changes otherwise and you land halfway down a page you have never seen.
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  describe(
    parts[0] === undefined
      ? `${project.name} — ${project.place}`
      : `${project.name} · ${titleFor(parts)}`,
    // The tagline is the one line written to describe the project to someone
    // who has not seen it, which is exactly what a description is for.
    project.tagline || `An interactive presentation of ${project.name}.`,
  )
}

function titleFor(parts: string[]): string {
  if (parts[0] === 'villa' || parts[0] === 'walkthrough') {
    const type = project.villaTypes.find((t) => t.id === parts[1])
    const prefix = parts[0] === 'walkthrough' ? '3D model · ' : ''
    return prefix + (type?.name ?? 'Villa')
  }
  const item = NAV.find((n) => n.href === `#/${parts[0]}`)
  return item?.label ?? project.place
}

window.addEventListener('hashchange', () => void route())

/**
 * Load the requested project, then render.
 *
 * ── Why a failed load must NOT fall back to the bundled project ─────────────
 * It is the obvious thing to write and it is the worst possible behaviour here.
 * A client opens the link to *their* development, the API is unreachable, and
 * the page renders — perfectly, with no error — showing somebody else's
 * project: their villas, their prices, their unit availability. Nothing looks
 * wrong, so nobody reports it.
 *
 * The bundled data is the default only when NO project was asked for. Once a
 * slug is in the URL, the only honest outcomes are that project or a visible
 * failure.
 */
async function boot(): Promise<void> {
  const slug = requestedSlug()
  if (!slug) {
    await route()
    return
  }

  root.replaceChildren(
    h('main', { class: 'band' }, h('div', { class: 'shell' }, h('p', { class: 'muted' }, 'Loading…'))),
  )

  let response: Response
  try {
    response = await fetch(`${apiBase()}/publications/public/${encodeURIComponent(slug)}`)
  } catch {
    root.replaceChildren(
      failure('This project could not be loaded', 'The server did not respond. Please try again shortly.'),
    )
    return
  }

  if (response.status === 404) {
    root.replaceChildren(
      failure('Nothing published at this address', 'The link may be out of date, or the project may have been withdrawn.'),
    )
    return
  }
  if (!response.ok) {
    const message = await response
      .json()
      .then((payload: { message?: string }) => payload.message)
      .catch(() => undefined)
    root.replaceChildren(failure('This project is not ready yet', message ?? 'Please try again shortly.'))
    return
  }

  const payload = (await response.json()) as { project?: Project }
  if (!payload.project) {
    root.replaceChildren(
      failure('This project is not ready yet', 'It has been published but not composed.'),
    )
    return
  }

  project = payload.project
  await route()
}

void boot()
