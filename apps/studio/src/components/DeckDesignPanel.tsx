import { useState } from 'react'

import { readDocument, readDesign, uploadFloorplan, type DocumentSheet } from '../lib/api'
import { hubQueriesForSpec, type DesignSpec } from '../plan/deckDesign'

interface Props {
  /** All room designs the scene currently wears, so each render can be marked. */
  designs: DesignSpec[]
  /**
   * The one path a design takes onto the scene. The editor owns application
   * (its rebuild effect re-dresses on every rebuild) and persistence; the
   * panel only chooses. The panel used to mutate the model directly, which
   * dressed it beautifully until the next wall drag rebuilt it plain — and
   * nothing ever reached the published page.
   */
  onApplyDesign(next: DesignSpec | null): void
  /** The stored deck, when the scene already remembers one. */
  deckUrl: string | null
  /** Persist a newly uploaded deck on the scene. */
  onDeckStored(url: string): void
}

interface RenderRow {
  sheet: DocumentSheet
  spec: DesignSpec | null
  state: 'idle' | 'reading' | 'read' | 'failed'
  error?: string
}

/**
 * From the deck's renders to the model's materials.
 *
 * ── Why this reads renders one at a time, on click ──────────────────────────
 * Each read is a hosted vision-model round trip (~15 s). A deck can carry a
 * dozen renders, and firing twelve reads because a panel mounted would spend
 * half the free tier answering questions nobody asked. The outline is cheap
 * and lists what COULD be read; the user reads the renders that matter.
 *
 * ── What Apply honestly does ────────────────────────────────────────────────
 * The first render supplies the whole-model fallback, including the aggregate
 * walls and ceilings. Further renders override the matching named room-floor
 * meshes, so bedroom timber and living-room tile can coexist at their doorway.
 * Per-room wall paint waits on the engine emitting per-room wall meshes.
 */
export default function DeckDesignPanel({ designs, onApplyDesign, deckUrl, onDeckStored }: Props) {
  const [url, setUrl] = useState<string | null>(deckUrl)
  const [rows, setRows] = useState<RenderRow[]>([])
  const [busy, setBusy] = useState<'upload' | 'outline' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const outline = async (storedUrl: string) => {
    setBusy('outline')
    setNote(null)
    try {
      const doc = await readDocument(storedUrl)
      const renders = doc.sheets.filter((sheet) => sheet.kind === 'render')
      setRows(renders.map((sheet) => ({ sheet, spec: null, state: 'idle' })))
      if (renders.length === 0) {
        setNote('The deck has no render pages — nothing to read a design from.')
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The deck could not be read.')
    } finally {
      setBusy(null)
    }
  }

  const pick = async (file: File) => {
    setBusy('upload')
    setNote(null)
    try {
      const stored = await uploadFloorplan(file)
      setUrl(stored.url)
      onDeckStored(stored.url)
      await outline(stored.url)
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The upload failed.')
      setBusy(null)
    }
  }

  const read = async (row: RenderRow) => {
    if (!url) return
    setRows((all) => all.map((r) => (r === row ? { ...r, state: 'reading' } : r)))
    try {
      const spec = await readDesign(url, row.sheet.page, row.sheet.index, row.sheet.room)
      setRows((all) =>
        all.map((r) => (r.sheet === row.sheet ? { ...r, spec, state: 'read' } : r)),
      )
    } catch (error) {
      setRows((all) =>
        all.map((r) =>
          r.sheet === row.sheet
            ? {
                ...r,
                state: 'failed',
                error: error instanceof Error ? error.message : 'unreadable',
              }
            : r,
        ),
      )
    }
  }

  const apply = (row: RenderRow) => {
    if (!row.spec) return
    onApplyDesign({
      ...row.spec,
      source: { page: row.sheet.page, index: row.sheet.index, room: row.sheet.room },
    })
  }

  /** Whether this row's render is the one the scene currently wears. */
  const worn = (row: RenderRow) =>
    designs.some((design) =>
      design.source?.page === row.sheet.page && design.source.index === row.sheet.index,
    )

  const wornRooms = Array.from(
    new Set(designs.map((design) => design.source?.room ?? design.room).filter(Boolean)),
  )

  return (
    <section>
      <span className="eyebrow">Deck design</span>
      <p className="note">
        Read materials and furniture out of the deck&apos;s renders. Apply its
        finishes, then review any observed furniture arranged in that room.
      </p>

      {designs.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5 }}>
          Worn rooms: {wornRooms.join(', ') || 'a deck render'}
          {designs[0]?.source?.auto ? ' — the fallback was read automatically' : ''}
          {' · '}
          <button className="btn" onClick={() => onApplyDesign(null)}>
            Clear all dressing
          </button>
        </p>
      )}

      {!url && (
        <label className="btn" style={{ display: 'inline-block', marginTop: 6 }}>
          {busy === 'upload' ? 'Uploading…' : 'Upload the client deck (PDF)'}
          <input
            type="file"
            accept="application/pdf,image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void pick(file)
            }}
          />
        </label>
      )}
      {url && rows.length === 0 && busy !== 'outline' && (
        <button className="btn" style={{ marginTop: 6 }} onClick={() => void outline(url)}>
          Find the deck&apos;s renders
        </button>
      )}
      {busy === 'outline' && <p className="muted">Reading the deck…</p>}
      {note && <p className="alert">{note}</p>}

      {rows.map((row) => (
        <div key={`${row.sheet.page}:${row.sheet.index}`} style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 12.5 }}>
            {row.sheet.room ?? row.sheet.caption ?? `Page ${row.sheet.page}`}
          </strong>
          <span style={{ display: 'inline-flex', gap: 3, marginLeft: 8, verticalAlign: 'middle' }}>
            {row.sheet.palette.slice(0, 5).map((hex) => (
              <span
                key={hex}
                title={hex}
                style={{ width: 12, height: 12, borderRadius: 2, background: hex }}
              />
            ))}
          </span>

          {row.state === 'idle' && (
            <button className="btn" style={{ marginLeft: 8 }} onClick={() => void read(row)}>
              Read the design
            </button>
          )}
          {row.state === 'reading' && <span className="muted"> reading…</span>}
          {row.state === 'failed' && <span className="alert"> {row.error}</span>}

          {row.spec && (
            <div style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 4 }}>
              <div>
                {swatch(row.spec.floor?.colour)} floor: {row.spec.floor?.material ?? '?'}
                {row.spec.floor?.pattern ? `, ${row.spec.floor.pattern}` : ''}
                {' · '}
                {swatch(row.spec.walls?.colour)} walls: {row.spec.walls?.finish ?? '?'}
                {row.spec.walls?.accent ? <> · accent {swatch(row.spec.walls.accent)}</> : null}
                {row.spec.style ? ` · ${row.spec.style}` : ''}
              </div>
              <div className="muted">
                {row.spec.furniture.map((f) => f.item).join(', ') || 'no furniture read'}
              </div>
              {worn(row) ? (
                <p className="muted" style={{ marginTop: 4 }}>
                  This room wears the render&apos;s floor finish. Its recognised
                  furniture was offered in the shared furniture review.
                </p>
              ) : (
                <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={() => apply(row)}>
                  Apply this room design
                </button>
              )}

              {/* The hub queries: where to find the SAME materials as real,
                  licensed assets. Text for now — the hub browser panel takes
                  a search, and these are the searches worth running. */}
              <details style={{ marginTop: 4 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Matching assets to search the hub for
                </summary>
                <ul style={{ paddingLeft: 16, margin: '4px 0' }}>
                  {hubQueriesForSpec(row.spec).map((query) => (
                    <li key={query.label} className="muted">
                      {query.label}: <span className="mono">{query.q}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}

function swatch(hex?: string | null) {
  if (!hex) return null
  return (
    <span
      title={hex}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: 2,
        background: hex,
        verticalAlign: 'middle',
      }}
    />
  )
}
