import { useEffect, useMemo, useRef, useState } from 'react'
import { CATEGORIES, searchCatalogue } from '../catalogue/items'
import { formatLength, type UnitSystem } from '../lib/format'
import type { CatalogueItem } from '../catalogue/types'
import { thumbnailFor } from '../catalogue/thumbnail'

interface Props {
  units: UnitSystem
  /** Item currently armed for placing, if any. */
  placing: string | null
  onPick(itemId: string | null): void
}

/**
 * The furniture picker.
 *
 * Every entry shows its real dimensions, because that is the question people
 * are actually asking when they open this: *will it fit*. The reference shows
 * only a thumbnail, which looks better and answers nothing — you find out the
 * sofa is too big after you have placed it.
 *
 * ── And a thumbnail as well, which is a different question ──────────────────
 * That argument is against a picture INSTEAD of the dimensions, and it still
 * holds. It was never an argument against having both: "will it fit" and "is
 * this the thing I mean" are both worth a row, and only the first was answered.
 * A list of forty-six names is hard to shop from.
 *
 * The picture is rendered from the object itself — `catalogue/thumbnail.ts`
 * builds it exactly as the editor does — so it is the thing that will land in
 * the plan rather than a photograph of something similar.
 *
 * Rendered only when a row is actually on screen. Drawing all of them on open
 * would fetch every GLB in the catalogue, eleven megabytes, to populate a panel
 * someone opened to place one chair.
 */
export function CataloguePanel({ units, placing, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('')

  const results = useMemo(
    () => searchCatalogue(query, category || undefined),
    [query, category],
  )

  return (
    <section>
      <span className="eyebrow">Catalogue</span>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search furniture…"
        aria-label="Search the catalogue"
      />

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        aria-label="Category"
      >
        <option value="">All categories</option>
        {CATEGORIES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      {placing && (
        <p className="alert" style={{ fontSize: 11.5, borderColor: 'var(--accent)' }}>
          Click in the plan to place it. <strong>R</strong> rotates,{' '}
          <strong>Esc</strong> cancels.
        </p>
      )}

      <div
        data-catalogue-list=""
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          maxHeight: 340,
          overflowY: 'auto',
        }}
      >
        {results.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>
            Nothing matches that.
          </p>
        ) : (
          results.map((item) => (
            <CatalogueRow
              key={item.id}
              item={item}
              units={units}
              active={placing === item.id}
              onPick={() => onPick(placing === item.id ? null : item.id)}
            />
          ))
        )}
      </div>

      <p className="muted" style={{ fontSize: 11 }}>
        Every item is sized correctly, so a plan answers whether it fits. Items
        without a model are drawn as dimensioned stand-ins.
      </p>
    </section>
  )
}

function CatalogueRow({
  item,
  units,
  active,
  onPick,
}: {
  item: CatalogueItem
  units: UnitSystem
  active: boolean
  onPick(): void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [thumb, setThumb] = useState<string | null>(null)

  /**
   * Render the picture when the row is actually visible.
   *
   * The catalogue is sixty-three items and thirty-eight of them have a GLB. All
   * of them at once is the whole model library downloaded to draw a list. An
   * observer per row is cheap; the alternative is a panel that stalls on open.
   */
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return

    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void thumbnailFor(item).then((url) => {
          if (!cancelled) setThumb(url)
        })
      },
      // A little ahead of the scroll, so a row is drawn by the time it arrives
      // rather than popping in under the cursor.
      { root: node.closest('[data-catalogue-list]'), rootMargin: '120px' },
    )
    observer.observe(node)

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [item])

  return (
    <button
      ref={ref}
      className="catalogue-row"
      aria-pressed={active}
      aria-current={active}
      onClick={onPick}
      style={{ alignItems: 'center', flexDirection: 'row', gap: 9 }}
    >
      <span
        aria-hidden="true"
        style={{
          // Explicit, not inherited from being a flex item. A span is `display:
          // inline` by default and an inline box IGNORES width and height, so
          // this collapsed to nothing the moment it was rendered outside a flex
          // parent — which is exactly what a test harness does.
          display: 'block',
          flex: 'none',
          width: 46,
          height: 35,
          borderRadius: 5,
          background: 'var(--panel-alt)',
          backgroundImage: thumb ? `url(${thumb})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
      <span style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8 }}>
        <span>{item.name}</span>
        {/* Placement is the thing that surprises people: a door behaves
            completely differently from a sofa, and saying so up front is
            cheaper than a rejected drop. */}
        {item.placement !== 'floor' && (
          <span className="pill" style={{ fontSize: 10 }}>
            {PLACEMENT_LABEL[item.placement]}
          </span>
        )}
      </span>
      <span className="muted mono" style={{ fontSize: 10.5 }}>
        {formatLength(item.size.width, units)} × {formatLength(item.size.depth, units)}
        {item.note ? ` · ${item.note}` : ''}
      </span>
      </span>
    </button>
  )
}

const PLACEMENT_LABEL: Record<string, string> = {
  wall: 'on wall',
  'in-wall': 'in wall',
  ceiling: 'ceiling',
}
