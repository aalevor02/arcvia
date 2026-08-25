import { useEffect, useRef, useState } from 'react'

import {
  cadJob,
  cancelCadJob,
  deckSurvey,
  storedUrl,
  submitCadJob,
  submitDeckBuild,
  uploadFloorplan,
  uploadScene,
  type CadSummary,
  type DeckSurvey,
} from '../lib/api'

interface Props {
  /** Which door the user came in through. */
  kind: 'model' | 'cad'
  /**
   * Called with the stored model path once there is a model to show.
   * `modelJsonUrl` is the reconstruction's building.json when the engine
   * produced one — the fixture placements the editor can furnish from.
   */
  onLanded(
    modelUrl: string,
    summary: CadSummary | null,
    modelJsonUrl?: string | null,
    sourceDocumentUrl?: string | null,
  ): void | Promise<void>
  onDismiss(): void
}

type Phase =
  | { at: 'pick' }
  | { at: 'uploading'; name: string }
  | { at: 'surveying'; name: string }
  | {
      at: 'choose'
      key: string
      sourceUrl: string
      survey: DeckSurvey
      sheet: number
      anchor: number
      metres: string
    }
  | { at: 'working'; jobId: string; progress: number; charged: number }
  | { at: 'failed'; message: string; refunded: boolean }

/**
 * The import step the two upload starts were missing.
 *
 * `model` is one hop: the GLB goes to storage and its path onto the scene.
 * `cad` covers two kinds of file through one door, split by what the file is:
 *
 *   DWG / DXF   straight to the engine — vectors are exact, one job.
 *   PDF         a presentation deck: a cheap SURVEY finds the plan sheets and
 *               the dimensions printed on them, the user confirms ONE, and a
 *               single build runs at the settled scale. Two phases by design —
 *               build-then-rebuild would charge twice for our own scale
 *               uncertainty.
 *
 * The scale anchor defaults to a well-enclosed room (the engine flags which):
 * a toilet's outline survives a rendered plan far better than an open-plan
 * living room's, so it is the dimension whose drawn span can be trusted.
 *
 * Failures show the engine's message verbatim. It writes refusals for people,
 * and a paraphrase would only lose information.
 */
export default function ImportPanel({ kind, onLanded, onDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ at: 'pick' })
  const fileRef = useRef<HTMLInputElement>(null)
  // The poll survives re-renders and must not survive unmount.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const jobRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  function watch(jobId: string, charged: number, sourceDocumentUrl?: string) {
    jobRef.current = jobId
    setPhase({ at: 'working', jobId, progress: 0, charged })
    pollRef.current = setInterval(async () => {
      try {
        const job = await cadJob(jobId)
        if (job.status === 'done' && job.outputUrl) {
          if (pollRef.current) clearInterval(pollRef.current)
          await onLanded(job.outputUrl, job.summary, job.modelJsonUrl, sourceDocumentUrl)
          return
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
          if (pollRef.current) clearInterval(pollRef.current)
          setPhase({
            at: 'failed',
            message: job.error ?? 'The reconstruction did not finish.',
            refunded: job.refunded > 0,
          })
          return
        }
        setPhase((prev) =>
          prev.at === 'working' ? { ...prev, progress: job.progress ?? 0 } : prev,
        )
      } catch {
        // One missed poll is a blip; the next tick asks again. The job is
        // server-side either way — nothing is lost by staying quiet here.
      }
    }, 2500)
  }

  async function picked(file: File) {
    setPhase({ at: 'uploading', name: file.name })
    try {
      if (kind === 'model') {
        const stored = await uploadScene(file)
        onLanded(stored.url, null)
        return
      }

      const stored = await uploadFloorplan(file)

      if (/\.pdf$/i.test(file.name)) {
        setPhase({ at: 'surveying', name: file.name })
        const survey = await deckSurvey(stored.key)
        if (!survey.sheets.length) {
          setPhase({
            at: 'failed',
            message:
              `No floor plans found across ${survey.pages} page(s) — ` +
              `${survey.otherSheets.length} sheet(s) look like renders, elevations or boards.`,
            refunded: false,
          })
          return
        }
        const anchor = Math.max(
          0,
          survey.sheets[0].confirmDimensions.findIndex((d) => d.reliableAnchor),
        )
        setPhase({
          at: 'choose',
          key: stored.key,
          sourceUrl: stored.url,
          survey,
          sheet: 0,
          anchor,
          metres: String(survey.sheets[0].confirmDimensions[anchor]?.longSideMetres ?? ''),
        })
        return
      }

      const submitted = await submitCadJob(stored.key)
      watch(submitted.jobId, submitted.creditsCharged)
    } catch (error) {
      setPhase({
        at: 'failed',
        message: error instanceof Error ? error.message : 'The upload failed.',
        refunded: false,
      })
    }
  }

  /** The scale the current choice implies, in metres across the sheet image. */
  function chosenScale(p: Extract<Phase, { at: 'choose' }>): number | null {
    const sheet = p.survey.sheets[p.sheet]
    const dim = sheet.confirmDimensions[p.anchor]
    const metres = Number(p.metres)
    if (dim && Number.isFinite(metres) && metres > 0 && dim.drawnSpanFraction > 0) {
      return metres / dim.drawnSpanFraction
    }
    return sheet.suggestedScale
  }

  async function build(p: Extract<Phase, { at: 'choose' }>) {
    const sheet = p.survey.sheets[p.sheet]
    try {
      const submitted = await submitDeckBuild({
        key: p.key,
        page: sheet.page,
        index: sheet.index,
        scale: chosenScale(p),
      })
      watch(submitted.jobId, submitted.creditsCharged, p.sourceUrl)
    } catch (error) {
      setPhase({
        at: 'failed',
        message: error instanceof Error ? error.message : 'The build could not start.',
        refunded: false,
      })
    }
  }

  async function cancel() {
    if (jobRef.current) {
      if (pollRef.current) clearInterval(pollRef.current)
      const result = await cancelCadJob(jobRef.current).catch(() => null)
      setPhase({
        at: 'failed',
        message:
          result && result.refunded > 0
            ? 'Cancelled before it started — the credits are back.'
            : 'Cancelled. The engine had already started, so the charge stands.',
        refunded: Boolean(result && result.refunded > 0),
      })
      jobRef.current = null
    } else {
      onDismiss()
    }
  }

  const accept = kind === 'model' ? '.glb' : '.dwg,.dxf,.pdf'
  const title = kind === 'model' ? 'Load a 3D model' : 'Reconstruct from CAD or a plan PDF'

  return (
    <div className="alert" style={{ margin: 12, display: 'grid', gap: 8 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>

      {phase.at === 'pick' && (
        <>
          <span style={{ fontSize: 12.5 }}>
            {kind === 'model'
              ? 'Pick a GLB and it becomes this project’s 3D scene.'
              : 'Pick a DWG or DXF for an exact reconstruction, or a presentation PDF — the engine finds the plan pages and builds a massing model from your plan. 3 credits per build.'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              style={{ fontSize: 12 }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void picked(file)
              }}
            />
            <button className="icon-btn" onClick={onDismiss}>
              Not now
            </button>
          </div>
        </>
      )}

      {phase.at === 'uploading' && (
        <span style={{ fontSize: 12.5 }}>Uploading {phase.name}…</span>
      )}

      {phase.at === 'surveying' && (
        <span style={{ fontSize: 12.5 }}>
          Reading {phase.name} — finding the plan pages and their printed dimensions…
        </span>
      )}

      {phase.at === 'choose' && (
        <>
          <span style={{ fontSize: 12.5 }}>
            {phase.survey.plansFound} floor plan{phase.survey.plansFound === 1 ? '' : 's'} in{' '}
            {phase.survey.pages} pages. Pick the one this project is about.
          </span>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {phase.survey.sheets.map((sheet, i) => (
              <button
                key={`${sheet.page}.${sheet.index}`}
                className="choice"
                aria-pressed={i === phase.sheet}
                style={{
                  width: 168,
                  display: 'grid',
                  gap: 4,
                  outline: i === phase.sheet ? '2px solid var(--accent, #4a9eff)' : 'none',
                }}
                onClick={() => {
                  const anchor = Math.max(
                    0,
                    sheet.confirmDimensions.findIndex((d) => d.reliableAnchor),
                  )
                  setPhase({
                    ...phase,
                    sheet: i,
                    anchor,
                    metres: String(sheet.confirmDimensions[anchor]?.longSideMetres ?? ''),
                  })
                }}
              >
                {sheet.preview && (
                  <img
                    src={storedUrl(sheet.preview)}
                    alt={sheet.floor ?? sheet.stem}
                    style={{ width: '100%', borderRadius: 4 }}
                  />
                )}
                <span style={{ fontSize: 12 }}>
                  <strong>{sheet.floor ?? sheet.caption ?? sheet.stem}</strong>
                  <br />
                  <span className="muted">
                    page {sheet.page} · {sheet.rooms} room{sheet.rooms === 1 ? '' : 's'}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {(() => {
            const sheet = phase.survey.sheets[phase.sheet]
            const scale = chosenScale(phase)
            return (
              <div style={{ display: 'grid', gap: 6 }}>
                {sheet.confirmDimensions.length > 0 ? (
                  <>
                    <span style={{ fontSize: 12 }}>
                      Confirm one printed dimension so the model is the right size —
                      small enclosed rooms are the reliable anchors.
                    </span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select
                        value={phase.anchor}
                        style={{ fontSize: 12 }}
                        onChange={(e) => {
                          const anchor = Number(e.target.value)
                          setPhase({
                            ...phase,
                            anchor,
                            metres: String(
                              sheet.confirmDimensions[anchor]?.longSideMetres ?? '',
                            ),
                          })
                        }}
                      >
                        {sheet.confirmDimensions.map((dim, i) => (
                          <option key={i} value={i}>
                            {dim.room} — {dim.sizeMetres[0]} × {dim.sizeMetres[1]} m
                            {dim.reliableAnchor ? '' : ' (open region)'}
                          </option>
                        ))}
                      </select>
                      <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                        long side
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          value={phase.metres}
                          style={{ width: 80, fontSize: 12 }}
                          onChange={(e) => setPhase({ ...phase, metres: e.target.value })}
                        />
                        m
                      </label>
                      {scale && (
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          → {scale.toFixed(2)} m across the sheet
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <span style={{ fontSize: 12 }}>
                    {sheet.scale.trustworthy
                      ? `Scale read from the drawing: ${sheet.scale.metresPerUnit?.toFixed(2)} m across the sheet.`
                      : 'No printed dimensions were readable on this sheet — the model will build at the detector’s best guess, and its size should be treated as approximate.'}
                  </span>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={() => void build(phase)}>
                    Build this plan — 3 credits
                  </button>
                  <button className="icon-btn" onClick={onDismiss}>
                    Not now
                  </button>
                </div>
              </div>
            )
          })()}
        </>
      )}

      {phase.at === 'working' && (
        <>
          <span style={{ fontSize: 12.5 }}>
            Reconstructing — {phase.progress > 0 ? `${phase.progress}%` : 'reading the drawing'}.
            Charged {phase.charged} credit{phase.charged === 1 ? '' : 's'}.
          </span>
          <div>
            <button className="icon-btn" onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase.at === 'failed' && (
        <>
          <span style={{ fontSize: 12.5 }}>{phase.message}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="icon-btn" onClick={() => setPhase({ at: 'pick' })}>
              Try another file
            </button>
            <button className="icon-btn" onClick={onDismiss}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  )
}
