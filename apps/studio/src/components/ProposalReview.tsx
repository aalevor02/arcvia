import { summarise, type ProposedWall } from '../plan/detections'
import { formatLength, formatThickness, type UnitSystem } from '../lib/format'

interface Props {
  proposal: ProposedWall[]
  units: UnitSystem
  onAccept(): void
  onDiscard(): void
}

/**
 * What the detector found, before any of it is committed.
 *
 * ── Why there is a review step at all ───────────────────────────────────────
 * The detector is classical computer vision over ink. It is good on a clean CAD
 * export and poor on a photograph of a printout, and it cannot tell you which
 * of those it just read. Writing forty guessed walls straight into the plan and
 * offering undo puts the burden in the wrong place: the room list, the areas
 * and the 3D model all churn before anyone agreed to anything.
 *
 * So the proposal is drawn as a ghost over the drawing and the numbers are
 * stated plainly. Accepting is one click; so is throwing it away.
 */
export function ProposalReview({ proposal, units, onAccept, onDiscard }: Props) {
  const summary = summarise(proposal)
  const unpaired = summary.total - summary.paired

  return (
    <>
      <div className="stat">
        <span className="muted">Walls found</span>
        <span className="mono">{summary.total}</span>
      </div>
      <div className="stat">
        <span className="muted">Total run</span>
        <span className="mono">{formatLength(summary.totalLength, units)}</span>
      </div>
      <div className="stat">
        <span className="muted">Typical thickness</span>
        <span className="mono">{formatThickness(summary.medianThickness, units)}</span>
      </div>

      {/* The distinction that decides how much to trust this. A paired wall was
          measured between its two drawn faces; an unpaired one is a single line
          at a default thickness, which is a guess. */}
      <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
        <span style={{ color: 'var(--signal)' }}>●</span>{' '}
        {summary.paired} measured from both faces of the wall.
        {unpaired > 0 && (
          <>
            <br />
            <span style={{ color: 'var(--warn)' }}>●</span> {unpaired} traced from
            a single line, so the thickness is a default.
          </>
        )}
      </p>

      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={onAccept}>
          Add these
        </button>
        <button className="btn" onClick={onDiscard}>
          Discard
        </button>
      </div>

      <p className="muted" style={{ fontSize: 11.5 }}>
        Adding them is a single undo away, and you can edit or delete any of them
        afterwards.
      </p>
    </>
  )
}
