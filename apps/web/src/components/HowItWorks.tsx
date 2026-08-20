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
  },
  {
    id: 'customise',
    label: 'Customise',
    title: 'Furnish, light and finish it',
    body: 'Place furniture from the catalogue, set materials per surface or per face, and light the scene. Everything happens live in the browser — nothing to install, nothing to re-import.',
    chips: ['Lighting', 'Furniture', 'Paint', 'Materials'],
  },
  {
    id: 'share',
    label: 'Share',
    title: 'Publish one link',
    body: 'Send a single URL. Clients explore on a phone, a laptop or a headset, reconfigure what you allow them to, and you see what they chose.',
    chips: ['Any device', 'No download', 'Configurable', 'VR ready'],
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

        {/* Inline SVG rather than a bitmap: it is a few hundred bytes, it is
            sharp at any density, and it recolours with the theme because it
            paints in currentColor and the brand tokens. */}
        <div className="aspect-[4/3] overflow-hidden rounded-lg border border-line bg-surface-alt">
          <Illustration step={active} />
        </div>
      </div>
    </div>
  )
}

function Illustration({ step }: { step: number }) {
  return (
    <svg
      viewBox="0 0 320 240"
      className="h-full w-full"
      role="img"
      aria-label={
        ['A floor plan being read', 'A furnished room', 'A shared link'][step]
      }
    >
      <defs>
        <pattern id="hiw-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path
            d="M16 0H0V16"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.5"
            className="text-line"
          />
        </pattern>
      </defs>
      <rect width="320" height="240" fill="url(#hiw-grid)" />

      {step === 0 && (
        <g>
          {/* Plan outline with detected openings marked */}
          <rect
            x="60" y="50" width="200" height="140"
            fill="none" stroke="currentColor" strokeWidth="6" className="text-ink"
          />
          <line x1="160" y1="50" x2="160" y2="130" stroke="currentColor" strokeWidth="6" className="text-ink" />
          <line x1="160" y1="130" x2="260" y2="130" stroke="currentColor" strokeWidth="6" className="text-ink" />
          {/* Openings the detector found */}
          {[
            [110, 50], [220, 50], [60, 120], [160, 95], [205, 130],
          ].map(([x, y], i) => (
            <rect
              key={i}
              x={x - 12} y={y - 4} width="24" height="8" rx="1"
              fill="currentColor" className="text-accent"
            />
          ))}
          <circle cx="110" cy="50" r="16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent" opacity="0.5" />
        </g>
      )}

      {step === 1 && (
        <g>
          <rect x="60" y="50" width="200" height="140" fill="none" stroke="currentColor" strokeWidth="6" className="text-ink" />
          {/* sofa */}
          <rect x="80" y="140" width="70" height="30" rx="5" fill="currentColor" className="text-accent" opacity="0.85" />
          <rect x="80" y="128" width="70" height="14" rx="5" fill="currentColor" className="text-accent" />
          {/* rug */}
          <ellipse cx="160" cy="150" rx="55" ry="22" fill="currentColor" className="text-ink-soft" opacity="0.18" />
          {/* table */}
          <rect x="140" y="140" width="42" height="22" rx="3" fill="currentColor" className="text-ink" opacity="0.65" />
          {/* bed / cabinet block */}
          <rect x="196" y="70" width="52" height="46" rx="4" fill="currentColor" className="text-ink" opacity="0.35" />
          {/* pendant light + cone */}
          <line x1="120" y1="50" x2="120" y2="76" stroke="currentColor" strokeWidth="2" className="text-ink" />
          <path d="M108 88 L120 76 L132 88 Z" fill="currentColor" className="text-ink" />
          <path d="M108 88 L92 130 L148 130 Z" fill="currentColor" className="text-warn" opacity="0.25" />
        </g>
      )}

      {step === 2 && (
        <g>
          {/* laptop */}
          <rect x="40" y="72" width="130" height="86" rx="6" fill="currentColor" className="text-ink" />
          <rect x="48" y="80" width="114" height="70" rx="3" fill="currentColor" className="text-accent" opacity="0.85" />
          <rect x="28" y="158" width="154" height="8" rx="4" fill="currentColor" className="text-ink" />
          {/* phone */}
          <rect x="196" y="86" width="52" height="90" rx="8" fill="currentColor" className="text-ink" />
          <rect x="202" y="94" width="40" height="74" rx="3" fill="currentColor" className="text-accent" opacity="0.85" />
          {/* link arc between them */}
          <path
            d="M150 60 Q200 26 250 62"
            fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeDasharray="6 5" className="text-accent"
          />
          <circle cx="250" cy="62" r="5" fill="currentColor" className="text-accent" />
          <circle cx="150" cy="60" r="5" fill="currentColor" className="text-accent" />
        </g>
      )}
    </svg>
  )
}
