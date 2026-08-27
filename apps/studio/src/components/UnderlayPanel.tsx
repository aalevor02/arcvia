import { useRef, useState } from 'react'
import {
  extractDocumentPage,
  readDocument,
  uploadFloorplan,
  type DocumentSheet,
} from '../lib/api'
import { formatLength, type UnitSystem } from '../lib/format'
import type { Underlay } from '../plan/types'

interface Props {
  underlay: Underlay | null
  units: UnitSystem
  calibrating: boolean
  detecting: boolean
  onPlace(input: { url: string; width: number; height: number }): void
  onChange(patch: Partial<Underlay>): void
  onRemove(): void
  onStartCalibrate(): void
  onDetect(): void
  /** Move to the view that reads and applies the deck's render pages. */
  onOpenRenders?(): void
  /**
   * The rest of an uploaded deck: its renders, elevations and other floors.
   *
   * Handed up rather than kept here because they outlive this panel. The
   * renders are what the finished rooms are meant to look like, and the other
   * floors are the next imports — both belong to the project, not to the
   * control that happened to open the file.
   */
  onDeck?(deck: { url: string; sheets: DocumentSheet[] }): void
}

/**
 * Bring a scanned drawing in and get its scale right.
 *
 * The scale is the only part that matters. Everything else here — opacity,
 * lock, remove — is in service of being able to see the drawing while you trace
 * it, and of not knocking it out of alignment once you have.
 */
export function UnderlayPanel({
  underlay,
  units,
  calibrating,
  detecting,
  onPlace,
  onChange,
  onRemove,
  onStartCalibrate,
  onDetect,
  onOpenRenders,
  onDeck,
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deck, setDeck] = useState<{ url: string; sheets: DocumentSheet[] } | null>(null)

  async function place(url: string) {
    // The server stores bytes and validates the type; it does not decode the
    // image. The browser is already going to decode it to display it, so the
    // dimensions come from here rather than adding an image library to the API
    // for two numbers.
    const { width, height } = await measure(url)
    onPlace({ url, width, height })
  }

  async function handleFile(file: File) {
    setError(null)
    try {
      setBusy('Uploading…')
      const stored = await uploadFloorplan(file)

      // An image is a drawing. A PDF is a document that might contain several,
      // among a great many things that are not drawings at all.
      if (!/\.pdf$/i.test(stored.url)) {
        await place(stored.url)
        return
      }

      setBusy('Reading the document…')
      const outline = await readDocument(stored.url)
      const found = { url: stored.url, sheets: outline.sheets }
      setDeck(found)
      onDeck?.(found)

      const plans = outline.sheets.filter((sheet) => sheet.kind === 'plan')
      if (plans.length === 0) {
        setError(
          'No floor plan was found in that document. Pick a page below, or upload the plan as an image.',
        )
        return
      }
      // One plan is not a choice, so it is not offered as one.
      if (plans.length === 1) await pick(found.url, plans[0])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.')
    } finally {
      setBusy(null)
    }
  }

  async function pick(documentUrl: string, sheet: DocumentSheet) {
    setError(null)
    try {
      setBusy('Extracting the plan…')
      const stored = await extractDocumentPage(documentUrl, sheet.page, sheet.index)
      await place(stored.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not extract that page.')
    } finally {
      setBusy(null)
    }
  }

  if (!underlay) {
    return (
      <section>
        <span className="eyebrow">Trace a drawing</span>
        <p className="muted" style={{ fontSize: 12 }}>
          A scan, an export, or the PDF you sent the client — the floor plans
          inside a presentation deck are usually higher resolution than anything
          you would screenshot out of it.
        </p>

        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Reset so choosing the same file twice still fires a change event.
            e.target.value = ''
            if (file) void handleFile(file)
          }}
        />
        <button
          className="btn"
          disabled={Boolean(busy)}
          onClick={() => input.current?.click()}
        >
          {busy ?? 'Upload a plan or PDF'}
        </button>

        {deck && (
          <DeckSummary
            deck={deck}
            busy={Boolean(busy)}
            onPick={pick}
            onOpenRenders={onOpenRenders}
          />
        )}

        {error && (
          <p className="alert alert-error" role="alert" style={{ fontSize: 12 }}>
            {error}
          </p>
        )}
      </section>
    )
  }

  const drawnWidth = underlay.width * underlay.scale

  return (
    <section>
      <span className="eyebrow">Underlay</span>

      {/* The scale is stated in the units the editor is showing, because "0.0043
          metres per pixel" is not a number anyone can sanity-check. The drawn
          width is. */}
      <div className="stat">
        <span className="muted">Drawing is</span>
        <span className="mono">{formatLength(drawnWidth, units)} wide</span>
      </div>

      <button
        className="btn"
        aria-pressed={calibrating}
        onClick={onStartCalibrate}
        style={calibrating ? { borderColor: 'var(--warn)', color: 'var(--warn)' } : undefined}
      >
        {calibrating ? 'Pick two points…' : 'Set the scale'}
      </button>
      <p className="muted" style={{ fontSize: 11.5 }}>
        Click along something you know the length of, then type it in. Do this
        before tracing — everything drawn beforehand keeps its own size.
      </p>

      {/* Offered after calibration, not before. Detection returns positions as
          fractions of the image, so without a scale the walls it proposes would
          be the right shape at the wrong size. */}
      <button className="btn" onClick={onDetect} disabled={detecting}>
        {detecting ? 'Reading the drawing…' : '✨ Read the plan for me'}
      </button>
      <p className="muted" style={{ fontSize: 11.5 }}>
        Finds the walls automatically and shows them for you to accept. Works
        well on clean exports, less well on photographs. Costs 1 credit.
      </p>

      <label style={{ fontSize: 12, marginTop: 4 }}>
        Opacity <span className="mono">{Math.round(underlay.opacity * 100)}%</span>
        <input
          type="range"
          min="0.05"
          max="1"
          step="0.05"
          value={underlay.opacity}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
        />
      </label>

      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
      >
        <input
          type="checkbox"
          checked={underlay.invert}
          onChange={(e) => onChange({ invert: e.target.checked })}
          style={{ width: 'auto' }}
        />
        Invert for the dark canvas
      </label>

      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
      >
        <input
          type="checkbox"
          checked={underlay.locked}
          onChange={(e) => onChange({ locked: e.target.checked })}
          style={{ width: 'auto' }}
        />
        Locked in place
      </label>

      <button className="btn btn-danger" onClick={onRemove}>
        Remove drawing
      </button>
    </section>
  )
}

/**
 * What was in the document, and which page to trace.
 *
 * Shown even when a plan was picked automatically, because the interesting news
 * is usually the rest of it: a deck that yielded one floor plan has typically
 * also yielded twenty captioned interior renders, and those are what the
 * finished rooms are supposed to look like. Saying nothing about them would
 * quietly discard the most valuable half of the upload.
 */
function DeckSummary({
  deck,
  busy,
  onPick,
  onOpenRenders,
}: {
  deck: { url: string; sheets: DocumentSheet[] }
  busy: boolean
  onPick(url: string, sheet: DocumentSheet): void
  onOpenRenders?(): void
}) {
  const plans = deck.sheets.filter((sheet) => sheet.kind === 'plan')
  const renders = deck.sheets.filter((sheet) => sheet.kind === 'render')
  const rooms = [...new Set(renders.map((sheet) => sheet.room).filter(Boolean))]

  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
      {plans.length > 1 && (
        <>
          <p className="muted" style={{ fontSize: 11.5 }}>
            {plans.length} floor plans in that document. Trace them one at a
            time — each floor is its own import.
          </p>
          {plans.map((sheet) => (
            <button
              key={`${sheet.page}-${sheet.index}`}
              className="btn"
              disabled={busy}
              onClick={() => onPick(deck.url, sheet)}
            >
              {sheet.caption || `Page ${sheet.page}`}
            </button>
          ))}
        </>
      )}

      {renders.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 11.5 }}>
            Also found {renders.length} interior render
            {renders.length === 1 ? '' : 's'}
            {rooms.length > 0 && <> of {rooms.join(', ').toLowerCase()}</>}. The
            first is analysed automatically in 3D; use Deck design there to
            read and apply the others.
          </p>
          {onOpenRenders && (
            <button className="btn btn-primary" onClick={onOpenRenders}>
              Analyze renders in 3D
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Decode just far enough to read the intrinsic dimensions. */
function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('That image could not be read.'))
    image.src = url
  })
}
