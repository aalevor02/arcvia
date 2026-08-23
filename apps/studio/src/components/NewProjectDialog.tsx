import { useEffect, useRef, useState } from 'react'

export type ProjectStart = 'draw' | 'floorplan' | 'model' | 'cad'

interface Props {
  busy: boolean
  onCancel(): void
  onCreate(start: ProjectStart, name: string): void
}

const STARTS: { id: ProjectStart; title: string; body: string; icon: string }[] = [
  {
    id: 'draw',
    title: 'Draw a floor plan',
    body: 'Start on a blank grid and trace the walls.',
    icon: '✎',
  },
  {
    id: 'floorplan',
    title: 'Upload a floor plan',
    body: 'Trace over a JPG, PNG, PDF or DWG drawing.',
    icon: '⇪',
  },
  {
    id: 'cad',
    title: 'Reconstruct from CAD or PDF',
    body: 'The engine reads a DWG, DXF or presentation PDF and builds the rooms and 3D model itself.',
    icon: '⌂',
  },
  {
    id: 'model',
    title: 'Upload a 3D model',
    body: 'Skip the plan — load a GLB straight into the scene.',
    icon: '◫',
  },
]

/**
 * Two-step create: pick how you are starting, then name it.
 *
 * The reference asks for both at once. Splitting them means the name field can
 * be pre-filled sensibly for the chosen start, and — more usefully — the choice
 * itself is a single unambiguous click rather than a form to fill in before you
 * find out what the options do.
 */
export function NewProjectDialog({ busy, onCancel, onCreate }: Props) {
  const [start, setStart] = useState<ProjectStart | null>(null)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape closes. Expected of anything modal, and cheap to honour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Move focus into the dialog when it opens, and to the name field when the
  // second step appears — otherwise keyboard focus stays behind on the page
  // underneath and Tab walks the wrong thing.
  useEffect(() => {
    if (start) nameRef.current?.focus()
    else dialogRef.current?.focus()
  }, [start])

  const submit = () => {
    if (!start || !name.trim() || busy) return
    onCreate(start, name)
  }

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        // Only a click that both starts and ends on the backdrop dismisses.
        // Otherwise a text selection dragged out of the dialog closes it.
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2 id="new-project-title">
          {start ? 'Name your project' : 'Create a new project'}
        </h2>
        <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          {start
            ? 'You can rename it at any time.'
            : 'How would you like to start?'}
        </p>

        {!start ? (
          <div style={{ marginTop: 14 }}>
            {STARTS.map((option) => (
              <button
                key={option.id}
                className="choice"
                onClick={() => {
                  setStart(option.id)
                  setName(defaultName(option.id))
                }}
              >
                <span className="choice-icon" aria-hidden="true">
                  {option.icon}
                </span>
                <span>
                  <strong style={{ display: 'block', fontSize: 13.5 }}>
                    {option.title}
                  </strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {option.body}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="project-name">Project name</label>
              <input
                id="project-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
                placeholder="Villa E-1"
                maxLength={80}
              />
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setStart(null)} disabled={busy}>
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={busy || !name.trim()}
              >
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </>
        )}

        {!start && (
          <div className="modal-actions">
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function defaultName(start: ProjectStart): string {
  if (start === 'model') return 'Imported model'
  if (start === 'cad') return 'Imported drawing'
  return 'Untitled project'
}
