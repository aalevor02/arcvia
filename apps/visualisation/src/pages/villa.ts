import type { Project, Floor, Room } from '../types'
import { h, area, dimension, squareMetres, renderImg } from '../ui/dom'

const KIND_ORDER: Record<NonNullable<Room['kind']>, number> = {
  habitable: 0,
  service: 1,
  outdoor: 2,
  circulation: 3,
}

export function villaPage(project: Project, typeId: string, highlightUnit?: string): HTMLElement {
  const type = project.villaTypes.find((t) => t.id === typeId)
  if (!type) {
    return h(
      'main',
      { class: 'band' },
      h('div', { class: 'shell' }, h('h2', {}, 'Unknown configuration'),
        h('p', { class: 'muted' }, 'That villa type is not part of this project.'),
        h('a', { class: 'btn', href: '#/plan' }, 'Back to the master plan')),
    )
  }

  const heroSlug = type.renders[0]
  let activeFloor = type.floors[type.floors.length - 1] // top floor: pool and living

  const planFigure = h('figure', { class: 'plan-figure' })
  const scheduleHost = h('div', {})

  function paintFloor(floor: Floor): void {
    activeFloor = floor

    planFigure.replaceChildren(
      h('img', {
        src: floor.plan,
        alt: `${type!.name} — ${floor.label} floor plan`,
        loading: 'lazy',
      }),
    )

    const rooms = [...floor.rooms].sort(
      (a, b) =>
        KIND_ORDER[a.kind ?? 'habitable'] - KIND_ORDER[b.kind ?? 'habitable'] ||
        (squareMetres(b.width, b.depth) ?? 0) - (squareMetres(a.width, a.depth) ?? 0),
    )

    scheduleHost.replaceChildren(
      h(
        'table',
        { class: 'schedule' },
        h('caption', {}, `${floor.label} — room schedule`),
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, 'Space'), h('th', {}, 'Dimensions'), h('th', {}, 'Area')),
        ),
        h(
          'tbody',
          {},
          ...rooms.map((room) => {
            const sqm = squareMetres(room.width, room.depth)
            return h(
              'tr',
              { class: `k-${room.kind ?? 'habitable'}` },
              h('td', {}, room.name),
              h('td', { class: 'dim' }, dimension(room.width, room.depth)),
              h('td', { class: 'dim' }, sqm === null ? '—' : `${sqm.toFixed(1)}`),
            )
          }),
        ),
      ),
      h(
        'p',
        { class: 'muted', style: 'font-size:11px;margin-top:14px' },
        'Dimensions are transcribed from the architect’s drawings and are in metres. ' +
          'Room areas are the product of the stated dimensions, not the built-up area of the level.',
      ),
    )

    for (const button of tabs.querySelectorAll('.floor-tab')) button.classList.remove('on')
    tabs.querySelector(`[data-floor="${floor.id}"]`)?.classList.add('on')
  }

  const tabs = h(
    'div',
    { class: 'floor-tabs' },
    ...type.floors.map((floor) =>
      h(
        'button',
        {
          class: 'floor-tab',
          type: 'button',
          'data-floor': floor.id,
          onclick: () => paintFloor(floor),
        },
        floor.label,
        h('span', { class: 'a' }, area(floor.area)),
      ),
    ),
  )

  const unitsOfType = project.sitePlan.units.filter((u) => u.typeId === type.id)

  const page = h(
    'main',
    {},

    // ---- hero -------------------------------------------------------------
    h(
      'section',
      { class: 'villa-hero' },
      renderImg(heroSlug, { alt: type.name }),
      h(
        'div',
        { class: 'caption' },
        h('div', { class: 'shell' },
          h('p', { class: 'kicker', style: 'color:#c9a86a' },
            highlightUnit ? `Villa ${highlightUnit}` : 'Configuration'),
          h('h1', {}, type.name)),
      ),
    ),

    // ---- summary + areas --------------------------------------------------
    h(
      'section',
      { class: 'band tight' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            {},
            h('p', {}, type.summary),
            h(
              'p',
              { class: 'kicker', style: 'margin-top:26px' },
              unitsOfType.length === 1 ? 'Unit' : `${unitsOfType.length} units share this drawing set`,
            ),
            h(
              'div',
              { class: 'unit-pills' },
              ...unitsOfType.map((unit) =>
                h(
                  'a',
                  {
                    class: 'unit-pill',
                    href: `#/villa/${type.id}?unit=${unit.code}`,
                    style:
                      unit.code === highlightUnit
                        ? 'border-color:var(--gold);color:var(--ink);background:rgba(201,168,106,.12)'
                        : undefined,
                  },
                  unit.code,
                ),
              ),
            ),
            h(
              'div',
              { style: 'margin-top:30px;display:flex;gap:12px;flex-wrap:wrap' },
              // Called a model, not a walkthrough. It is an accurate massing model
              // generated from the drawings - floor plates, envelope, columns,
              // openings - presented as an orbit with a rendered film. Calling it a
              // walkthrough sets an expectation of walking through furnished rooms
              // that the geometry cannot meet, and an honest label reads as finished
              // where an overclaimed one reads as broken.
              h('a', { class: 'btn solid', href: `#/walkthrough/${type.id}` }, 'View the 3D model'),
              h('a', { class: 'btn', href: '#/plan' }, 'Master plan'),
            ),
          ),
          h(
            'div',
            {},
            h(
              'table',
              { class: 'area-table' },
              h(
                'tbody',
                {},
                ...type.floors.map((floor) =>
                  h('tr', {}, h('td', {}, `${floor.label} floor`), h('td', {}, area(floor.area))),
                ),
                h('tr', { class: 'total' }, h('td', {}, 'Total SBUA'), h('td', {}, area(type.totalSbua))),
              ),
            ),
            h(
              'p',
              { class: 'muted', style: 'font-size:12px' },
              'Super built-up area as stated on the architect’s type sheet.',
            ),
          ),
        ),
      ),
    ),

    // ---- floor plans ------------------------------------------------------
    h(
      'section',
      { class: 'band alt' },
      h(
        'div',
        { class: 'shell' },
        h('p', { class: 'kicker' }, 'Drawings'),
        h('h2', { style: 'font-size:32px;margin-bottom:26px' }, 'Floor by floor'),
        tabs,
        h('div', { class: 'floor-body' }, planFigure, scheduleHost),
      ),
    ),

    // ---- renders ----------------------------------------------------------
    type.renders.length > 1 &&
      h(
        'section',
        { class: 'band' },
        h(
          'div',
          { class: 'shell' },
          h('p', { class: 'kicker' }, 'Views'),
          h(
            'div',
            { class: 'gallery-grid', style: 'margin-top:22px' },
            ...type.renders.map((slug) => {
              const item = project.gallery.find((g) => g.slug === slug)
              return h(
                'figure',
                {
                  class: 'gallery-item',
                  onclick: () => openLightbox(slug, item?.caption ?? type.name),
                },
                h('img', { src: `renders/${slug}-card.webp`, alt: item?.caption ?? type.name, loading: 'lazy' }),
                h('figcaption', {}, item?.caption ?? type.name),
              )
            }),
          ),
        ),
      ),
  )

  paintFloor(activeFloor)
  return page
}

export function openLightbox(slug: string, caption: string): void {
  const box = h(
    'div',
    { class: 'lightbox', onclick: () => box.remove() },
    h(
      'div',
      {},
      h('img', { src: `renders/${slug}.webp`, alt: caption }),
      h('p', { class: 'cap' }, caption),
    ),
  )
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      box.remove()
      window.removeEventListener('keydown', onKey)
    }
  }
  window.addEventListener('keydown', onKey)
  document.body.appendChild(box)
}
