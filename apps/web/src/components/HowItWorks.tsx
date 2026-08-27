import { useEffect, useRef, useState } from 'react'

/**
 * The three-step explainer, as tabs.
 *
 * ── Why tabs rather than three stacked cards ────────────────────────────────
 * The three steps are *sequential*, and a stack invites the eye to compare
 * them side by side instead of reading them in order. One panel at a time
 * enforces the sequence, and gives each step enough room for an illustration
 * that actually shows the thing.
 *
 * ── Why it advances on its own, and why that stops ──────────────────────────
 * Most visitors will not click a tab. Auto-advance means they still see all
 * three. But an auto-advancing control that keeps moving after someone has
 * chosen a tab is actively hostile, so the first interaction cancels the timer
 * permanently — and it never starts at all under prefers-reduced-motion.
 */

const STEPS = [
  {
    id: 'upload',
    label: 'Upload',
    title: 'Upload your drawings',
    body: 'CAD, SketchUp exports, PDF, JPG or PNG. The plan detector reads walls, doors, windows and fixtures — and tells you where it was unsure rather than guessing.',
    chips: ['DWG / DXF', 'PDF', 'PNG / JPG', 'GLB'],
    image: '/how/upload.webp',
    imageAlt: 'An architect’s drawing sheet with the storey plans Arcvia reads',
    width: 2000,
    height: 1000,
    // CONTAIN, not cover. This is a 2:1 drawing sheet in a 4:3 frame, and
    // object-cover crops to the centre - which lands in the white gap between
    // two storey plans and renders as an empty box. Cropping a technical drawing
    // also destroys the parts that make it one: the title block, the storey
    // labels and the area schedule. A render survives a crop; a drawing does not.
    fit: 'contain' as const,
  },
  {
    id: 'customise',
    label: 'Customise',
    title: 'Furnish, light and finish it',
    body: 'Place furniture from the catalogue, set materials per surface or per face, and light the scene. Everything happens live in the browser — nothing to install, nothing to re-import.',
    chips: ['Lighting', 'Furniture', 'Paint', 'Materials'],
    image: '/how/customise.webp',
    fit: 'cover' as const,
    imageAlt: 'A furnished and lit living room, materials set per surface',
    width: 1920,
    height: 1080,
  },
  {
    id: 'share',
    label: 'Share',
    title: 'Publish one link',
    body: 'Send a single URL. Clients explore on a phone, a laptop or a headset, reconfigure what you allow them to, and you see what they chose.',
    chips: ['Any device', 'No download', 'Configurable', 'VR ready'],
    image: '/how/share.webp',
    fit: 'cover' as const,
    imageAlt: 'The published exterior view a client opens from a single link',
    width: 1920,
    height: 1080,
  },
] as const

const ROTATE_MS = 6000

export default function HowItWorks() {
  const [active, setActive] = useState(0)
  const [auto, setAuto] = useState(true)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!auto) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setActive((i) => (i + 1) % STEPS.length), ROTATE_MS)
    return () => clearInterval(t)
  }, [auto])

  const choose = (i: number) => {
    setActive(i)
    setAuto(false)
  }

  // Arrow-key navigation is what makes a tablist a tablist to a screen reader.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = (active + delta + STEPS.length) % STEPS.length
    choose(next)
    tabs.current[next]?.focus()
  }

  const step = STEPS[active]

  return (
    <div className="mt-10">
      <div
        role="tablist"
        aria-label="How it works"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-2"
      >
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            role="tab"
            id={`hiw-tab-${s.id}`}
            aria-selected={i === active}
            aria-controls={`hiw-panel-${s.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => choose(i)}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              i === active
                ? 'border-accent bg-accent text-white'
                : 'border-line bg-surface text-ink-soft hover:bg-surface-alt'
            }`}
          >
            <span className="font-mono text-xs opacity-70">0{i + 1}</span>{' '}
            {s.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`hiw-panel-${step.id}`}
        aria-labelledby={`hiw-tab-${step.id}`}
        className="mt-6 grid gap-8 rounded-card border border-line bg-surface p-6 sm:p-8 lg:grid-cols-2 lg:items-center"
      >
        <div>
          <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {step.title}
          </h3>
          <p className="mt-3 leading-relaxed text-ink-soft">{step.body}</p>

          <ul className="mt-6 flex flex-wrap gap-2">
            {step.chips.map((c) => (
              <li key={c} className="pill">
                {c}
              </li>
            ))}
          </ul>
        </div>

        {/* Real frames from a real project, not drawings of them. The previous
            inline SVGs were chosen when there was nothing to show; there is now.
            An illustration of a floor plan cannot demonstrate that the detector
            reads a floor plan, which is the only claim this section makes.

            Only the ACTIVE step's image is eager. The other two are a tab click
            away and pre-loading all three would cost ~900 kB for two pictures
            most visitors never see. */}
        <div className="aspect-[4/3] overflow-hidden rounded-lg border border-line bg-surface-alt">
          <img
            src={step.image}
            width={step.width}
            height={step.height}
            alt={step.imageAlt}
            className={`h-full w-full ${step.fit === 'contain' ? 'object-contain p-3' : 'object-cover'}`}
            loading={active === 0 ? 'eager' : 'lazy'}
            decoding="async"
          />
        </div>
      </div>
    </div>
  )
}
