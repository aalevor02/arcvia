import { useEffect, useRef, useState } from 'react'

import {
  cadJob,
  cancelCadJob,
  submitCadJob,
  uploadFloorplan,
  uploadScene,
  type CadSummary,
} from '../lib/api'

interface Props {
  /** Which door the user came in through. */
  kind: 'model' | 'cad'
  /** Called with the stored model path once there is a model to show. */
  onLanded(modelUrl: string, summary: CadSummary | null): void
  onDismiss(): void
}

type Phase =
  | { at: 'pick' }
  | { at: 'uploading'; name: string }
  | { at: 'working'; jobId: string; progress: number; charged: number }
  | { at: 'failed'; message: string; refunded: boolean }

/**
 * The import step the two upload starts were missing.
 *
 * Both starts already created a real project and then apologised — a notice
 * saying the import was "not wired up yet". This is the wiring.
 *
 * `model` is one hop: the GLB goes to storage and its path onto the scene.
 * `cad` is the front door to the reconstruction engine: the drawing uploads,
 * a job runs (tens of seconds, 3 credits), and what lands is not just a model
 * but the engine's own account of it — rooms, walls, openings, the unit it
 * settled on — because a reviewer accepts an import on facts, not on a
 * spinner reaching 100%.
 *
 * Failures show the engine's message verbatim. It writes refusals for people
 * ("the drawing did not reconstruct", with the blocking checks named), and a
 * paraphrase would only lose information.
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

  async function picked(file: File) {
    setPhase({ at: 'uploading', name: file.name })
    try {
      if (kind === 'model') {
        const stored = await uploadScene(file)
        onLanded(stored.url, null)
        return
      }

      const stored = await uploadFloorplan(file)
      const submitted = await submitCadJob(stored.key)
      setPhase({
        at: 'working',
        jobId: submitted.jobId,
        progress: 0,
        charged: submitted.creditsCharged,
      })
      jobRef.current = submitted.jobId

      pollRef.current = setInterval(async () => {
        try {
          const job = await cadJob(submitted.jobId)
          if (job.status === 'done' && job.outputUrl) {
            if (pollRef.current) clearInterval(pollRef.current)
            onLanded(job.outputUrl, job.summary)
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
    } catch (error) {
      setPhase({
        at: 'failed',
        message: error instanceof Error ? error.message : 'The upload failed.',
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

  const accept = kind === 'model' ? '.glb' : '.dwg,.dxf'
  const title = kind === 'model' ? 'Load a 3D model' : 'Reconstruct from CAD'

  return (
    <div className="alert" style={{ margin: 12, display: 'grid', gap: 8 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>

      {phase.at === 'pick' && (
        <>
          <span style={{ fontSize: 12.5 }}>
            {kind === 'model'
              ? 'Pick a GLB and it becomes this project’s 3D scene.'
              : 'Pick a DWG or DXF. The engine builds the walls, rooms and a walkable model — about a minute, 3 credits.'}
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
