import { useRef, useState } from 'react'
import { uploadFloorplan } from '../lib/api'
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
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const stored = await uploadFloorplan(file)

      // The server stores bytes and validates the type; it does not decode the
      // image. The browser is already going to decode it to display it, so the
      // dimensions come from here rather than adding an image library to the
      // API for two numbers.
      const { width, height } = await measure(stored.url)
      onPlace({ url: stored.url, width, height })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that file.')
    } finally {
      setBusy(false)
    }
  }

  if (!underlay) {
    return (
      <section>
        <span className="eyebrow">Trace a drawing</span>
        <p className="muted" style={{ fontSize: 12 }}>
          Drop in a scan or export and draw over it. PNG, JPG or WebP.
        </p>

        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Reset so choosing the same file twice still fires a change event.
            e.target.value = ''
            if (file) void handleFile(file)
          }}
        />
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : 'Upload a floor plan'}
        </button>

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
