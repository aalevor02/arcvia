import type { BimEntitySnapshot } from '../bim/semantics'

interface Props {
  data: BimEntitySnapshot
}

function relationCount(data: BimEntitySnapshot): number {
  const relations = data.relations
  return (relations.hostId ? 1 : 0)
    + (relations.fillsOpeningId ? 1 : 0)
    + (relations.containerId ? 1 : 0)
    + (relations.typeId ? 1 : 0)
    + (relations.parentId ? 1 : 0)
    + (relations.groupIds?.length ?? 0)
    + (relations.connectedIds?.length ?? 0)
    + (relations.spaceIds?.length ?? 0)
}

/** Compact audit summary for source semantics retained on editable geometry. */
export function BimDataSummary({ data }: Props) {
  return (
    <>
      <div className="stat">
        <span className="muted">Semantic confidence</span>
        <span className="mono">{Math.round(data.confidence * 100)}%</span>
      </div>
      <div className="stat">
        <span className="muted">Evidence / conflicts</span>
        <span className="mono">{data.evidence.length} / {data.conflicts.length}</span>
      </div>
      <div className="stat">
        <span className="muted">Quantities / relations</span>
        <span className="mono">{data.quantities.length} / {relationCount(data)}</span>
      </div>
      <div className="stat">
        <span className="muted">Source fields</span>
        <span className="mono">{Object.keys(data.properties).length}</span>
      </div>
      <div className="stat">
        <span className="muted">Materials / layers</span>
        <span className="mono">
          {(data.materials ?? []).length} / {(data.materials ?? []).reduce(
            (sum, material) => sum + material.layers.length,
            0,
          )}
        </span>
      </div>
    </>
  )
}
