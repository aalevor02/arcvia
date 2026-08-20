import { useMemo, useState } from 'react'
import { CATEGORIES, searchCatalogue } from '../catalogue/items'
import { formatLength, type UnitSystem } from '../lib/format'
import type { CatalogueItem } from '../catalogue/types'

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
        Shapes are dimensioned stand-ins, not finished models — sized correctly
        so you can check clearances. Real models drop in later.
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
  return (
    <button
      className="catalogue-row"
      aria-pressed={active}
      aria-current={active}
      onClick={onPick}
      style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}
    >
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
    </button>
  )
}

const PLACEMENT_LABEL: Record<string, string> = {
  wall: 'on wall',
  'in-wall': 'in wall',
  ceiling: 'ceiling',
}
