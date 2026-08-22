import { useEffect, useRef, useState } from 'react'
import { SceneViewer, WalkController } from '@arcvia/viewer'
import { buildPlanGeometry } from '../plan/buildGeometry'
import { suggestedCamera } from '../plan/buildGeometry'
import { activeFloor } from '../plan/planStore'
import { usedSurfaces } from '../plan/materials'
import { submitRender, pollRender, type RenderPreset } from '../lib/renderClient'
import { exportForBake, loadAndApply } from '../plan/bake'
import {
  uploadScene,
  updateScene,
  storedUrl,
  publishScene,
  siteOrigin,
  getScene,
  uploadCapture,
  renderStyles,
} from '../lib/api'
import { upgradeModels, modelsSettled } from '../catalogue/models'
import { upgradeSurfaces } from '../catalogue/surfaceUpgrade'
import { creditsFor } from '../catalogue/credits'
import { exportGlb, downloadBlob, filenameFor } from '../plan/exportGlb'
import PresentationPanel, { hotspotAt } from '../components/PresentationPanel'
import EnvironmentPanel from '../components/EnvironmentPanel'
import OptionsPanel from '../components/OptionsPanel'
import CommentsPanel from '../components/CommentsPanel'
import type { SceneOptions } from '../publish/options'
import { upsertHotspot, type Presentation } from '../plan/presentation'
import { setAccessCode } from '../lib/api'
import { FLOOR_FINISHES, type FloorFinish, type Plan } from '../plan/types'

interface Props {
  plan: Plan
  sceneId: string
  /** Used to name an exported file. Optional so the 3D view still renders
   *  while the scene record is still loading. */
  sceneName?: string
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
export default function SceneView({ plan, sceneId, sceneName }: Props) {
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
  /**
   * The project default, used by every room that has not been given its own.
   *
   * Rooms carry their own finish on the floor (`Floor.roomFinishes`), so this
   * is no longer "the floor finish" — it is the fallback, and changing it still
   * reaches every room nobody has specified.
   */
  const [finish, setFinish] = useState<FloorFinish>('floor-wood')
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
  /** The public link, once this scene has been published. */
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<Presentation>({
    views: [],
    hotspots: [],
    branding: null,
  })
  const [placing, setPlacing] = useState(false)
  /**
   * The scene's `hdriUrl`. Null means none has ever been chosen, which renders
   * against the worker's own default sky rather than failing.
   */
  const [environment, setEnvironment] = useState<string | null>(null)
  /** Client options for the published page, loaded with the scene. */
  const [options, setOptions] = useState<SceneOptions | null>(null)
  /** Walking pace, metres per second. */
  const [pace, setPace] = useState(4.5)
  /** Whether a code gates the published link, and the box for changing it. */
  const [gated, setGated] = useState(false)
  const [code, setCode] = useState('')
  const [styles, setStyles] = useState<{ id: string; name: string }[]>([])
  const [style, setStyle] = useState('daylight')
  /** The last photoreal render, shown beside the viewport. */
  const [aiImage, setAiImage] = useState<string | null>(null)

  // Styles come from the server so there is one definition of what the
  // renderer will accept, rather than a copy here that can drift out of step.
  useEffect(() => {
    void renderStyles()
      .then(setStyles)
      .catch(() => setStyles([]))
  }, [])

  // Load the presentation the scene already has. Separate from the plan
  // because it is edited independently and far more often — a scene is lit
  // once and re-presented per client.
  useEffect(() => {
    let cancelled = false
    void getScene(sceneId)
      .then((scene) => {
        if (cancelled) return
        setPresentation({
          views: scene.views ?? [],
          hotspots: scene.hotspots ?? [],
          branding: scene.branding ?? null,
        })
        setGated(Boolean(scene.protected))
        setEnvironment(scene.hdriUrl ?? null)
        setOptions(scene.options ?? null)
      })
      .catch(() => {
        /* a scene that will not load is already reported by the editor */
      })
    return () => {
      cancelled = true
    }
  }, [sceneId])

  /** Persist, and keep the panel responsive by not awaiting the write. */
  function updateEnvironment(url: string | null) {
    setEnvironment(url)
    void updateScene(sceneId, { hdriUrl: url }).catch(() =>
      setStatus('That change could not be saved. Check your connection.'),
    )
  }

  /**
   * Persist the client options. Awaited, unlike the others: the textures were
   * just uploaded and the save is the whole point of the button.
   */
  async function updateOptions(next: SceneOptions | null) {
    setOptions(next)
    await updateScene(sceneId, { options: next ?? undefined })
  }

  /** Persist, and keep the panel responsive by not awaiting the write. */
  function updatePresentation(next: Presentation) {
    setPresentation(next)
    void updateScene(sceneId, next).catch(() =>
      setStatus('That change could not be saved. Check your connection.'),
    )
  }

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

  /**
   * Show the scene's chosen environment in the editor, not only in renders.
   *
   * ── Why this is its own effect, declared here ───────────────────────────
   * `viewerRef` is a ref, so nothing re-runs when the viewer appears. This
   * effect therefore has to be declared AFTER the one that builds it: React
   * runs effects in declaration order, so by the time this first fires the
   * viewer exists.
   *
   * Applying it inside the scene load instead would depend on the same
   * ordering while looking like it did not — that effect is declared *before*
   * the viewer is created, and only works because `getScene` is a network
   * round trip that resolves long after mount. That is not a reason, it is a
   * race that has not yet been lost. The first version of this was written
   * that way.
   */
  useEffect(() => {
    if (!environment) return
    void viewerRef.current?.loadEnvironment(environment)
  }, [environment])

  // Rebuild whenever the plan changes. Cheap for a plan-sized model, and it
  // keeps the 3D view honest: there is no "regenerate" button to forget.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const group = buildPlanGeometry(plan.floors, { ceilings, floorFinish: finish })
    viewer.setModel(group)
    // New geometry, so the old atlas no longer describes it. Hand lighting
    // back to the real-time rig, or the fresh model renders unlit.
    viewer.setBakedLighting(false)
    setBaked(false)

    // Real furniture arrives afterwards, one model at a time, redrawing as
    // each lands. Not awaited: this effect runs on every wall drag, and a room
    // that will not update until a dozen GLBs have downloaded is a room that
    // feels broken while you are drawing it.
    void upgradeModels(group, () => viewer.requestRender()).then((upgraded) => {
      if (upgraded > 0) setStatus(`${upgraded} object${upgraded === 1 ? '' : 's'} using real models`)
    })

    // Photographed surfaces arrive the same way. Cheaper than the models — the
    // materials are shared per kind, so this is eight downloads however large
    // the plan is, and it resolves once for the session however often this
    // effect re-runs.
    void upgradeSurfaces(() => viewer.requestRender())

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
      // Back to the framing that suits looking at a building from outside.
      viewer.setFieldOfView(50)
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
    // Wider inside than out. At 50 degrees a small room fills the screen with
    // one wall and a doorway two metres away is off-frame, which is what makes
    // moving around feel cramped rather than slow.
    viewer.setFieldOfView(72)
    walk.setSpeed(pace)
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
      // Wait for furniture before exporting anything.
      //
      // The bake captures the scene as it stands. Export while models are
      // still downloading and the atlas describes the stand-ins, then gets
      // applied to the real furniture that arrives afterwards — geometry from
      // one room lit by another, which renders perfectly and is baffling.
      setStatus('Waiting for models to finish loading…')
      await modelsSettled()

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

      // Recorded on the scene, not just applied to the screen. A published
      // walkthrough cannot reach render-job records, and the atlas *is* the
      // lighting — without it a client opens the flat, sourceless room the
      // bake exists to fix.
      await updateScene(sceneId, { bakedUrl: result.outputUrl })

      const applied = await loadAndApply(model, storedUrl(result.outputUrl))
      // The atlas already contains the sun, the sky, the bounce and the
      // occlusion. Leaving the real-time rig on top of it does not add to the
      // bake, it cancels it — see setBakedLighting.
      viewer.setBakedLighting(true)
      viewer.requestRender()
      setBaked(true)
      setStatus(`Baked lighting applied to ${applied} meshes`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Bake failed')
    } finally {
      setJob(null)
    }
  }

  /**
   * Export the whole building as a GLB.
   *
   * For any tool that imports glTF and does its own baking — Shapespark and
   * the like. Those are destinations rather than rivals: the plan is still
   * drawn here, the dimensions are still real, the catalogue is still the
   * catalogue, and only the final render moves elsewhere. A studio that
   * already pays for one of them should be able to draw in Arcvia and publish
   * through the renderer they own.
   *
   * Ceilings are forced on regardless of the display toggle. That switch
   * exists so an orbiting camera can see into the room while you work; a
   * receiving tool bakes what it is given, and a building with no ceilings
   * bakes as one lit from directly above through an open roof.
   */
  async function handleExport() {
    const viewer = viewerRef.current
    if (!viewer) return

    setStatus('Preparing the export…')
    try {
      await modelsSettled()

      const complete = buildPlanGeometry(plan.floors, {
        ceilings: true,
        floorFinish: finish,
      })
      await upgradeModels(complete)

      const { blob, meshes, triangles } = await exportGlb(complete)
      downloadBlob(blob, filenameFor(sceneName ?? sceneId))

      setStatus(
        `Exported ${meshes} meshes, ${triangles.toLocaleString()} triangles — ` +
          `${(blob.size / 1024 / 1024).toFixed(1)} MB`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed')
    }
  }

  /**
   * Publish the scene and show the link.
   *
   * Publishing an unbaked scene is allowed, and deliberately so — a client
   * looking at flat lighting is still better than a client waiting half an
   * hour. But it is said out loud, because "I published it and it looks
   * nothing like the preview" is the obvious way for this to go wrong.
   */
  async function handlePublish() {
    setStatus('Publishing…')
    try {
      // ── Attribution, written before the page becomes public ─────────────
      // The published viewer already renders a credit list from
      // `scene.credits` — a toggle, author links to source, licence per line.
      // Nothing ever wrote that field, so every walkthrough this product has
      // published showed no credits at all, while 35 of the 38 catalogue
      // models are CC-BY or CC-BY-SA and require attribution.
      //
      // Derived here rather than in the API because only the studio knows what
      // the client will see: which models were placed, which environment was
      // chosen, and which surfaces the geometry actually bound. Written before
      // `publishScene` so a page is never public without them.
      // Switchable objects ship their models to the page whether or not a
      // visitor ever picks them, so their authors are owed exactly as if the
      // items had been placed. Synthetic placements reuse the one credit
      // derivation instead of growing a second that can drift from it.
      const variantPlacements = (options?.objects?.groups ?? []).flatMap((group) =>
        group.choices
          .filter((choice) => choice.id !== 'original')
          .map((choice, index) => ({
            id: `variant-${group.objectId}-${index}`,
            item: choice.id,
            position: { x: 0, y: 0 },
            rotation: 0,
          })),
      )

      const credits = creditsFor(
        [
          ...plan.floors.flatMap((floor) => Object.values(floor.objects)),
          ...variantPlacements,
        ],
        {
          environmentUrl: environment,
          // Offered finishes ride along with the used ones: a finish a visitor
          // can switch TO is shipped to the page whether or not any room wears
          // it at publish time, and its author is owed either way.
          surfaces: [
            ...usedSurfaces(),
            ...(options?.flooring?.choices.map((choice) => choice.id) ?? []),
          ],
        },
      )
      try {
        await updateScene(sceneId, { credits })
      } catch (error) {
        // Deliberately fatal: publishing without credits is the licence breach
        // this exists to prevent, so a page that cannot carry them must not go
        // public. But say WHY — the likely cause is an API older than the
        // commit that added `credits` to the scenes allow-list, and that route
        // rejects unknown fields, so the raw message is about a field name and
        // reads like a client bug.
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Could not save attribution, so the scene was not published: ${detail} ` +
            '(if the API predates the credits change, restart it.)',
        )
      }

      const { url } = await publishScene(sceneId)
      const absolute = new URL(url, siteOrigin()).toString()
      setShareUrl(absolute)
      setStatus(
        baked
          ? 'Published — the link is below.'
          : 'Published. This scene has no bake yet, so it will look flatter than a baked one.',
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not publish')
    }
  }

  /**
   * Photograph the current view.
   *
   * ── Why the capture is the input ────────────────────────────────────────
   * The viewport image already encodes the camera, the layout, the openings
   * and the furniture. Handing an image model the picture and telling it to
   * change only the realism is the one arrangement that keeps the result
   * *this* property — describing the room in a prompt instead lets the model
   * invent, and a flat with an invented window is not the flat.
   *
   * It is also the thing an AI renderer on its own cannot do. Every capture
   * comes from one dimensionally correct scene, so two views of the same
   * kitchen agree; a diffusion model asked twice produces two kitchens.
   */
  async function handleAiRender() {
    const viewer = viewerRef.current
    if (!viewer) return

    setJob({ status: 'capturing', progress: 0 })
    try {
      setStatus('Capturing the view…')
      // Full width: the capture is the structure the model has to preserve,
      // and detail thrown away here cannot be recovered by the model.
      const capture = viewer.snapshot({ width: 1536, type: 'image/png' })
      const stored = await uploadCapture(capture)

      const { jobId } = await submitRender({
        sceneId,
        preset: 'ai',
        camera: viewer.cameraSpec(),
        captureUrl: stored.url,
        style,
      })

      setJob({ status: 'queued', progress: 0 })
      const result = await pollRender(jobId, (update) => setJob({ ...update }))

      if (result.status !== 'done' || !result.outputUrl) {
        setStatus(result.error ?? `Photoreal render ${result.status}`)
        return
      }

      setAiImage(storedUrl(result.outputUrl))
      setStatus('Photoreal render ready.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Photoreal render failed')
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
        <canvas
          ref={canvasRef}
          style={placing ? { cursor: 'crosshair' } : undefined}
          onPointerDown={(event) => {
            if (!placing) return
            const point = viewerRef.current?.pick(event.clientX, event.clientY)
            if (!point) {
              setStatus('That missed the model — click a wall, floor or object.')
              return
            }
            updatePresentation({
              ...presentation,
              hotspots: upsertHotspot(presentation.hotspots, hotspotAt(point, presentation.hotspots)),
            })
            // One click, one hotspot. Staying in placing mode after a
            // successful drop makes it far too easy to litter the model while
            // trying to orbit.
            setPlacing(false)
          }}
        />
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
          <span className="eyebrow">Default floor finish</span>
          <p className="note" style={{ marginBottom: 6 }}>
            Used by rooms with no finish of their own. Set one per room in the plan.
          </p>
          <div className="segmented">
            {FLOOR_FINISHES.map((option) => (
              <button
                key={option.id}
                aria-pressed={finish === option.id}
                onClick={() => setFinish(option.id)}
              >
                {option.name}
              </button>
            ))}
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

        <EnvironmentPanel
          viewer={viewerRef.current}
          value={environment}
          onChange={updateEnvironment}
        />

        <OptionsPanel plan={plan} value={options} onSave={updateOptions} />

        <CommentsPanel sceneId={sceneId} />

        <PresentationPanel
          viewer={viewerRef.current}
          presentation={presentation}
          onChange={updatePresentation}
          placing={placing}
          onPlacingChange={setPlacing}
        />

        <section>
          <span className="eyebrow">Walkthrough</span>
          <label style={{ fontSize: 11.5 }}>
            Walking pace <span className="mono">{pace.toFixed(1)} m/s</span>
            <input
              type="range"
              min="1.5"
              max="9"
              step="0.5"
              value={pace}
              onChange={(e) => {
                const next = Number(e.target.value)
                setPace(next)
                walkRef.current?.setSpeed(next)
              }}
            />
          </label>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
            A real walk is 2.7 m/s and feels slow indoors — a room is crossed in
            two seconds, so most of the time goes on stopping and turning. Hold
            shift to move faster still.
          </p>
        </section>

        <section>
          <span className="eyebrow">Photoreal</span>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
            Photographs the view you are looking at. The layout is kept exactly —
            only the lighting and materials are made real.
          </p>

          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            style={{ width: '100%', fontSize: 12 }}
          >
            {styles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>

          <button
            className="btn"
            style={{ width: '100%', marginTop: 6, justifyContent: 'space-between' }}
            onClick={() => void handleAiRender()}
            disabled={Boolean(job) || empty || styles.length === 0}
            title={
              styles.length === 0
                ? 'No image provider is configured on the server'
                : 'Render this view photorealistically'
            }
          >
            <span style={{ textAlign: 'left' }}>
              <strong style={{ display: 'block', fontSize: 12.5 }}>Photograph this view</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                Seconds, not minutes
              </span>
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
              5cr
            </span>
          </button>

          {aiImage && (
            <a href={aiImage} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 8 }}>
              <img
                src={aiImage}
                alt="Photoreal render of the current view"
                style={{ width: '100%', borderRadius: 6, display: 'block' }}
              />
              <span className="muted" style={{ fontSize: 11 }}>Open full size</span>
            </a>
          )}
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

          <button
            className="btn btn-primary"
            style={{ justifyContent: 'space-between', marginTop: 8 }}
            onClick={() => void handlePublish()}
            disabled={Boolean(job) || empty}
            title="Put this walkthrough on a link you can send to a client"
          >
            <span style={{ textAlign: 'left' }}>
              <strong style={{ display: 'block', fontSize: 12.5 }}>Publish</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                A link for the client
              </span>
            </span>
          </button>

          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {gated ? 'Access code is set' : 'Access code (optional)'}
            </label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                type="password"
                value={code}
                placeholder={gated ? '••••••••' : 'Leave empty for an open link'}
                onChange={(e) => setCode(e.target.value)}
                style={{ flex: 1, fontSize: 11.5 }}
              />
              <button
                className="btn btn-tiny"
                onClick={() => {
                  void setAccessCode(sceneId, code)
                    .then((result) => {
                      setGated(result.protected)
                      setCode('')
                      setStatus(
                        result.protected
                          ? 'Access code set — the link now asks for it.'
                          : 'Access code removed — the link is open.',
                      )
                    })
                    .catch((error) =>
                      setStatus(error instanceof Error ? error.message : 'Could not save the code'),
                    )
                }}
              >
                {code ? 'Set' : 'Clear'}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Gates the link, not the files behind it — enough to stop a
              forwarded link being opened, not encryption.
            </p>
          </div>

          {shareUrl && (
            <div style={{ marginTop: 8 }}>
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                style={{ width: '100%', fontSize: 11, fontFamily: 'var(--mono, monospace)' }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                  className="btn"
                  style={{ flex: 1, fontSize: 11 }}
                  onClick={() => void navigator.clipboard?.writeText(shareUrl)}
                >
                  Copy link
                </button>
                <a
                  className="btn"
                  style={{ flex: 1, fontSize: 11, textAlign: 'center' }}
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </a>
              </div>
            </div>
          )}

          <button
            className="btn"
            style={{ justifyContent: 'space-between', marginTop: 8 }}
            onClick={() => void handleExport()}
            disabled={Boolean(job) || empty}
            title="A .glb of the whole building, for Shapespark or any tool that imports glTF"
          >
            <span style={{ textAlign: 'left' }}>
              <strong style={{ display: 'block', fontSize: 12.5 }}>Export .glb</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                Whole building · ceilings included
              </span>
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              free
            </span>
          </button>

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
