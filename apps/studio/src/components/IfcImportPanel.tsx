import { useMemo, useRef, useState } from 'react'
import type { IfcMetadataResult } from '../bim/ifcMetadata'
import { createIfcPlanProposal, type IfcPlanProposal } from '../bim/ifcPlanProposal'
import type { BimElementKind } from '../bim/semantics'

const MAX_IFC_BYTES = 250 * 1024 * 1024

interface KindCount {
  kind: BimElementKind
  count: number
}

interface NativeClassCount {
  sourceClass: string
  count: number
}

interface QuantitySummary {
  name: string
  unit: string
  count: number
  total: number
}

interface Props {
  onImportPlan?(proposal: IfcPlanProposal): void
}

/**
 * Local IFC inspection.
 *
 * The file never leaves the browser. `web-ifc` is dynamically imported only
 * after a file is chosen, keeping its WASM parser out of the normal editor
 * startup path.
 */
export function IfcImportPanel({ onImportPlan }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [deep, setDeep] = useState(true)
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<IfcMetadataResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const counts = useMemo<KindCount[]>(() => {
    if (!result) return []
    const grouped = new Map<BimElementKind, number>()
    for (const element of result.elements) {
      grouped.set(element.kind, (grouped.get(element.kind) ?? 0) + 1)
    }
    return [...grouped]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind))
  }, [result])
  const proposal = useMemo(
    () => result && fileName ? createIfcPlanProposal(result, fileName) : null,
    [fileName, result],
  )
  const unsupportedClasses = useMemo<NativeClassCount[]>(() => {
    if (!result) return []
    const grouped = new Map<string, number>()
    for (const record of result.records) {
      if (record.kind !== 'unknown') continue
      const sourceClass = record.sourceClass ?? 'Unknown native class'
      grouped.set(sourceClass, (grouped.get(sourceClass) ?? 0) + 1)
    }
    return [...grouped]
      .map(([sourceClass, count]) => ({ sourceClass, count }))
      .sort((left, right) =>
        right.count - left.count || left.sourceClass.localeCompare(right.sourceClass))
  }, [result])
  const unsupportedRecords = unsupportedClasses.reduce((sum, item) => sum + item.count, 0)
  const quantitySummaries = useMemo<QuantitySummary[]>(() => {
    if (!result) return []
    const grouped = new Map<string, QuantitySummary>()
    for (const record of result.records) {
      for (const quantity of record.quantities) {
        if (quantity.valueSI === undefined || !quantity.unitSI) continue
        const key = `${quantity.name}\0${quantity.unitSI}`
        const current = grouped.get(key)
        if (current) {
          current.count++
          current.total += quantity.valueSI
        } else {
          grouped.set(key, {
            name: quantity.name,
            unit: quantity.unitSI,
            count: 1,
            total: quantity.valueSI,
          })
        }
      }
    }
    return [...grouped.values()].sort((left, right) =>
      right.count - left.count || left.name.localeCompare(right.name))
  }, [result])
  const normalizedQuantityCount = quantitySummaries.reduce((sum, item) => sum + item.count, 0)
  const proposedWalls = proposal
    ? proposal.storeys.reduce((sum, storey) => sum + storey.walls.length, 0)
    : 0
  const proposedOpenings = proposal
    ? proposal.storeys.reduce((sum, storey) => sum + storey.openings.length, 0)
    : 0
  const proposedComponents = proposal
    ? proposal.storeys.reduce((sum, storey) => sum + storey.components.length, 0)
    : 0
  const proposedMeshes = proposal
    ? proposal.storeys.reduce(
      (sum, storey) => sum + storey.components.filter((component) => component.mesh).length,
      0,
    )
    : 0

  async function inspect(file: File) {
    setError(null)
    setResult(null)
    setFileName(file.name)

    const lowerName = file.name.toLowerCase()
    const isIfc = lowerName.endsWith('.ifc')
    const isJson = lowerName.endsWith('.json')
    if (!isIfc && !isJson) {
      setError('Choose an IFC file or an Arcvia Revit Export JSON file.')
      return
    }
    if (file.size === 0) {
      setError('That IFC file is empty.')
      return
    }
    if (file.size > MAX_IFC_BYTES) {
      setError('That IFC is over 250 MB. Split or federate it before browser inspection.')
      return
    }

    setBusy(true)
    try {
      if (isIfc) {
        const [{ readIfcMetadata }, bytes] = await Promise.all([
          import('../bim/ifcReader'),
          file.arrayBuffer(),
        ])
        setResult(await readIfcMetadata(new Uint8Array(bytes), { includeProperties: deep }))
      } else {
        const [{ readRevitExport }, source] = await Promise.all([
          import('../bim/revitMetadata'),
          file.text(),
        ])
        setResult(readRevitExport(JSON.parse(source) as unknown))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Arcvia could not read this IFC file.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  function exportInventory() {
    if (!result || !fileName) return
    const blob = new Blob([JSON.stringify({ fileName, ...result }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${fileName.replace(/\.(ifc|json)$/i, '')}.arcvia-bim.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const totalEntities = result
    ? Object.values(result.typeCounts).reduce((sum, count) => sum + count, 0)
    : 0

  return (
    <section>
      <span className="eyebrow">BIM / IFC / Revit</span>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Inspect IFC or authorized Arcvia Revit exports locally, then import measured geometry.
      </p>

      <label className="check-row" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={deep}
          onChange={(event) => setDeep(event.target.checked)}
          disabled={busy}
        />
        <span>
          Deep IFC property scan
          <small>IFC property sets, type properties and materials</small>
        </span>
      </label>

      <input
        ref={inputRef}
        type="file"
        accept=".ifc,.json,application/x-step,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void inspect(file)
        }}
      />
      <button
        className="btn btn-primary"
        style={{ width: '100%', marginTop: 10 }}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy ? 'Reading BIM file…' : 'Choose BIM file'}
      </button>

      {error && (
        <p className="alert alert-error" role="alert" style={{ marginTop: 10, fontSize: 12 }}>
          {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="stat">
            <span className="muted">Schema</span>
            <span className="mono">{result.schema}</span>
          </div>
          <div className="stat">
            <span className="muted">All entities</span>
            <span className="mono">{totalEntities.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="muted">Building elements</span>
            <span className="mono">{result.elements.length.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="muted">Native BIM records</span>
            <span className="mono">{result.records.length.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="muted">Unsupported, preserved</span>
            <span className="mono">{unsupportedRecords.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="muted">Normalized quantities</span>
            <span className="mono">{normalizedQuantityCount.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="muted">Quality findings</span>
            <span className="mono">
              {result.quality.counts.error}E · {result.quality.counts.warning}W · {result.quality.counts.info}I
            </span>
          </div>

          <div className="bim-kind-list" aria-label="IFC element counts">
            {counts.map(({ kind, count }) => (
              <div className="stat" key={kind}>
                <span>{kind.replace('-', ' ')}</span>
                <span className="mono">{count.toLocaleString()}</span>
              </div>
            ))}
          </div>

          {unsupportedClasses.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                Native classes not editable yet
              </summary>
              <div className="bim-kind-list" aria-label="Preserved unsupported IFC classes">
                {unsupportedClasses.slice(0, 12).map(({ sourceClass, count }) => (
                  <div className="stat" key={sourceClass}>
                    <span className="mono" style={{ fontSize: 10.5 }}>{sourceClass}</span>
                    <span className="mono">{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              {unsupportedClasses.length > 12 && (
                <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  {unsupportedClasses.length - 12} more native classes are included in the JSON.
                </p>
              )}
            </details>
          )}

          {quantitySummaries.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                Quantity totals by source name
              </summary>
              <div className="bim-kind-list" aria-label="Normalized IFC quantity totals">
                {quantitySummaries.slice(0, 12).map(({ name, unit, count, total }) => (
                  <div className="stat" key={`${name}-${unit}`}>
                    <span title={`${count} source quantities`}>{name}</span>
                    <span className="mono">
                      {total.toLocaleString(undefined, { maximumFractionDigits: 3 })} {unit}
                    </span>
                  </div>
                ))}
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Totals are kept separate by IFC quantity name to avoid mixing gross, net and side areas.
              </p>
            </details>
          )}

          {result.quality.issues.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                BIM quality findings
              </summary>
              <div className="bim-kind-list" aria-label="BIM quality findings">
                {result.quality.issues.slice(0, 12).map((issue, index) => (
                  <div className="stat" key={`${issue.code}-${index}`}>
                    <span title={issue.message}>{issue.code.replaceAll('-', ' ')}</span>
                    <span className="mono">{issue.severity[0].toUpperCase()}</span>
                  </div>
                ))}
              </div>
              {result.quality.issues.length > 12 && (
                <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  {result.quality.issues.length - 12} more findings are included in the JSON.
                </p>
              )}
            </details>
          )}

          {result.warnings.length > 0 && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              {result.warnings.length} element{result.warnings.length === 1 ? '' : 's'} could not be
              fully read. The exported inventory includes the details.
            </p>
          )}

          {proposal && (
            <div style={{ marginTop: 10 }}>
              <div className="stat">
                <span className="muted">Editable walls</span>
                <span className="mono">{proposedWalls.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="muted">Hosted openings</span>
                <span className="mono">{proposedOpenings.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="muted">BIM components</span>
                <span className="mono">{proposedComponents.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="muted">Exact meshes / bounds</span>
                <span className="mono">
                  {proposedMeshes.toLocaleString()} / {(proposedComponents - proposedMeshes).toLocaleString()}
                </span>
              </div>
              {proposal.skipped.wallsWithoutAxis > 0 && (
                <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                  {proposal.skipped.wallsWithoutAxis} curved, composite or unmeasurable wall
                  {proposal.skipped.wallsWithoutAxis === 1 ? '' : 's'} remain in the BIM inventory
                  and will not be flattened.
                </p>
              )}
              {onImportPlan && (proposedWalls > 0 || proposedComponents > 0) && (
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: 10 }}
                  onClick={() => onImportPlan(proposal)}
                >
                  Import as editable plan
                </button>
              )}
            </div>
          )}

          <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={exportInventory}>
            Export BIM inventory JSON
          </button>
        </div>
      )}
    </section>
  )
}
