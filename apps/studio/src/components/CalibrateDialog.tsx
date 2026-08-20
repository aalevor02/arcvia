import { useEffect, useRef, useState } from 'react'
import { parseLength, type UnitSystem } from '../lib/format'

interface Props {
  units: UnitSystem
  onCancel(): void
  onConfirm(metres: number): void
}

/**
 * "How long is that, really?"
 *
 * Asked after two points have been picked on the drawing. Accepts whatever
 * form the length is written in — `3.6`, `3600mm`, `12'`, `12' 6"` — because
 * the number is being copied off a drawing that was dimensioned by someone
 * else, in whatever units they used.
 */
export function CalibrateDialog({ units, onCancel, onConfirm }: Props) {
  const [value, setValue] = useState('')
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const metres = parseLength(value, units)
  // A plausible architectural dimension. The bound is not pedantry: a typo of
  // 3600 in a metric field would scale the drawing by a thousand and put the
  // building in orbit, and the way back from that is not obvious.
  const valid = metres !== null && metres > 0.05 && metres < 500

  const submit = () => {
    if (valid) onConfirm(metres)
  }

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="calibrate-title">
        <h2 id="calibrate-title">How long is that line?</h2>
        <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          The drawing will be resized so the two points you picked are exactly
          this far apart.
        </p>

        <div className="field">
          <label htmlFor="calibrate-length">Real length</label>
          <input
            id="calibrate-length"
            ref={field}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder={units === 'imperial' ? `12' 6"` : '3.6 m'}
            autoComplete="off"
          />
          <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            {value && !valid
              ? 'That does not read as a length. Try 3.6, 3600mm, 12&apos; or 12&apos; 6".'
              : units === 'imperial'
                ? 'Feet and inches, or add a unit: 3.6m, 3600mm.'
                : 'Metres, or add a unit: 3600mm, 12&apos;.'}
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!valid}>
            Set the scale
          </button>
        </div>
      </div>
    </div>
  )
}
