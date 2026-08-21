import {
  summarise,
  type DetectedRoom,
  type DetectedScale,
  type ProposedWall,
} from '../plan/detections'
import { formatLength, formatThickness, type UnitSystem } from '../lib/format'

interface Props {
  proposal: ProposedWall[]
  units: UnitSystem
  /** The spaces the walls closed, named from the drawing where it says so. */
  rooms: DetectedRoom[]
  /** The scale implied by the room sizes printed on the drawing. */
  scale: DetectedScale | null
  /** Whether that scale was used, or the drawing was already calibrated. */
  scaleApplied: boolean
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
export function ProposalReview({
  proposal,
  units,
  rooms,
  scale,
  scaleApplied,
  onAccept,
  onDiscard,
}: Props) {
  const summary = summarise(proposal)
  const unpaired = summary.total - summary.paired
  const named = rooms.filter((room) => room.name)
  const merged = rooms.filter((room) => room.also.length > 0)

  return (
    <>
      <div className="stat">
        <span className="muted">Walls found</span>
        <span className="mono">{summary.total}</span>
      </div>

      {/* Rooms are the number that means something. Walls are found in any
          drawing, and in plenty of things that are not drawings; enclosed rooms
          are what tells you a building was read rather than a page of lines. */}
      <div className="stat">
        <span className="muted">Rooms closed</span>
        <span className="mono">{rooms.length}</span>
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

      {named.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          Read from the drawing:{' '}
          {named.map((room) => room.name).join(', ')}.
        </p>
      )}

      {/* Two rooms read as one is the commonest remaining error and the easiest
          to fix — a doorway too wide to bridge, or an opening with no wall over
          it. Naming both halves turns a confusing merged room into a ten-second
          correction. */}
      {merged.map((room) => (
        <p
          key={room.name ?? room.also.join()}
          className="muted"
          style={{ fontSize: 11.5, lineHeight: 1.45 }}
        >
          <span style={{ color: 'var(--warn)' }}>●</span> {room.name} and{' '}
          {room.also.join(', ')} were read as one space. Draw a wall between them
          if they should be separate.
        </p>
      ))}

      {scale && scaleApplied && (
        <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          Scale set from the sizes printed on the drawing
          {scale.samples > 1 ? <>, agreed across {scale.samples} rooms</> : ' — from one room only, so check it'}
          {scale.spread !== null && scale.spread > 0.15 && (
            <>
              . Those rooms disagree by {Math.round(scale.spread * 100)}%, which
              usually means more than one drawing is on this sheet
            </>
          )}
          .
        </p>
      )}

      {scale && !scaleApplied && (
        <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          The drawing's printed sizes imply a different scale to the one you set.
          Yours was kept.
        </p>
      )}

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
