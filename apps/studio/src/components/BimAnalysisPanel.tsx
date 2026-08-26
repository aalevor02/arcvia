import { useMemo, useState } from 'react'
import type { BimPlanAnalysis } from '../bim/analytics'
import {
  compareBimAnalyses,
  isBimPlanAnalysis,
  type BimAnalysisComparison,
} from '../bim/comparison'
import { createBimLearningDataset } from '../bim/learningDataset'
import {
  buildBimLearningCorpus,
  isBimLearningDataset,
  type BimLearningCorpus,
} from '../bim/learningCorpus'
import {
  evaluateBimBaseline,
  isBimBaselineEvaluation,
  type BimBaselineEvaluation,
} from '../bim/baselineClassifier'
import { inferBimElementKinds, type BimInferenceReport } from '../bim/inference'

interface Props {
  analysis: BimPlanAnalysis
}

export function BimAnalysisPanel({ analysis }: Props) {
  const [baseline, setBaseline] = useState<BimPlanAnalysis | null>(null)
  const [comparisonError, setComparisonError] = useState<string | null>(null)
  const [datasetName, setDatasetName] = useState(
    `${analysis.source?.sourceName ?? 'Arcvia BIM'} learning dataset`,
  )
  const [buildingId, setBuildingId] = useState('')
  const [datasetLicence, setDatasetLicence] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [datasetError, setDatasetError] = useState<string | null>(null)
  const [corpus, setCorpus] = useState<BimLearningCorpus | null>(null)
  const [corpusError, setCorpusError] = useState<string | null>(null)
  const [modelEvaluation, setModelEvaluation] = useState<BimBaselineEvaluation | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [inferenceEnabled, setInferenceEnabled] = useState(false)
  const comparison: BimAnalysisComparison | null = useMemo(
    () => baseline ? compareBimAnalyses(baseline, analysis) : null,
    [analysis, baseline],
  )
  const inferenceReport = useMemo(
    () => modelEvaluation && inferenceEnabled
      ? inferBimElementKinds(modelEvaluation, analysis)
      : null,
    [analysis, inferenceEnabled, modelEvaluation],
  )
  const exportAnalysis = () => {
    const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${analysis.source?.sourceName ?? 'arcvia-plan'}.bim-analysis.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const compareBaseline = async (file: File) => {
    setBaseline(null)
    setComparisonError(null)
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Analysis JSON is over 50 MB.')
      const value = JSON.parse(await file.text()) as unknown
      if (!isBimPlanAnalysis(value)) {
        throw new Error('Choose an Arcvia BIM analysis containing element fingerprints.')
      }
      setBaseline(value)
    } catch (error) {
      setComparisonError(error instanceof Error ? error.message : 'Could not compare that analysis.')
    }
  }

  const exportComparison = () => {
    if (!comparison) return
    const blob = new Blob([JSON.stringify(comparison, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${analysis.source?.sourceName ?? 'arcvia-plan'}.bim-comparison.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportLearningDataset = () => {
    setDatasetError(null)
    try {
      const dataset = createBimLearningDataset(analysis, {
        datasetName,
        buildingId,
        licence: datasetLicence,
        rightsConfirmed,
      })
      const blob = new Blob([JSON.stringify(dataset, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${analysis.source?.sourceName ?? 'arcvia-plan'}.bim-learning.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setDatasetError(error instanceof Error ? error.message : 'Could not create the dataset.')
    }
  }

  const loadLearningCorpus = async (files: FileList) => {
    setCorpus(null)
    setCorpusError(null)
    setModelEvaluation(null)
    setModelError(null)
    setInferenceEnabled(false)
    try {
      const selected = [...files]
      if (selected.length === 0) throw new Error('Choose at least one learning dataset.')
      if (selected.some((file) => file.size > 100 * 1024 * 1024)) {
        throw new Error('Each learning dataset must be 100 MB or smaller.')
      }
      if (selected.reduce((total, file) => total + file.size, 0) > 250 * 1024 * 1024) {
        throw new Error('The selected corpus is over the 250 MB browser limit.')
      }
      const values = await Promise.all(selected.map(async (file) =>
        JSON.parse(await file.text()) as unknown))
      if (!values.every(isBimLearningDataset)) {
        throw new Error('Every file must be a permission-confirmed Arcvia BIM learning dataset.')
      }
      setCorpus(buildBimLearningCorpus(values))
    } catch (error) {
      setCorpusError(error instanceof Error ? error.message : 'Could not audit that corpus.')
    }
  }

  const exportLearningCorpus = () => {
    if (!corpus) return
    const blob = new Blob([JSON.stringify(corpus, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${corpus.corpusId}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const runBaselineEvaluation = () => {
    setModelEvaluation(null)
    setModelError(null)
    try {
      if (!corpus) throw new Error('Audit a learning corpus first.')
      setModelEvaluation(evaluateBimBaseline(corpus))
      setInferenceEnabled(false)
    } catch (error) {
      setModelError(error instanceof Error ? error.message : 'Could not evaluate the baseline.')
    }
  }

  const exportBaselineEvaluation = () => {
    if (!modelEvaluation) return
    const blob = new Blob([JSON.stringify(modelEvaluation, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${modelEvaluation.modelId}.evaluation.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const loadBaselineEvaluation = async (file: File) => {
    setModelEvaluation(null)
    setModelError(null)
    setInferenceEnabled(false)
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Model evaluation JSON is over 50 MB.')
      const value = JSON.parse(await file.text()) as unknown
      if (!isBimBaselineEvaluation(value)) {
        throw new Error('Choose a valid Arcvia structured baseline evaluation.')
      }
      setModelEvaluation(value)
    } catch (error) {
      setModelError(error instanceof Error ? error.message : 'Could not load that baseline model.')
    }
  }

  const exportInferenceReport = () => {
    if (!inferenceReport) return
    const blob = new Blob([JSON.stringify(inferenceReport, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${inferenceReport.reportId}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section>
      <span className="eyebrow">BIM analysis</span>
      <div className="stat">
        <span className="muted">Source elements / instances</span>
        <span className="mono">
          {analysis.totals.uniqueSourceElements} / {analysis.totals.editableInstances}
        </span>
      </div>
      <div className="stat">
        <span className="muted">Semantic snapshots</span>
        <span className="mono">{analysis.totals.semanticSnapshots}</span>
      </div>
      <div className="stat">
        <span className="muted">Exact meshes / bounds</span>
        <span className="mono">
          {analysis.totals.exactMeshes} / {analysis.totals.boundsFallbacks}
        </span>
      </div>
      <div className="stat">
        <span className="muted">Quantity totals</span>
        <span className="mono">{analysis.quantities.length}</span>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
          Element breakdown and findings
        </summary>
        <div className="bim-kind-list">
          {analysis.byKind.map((entry) => (
            <div className="stat" key={entry.name}>
              <span>{entry.name}</span>
              <span className="mono">{entry.count}</span>
            </div>
          ))}
          {analysis.byNativeClass.map((entry) => (
            <div className="stat" key={`class:${entry.name}`}>
              <span className="muted">{entry.name}</span>
              <span className="mono">{entry.count}</span>
            </div>
          ))}
          {analysis.byStorey.map((entry) => (
            <div className="stat" key={`storey:${entry.name}`}>
              <span className="muted">Storey: {entry.name}</span>
              <span className="mono">{entry.count}</span>
            </div>
          ))}
          {analysis.findings.map((finding) => (
            <p className="muted" style={{ fontSize: 11.5 }} key={finding.code}>
              {finding.message}
            </p>
          ))}
        </div>
      </details>
      {analysis.quantities.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Normalized quantity totals
          </summary>
          <div className="bim-kind-list">
            {analysis.quantities.map((quantity) => (
              <div
                className="stat"
                key={`${quantity.dimension}:${quantity.name}:${quantity.unit}`}
              >
                <span>{quantity.name}</span>
                <span className="mono" title={`${quantity.sourceElementCount} source elements`}>
                  {quantity.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  {' '}{quantity.unit}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {analysis.materials.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Material and layer takeoff
          </summary>
          <div className="bim-kind-list">
            {analysis.materials.map((material) => (
              <div className="stat" key={`${material.name}:${material.category ?? ''}`}>
                <span>{material.name}</span>
                <span className="mono" title={`${material.sourceElementCount} source elements`}>
                  {material.totalThicknessSI === undefined
                    ? `${material.sourceElementCount} elements`
                    : `${material.totalThicknessSI.toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })} m`}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={exportAnalysis}>
        Export BIM analysis JSON
      </button>
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
          Prepare governed learning dataset
        </summary>
        <div className="field">
          <label htmlFor="bim-dataset-name">Dataset name</label>
          <input
            id="bim-dataset-name"
            value={datasetName}
            onChange={(event) => setDatasetName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="bim-building-id">Stable building ID</label>
          <input
            id="bim-building-id"
            placeholder="Same ID for every revision"
            value={buildingId}
            onChange={(event) => setBuildingId(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="bim-dataset-licence">Licence or internal-use permission</label>
          <input
            id="bim-dataset-licence"
            placeholder="e.g. CC BY 4.0"
            value={datasetLicence}
            onChange={(event) => setDatasetLicence(event.target.value)}
          />
        </div>
        <label
          className="muted"
          style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, marginTop: 10 }}
        >
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(event) => setRightsConfirmed(event.target.checked)}
            style={{ width: 'auto', marginTop: 2 }}
          />
          I confirm this model may be used for learning under the permission above.
        </label>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          Exports normalized features and labels locally. Raw property values are excluded,
          and every revision of this building stays in one evaluation split.
        </p>
        {datasetError && (
          <p style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 8 }}>
            {datasetError}
          </p>
        )}
        <button
          className="btn btn-tiny"
          style={{ width: '100%', marginTop: 8 }}
          onClick={exportLearningDataset}
        >
          Export learning dataset JSON
        </button>
      </details>
      <label className="btn" style={{ display: 'block', width: '100%', marginTop: 8 }}>
        Audit learning corpus
        <input
          type="file"
          accept=".json,application/json"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            const files = event.target.files
            if (files) void loadLearningCorpus(files)
            event.target.value = ''
          }}
        />
      </label>
      {corpusError && (
        <p style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 8 }}>
          {corpusError}
        </p>
      )}
      {corpus && (
        <details open style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Corpus audit: {corpus.trainingReady ? 'training ready' : 'blocked'}
          </summary>
          <div className="bim-kind-list">
            <div className="stat">
              <span>Datasets / buildings</span>
              <span className="mono">
                {corpus.summary.datasetCount} / {corpus.summary.buildingCount}
              </span>
            </div>
            <div className="stat">
              <span>Unique examples</span>
              <span className="mono">{corpus.summary.exampleCount}</span>
            </div>
            {corpus.summary.bySplit.map((entry) => (
              <div className="stat" key={`corpus:${entry.name}`}>
                <span>{entry.name}</span>
                <span className="mono">{entry.buildings} / {entry.examples}</span>
              </div>
            ))}
            {corpus.summary.byLabel.map((entry) => (
              <div className="stat" key={`corpus-label:${entry.name}`}>
                <span className="muted">{entry.name}</span>
                <span className="mono">{entry.count}</span>
              </div>
            ))}
            {corpus.issues.map((issue) => (
              <p
                className="muted"
                style={{ fontSize: 11.5 }}
                key={`corpus-issue:${issue.code}`}
              >
                {issue.severity.toUpperCase()} ({issue.count}): {issue.message}
              </p>
            ))}
            {corpus.trainingReady && (
              <button
                className="btn btn-tiny"
                style={{ width: '100%' }}
                onClick={runBaselineEvaluation}
              >
                Train and evaluate structured baseline
              </button>
            )}
            {modelError && (
              <p style={{ color: 'var(--danger)', fontSize: 11.5 }}>
                {modelError}
              </p>
            )}
            {modelEvaluation && (
              <details open>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                  Baseline evaluation
                </summary>
                <p className="muted" style={{ fontSize: 11.5 }}>
                  Interpretable nearest-centroid benchmark; not a production classifier.
                  Native classes and semantic label evidence are excluded from its inputs.
                </p>
                <div className="stat">
                  <span>Training examples / classes</span>
                  <span className="mono">
                    {modelEvaluation.training.exampleCount}
                    {' / '}{modelEvaluation.training.classCounts.length}
                  </span>
                </div>
                {([modelEvaluation.validation, modelEvaluation.test]).map((partition) => (
                  <div key={`evaluation:${partition.split}`}>
                    <div className="stat">
                      <span>{partition.split} accuracy</span>
                      <span className="mono">
                        {(partition.accuracy * 100).toFixed(1)}% ({partition.exampleCount})
                      </span>
                    </div>
                    <div className="stat">
                      <span className="muted">{partition.split} macro F1</span>
                      <span className="mono">{partition.macroF1.toFixed(3)}</span>
                    </div>
                    {partition.classes.map((metric) => (
                      <p className="muted" style={{ fontSize: 11.5 }} key={`${partition.split}:${metric.label}`}>
                        {metric.label}: P {metric.precision.toFixed(3)}, R {metric.recall.toFixed(3)},
                        {' '}F1 {metric.f1.toFixed(3)}, n={metric.support}
                      </p>
                    ))}
                  </div>
                ))}
                <button
                  className="btn btn-tiny"
                  style={{ width: '100%' }}
                  onClick={exportBaselineEvaluation}
                >
                  Export model evaluation JSON
                </button>
              </details>
            )}
            <button
              className="btn btn-tiny"
              style={{ width: '100%' }}
              onClick={exportLearningCorpus}
            >
              Export corpus and audit JSON
            </button>
          </div>
        </details>
      )}
      <label className="btn" style={{ display: 'block', width: '100%', marginTop: 8 }}>
        Load structured baseline model
        <input
          type='file'
          accept='.json,application/json'
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadBaselineEvaluation(file)
            event.target.value = ''
          }}
        />
      </label>
      <label className='btn' style={{ display: 'block', width: '100%', marginTop: 8 }}>
        Compare previous analysis
        <input
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void compareBaseline(file)
            event.target.value = ''
          }}
        />
      </label>
      {modelEvaluation && (
        <details open style={{ marginTop: 8 }}>
          <summary className='muted' style={{ cursor: 'pointer', fontSize: 12 }}>
            Safe BIM inference
          </summary>
          <p className='muted' style={{ fontSize: 11.5 }}>
            Reviews uncertain elements without replacing native IFC/Revit labels.
            Ambiguous or unfamiliar geometry remains unclassified.
          </p>
          <div className='stat'>
            <span>Model / trained classes</span>
            <span className='mono'>
              {modelEvaluation.modelId} / {modelEvaluation.training.centroids.length}
            </span>
          </div>
          <button className='btn btn-tiny' style={{ width: '100%' }}
            onClick={() => setInferenceEnabled(true)}>
            Review uncertain elements
          </button>
          {inferenceReport && (
            <InferenceReview report={inferenceReport} onExport={exportInferenceReport} />
          )}
        </details>
      )}
      {comparisonError && (
        <p style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 8 }}>
          {comparisonError}
        </p>
      )}
      {comparison && (
        <details open style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Version comparison
          </summary>
          <div className="bim-kind-list">
            {([
              ['Added', comparison.added.length],
              ['Removed', comparison.removed.length],
              ['Modified', comparison.modified.length],
              ['Unchanged', comparison.unchanged],
            ] as const).map(([label, count]) => (
              <div className="stat" key={label}>
                <span>{label}</span>
                <span className="mono">{count}</span>
              </div>
            ))}
            {comparison.modified.map((element) => (
              <p className="muted" style={{ fontSize: 11.5 }} key={element.key}>
                {element.sourceClass ?? element.sourceId}: {[
                  element.geometryChanged && 'geometry',
                  element.semanticsChanged && 'semantics',
                  element.storeyChanged && 'storey',
                  element.kindChanged && 'kind',
                  element.nativeClassChanged && 'class',
                  element.instanceCountChanged && 'segments',
                ].filter(Boolean).join(', ')}
              </p>
            ))}
            {comparison.added.map((element) => (
              <p className="muted" style={{ fontSize: 11.5 }} key={`added:${element.key}`}>
                Added: {element.sourceClass ?? element.sourceId} #{element.sourceId}
              </p>
            ))}
            {comparison.removed.map((element) => (
              <p className="muted" style={{ fontSize: 11.5 }} key={`removed:${element.key}`}>
                Removed: {element.sourceClass ?? element.sourceId} #{element.sourceId}
              </p>
            ))}
            <button className="btn btn-tiny" style={{ width: '100%' }} onClick={exportComparison}>
              Export comparison JSON
            </button>
          </div>
        </details>
      )}
    </section>
  )
}

function InferenceReview({ report, onExport }: {
  report: BimInferenceReport
  onExport(): void
}) {
  return (
    <div className='bim-kind-list'>
      <div className='stat'>
        <span>Eligible / suggestions / abstentions</span>
        <span className='mono'>
          {report.summary.eligibleElements}
          {' / '}{report.summary.suggestions}
          {' / '}{report.summary.abstentions}
        </span>
      </div>
      {report.suggestions.map((item) => (
        <p className='muted' style={{ fontSize: 11.5 }} key={item.elementKey}>
          {item.sourceClass ?? item.sourceId} #{item.sourceId}: {item.decision === 'suggested'
            ? `review as ${item.predictedKind} (margin ${item.marginScore.toFixed(3)})`
            : `abstained — ${item.abstentionReason}`}
        </p>
      ))}
      {report.summary.eligibleElements === 0 && (
        <p className='muted' style={{ fontSize: 11.5 }}>
          No unknown or low-confidence elements need review.
        </p>
      )}
      <button className='btn btn-tiny' style={{ width: '100%' }} onClick={onExport}>
        Export review-only inference JSON
      </button>
    </div>
  )
}
