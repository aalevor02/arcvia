import { useEffect, useRef, useState } from 'react'
import { SceneViewer, WalkController } from '@arcvia/viewer'
import { buildPlanGeometry } from '../plan/buildGeometry'
import { suggestedCamera } from '../plan/buildGeometry'
import { activeFloor } from '../plan/planStore'
import { submitRender, pollRender, type RenderPreset } from '../lib/renderClient'
import { exportForBake, loadAndApply } from '../plan/bake'
import { uploadScene, updateScene, storedUrl } from '../lib/api'
import type { Plan } from '../plan/types'

interface Props {
  plan: Plan
  sceneId: string
}

const PRESETS: { id: RenderPreset; label: string; credits: number; note: string }[] = [
  { id: 'preview', label: 'Preview', credits: 1, note: '240px · 4 samples' },
  { id: 'isometric', label: 'Isometric', credits: 3, note: '1920×1080 · 32 samples' },
  { id: 'full', label: 'Full still', credits: 5, note: '2560×1440 · 128 samples' },
  { id: 'bake', label: 'Lightmap bake', credits: 25, note: 'Whole scene · minutes' },
]

/**
 * Milliseconds as "2m 14s".
 *
 * Rounded to whole seconds: this is shown next to a job that takes minutes, and
 * a figure flickering through tenths reads as instability rather than as
 * precision.
 */
function elapsed(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

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
  const walkRef = useRef<WalkController | null>(null)
  /**
   * Whether we are in first-person, readable from inside the rebuild effect.
   *
   * A ref rather than the state value, because putting `walking` in that
   * effect's dependency list makes entering the walkthrough rebuild the whole
   * model — which is wasted work, and fires onReady, which overwrites the
   * movement instructions with "Ready" the instant they appear.
   */
  const walkingRef = useRef(false)

  const [stats, setStats] = useState<{ triangles: number; objects: number } | null>(null)
  const [status, setStatus] = useState('Building from the plan…')
  const [exposure, setExposure] = useState(1)
  const [ceilings, setCeilings] = useState(false)
  const [walking, setWalking] = useState(false)
  const [finish, setFinish] = useState<'floor-wood' | 'floor-tile'>('floor-wood')
  const [job, setJob] = useState<{
    status: string
    progress: number
    elapsedMs?: number | null
    markers?: Record<string, string>
  } | null>(null)
  /**
   * Whether the model on screen is currently wearing a baked lightmap.
   *
   * Only ever true between a finished bake and the next edit: the rebuild
   * effect below throws the whole group away and generates a new one, which
   * takes the lightmap with it. That is the correct behaviour — a bake of the
   * old geometry lighting the new geometry would be worse than no bake — but
   * it has to be *said*, or it reads as the feature quietly not working.
   */
  const [baked, setBaked] = useState(false)

  useEffect(() => {
    if (!canvasRef.current) return

    const viewer = new SceneViewer({
      canvas: canvasRef.current,
      onReady: (info) => {
        setStats(info)
        setStatus(info.objects === 0 ? 'Nothing drawn yet' : 'Ready')
      },
      onError: (error) => setStatus(error.message),
      // Said out loud rather than swallowed. The picture visibly changes when
      // the viewer downgrades itself, and an unexplained change in how the
      // scene looks reads as a bug in whatever the user did last.
      onQualityDrop: (reason) => setStatus(reason),
    })
    viewerRef.current = viewer
    // A handle on the renderer from the console, in development only.
    // Lighting and post-processing are the two things that cannot be debugged
    // from the outside — "the corners are not dark enough" needs a way to flip
    // one pass to its raw output and look, and there is no other route in.
    if (import.meta.env.DEV) {
      ;(window as unknown as { viewer?: SceneViewer }).viewer = viewer
    }
    walkRef.current = new WalkController(viewer, canvasRef.current, {
      // 1.6 m is standing eye height. This one number is most of the difference
      // between "a 3D image of a room" and "being in the room" — an orbit
      // camera looking down into a roofless box reads as a model no matter how
      // well it is lit or textured.
      eyeHeight: 1.6,
      speed: 2.68,
    })

    return () => {
      walkRef.current?.dispose()
      walkRef.current = null
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // Rebuild whenever the plan changes. Cheap for a plan-sized model, and it
  // keeps the 3D view honest: there is no "regenerate" button to forget.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const group = buildPlanGeometry(plan.floors, { ceilings, floorFinish: finish })
    viewer.setModel(group)
    setBaked(false)

    // Framing the model fights the walk camera: it would yank the view back
    // outside the building on every edit.
    if (!walkingRef.current) viewer.frameModel()
  }, [plan, ceilings, finish])

  /**
   * Enter or leave first-person.
   *
   * Entering drops the camera into the largest room rather than wherever the
   * orbit camera happened to be — which is usually outside the building,
   * looking at it. Standing in a wall on the first frame is the fastest way to
   * make a walkthrough feel broken.
   */
  function toggleWalk() {
    const viewer = viewerRef.current
    const walk = walkRef.current
    if (!viewer || !walk) return

    if (walking) {
      walk.disable()
      walkingRef.current = false
      viewer.frameModel()
      setWalking(false)
      setStatus('Ready')
      return
    }

    const floor = activeFloor(plan)
    const start = suggestedCamera(floor)
    if (!start) {
      setStatus('Draw a room first — there is nowhere to stand.')
      return
    }

    viewer.cameraObject.position.set(start.position.x, start.height, -start.position.y)
    walk.setFloorLevel(floor.elevation)
    walk.enable()
    walkingRef.current = true
    setWalking(true)
    setStatus('Drag to look · W A S D to move · Shift to hurry')
  }

  /**
   * Bake the scene's lighting and wear the result.
   *
   * ── Why this is not just another preset ─────────────────────────────────
   * The other three presets send geometry away and get a *picture* back, which
   * the user looks at. This one sends geometry away and gets a *texture* back
   * that goes onto the model still on screen — so the round trip has to end
   * where it started, and the geometry that goes out has to be the exact
   * geometry that comes home. Hence exporting `viewer.modelRoot` rather than
   * rebuilding from the plan: a rebuild between export and apply would produce
   * a different object order, and the atlas would light the wrong surfaces.
   *
   * It is also slow — minutes, not seconds, and on a machine without a CUDA or
   * HIP device Cycles falls back to CPU and it is minutes per handful of
   * objects. Treated as a background job throughout: the button stays disabled,
   * progress is reported, and nothing blocks the viewport.
   */
  async function handleBake() {
    const viewer = viewerRef.current
    const model = viewer?.modelRoot
    if (!viewer || !model) return

    setJob({ status: 'exporting', progress: 0 })
    try {
      const { blob, grid, meshes } = await exportForBake(model)
      const megabytes = (blob.size / 1024 / 1024).toFixed(1)
      setStatus(`Uploading ${megabytes} MB — ${meshes} meshes in a ${grid}x${grid} atlas`)

      const stored = await uploadScene(blob)
      await updateScene(sceneId, { modelUrl: stored.url })

      const { jobId } = await submitRender({
        sceneId,
        preset: 'bake',
        camera: viewer.cameraSpec(),
        // The UVs went out with the geometry; the worker must bake into them
        // rather than unwrapping its own, or every surface lights with some
        // other surface's bake.
        prebakedUv: true,
      })

      setJob({ status: 'queued', progress: 0 })
      const result = await pollRender(jobId, (update) => setJob({ ...update }))

      if (result.status !== 'done' || !result.outputUrl) {
        setStatus(result.error ?? `Bake ${result.status}`)
        return
      }

      const applied = await loadAndApply(model, storedUrl(result.outputUrl))
      viewer.requestRender()
      setBaked(true)
      setStatus(`Baked lighting applied to ${applied} meshes`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Bake failed')
    } finally {
      setJob(null)
    }
  }

  async function handleRender(preset: RenderPreset) {
    if (preset === 'bake') return handleBake()

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
          <button
            className={walking ? 'btn btn-primary' : 'btn'}
            onClick={toggleWalk}
            disabled={empty}
            title={empty ? 'Draw a room first' : 'First-person view at eye height'}
          >
            {walking ? 'Leave walkthrough' : 'Walk through it'}
          </button>
          <button
            className="btn"
            onClick={() => viewerRef.current?.frameModel()}
            disabled={walking}
          >
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
          <span className="eyebrow">Floor finish</span>
          <div className="segmented">
            <button aria-pressed={finish === 'floor-wood'} onClick={() => setFinish('floor-wood')}>
              Timber
            </button>
            <button aria-pressed={finish === 'floor-tile'} onClick={() => setFinish('floor-tile')}>
              Tile
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11.5 }}>
            Whole-floor for now. Per-room finishes arrive with the material
            editor.
          </p>
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

          {job?.markers?.device === 'CPU' && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Rendering on the CPU — no CUDA or HIP device was found, so this
              will take minutes rather than seconds. You can keep working.
            </p>
          )}

          {baked && !job && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Baked lighting is on the model. Editing the plan rebuilds the
              geometry and clears it — bake again when the layout is settled.
            </p>
          )}

          {job && (
            <div style={{ marginTop: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {/*
                  A bake reports no progress at all — Blender's bake is one
                  atomic call that returns nothing until it is done. Showing
                  "0%" for six minutes reads as a hang, so when there is no
                  progress to report, report elapsed time instead. It is the
                  one number that is definitely moving.
                */}
                {job.progress > 0
                  ? `${job.status} · ${job.progress}%`
                  : `${job.status}${job.elapsedMs ? ` · ${elapsed(job.elapsedMs)}` : ''}`}
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
                    // A bar that cannot report progress sweeps instead of
                    // sitting at zero. Different animation, honest meaning:
                    // "running" rather than "nothing has happened yet".
                    width: job.progress > 0 ? `${job.progress}%` : '35%',
                    background: 'var(--accent)',
                    transition: 'width .3s',
                    animation: job.progress > 0 ? undefined : 'sweep 1.4s ease-in-out infinite',
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
