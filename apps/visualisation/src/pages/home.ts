import type { Project } from '../types'
import { h, area, renderImg } from '../ui/dom'
import { openLightbox } from './villa'

export function homePage(project: Project): HTMLElement {
  return h(
    'main',
    {},

    // ---- hero -------------------------------------------------------------
    h(
      'section',
      { class: 'hero' },
      // The hero image is the PROJECT's own site plan, not a bundled literal.
      // This was `renders/aerial-day.webp` — a hard-coded path into the app
      // bundle, which ships only Casa Altinho's renders — so every composed
      // project rendered a different client's hillside villas full-bleed above
      // the fold, HTTP 200, captioned with the wrong developer's name.
      // `sitePlan.image` is a complete path (`site/siteplan.webp`), used raw
      // the same way `imageSmall` is in the master-plan teaser below — NOT a
      // render slug, so it is not run through `renderImg`. When a project has
      // no site plan the hero shows its copy over the section background rather
      // than someone else's photograph.
      project.sitePlan?.image
        ? h('img', {
            src: project.sitePlan.image,
            alt: `${project.name} seen from the air`,
            fetchpriority: 'high',
          })
        : false,
      h(
        'div',
        { class: 'hero-copy' },
        h('div', { class: 'script' }, project.script),
        h('h1', {}, project.name.replace(`${project.script} `, '')),
        h('div', { class: 'place' }, project.place),
        h('div', { class: 'tagline' }, project.tagline),
      ),
    ),

    // ---- intro ------------------------------------------------------------
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'lede', style: 'margin:0 auto;text-align:center' },
          h('p', { class: 'kicker' }, project.place),
          h('h2', {}, project.intro.heading),
          ...project.intro.body.map((line) => h('p', {}, line)),
        ),
      ),
    ),

    // ---- key figures ------------------------------------------------------
    h(
      'section',
      { class: 'band tight alt' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'stat-row' },
          ...project.stats.map((stat) =>
            h('div', { class: 'stat' },
              h('div', { class: 'value' }, stat.value),
              h('div', { class: 'label' }, stat.label)),
          ),
        ),
      ),
    ),

    // ---- master plan teaser ----------------------------------------------
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            {},
            h('p', { class: 'kicker' }, 'The site'),
            h('h2', { style: 'font-size:34px;margin-bottom:18px' }, 'Five rows above the river'),
            h(
              'p',
              { class: 'muted' },
              'Nineteen villas across rows A to E, each with its own pool and lift, arranged around 6.00 m internal roads with landscaped terraces stepping between the rows.',
            ),
            h(
              'p',
              { style: 'margin-top:22px' },
              h('a', { class: 'btn solid', href: '#/plan' }, 'Explore the master plan'),
            ),
          ),
          h(
            'a',
            { href: '#/plan', style: 'display:block;border:1px solid var(--line)' },
            h('img', {
              src: project.sitePlan.imageSmall,
              alt: 'Master plan',
              loading: 'lazy',
            }),
          ),
        ),
      ),
    ),

    // ---- narrative sections ----------------------------------------------
    ...project.sections.map((section, index) =>
      h(
        'section',
        { class: index % 2 === 1 ? 'band alt' : 'band' },
        h(
          'div',
          { class: 'shell' },
          h(
            'div',
            { class: index % 2 === 1 ? 'split reverse' : 'split' },
            h(
              'div',
              { class: 'lede' },
              h('p', { class: 'kicker' }, section.kicker),
              h('h2', {}, section.heading),
              ...section.body.map((line) => h('p', {}, line)),
            ),
            h('img', { src: section.image, alt: section.heading, loading: 'lazy' }),
          ),
        ),
      ),
    ),

    // ---- configurations ---------------------------------------------------
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'lede', style: 'margin-bottom:34px' },
          h('p', { class: 'kicker' }, 'Configurations'),
          h('h2', {}, 'Five villa types'),
          h(
            'p',
            {},
            'Every villa runs over four levels with a private pool on the top floor and a lift to every level. The five drawing sets differ in footprint, bedroom count and the treatment of the stilt level.',
          ),
        ),
        h(
          'div',
          { class: 'type-grid' },
          ...project.villaTypes.map((type) => {
            const count = project.sitePlan.units.filter((u) => u.typeId === type.id).length
            return h(
              'a',
              { class: 'type-card', href: `#/villa/${type.id}` },
              renderImg(type.renders[0], { alt: type.name, suffix: '-card', loading: 'lazy' }),
              h(
                'div',
                { class: 'body' },
                h('h3', {}, type.name),
                h('div', { class: 'units' }, `${count} unit${count === 1 ? '' : 's'} · ${type.floors.length} levels`),
                h('div', { class: 'sbua' }, area(type.sbua ?? type.totalMeasuredArea ?? 0)),
              ),
            )
          }),
        ),
      ),
    ),

    // ---- gallery strip ----------------------------------------------------
    h(
      'section',
      { class: 'band alt' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { style: 'display:flex;justify-content:space-between;align-items:end;margin-bottom:26px;gap:20px;flex-wrap:wrap' },
          h('div', {}, h('p', { class: 'kicker' }, 'Gallery'), h('h2', { style: 'font-size:32px' }, 'The project in view')),
          h('a', { class: 'btn', href: '#/gallery' }, 'All images'),
        ),
        h(
          'div',
          { class: 'gallery-grid' },
          ...project.gallery.slice(0, 6).map((item) =>
            h(
              'figure',
              { class: 'gallery-item', onclick: () => openLightbox(item.slug, item.caption) },
              h('img', { src: `renders/${item.slug}-card.webp`, alt: item.caption, loading: 'lazy' }),
              h('figcaption', {}, item.caption),
            ),
          ),
        ),
      ),
    ),

    // ---- location ---------------------------------------------------------
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'lede' },
            h('p', { class: 'kicker' }, 'Location'),
            h('h2', {}, 'Tranquility at a driving distance'),
            ...project.locationMap.note.map((line) => h('p', {}, line)),
          ),
          h('img', {
            src: project.locationMap.image,
            alt: 'Location map',
            loading: 'lazy',
            style: 'border:1px solid var(--line)',
          }),
        ),
      ),
    ),
  )
}
