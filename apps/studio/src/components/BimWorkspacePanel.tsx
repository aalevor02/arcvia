import { useMemo, useState } from 'react'
import { analysePlanBim } from '../bim/analytics'
import type { IfcPlanProposal } from '../bim/ifcPlanProposal'
import { planFromIfcProposal } from '../bim/ifcPlanProposal'
import type { Plan } from '../plan/types'
import { BimAnalysisPanel } from './BimAnalysisPanel'
import { IfcImportPanel } from './IfcImportPanel'

interface Props {
  plan: Plan
  /** Replace the whole plan. Importing a model is not an edit, it is a new document. */
  onReplacePlan(plan: Plan): void
}

/**
 * The BIM workspace: bring a model in, then read what it actually contains.
 *
 * ── Why this wrapper exists ─────────────────────────────────────────────────
 * `IfcImportPanel` and `BimAnalysisPanel` were written as a pair but nothing
 * ever mounted them, so the whole subsystem was unreachable from the editor.
 * This is the seam between them: the importer produces a proposal, the analysis
 * reads the plan that proposal became. Keeping the seam here means PlanEditor
 * gains one element rather than the state machine for two panels.
 *
 * ── Why replace rather than merge ───────────────────────────────────────────
 * A model carries its own storeys, origin and provenance. Merging it into a
 * plan someone has already drawn would produce a document with two origins and
 * a provenance record that is true of only half the geometry. So the import is
 * explicit and destructive, and it says so before it happens.
 */
export function BimWorkspacePanel({ plan, onReplacePlan }: Props) {
  const [pending, setPending] = useState<IfcPlanProposal | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // Analysis is derived, never stored: it is a reading of the current plan, and
  // a cached one would quietly describe a plan that has since been edited.
  const analysis = useMemo(() => {
    try {
      return analysePlanBim(plan)
    } catch {
      return null
    }
  }, [plan])

  const hasBim = !!analysis && analysis.totals.uniqueSourceElements > 0

  function confirmImport() {
    if (!pending) return
    try {
      onReplacePlan(planFromIfcProposal(pending))
      setPending(null)
      setImportError(null)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="bim-workspace">
      <span className="eyebrow">BIM &amp; Revit</span>
      <p className="muted" style={{ fontSize: 12 }}>
        Read an IFC or an authorized Revit export. The file is parsed in this browser and
        never uploaded.
      </p>

      <IfcImportPanel onImportPlan={(proposal) => { setPending(proposal); setImportError(null) }} />

      {/* ---- confirmation, because import replaces the document ------------- */}
      {pending && (
        <div className="bim-confirm" role="alertdialog" aria-label="Confirm model import">
          <h3>Replace the current plan?</h3>
          <p>
            <strong>{pending.sourceName}</strong> — {pending.storeys.length} storey
            {pending.storeys.length === 1 ? '' : 's'},{' '}
            {pending.sourceRecordCount.toLocaleString()} source records
            {pending.sourceSchema ? ` · ${pending.sourceSchema}` : ''}
          </p>
          {/* What the importer could NOT bring across. Stated before the import,
              not after, because it is the one moment the choice is still open. */}
          <SkippedNotice skipped={pending.skipped} />
          <div className="bim-confirm-actions">
            <button className="btn btn-primary" onClick={confirmImport}>
              Replace plan with this model
            </button>
            <button className="btn" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {importError && (
        <p className="alert alert-error" role="alert" style={{ fontSize: 12 }}>Could not build a plan from this model: {importError}</p>
      )}

      {/* ---- provenance: where this plan came from -------------------------- */}
      {plan.bimSource && (
        <dl className="bim-provenance">
          <dt>Source</dt>
          <dd>{plan.bimSource.sourceName}</dd>
          <dt>Format</dt>
          <dd>{plan.bimSource.schema || plan.bimSource.source}</dd>
          <dt>Records read</dt>
          <dd>{plan.bimSource.recordCount.toLocaleString()}</dd>
          <dt>Origin offset</dt>
          <dd>
            x {plan.bimSource.sourceOrigin.x.toFixed(3)} m · z{' '}
            {plan.bimSource.sourceOrigin.z.toFixed(3)} m
          </dd>
        </dl>
      )}

      {/* ---- the three states this panel can be in -------------------------- */}
      {!analysis ? (
        <p className="alert alert-error" role="alert" style={{ fontSize: 12 }}>
          This plan could not be analysed. That is a defect, not an empty result — the
          reading failed rather than finding nothing.
        </p>
      ) : hasBim ? (
        <BimAnalysisPanel analysis={analysis} />
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>
          Nothing in this plan came from a BIM model, so there is nothing to measure against
          a source. Drawn geometry has no provenance to report — that is expected, not a
          failure.
        </p>
      )}
    </section>
  )
}

/**
 * What the import dropped, named individually.
 *
 * A single "12 elements skipped" is unactionable. Each of these has a different
 * cause and a different fix — a wall with no axis is a modelling problem, an
 * opening with no host is a relationship problem — so they are never summed.
 */
function SkippedNotice({ skipped }: { skipped: IfcPlanProposal['skipped'] }) {
  const rows = [
    ['Walls without an axis', skipped.wallsWithoutAxis],
    ['Openings without geometry', skipped.openingsWithoutGeometry],
    ['Openings without a host wall', skipped.openingsWithoutHost],
  ] as const
  const real = rows.filter(([, n]) => n > 0)
  if (real.length === 0) {
    return <p className="muted" style={{ fontSize: 12 }}>Every wall and opening in this model converted cleanly.</p>
  }
  return (
    <div className="bim-skipped">
      <h4>Not brought across</h4>
      <ul>
        {real.map(([label, n]) => <li key={label}><strong>{n}</strong> {label.toLowerCase()}</li>)}
      </ul>
    </div>
  )
}
