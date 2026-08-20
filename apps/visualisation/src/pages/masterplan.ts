import type { Project, Unit } from '../types'
import { h, svg, area } from '../ui/dom'

/** One colour per villa type, so the plan reads as five configurations. */
const TYPE_COLOUR: Record<string, string> = {
  a1: '#c9a86a',
  b1: '#7fa8b5',
  bd: '#8fae7d',
  ce: '#b58f9c',
  e1: '#d08a5c',
}

const STATUS_LABEL: Record<Unit['status'], string> = {
  available: 'Available',
  held: 'On hold',
  sold: 'Sold',
}

export function masterPlanPage(project: Project): HTMLElement {
  const types = new Map(project.villaTypes.map((t) => [t.id, t]))
  let activeType: string | null = null

  const card = h('div', { class: 'plot-card', style: 'display:none' })
  const overlay = svg('svg', {
    class: 'plan-overlay',
    viewBox: '0 0 100 100',
    // The plan is a fixed-aspect drawing that must stretch with its image, so
    // the viewBox stretches too. Circles would become ellipses under this, which
    // is why every marker here is a polygon.
    preserveAspectRatio: 'none',
  })

  const shapes = new Map<string, SVGPolygonElement>()

  for (const unit of project.sitePlan.units) {
    const type = types.get(unit.typeId)
    const colour = TYPE_COLOUR[unit.typeId] ?? '#c9a86a'

    const poly = svg('polygon', {
      class: 'plot',
      points: unit.polygon.map(([x, y]) => `${x},${y}`).join(' '),
      fill: hexToRgba(colour, 0.0),
      stroke: hexToRgba(colour, 0.0),
      'stroke-width': '0.35',
      tabindex: '0',
      role: 'link',
      'aria-label': `${unit.code} — ${type?.name ?? 'villa'}, ${area(type?.totalSbua ?? 0)}`,
    })

    const show = () => {
      poly.setAttribute('fill', hexToRgba(colour, 0.55))
      poly.setAttribute('stroke', colour)
      showCard(unit, colour)
    }
    const hide = () => {
      applyFilter()
      card.style.display = 'none'
    }

    poly.addEventListener('pointerenter', show)
    poly.addEventListener('focus', show)
    poly.addEventListener('pointerleave', hide)
    poly.addEventListener('blur', hide)
    poly.addEventListener('click', () => {
      location.hash = `#/villa/${unit.typeId}?unit=${unit.code}`
    })
    poly.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter' || key === ' ') {
        event.preventDefault()
        location.hash = `#/villa/${unit.typeId}?unit=${unit.code}`
      }
    })

    shapes.set(unit.code, poly)
    overlay.appendChild(poly)
  }

  // Unit codes sit above the polygons so they never swallow a pointer event.
  for (const unit of project.sitePlan.units) {
    const cx = unit.polygon.reduce((sum, p) => sum + p[0], 0) / unit.polygon.length
    const cy = unit.polygon.reduce((sum, p) => sum + p[1], 0) / unit.polygon.length
    overlay.appendChild(
      svg(
        'text',
        {
          x: String(cx),
          y: String(cy),
          fill: '#ffffff',
          'font-size': '2.1',
          'font-family': 'ui-sans-serif, system-ui, sans-serif',
          'font-weight': '600',
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          'pointer-events': 'none',
          style: 'paint-order: stroke; stroke: rgba(10,18,14,.55); stroke-width: .5px;',
        },
        unit.code,
      ),
    )
  }

  const planWrap = h(
    'div',
    { class: 'plan-wrap' },
    h('img', {
      src: project.sitePlan.image,
      alt: `${project.name} site plan — ${project.sitePlan.units.length} villas`,
      width: '2400',
      height: '1200',
    }),
    overlay,
    card,
  )

  function showCard(unit: Unit, colour: string): void {
    const type = types.get(unit.typeId)
    const cx = unit.polygon.reduce((s, p) => s + p[0], 0) / unit.polygon.length
    const top = Math.min(...unit.polygon.map((p) => p[1]))

    card.replaceChildren(
      h('h4', {}, `Villa ${unit.code}`),
      h('div', { class: 'type', style: `color:${colour}` }, type?.name ?? ''),
      h(
        'dl',
        {},
        h('dt', {}, 'Total SBUA'),
        h('dd', {}, area(type?.totalSbua ?? 0)),
        h('dt', {}, 'Levels'),
        h('dd', {}, String(type?.floors.length ?? 0)),
        h('dt', {}, 'Facing'),
        h('dd', {}, unit.facing ?? '—'),
        h('dt', {}, 'Status'),
        h('dd', {}, STATUS_LABEL[unit.status]),
      ),
    )
    card.style.left = `${cx}%`
    card.style.top = `${top}%`
    card.style.display = 'block'
  }

  /** Dim everything that is not the selected type. */
  function applyFilter(): void {
    for (const unit of project.sitePlan.units) {
      const poly = shapes.get(unit.code)
      if (!poly) continue
      const colour = TYPE_COLOUR[unit.typeId] ?? '#c9a86a'
      const on = activeType === null || activeType === unit.typeId
      poly.setAttribute('fill', hexToRgba(colour, on && activeType ? 0.45 : 0.16))
      poly.setAttribute('stroke', hexToRgba(colour, on ? 0.85 : 0.15))
    }
  }

  const chips = h(
    'div',
    { class: 'plan-legend' },
    ...project.villaTypes.map((type) => {
      const count = project.sitePlan.units.filter((u) => u.typeId === type.id).length
      const chip = h(
        'button',
        {
          class: 'chip',
          type: 'button',
          onclick: () => {
            activeType = activeType === type.id ? null : type.id
            for (const el of chips.querySelectorAll('.chip')) el.classList.remove('on')
            if (activeType) chip.classList.add('on')
            applyFilter()
          },
        },
        h('span', { class: 'swatch', style: `background:${TYPE_COLOUR[type.id]}` }),
        `${type.name.replace('Villa ', '')} · ${count}`,
      )
      return chip
    }),
  )

  applyFilter()

  return h(
    'main',
    {},
    h(
      'section',
      { class: 'band tight' },
      h(
        'div',
        { class: 'shell stack-lg' },
        h(
          'div',
          { class: 'lede' },
          h('p', { class: 'kicker' }, 'Master plan'),
          h('h2', {}, `${project.sitePlan.units.length} villas, five configurations`),
          h(
            'p',
            {},
            'Hover a plot for its configuration and built-up area; select one to open its drawings. Filter by configuration to see how the five types are distributed across the site.',
          ),
        ),
        chips,
        planWrap,
        h(
          'p',
          { class: 'muted', style: 'font-size:12px' },
          'Site plan reproduced from the developer’s brochure. Internal roads are 6.00 m wide throughout; service space runs along the northern boundary and open space sits to the north-east.',
        ),
      ),
    ),
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int)) return `rgba(201,168,106,${alpha})`
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`
}
