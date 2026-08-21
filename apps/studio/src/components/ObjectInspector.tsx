import { itemById } from '../catalogue/items'
import { elevationOf, sizeOf } from '../catalogue/placement'
import { formatLength, parseLength, type UnitSystem } from '../lib/format'
import type { PlacedObject, Size } from '../catalogue/types'

interface Props {
  object: PlacedObject
  units: UnitSystem
  onChange(patch: Partial<PlacedObject>): void
  onRemove(): void
}

/** Editing one placed object. */
export function ObjectInspector({ object, units, onChange, onRemove }: Props) {
  const item = itemById(object.item)
  if (!item) return null

  const size = sizeOf(object)
  const isOpening = item.placement === 'in-wall'
  const isDoor = item.shape === 'door' || item.shape === 'door-double'

  const setSize = (patch: Partial<Size>) => onChange({ size: { ...size, ...patch } })

  /**
   * Parse a typed dimension, apply it only if it is sane.
   *
   * Rejecting rather than clamping: a mistyped 30 where 3 was meant is not a
   * request for a 30 m sofa, and silently correcting it to a maximum hides the
   * typo. The field snaps back so the old value is visibly still there.
   */
  const dimension = (
    current: number,
    apply: (metres: number) => void,
  ) => (event: React.FocusEvent<HTMLInputElement>) => {
    const metres = parseLength(event.target.value, units)
    if (metres !== null && metres > 0.02 && metres < 30) apply(metres)
    else event.target.value = formatLength(current, units)
  }

  return (
    <section>
      <span className="eyebrow">Selected object</span>

      <div className="stat">
        <span className="muted">{item.category}</span>
        <span>{object.label ?? item.name}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ fontSize: 11.5 }}>
          Width
          <input
            key={`${object.id}-w-${units}`}
            defaultValue={formatLength(size.width, units)}
            onBlur={dimension(size.width, (width) => setSize({ width }))}
          />
        </label>
        <label style={{ fontSize: 11.5 }}>
          {/* An opening's "depth" is the wall it sits in, so it is not the
              user's to set — the wall owns it. */}
          {isOpening ? 'Height' : 'Depth'}
          <input
            key={`${object.id}-d-${units}`}
            defaultValue={formatLength(isOpening ? size.height : size.depth, units)}
            onBlur={dimension(isOpening ? size.height : size.depth, (value) =>
              setSize(isOpening ? { height: value } : { depth: value }),
            )}
          />
        </label>
      </div>

      {!isOpening && (
        <label style={{ fontSize: 11.5 }}>
          Height
          <input
            key={`${object.id}-h-${units}`}
            defaultValue={formatLength(size.height, units)}
            onBlur={dimension(size.height, (height) => setSize({ height }))}
          />
        </label>
      )}

      <label style={{ fontSize: 11.5 }}>
        {item.placement === 'ceiling' ? 'Drop below ceiling' : 'Height above floor'}
        <input
          key={`${object.id}-e-${units}`}
          defaultValue={formatLength(elevationOf(object), units)}
          onBlur={(event) => {
            const metres = parseLength(event.target.value, units)
            if (metres !== null && metres >= 0 && metres < 20) onChange({ elevation: metres })
            else event.target.value = formatLength(elevationOf(object), units)
          }}
        />
      </label>

      <label style={{ fontSize: 11.5 }}>
        Rotation <span className="mono">{Math.round((object.rotation * 180) / Math.PI)}°</span>
        <input
          type="range"
          min="0"
          max="360"
          step="5"
          value={Math.round(((object.rotation * 180) / Math.PI + 360) % 360)}
          onChange={(e) => onChange({ rotation: (Number(e.target.value) * Math.PI) / 180 })}
        />
      </label>

      {/*
        Quarter turns, next to the slider rather than instead of it.

        Furniture is square to the room the overwhelming majority of the time,
        and hitting exactly 90° on a 5°-step slider is a fiddle for the case
        that comes up most. The slider stays for the angled sofa in the bay
        window, which is the case it is actually good at.
      */}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {([
          ['⟲ 90°', -Math.PI / 2],
          ['⟳ 90°', Math.PI / 2],
          ['180°', Math.PI],
        ] as const).map(([label, delta]) => (
          <button
            key={label}
            className="btn btn-tiny"
            style={{ flex: 1 }}
            onClick={() => {
              // Normalised, so the slider and the readout never show 450°.
              const next = (object.rotation + delta) % (Math.PI * 2)
              onChange({ rotation: next < 0 ? next + Math.PI * 2 : next })
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {isDoor && (
        <>
          <div className="segmented">
            {(['left', 'right'] as const).map((side) => (
              <button
                key={side}
                aria-pressed={((object as { hinge?: string }).hinge ?? 'left') === side}
                onClick={() => onChange({ hinge: side } as Partial<PlacedObject>)}
              >
                Hinge {side}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 11.5 }}>
            Swing{' '}
            <span className="mono">{(object as { swing?: number }).swing ?? 90}°</span>
            <input
              type="range"
              min="15"
              max="120"
              step="5"
              value={(object as { swing?: number }).swing ?? 90}
              onChange={(e) =>
                onChange({ swing: Number(e.target.value) } as Partial<PlacedObject>)
              }
            />
          </label>
        </>
      )}

      <button className="btn btn-danger" onClick={onRemove}>
        Delete object
      </button>
    </section>
  )
}
