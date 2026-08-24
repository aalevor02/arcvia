import { useState } from 'react'
import type { SceneViewer } from '@arcvia/viewer'

import { readDocument, request, uploadFloorplan, type DocumentSheet } from '../lib/api'
import {
  applyDesignToModel,
  hubQueriesForSpec,
  type DesignSpec,
} from '../plan/deckDesign'

/** Read one render's design. `page` 0 means the stored file IS the image. */
const readDesign = (url: string, page = 0, index = 0, room?: string | null) =>
  request<DesignSpec>('/detect/document/design', {
    method: 'POST',
    body: { url, page, index, ...(room ? { room } : {}) },
  })

interface Props {
  viewer: SceneViewer | null
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
  applied?: string
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
 * The whole model's floors, walls and ceilings take this render's finishes —
 * surface maps of the right kind, tinted toward the render's own measured
 * colours. A CAD storey is one floors mesh, so one room's carpet cannot stop
 * at its doorway; the caption under the button says which render is worn.
 * Per-room application arrives with per-room floor meshes from the engine.
 */
export default function DeckDesignPanel({ viewer, deckUrl, onDeckStored }: Props) {
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
    const model = viewer?.modelRoot
    if (!model || !row.spec) return
    const applied = applyDesignToModel(model, row.spec)
    viewer?.requestRender()
    setRows((all) =>
      all.map((r) =>
        r.sheet === row.sheet
          ? {
              ...r,
              applied: `${applied.floors} floor, ${applied.walls} wall and ` +
                `${applied.ceilings} ceiling mesh(es) wear this render's finishes`,
            }
          : { ...r, applied: undefined },
      ),
    )
  }

  return (
    <section>
      <span className="eyebrow">Deck design</span>
      <p className="note">
        Read the materials and furnishing out of the deck&apos;s renders, and
        dress the model in the same finishes.
      </p>

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
              <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={() => apply(row)}>
                Dress the model in these finishes
              </button>
              {row.applied && <p className="muted">{row.applied}</p>}

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
