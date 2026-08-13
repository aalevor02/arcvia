import { useState } from 'react'
import type { Faq } from '../data/faqs'

interface Props {
  items: Faq[]
  /** Index open on first paint. `null` collapses everything. */
  initialOpen?: number | null
}

/**
 * Single-open accordion.
 *
 * Built on <button> + aria-expanded rather than <details>/<summary> because we
 * want exactly one panel open at a time, which <details> cannot express without
 * JS anyway — and once JS is involved, the explicit ARIA version is the one
 * screen readers announce correctly.
 */
export default function FaqAccordion({ items, initialOpen = 0 }: Props) {
  const [open, setOpen] = useState<number | null>(initialOpen)

  return (
    <div className="mt-8 divide-y divide-line border-y border-line">
      {items.map((item, i) => {
        const isOpen = open === i
        const panelId = `faq-panel-${i}`
        const buttonId = `faq-button-${i}`

        return (
          <div key={item.q}>
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-6 py-5 text-left"
              >
                <span className="text-[15px] font-medium leading-snug">
                  {item.q}
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className={`shrink-0 text-ink-soft transition-transform duration-200 ${
                    isOpen ? 'rotate-45' : ''
                  }`}
                >
                  <path
                    d="M8 2v12M2 8h12"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </h3>

            {/* Grid-rows 0fr -> 1fr animates to the panel's natural height
                without measuring it in JS or hard-coding a max-height. */}
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!isOpen}
              className="grid transition-[grid-template-rows] duration-200"
              style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
            >
              <div className="overflow-hidden">
                <p className="pb-5 pr-10 text-sm leading-relaxed text-ink-soft">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
