import { summariseFurniture, type Proposal } from '../plan/furnish'
import { CATALOGUE } from '../catalogue/items'

interface Props {
  furniture: Proposal[]
  /**
   * One line of context above the stats — a multi-storey CAD import reviews
   * one storey at a time, and without this line the second batch looks like
   * the first one reappearing.
   */
  heading?: string
  onAccept(): void
  onDiscard(): void
  onFindAsset?(piece: Proposal): void
}

const NAME = new Map(CATALOGUE.map((item) => [item.id, item.name]))

/**
 * What the drawing said was in the rooms, before any of it is placed.
 *
 * ── Why the evidence is shown and not just the count ────────────────────────
 * "18 pieces of furniture found" is not reviewable. Some of those were read off
 * a label the architect wrote, some were inferred from a rectangle's size, and
 * on a bare plan some are a guess from the room's name — and the three deserve
 * very different amounts of trust. Presenting them as one number invites
 * accepting the guesses along with the certainties, then finding a bed in the
 * pantry later with no way to tell how it got there.
 *
 * So they are grouped by what led to them, strongest first, and each row says
 * so in words. The user can accept the lot in one click; the point is that they
 * can see what they are accepting.
 */
export function FurnitureReview({ furniture, heading, onAccept, onDiscard, onFindAsset }: Props) {
  const summary = summariseFurniture(furniture)

  const groups = [
    {
      key: 'labelled' as const,
      title: 'Named on the drawing',
      note: 'The architect wrote what these are.',
      tone: 'var(--signal)',
    },
    {
      key: 'measured' as const,
      title: 'Read from their size',
      note: 'Drawn to scale and matched against the catalogue.',
      tone: 'var(--accent, var(--signal))',
    },
    {
      key: 'rendered' as const,
      title: 'Seen in the render',
      note: 'The item is visible; its proposed position is arranged inside the measured room.',
      tone: 'var(--accent, var(--signal))',
    },
    {
      key: 'typical' as const,
      title: 'Assumed from the room',
      note: 'Nothing was drawn here — these are a starting point, not a reading.',
      tone: 'var(--warn)',
    },
    {
      key: 'unresolved' as const,
      title: 'Needs an asset or placement decision',
      note: 'Seen in the render, but no safe catalogue model or attachment target exists yet.',
      tone: 'var(--warn)',
    },
  ]

  return (
    <>
      {heading && (
        <p className="alert" style={{ fontSize: 11.5, margin: '0 0 6px' }}>
          {heading}
        </p>
      )}
      <div className="stat">
        <span className="muted">Furniture found</span>
        <span className="mono">{summary.total}</span>
      </div>
      <div className="stat">
        <span className="muted">Across rooms</span>
        <span className="mono">{summary.rooms}</span>
      </div>

      {groups.map((group) => {
        const items = furniture.filter((piece) => piece.evidence === group.key)
        if (items.length === 0) return null

        // Collapsed by item and room: "2 x Bedside — Bedroom-1" reads better
        // than the same row twice, and a plan with eight dining chairs would
        // otherwise fill the panel with one of them.
        const counted = new Map<string, { count: number; piece: Proposal }>()
        for (const piece of items) {
          const key = `${piece.item}|${piece.room ?? ''}`
          const existing = counted.get(key)
          if (existing) existing.count++
          else counted.set(key, { count: 1, piece })
        }

        return (
          <div key={group.key} style={{ marginTop: 10 }}>
            <p style={{ fontSize: 12.5, margin: '0 0 2px', fontWeight: 600 }}>
              <span style={{ color: group.tone }}>●</span> {group.title}{' '}
              <span className="mono muted">{items.length}</span>
            </p>
            <p className="muted" style={{ fontSize: 11, margin: '0 0 6px' }}>
              {group.note}
            </p>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
              {[...counted.values()].map(({ count, piece }) => (
                <li key={`${piece.item}-${piece.room}`} style={{ margin: '2px 0' }}>
                  {count > 1 && <span className="mono">{count} × </span>}
                  {piece.observedItem ?? NAME.get(piece.item) ?? piece.item}
                  {piece.room && <span className="muted"> — {piece.room}</span>}
                  {piece.reviewOnly && piece.hubQuery && (
                    <>
                      {onFindAsset && (
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: 10, padding: '1px 5px', marginLeft: 5 }}
                          title="Search, condition, size, and credit an Asset Hub model"
                          onClick={() => onFindAsset(piece)}
                        >
                          Find asset
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ fontSize: 10, padding: '1px 5px', marginLeft: 4 }}
                        title="Copy this phrase into the Asset Hub search"
                        onClick={() => void navigator.clipboard?.writeText(piece.hubQuery!)}
                      >
                        Copy search
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={onAccept}>
          {furniture.some((piece) => !piece.reviewOnly) ? 'Place these' : 'Mark reviewed'}
        </button>
        <button className="btn" onClick={onDiscard}>
          Discard
        </button>
      </div>

      <p className="muted" style={{ fontSize: 11.5 }}>
        Render-only observations stay out of the model until an asset and
        attachment decision exists. Accepted catalogue items land as normal
        objects, and one undo reverses the whole placement.
      </p>
    </>
  )
}
