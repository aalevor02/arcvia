import { useState } from 'react'

import {
  assignRoom, detectFloorplan, readDocument, readDesign, uploadFloorplan,
  type DocumentSheet, type RoomProposal,
} from '../lib/api'
import { hubQueriesForSpec, type DesignSpec } from '../plan/deckDesign'
import type { RoomAssignment } from '../plan/roomAssignment'

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
  /**
   * How every render past the first was matched, in the same order. Unresolved
   * ones are shown rather than resolved silently: a room wearing the fallback
   * because its render was ambiguous looks exactly like a room deliberately
   * dressed that way, and a client is the worst possible person to discover
   * the difference.
   */
  assignments: RoomAssignment[]
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
/** One render's trip through "which room is this?", per unresolved assignment. */
interface Placing {
  state: 'idle' | 'asking' | 'answered' | 'failed'
  proposal?: RoomProposal | null
  error?: string
}

export default function DeckDesignPanel({
  designs, assignments, onApplyDesign, deckUrl, onDeckStored,
}: Props) {
  const [placing, setPlacing] = useState<Record<number, Placing>>({})

  /**
   * Ask the vision model which room this render is of.
   *
   * Two calls: detect the plan for its rooms, then assign against them. The
   * detector's rooms are used rather than the editor's because they are
   * normalised to THIS image, and the model is being shown numbers drawn on
   * that same image — editor rooms are in metres and would put the numbers in
   * the wrong places.
   */
  const place = async (position: number, spec: DesignSpec) => {
    if (!deckUrl) return
    setPlacing((prev) => ({ ...prev, [position]: { state: 'asking' } }))
    try {
      const detected = await detectFloorplan(deckUrl)
      const rooms = (detected.rooms ?? []).filter((room) => (room.kind ?? 'room') === 'room')
      if (rooms.length === 0) {
        setPlacing((prev) => ({
          ...prev,
          [position]: { state: 'failed', error: 'No rooms could be found on the plan.' },
        }))
        return
      }
      const { proposal } = await assignRoom({
        planUrl: deckUrl,
        renderUrl: deckUrl,
        renderPage: spec.source?.page ?? 0,
        renderIndex: spec.source?.index ?? 0,
        rooms,
      })
      setPlacing((prev) => ({ ...prev, [position]: { state: 'answered', proposal } }))
    } catch (error) {
      setPlacing((prev) => ({
        ...prev,
        [position]: {
          state: 'failed',
          error: error instanceof Error ? error.message : 'That render could not be placed.',
        },
      }))
    }
  }

  /**
   * Accept a proposal by writing it as the render's caption.
   *
   * The caption, not an index: the room's name is what the mesh slug is built
   * from, so once the caption says "Bedroom-3" the ordinary deterministic
   * matcher resolves it and no part of the pipeline has to trust the model
   * again. A proposal for a room the drawing never labelled has no name to
   * write, which is why the button is only offered when there is one.
   */
  const accept = (spec: DesignSpec, proposal: RoomProposal) => {
    if (!proposal.name) return
    onApplyDesign({
      ...spec,
      source: { ...(spec.source ?? { page: 0, index: 0 }), room: proposal.name },
    })
  }

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

      {(() => {
        // Position matters: an assignment's index is the design it belongs to,
        // offset by one because the first render is the fallback and is never
        // assigned to a room.
        const open = assignments
          .map((assignment, position) => ({ assignment, position }))
          .filter((entry) => entry.assignment.status !== 'auto')
        if (open.length === 0) return null
        return (
          <div
            className="note"
            style={{
              borderLeft: '3px solid var(--warn, #c9862b)',
              paddingLeft: 10,
              marginBottom: 10,
            }}
          >
            <strong style={{ fontSize: 12 }}>
              {open.length === 1
                ? '1 render was not applied'
                : `${open.length} renders were not applied`}
            </strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11.5 }}>
              {open.map(({ assignment, position }) => {
                const spec = designs[position + 1]
                const trip = placing[position] ?? { state: 'idle' as const }
                return (
                  <li key={`${assignment.label}-${position}`} style={{ marginBottom: 6 }}>
                    <span style={{ fontWeight: 600 }}>
                      {assignment.label || 'An uncaptioned render'}
                    </span>
                    {' — '}
                    {assignment.reason}
                    {spec && deckUrl && trip.state === 'idle' && (
                      <>
                        {' '}
                        <button className="btn" onClick={() => void place(position, spec)}>
                          Find its room
                        </button>
                      </>
                    )}
                    {trip.state === 'asking' && (
                      <span className="muted"> · looking at the plan…</span>
                    )}
                    {trip.state === 'failed' && (
                      <span className="muted"> · {trip.error}</span>
                    )}
                    {trip.state === 'answered' && !trip.proposal && (
                      <span className="muted">
                        {' '}
                        · the model could not tell which room this is
                      </span>
                    )}
                    {trip.state === 'answered' && trip.proposal && (
                      <div style={{ marginTop: 3 }}>
                        {trip.proposal.name ? (
                          <>
                            Looks like <strong>{trip.proposal.name}</strong>
                            {trip.proposal.weak ? ' (not confident)' : ''}
                            {trip.proposal.because ? ` — ${trip.proposal.because}` : ''}{' '}
                            <button
                              className="btn"
                              onClick={() => spec && accept(spec, trip.proposal!)}
                            >
                              Use this room
                            </button>
                          </>
                        ) : (
                          // Nothing to write as a caption, so nothing to apply.
                          // Saying which room by position is more use than a
                          // greyed-out button with no explanation.
                          <span className="muted">
                            It points at room {trip.proposal.index + 1}, which the drawing never
                            labelled — name that room on the plan first.
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
              Those rooms keep the fallback finish until a render is matched to
              them. “Find its room” reads the plan and this render together, and
              costs one vision call.
            </p>
          </div>
        )
      })()}

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
