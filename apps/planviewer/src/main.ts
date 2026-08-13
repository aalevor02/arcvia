import { exportPlanHtml, type Zone, type PlanDocument } from './exporter'

const SVG_NS = 'http://www.w3.org/2000/svg'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fileInput = el<HTMLInputElement>('file')
const titleInput = el<HTMLInputElement>('title')
const accentInput = el<HTMLInputElement>('accent')
const planImg = el<HTMLImageElement>('plan')
const stage = el<HTMLDivElement>('stage')
const empty = el<HTMLParagraphElement>('empty')
const draw = document.getElementById('draw') as unknown as SVGSVGElement
const zoneList = el<HTMLDivElement>('zoneList')
const editor = el<HTMLDivElement>('editor')
const exportBtn = el<HTMLButtonElement>('export')
const clearBtn = el<HTMLButtonElement>('clear')
const sizeHint = el<HTMLParagraphElement>('sizeHint')

const fields = {
  label: el<HTMLInputElement>('zLabel'),
  title: el<HTMLInputElement>('zTitle'),
  body: el<HTMLTextAreaElement>('zBody'),
  linkText: el<HTMLInputElement>('zLinkText'),
  linkUrl: el<HTMLInputElement>('zLinkUrl'),
}

let imageSrc = ''
let zones: Zone[] = []
let selectedId: string | null = null
let drafting: { x: number; y: number }[] = []

const uid = () => Math.random().toString(36).slice(2, 10)

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = () => {
    imageSrc = String(reader.result)
    planImg.src = imageSrc
    stage.hidden = false
    empty.hidden = true
    exportBtn.disabled = false

    // Base64 inflates by ~33%. Above a couple of MB, a single-file export stops
    // being convenient and starts being a page that takes ten seconds to open.
    const mb = (imageSrc.length / 1_048_576) * 0.75
    sizeHint.textContent =
      mb > 2
        ? `Image is ~${mb.toFixed(1)} MB. The export will be large — consider compressing it first.`
        : `Image ~${mb.toFixed(1)} MB.`
  }
  reader.readAsDataURL(file)
})

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Convert a pointer event to percentage coordinates.
 *
 * Percentages rather than pixels because the exported viewer scales the plan to
 * fit any window. Pixel coordinates captured at the editor's size would be
 * wrong everywhere else.
 */
function toPercent(event: MouseEvent): { x: number; y: number } {
  const rect = planImg.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * 100,
    y: ((event.clientY - rect.top) / rect.height) * 100,
  }
}

draw.addEventListener('click', (event) => {
  drafting.push(toPercent(event as MouseEvent))
  render()
})

document.addEventListener('keydown', (event) => {
  // Ignore shortcuts while the user is typing into the zone fields.
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

  if (event.key === 'Enter' && drafting.length >= 3) {
    commitDraft()
  } else if (event.key === 'Escape') {
    drafting = []
    render()
  } else if (event.key === 'Backspace') {
    event.preventDefault()
    drafting.pop()
    render()
  }
})

function commitDraft(): void {
  const zone: Zone = {
    id: uid(),
    label: `Zone ${zones.length + 1}`,
    points: drafting,
    popupTitle: `Zone ${zones.length + 1}`,
    popupBody: '',
    hoverColor: hexToRgba(accentInput.value, 0.35),
    groupId: null,
  }
  zones.push(zone)
  drafting = []
  select(zone.id)
  render()
}

function select(id: string | null): void {
  selectedId = id
  const zone = zones.find((z) => z.id === id)
  editor.hidden = !zone
  if (!zone) return

  fields.label.value = zone.label
  fields.title.value = zone.popupTitle
  fields.body.value = zone.popupBody
  fields.linkText.value = zone.linkText ?? ''
  fields.linkUrl.value = zone.linkUrl ?? ''
  render()
}

for (const [key, input] of Object.entries(fields)) {
  input.addEventListener('input', () => {
    const zone = zones.find((z) => z.id === selectedId)
    if (!zone) return

    if (key === 'label') zone.label = input.value
    if (key === 'title') zone.popupTitle = input.value
    if (key === 'body') zone.popupBody = input.value
    if (key === 'linkText') zone.linkText = input.value
    if (key === 'linkUrl') zone.linkUrl = input.value

    renderList()
  })
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  while (draw.firstChild) draw.removeChild(draw.firstChild)

  for (const zone of zones) {
    const poly = document.createElementNS(SVG_NS, 'polygon')
    poly.setAttribute('points', zone.points.map((p) => `${p.x},${p.y}`).join(' '))
    const selected = zone.id === selectedId
    poly.setAttribute('fill', selected ? hexToRgba(accentInput.value, 0.4) : hexToRgba(accentInput.value, 0.18))
    poly.setAttribute('stroke', accentInput.value)
    poly.setAttribute('stroke-width', selected ? '0.4' : '0.2')
    poly.style.cursor = 'pointer'
    poly.addEventListener('click', (e) => {
      e.stopPropagation()
      select(zone.id)
    })
    draw.appendChild(poly)
  }

  // In-progress polygon: line so far plus a dot on each placed point.
  if (drafting.length > 0) {
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', drafting.map((p) => `${p.x},${p.y}`).join(' '))
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', '#ffffff')
    line.setAttribute('stroke-width', '0.3')
    line.setAttribute('stroke-dasharray', '1 0.6')
    draw.appendChild(line)

    for (const point of drafting) {
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('cx', String(point.x))
      dot.setAttribute('cy', String(point.y))
      // preserveAspectRatio="none" stretches the viewBox, so a circle would
      // render as an ellipse. A tiny square is honest about the distortion.
      dot.setAttribute('r', '0.5')
      dot.setAttribute('fill', '#ffffff')
      draw.appendChild(dot)
    }
  }

  renderList()
}

function renderList(): void {
  // replaceChildren() rather than innerHTML = '': same effect, but it never
  // parses a string as HTML, so the pattern cannot rot into an XSS hole if
  // someone later drops a zone label into it.
  zoneList.replaceChildren()

  for (const zone of zones) {
    const row = document.createElement('div')
    row.className = `zone-item${zone.id === selectedId ? ' sel' : ''}`
    row.addEventListener('click', () => select(zone.id))

    const name = document.createElement('span')
    name.textContent = zone.label || '(untitled)'

    const remove = document.createElement('button')
    remove.textContent = '×'
    remove.title = 'Delete zone'
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      zones = zones.filter((z) => z.id !== zone.id)
      if (selectedId === zone.id) select(null)
      render()
    })

    row.append(name, remove)
    zoneList.appendChild(row)
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

exportBtn.addEventListener('click', () => {
  const doc: PlanDocument = {
    title: titleInput.value || 'Master Plan',
    imageSrc,
    accent: accentInput.value,
    zones,
    groups: [],
  }

  const html = exportPlanHtml(doc)
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${slugify(doc.title)}.html`
  anchor.click()

  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers before it has actually started.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

clearBtn.addEventListener('click', () => {
  if (zones.length > 0 && !confirm('Delete all zones?')) return
  zones = []
  drafting = []
  select(null)
  render()
})

accentInput.addEventListener('input', render)

// ---------------------------------------------------------------------------

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int)) return `rgba(47,109,246,${alpha})`
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plan'
}

render()
