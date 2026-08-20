import type { Project, GalleryItem } from '../types'
import { h } from '../ui/dom'
import { openLightbox } from './villa'

const GROUPS: { id: GalleryItem['group'] | 'all'; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'aerial', label: 'Aerial' },
  { id: 'exterior', label: 'Exteriors' },
  { id: 'interior', label: 'Interiors' },
  { id: 'landscape', label: 'Landscape' },
]

export function galleryPage(project: Project): HTMLElement {
  let active: GalleryItem['group'] | 'all' = 'all'
  const grid = h('div', { class: 'gallery-grid' })

  function paint(): void {
    const items = project.gallery.filter((item) => active === 'all' || item.group === active)
    grid.replaceChildren(
      ...items.map((item) =>
        h(
          'figure',
          { class: 'gallery-item', onclick: () => openLightbox(item.slug, item.caption) },
          h('img', { src: `renders/${item.slug}-card.webp`, alt: item.caption, loading: 'lazy' }),
          h('figcaption', {}, item.caption),
        ),
      ),
    )
  }

  const chips = h(
    'div',
    { class: 'plan-legend', style: 'margin-bottom:30px' },
    ...GROUPS.map((group) => {
      const count =
        group.id === 'all'
          ? project.gallery.length
          : project.gallery.filter((g) => g.group === group.id).length
      if (count === 0) return h('span', { style: 'display:none' })

      const chip = h(
        'button',
        {
          class: group.id === 'all' ? 'chip on' : 'chip',
          type: 'button',
          onclick: () => {
            active = group.id
            for (const el of chips.querySelectorAll('.chip')) el.classList.remove('on')
            chip.classList.add('on')
            paint()
          },
        },
        `${group.label} · ${count}`,
      )
      return chip
    }),
  )

  paint()

  return h(
    'main',
    { class: 'band tight' },
    h(
      'div',
      { class: 'shell' },
      h('p', { class: 'kicker' }, 'Gallery'),
      h('h2', { style: 'font-size:34px;margin-bottom:8px' }, project.name),
      h(
        'p',
        { class: 'muted', style: 'margin-bottom:26px' },
        `${project.gallery.length} images. Select any image to view it full size.`,
      ),
      chips,
      grid,
    ),
  )
}
