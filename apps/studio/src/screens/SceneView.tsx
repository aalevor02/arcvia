import { useEffect, useRef, useState } from 'react'
import { SceneViewer } from '@arcvia/viewer'
import { buildPlanGeometry } from '../plan/buildGeometry'
import { submitRender, pollRender, type RenderPreset } from '../lib/renderClient'
import type { Plan } from '../plan/types'

interface Props {
  plan: Plan
  sceneId: string
}

const PRESETS: { id: RenderPreset; label: string; credits: number; note: string }[] = [
  { id: 'preview', label: 'Preview', credits: 1, note: '240px · 4 samples' },
  { id: 'isometric', label: 'Isometric', credits: 3, note: '1920×1080 · 32 samples' },
  { id: 'full', label: 'Full still', credits: 5, note: '2560×1440 · 128 samples' },
  { id: 'bake', label: 'Lightmap bake', credits: 25, note: 'Whole scene · slow' },
]

/**
 * The 3D half of the editor.
 *
 * Everything here is generated from the plan — there is no import step and
 * nothing to save. That is the point of deriving geometry rather than storing
 * it: the 3D view cannot fall out of sync with the drawing, because it *is* the
 * drawing, rebuilt.
 */
export default function SceneView({ plan, sceneId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<SceneViewer | null>(null)

  const [stats, setStats] = useState<{ triangles: number; objects: number } | null>(null)
  const [status, setStatus] = useState('Building from the plan…')
  const [exposure, setExposure] = useState(1)
  const [ceilings, setCeilings] = useState(false)
  const [job, setJob] = useState<{ status: string; progress: number } | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    const viewer = new SceneViewer({
      canvas: canvasRef.current,
      onReady: (info) => {
        setStats(info)
        setStatus(info.objects === 0 ? 'Nothing drawn yet' : 'Ready')
      },
      onError: (error) => setStatus(error.message),
    })
    viewerRef.current = viewer

    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild whenever the plan changes. Cheap for a plan-sized model, and it
  // keeps the 3D view honest: there is no "regenerate" button to forget.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const group = buildPlanGeometry(plan.floors, { ceilings })
    viewer.setModel(group)
    viewer.frameModel()
  }, [plan, ceilings])

  async function handleRender(preset: RenderPreset) {
    const viewer = viewerRef.current
    if (!viewer) return

    setStatus(`Submitting ${preset}…`)
    try {
      const { jobId } = await submitRender({
        sceneId,
        preset,
        camera: viewer.cameraSpec(),
      })
      setJob({ status: 'queued', progress: 0 })

      // Poll rather than hold a socket open. A bake can take minutes, and a
      // dropped websocket mid-render is a worse failure than a missed poll.
      const result = await pollRender(jobId, (update) =>
        setJob({ status: update.status, progress: update.progress }),
      )
      setStatus(result.status === 'done' ? 'Render complete' : `Render ${result.status}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Render failed')
    } finally {
      setJob(null)
    }
  }

  const empty = !stats || stats.objects === 0

  return (
    <div className="editor-body" style={{ gridTemplateColumns: '1fr 260px' }}>
      <div className="stage">
        <canvas ref={canvasRef} />
        <p className="hint">{status}</p>
        <div className="stage-actions">
          <button className="btn" onClick={() => viewerRef.current?.frameModel()}>
            Fit
          </button>
        </div>
      </div>

      <aside className="panel panel-right">
        <section>
          <span className="eyebrow">Model</span>
          {empty ? (
            <p className="muted" style={{ fontSize: 12.5 }}>
              Draw some walls in the 2D view and they will appear here
              immediately — the 3D model is generated from the plan, so there is
              nothing to import or regenerate.
            </p>
          ) : (
            <>
              <div className="stat">
                <span className="muted">Objects</span>
                <span className="mono">{stats.objects.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="muted">Triangles</span>
                <span className="mono">{stats.triangles.toLocaleString()}</span>
              </div>
            </>
          )}
        </section>

        <section>
          <span className="eyebrow">Display</span>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
          >
            <input
              type="checkbox"
              checked={ceilings}
              onChange={(e) => setCeilings(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Show ceilings
          </label>
          <p className="muted" style={{ fontSize: 11.5 }}>
            Off by default — a ceiling hides the room from an orbiting camera.
          </p>
        </section>

        <section>
          <span className="eyebrow">
            Exposure <span className="mono">{exposure.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min="0.1"
            max="3"
            step="0.05"
            value={exposure}
            onChange={(e) => {
              const value = Number(e.target.value)
              setExposure(value)
              viewerRef.current?.setExposure(value)
            }}
          />
        </section>

        <section>
          <span className="eyebrow">Render</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="btn"
              style={{ justifyContent: 'space-between' }}
              onClick={() => void handleRender(preset.id)}
              disabled={Boolean(job) || empty}
              title={empty ? 'Draw a plan first' : preset.note}
            >
              <span style={{ textAlign: 'left' }}>
                <strong style={{ display: 'block', fontSize: 12.5 }}>
                  {preset.label}
                </strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  {preset.note}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                {preset.credits}cr
              </span>
            </button>
          ))}

          {job && (
            <div style={{ marginTop: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {job.status} · {job.progress}%
              </span>
              <div
                style={{
                  height: 4,
                  borderRadius: 999,
                  background: 'var(--line)',
                  overflow: 'hidden',
                  marginTop: 6,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${job.progress}%`,
                    background: 'var(--accent)',
                    transition: 'width .3s',
                  }}
                />
              </div>
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}
