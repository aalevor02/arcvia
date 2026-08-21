import './styles.css'
import { brand } from '@arcvia/brand'
import project from './data/casa-altinho'
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
  document.title =
    parts[0] === undefined
      ? `${project.name} — ${project.place}`
      : `${project.name} · ${titleFor(parts)}`
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
void route()
