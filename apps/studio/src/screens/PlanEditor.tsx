import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PlanCanvas,
  type Selection,
  type Tool,
  type ViewState,
} from '../plan/PlanCanvas'
import {
  activeFloor,
  addFloor,
  addWall,
  commit,
  duplicateFloor,
  emptyPlan,
  initialHistory,
  loadPlan,
  moveVertex,
  nameRoom,
  redo,
  removeFloor,
  removeWall,
  setActiveFloor,
  addObject,
  updateObject,
  removeObject,
  setUnderlay,
  placeUnderlay,
  calibrateUnderlay,
  rescaleUnderlay,
  undo,
  updateAllWalls,
  type History,
} from '../plan/planStore'
import { detectRooms, displayName, totalArea } from '../plan/rooms'
import { WALL_DEFAULTS, type Plan, type Underlay, type Vec2 } from '../plan/types'
import { formatArea, formatLength, parseLength, type UnitSystem } from '../lib/format'
import { detectFloorplan, getScene, updateScene, type Scene } from '../lib/api'
import { assessDetection } from '../plan/detectionQuality'
import { proposeFurniture, type Proposal } from '../plan/furnish'
import {
  convertDetections,
  type DetectedRoom,
  type DetectedScale,
  type ProposedWall,
} from '../plan/detections'
import SceneView from './SceneView'
import { UnderlayPanel } from '../components/UnderlayPanel'
import { CalibrateDialog } from '../components/CalibrateDialog'
import { ProposalReview } from '../components/ProposalReview'
import { FurnitureReview } from '../components/FurnitureReview'
import { CataloguePanel } from '../components/CataloguePanel'
import { ObjectInspector } from '../components/ObjectInspector'
import type { PlacedObject } from '../catalogue/types'

interface Props {
  sceneId: string
  /**
   * How the project was started, from the create dialog. Selects the editor's
   * opening state — it is not a mode, and nothing later in the session depends
   * on it.
   */
  start?: string
  onBack(): void
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** Quiet period after the last edit before the plan is written back. */
const AUTOSAVE_DELAY_MS = 1500

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'select', label: 'Select', icon: '↖', key: '1' },
  { id: 'wall', label: 'Wall', icon: '▤', key: '2' },
  { id: 'delete', label: 'Delete', icon: '⌫', key: '3' },
  { id: 'measure', label: 'Measure', icon: '⟷', key: '4' },
  { id: 'calibrate', label: 'Set scale', icon: '⇹', key: '5' },
  { id: 'place', label: 'Place', icon: '⌸', key: '6' },
]

export default function PlanEditor({ sceneId, start, onBack }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRef = useRef<PlanCanvas | null>(null)
  /** Pan and zoom, held across the canvas being torn down and rebuilt. */
  const viewRef = useRef<ViewState | null>(null)
  /**
   * The current tool and unit system, readable from the canvas callback.
   *
   * The callback ref is created once, so anything it reads from the render
   * scope is frozen at first render. These keep it honest.
   */
  const toolRef = useRef<Tool>('select')
  const unitsRef = useRef<UnitSystem>('imperial')

  const [scene, setScene] = useState<Scene | null>(null)
  const [history, setHistory] = useState<History>(() => initialHistory(emptyPlan()))
  // 'draw' opens on the wall tool ready to trace; the import starts open on
  // Select, because the first thing to do there is bring something in rather
  // than draw over an empty grid.
  const [tool, setTool] = useState<Tool>(start === 'draw' || !start ? 'wall' : 'select')
  const [units, setUnits] = useState<UnitSystem>('imperial')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [hint, setHint] = useState('Click to start a wall.')
  const [save, setSave] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(true)
  const [mode, setMode] = useState<'2d' | '3d'>('2d')
  /** Two picked points awaiting a real-world length. */
  const [calibration, setCalibration] = useState<{ from: Vec2; to: Vec2 } | null>(null)
  /** Detector output awaiting acceptance. Never written into the plan directly. */
  const [proposal, setProposal] = useState<ProposedWall[] | null>(null)
  // What the reader made of the drawing beyond its walls: the rooms it closed,
  // their names, and the scale it read off the printed dimensions. Kept beside
  // the proposal because it is reviewed with it and discarded with it.
  /**
   * Furniture read off the drawing, waiting to be accepted.
   *
   * Separate from the wall proposal because the two are accepted at different
   * moments: walls first, since everything else depends on them, and furniture
   * once the plan itself looks right.
   */
  const [furniture, setFurniture] = useState<Proposal[] | null>(null)

  const [reading, setReading] = useState<{
    rooms: DetectedRoom[]
    scale: DetectedScale | null
    scaleApplied: boolean
  } | null>(null)
  const [detecting, setDetecting] = useState(false)
  /** Catalogue item armed for placing. */
  const [placing, setPlacing] = useState<string | null>(null)

  const plan = history.present

  /**
   * The canvas is imperative and long-lived; React state changes every render.
   * Callbacks handed to it therefore read the *current* plan through a ref
   * rather than closing over one — otherwise every wall drawn after the first
   * is applied to the plan as it was when the canvas was constructed, and the
   * drawing silently loses everything but the last stroke.
   */
  const planRef = useRef(plan)
  planRef.current = plan

  // ---- Load ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    getScene(sceneId)
      .then((loaded) => {
        if (cancelled) return
        setScene(loaded)
        setHistory(initialHistory(loadPlan(loaded.plan)))
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Could not open this project.'),
      )
    return () => {
      cancelled = true
    }
  }, [sceneId])

  // ---- Edits ---------------------------------------------------------------
  // `apply` records history; `applyLive` does not, and is used for the frames
  // of a drag so the undo stack gets one entry per gesture rather than sixty.
  const apply = useCallback((fn: (plan: Plan) => Plan) => {
    setHistory((h) => commit(h, fn(h.present)))
    setSave('dirty')
  }, [])

  const applyLive = useCallback((fn: (plan: Plan) => Plan) => {
    setHistory((h) => ({ ...h, present: fn(h.present) }))
    setSave('dirty')
  }, [])

  // ---- Canvas lifecycle ----------------------------------------------------
  /**
   * Bind the renderer to whichever canvas element is currently on screen.
   *
   * ── Why a callback ref and not a mount-once effect ──────────────────────────
   * This was `useEffect(..., [])` with a comment saying the canvas is created
   * once and kept in sync afterwards. That was true until the 3D view arrived.
   * The 2D editor — and the `<canvas>` inside it — unmounts while 3D is shown,
   * so coming back React mounts a *brand new* element while the renderer still
   * holds the old, detached one. Everything kept working except the part you
   * could see: walls updated, rooms recomputed, the panel showed the right area,
   * and the canvas sat blank, because every frame was being drawn into an
   * element no longer in the document.
   *
   * A callback ref cannot drift like that. React calls it with the element when
   * one attaches and with null when it goes, so the renderer is rebuilt exactly
   * when the thing it draws into is replaced — for this remount and any future
   * one.
   */
  const attachCanvas = useCallback((element: HTMLCanvasElement | null) => {
    if (!element) {
      // Carry the framing over to the next canvas. Losing your zoom every time
      // you glance at the 3D view is a small thing that happens constantly.
      viewRef.current = viewerRef.current?.getView() ?? viewRef.current
      viewerRef.current?.dispose()
      viewerRef.current = null
      canvasRef.current = null
      return
    }

    canvasRef.current = element

    const canvas = new PlanCanvas(element, planRef.current, {
      onDrawWall: (from, to) =>
        apply((p) =>
          addWall(p, from, to, {
            // A floor with no walls yet is being given its outline, so the
            // first strokes default to external thickness. Everything after
            // that is a partition until told otherwise.
            ...(Object.keys(activeFloor(p).walls).length === 0
              ? WALL_DEFAULTS.exterior
              : WALL_DEFAULTS.interior),
            snapRadius: 0.25,
          }),
        ),
      onDeleteWall: (id) => apply((p) => removeWall(p, id)),
      onMoveVertex: (id, to) => applyLive((p) => moveVertex(p, id, to)),
      onCommit: () => setHistory((h) => commit(h, h.present)),
      onCalibrate: (from, to) => setCalibration({ from, to }),
      onPlaceObject: (itemId, at, rotation, wallId) =>
        apply((p) => addObject(p, { item: itemId, position: at, rotation, wallId })),
      onMoveObject: (objectId, to, rotation, wallId) =>
        // Live, uncommitted: a drag produces one history entry on release.
        applyLive((p) => updateObject(p, objectId, { position: to, rotation, wallId })),
      onSelect: setSelection,
      onHint: setHint,
    })

    viewerRef.current = canvas
    canvas.setPlan(planRef.current)
    canvas.setTool(toolRef.current)
    canvas.setUnits(unitsRef.current)
    if (viewRef.current) canvas.setView(viewRef.current)
    // Read through refs, not through the values captured when this callback was
    // created: a stale closure here would silently reset the tool and units to
    // whatever they were on first render, which is the same class of bug as the
    // one above and just as quiet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => viewerRef.current?.setPlan(plan), [plan])
  useEffect(() => {
    toolRef.current = tool
    viewerRef.current?.setTool(tool)
  }, [tool])
  useEffect(() => {
    unitsRef.current = units
    viewerRef.current?.setUnits(units)
  }, [units])
  useEffect(() => viewerRef.current?.setSelection(selection), [selection])
  useEffect(() => viewerRef.current?.setProposal(proposal ?? []), [proposal])
  useEffect(() => {
    viewerRef.current?.setPlacing(placing)
    // Arming an item switches to the place tool; disarming returns to Select so
    // the next click does something sensible rather than nothing.
    if (placing) setTool('place')
    else if (tool === 'place') setTool('select')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing])

  // ---- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal keys from a field: "2" in the room-name box must type a 2,
      // not switch to the wall tool.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        setHistory(event.shiftKey ? redo : undo)
        setSave('dirty')
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        setHistory(redo)
        setSave('dirty')
        return
      }

      const match = TOOLS.find((t) => t.key === event.key)
      if (match) setTool(match.id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- Autosave ------------------------------------------------------------
  useEffect(() => {
    if (save !== 'dirty' || !scene) return

    // Debounced: saving on every keystroke of a drag would be one request per
    // frame. The timer restarts on each edit, so the write happens once the
    // user pauses.
    const timer = setTimeout(async () => {
      setSave('saving')
      try {
        await updateScene(scene.id, { plan })
        setSave('saved')
      } catch (err) {
        setSave('error')
        setError(err instanceof Error ? err.message : 'Could not save.')
      }
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [save, plan, scene])

  // Warn before losing unsaved work. Only while genuinely dirty — a beforeunload
  // handler that always fires trains people to click through it.
  useEffect(() => {
    if (save !== 'dirty' && save !== 'saving') return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [save])

  // ---- Detection -----------------------------------------------------------
  async function runDetection() {
    const underlay = activeFloor(plan).underlay
    if (!underlay) return

    setDetecting(true)
    setError(null)
    try {
      const result = await detectFloorplan(underlay.url)

      // The drawing usually states its own size. Architects print a room's
      // dimensions inside it for a reader who cannot measure the paper, and the
      // reader now reports the scale those imply — so the calibration step that
      // used to come first can simply not be needed.
      //
      // Applied only to an underlay nobody has calibrated. Someone who measured
      // against a dimension they trust has made a judgement, and overriding it
      // with a number read by OCR would be the software second-guessing the one
      // person who knows the building.
      let traced = underlay
      let scaleApplied = false
      const printed = result.scale
      if (printed && !underlay.calibrated && result.width > 0) {
        const metresPerPixel = printed.metres_per_unit / result.width
        traced = { ...underlay, scale: metresPerPixel, calibrated: true }
        apply((current) => rescaleUnderlay(current, metresPerPixel))
        scaleApplied = true
      }

      const walls = convertDetections(result, traced)
      setReading({
        rooms: result.rooms ?? [],
        scale: printed ?? null,
        scaleApplied,
      })

      // Furniture comes out of the same read. The detector had to decide which
      // outlines were fittings in order to keep them out of the walls, so the
      // work is already done — making the user run a second pass for it would
      // be charging twice for one answer.
      const pieces = proposeFurniture(result, traced)
      setFurniture(pieces.length > 0 ? pieces : null)

      // Judge the result before offering it.
      //
      // Counting walls is not a quality check — the reader finds lines in
      // anything, and a styled brochure yields hundreds of them, none of which
      // is a wall. What separates a real plan is that its walls *enclose*
      // something, so the rooms those walls would produce are the measure.
      // Predicted by running the *actual* accept logic on a throwaway plan,
      // not by an approximation of it. `addWall` snaps coincident endpoints
      // together, and that snapping is precisely what decides whether a
      // detection closes any rooms — a prediction that skipped it would report
      // zero rooms for a perfectly good import.
      const rooms = detectRooms(
        activeFloor(
          walls.reduce(
            (draft, w) =>
              addWall(draft, w.a, w.b, {
                thickness: w.thickness,
                height: WALL_DEFAULTS.interior.height,
                snapRadius: 0.15,
              }),
            emptyPlan(),
          ),
        ),
      ).length

      const verdict = assessDetection(walls, rooms)
      if (!verdict.ok) {
        setError(`${verdict.reason} ${verdict.detail}`)
      }
      // Shown either way. A poor detection is still a starting point somebody
      // may want to correct by hand, and throwing it away would make that
      // impossible — but it is no longer offered silently as if it worked.
      if (walls.length > 0) setProposal(walls)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The floor-plan reader failed.')
    } finally {
      setDetecting(false)
    }
  }

  function acceptProposal() {
    if (!proposal) return
    // One history entry for the whole import, so a single undo reverses it —
    // rather than forty, which would be unusable.
    apply((current) =>
      proposal.reduce(
        (next, wall) =>
          addWall(next, wall.a, wall.b, {
            thickness: wall.thickness,
            height: WALL_DEFAULTS.interior.height,
            snapRadius: 0.15,
          }),
        current,
      ),
    )
    setProposal(null)
  }

  /** Place the furniture the drawing showed, as one undoable step. */
  function acceptFurniture() {
    if (!furniture) return
    apply((current) =>
      furniture.reduce(
        (next, piece) =>
          addObject(next, {
            item: piece.item,
            position: piece.position,
            rotation: piece.rotation,
            size: piece.size,
          }),
        current,
      ),
    )
    setFurniture(null)
  }

  // ---- Derived -------------------------------------------------------------
  const floor = activeFloor(plan)
  const rooms = useMemo(() => detectRooms(floor), [floor])
  const selectedRoom = selection?.kind === 'room' ? rooms.find((r) => r.id === selection.id) : null
  const selectedWall = selection?.kind === 'wall' ? floor.walls[selection.id] : null
  const selectedObject =
    selection?.kind === 'object' ? (floor.objects?.[selection.id] ?? null) : null

  return (
    <div className="editor">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ← Projects
        </button>
        <strong style={{ fontSize: 14 }}>{scene?.name ?? 'Loading…'}</strong>

        <span className="saving">
          <span
            className={`dot ${save === 'dirty' || save === 'saving' ? 'dot-dirty' : save === 'saved' ? 'dot-saved' : ''}`}
          />
          {SAVE_LABEL[save]}
        </span>

        <span className="spacer" />

        {/* The reference puts this dead centre; here it sits with the other
            view controls, because it is one of several and not the most used. */}
        <div className="segmented" style={{ width: 108 }}>
          <button aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>
            2D
          </button>
          <button aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>
            3D
          </button>
        </div>

        <div className="segmented" style={{ width: 132 }}>
          <button
            aria-pressed={units === 'imperial'}
            onClick={() => setUnits('imperial')}
          >
            ft / in
          </button>
          <button aria-pressed={units === 'metric'} onClick={() => setUnits('metric')}>
            metric
          </button>
        </div>

        <button
          className="btn"
          onClick={() => {
            setHistory(undo)
            setSave('dirty')
          }}
          disabled={history.past.length === 0}
          title="Undo (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          className="btn"
          onClick={() => {
            setHistory(redo)
            setSave('dirty')
          }}
          disabled={history.future.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↷
        </button>
      </header>

      {error && (
        <p className="alert alert-error" role="alert" style={{ margin: 12 }}>
          {error}
        </p>
      )}

      {/* Said plainly rather than shown as a disabled button that does nothing.
          The two import starts create a real project — the import step itself
          is not wired yet, and pretending otherwise wastes someone's time. */}
      {notice && start === 'model' && (
        <p className="alert" style={{ margin: 12, display: 'flex', gap: 12 }}>
          <span style={{ flex: 1 }}>
            Loading a GLB into the 3D scene is not wired up yet. The project is
            created, and both the floor-plan editor and tracing over an uploaded
            drawing work.
          </span>
          <button className="icon-btn" onClick={() => setNotice(false)}>
            Dismiss
          </button>
        </p>
      )}

      {mode === '3d' ? (
        <SceneView plan={plan} sceneId={sceneId} sceneName={scene?.name} />
      ) : (
      <div className="editor-body">
        {/* ---- Tools ---------------------------------------------------- */}
        <aside className="panel panel-left">
          <section>
            <span className="eyebrow">Tools</span>
            <div className="tool-grid">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className="tool"
                  aria-pressed={tool === t.id}
                  onClick={() => setTool(t.id)}
                  title={`${t.label} (${t.key})`}
                >
                  <span style={{ fontSize: 17 }} aria-hidden="true">
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <span className="eyebrow">Floors</span>
            <div className="floor-tabs">
              {plan.floors.map((f) => (
                <button
                  key={f.id}
                  className="floor-tab"
                  aria-current={f.id === plan.activeFloorId}
                  onClick={() => apply((p) => setActiveFloor(p, f.id))}
                >
                  <span>{f.name}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {formatLength(f.elevation, units)}
                  </span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => apply(addFloor)}>
                + Floor
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => apply((p) => duplicateFloor(p, p.activeFloorId))}
                title="Copy this floor's walls to a new storey"
              >
                Copy
              </button>
            </div>
            {plan.floors.length > 1 && (
              <button
                className="btn btn-danger"
                onClick={() => apply((p) => removeFloor(p, p.activeFloorId))}
              >
                Delete this floor
              </button>
            )}
          </section>

          <CataloguePanel
            units={units}
            placing={placing}
            onPick={setPlacing}
          />

          <UnderlayPanel
            underlay={floor.underlay}
            units={units}
            calibrating={tool === 'calibrate'}
            onPlace={(input) => {
              apply((p) => placeUnderlay(p, input))
              // Straight into calibration: an uncalibrated drawing is the one
              // state where the next action is never anything else.
              setTool('calibrate')
            }}
            onChange={(patch: Partial<Underlay>) =>
              apply((p) =>
                setUnderlay(
                  p,
                  activeFloor(p).underlay
                    ? { ...activeFloor(p).underlay!, ...patch }
                    : null,
                ),
              )
            }
            onRemove={() => apply((p) => setUnderlay(p, null))}
            onStartCalibrate={() => setTool('calibrate')}
            detecting={detecting}
            onDetect={runDetection}
          />

          {furniture && (
            <section>
              <span className="eyebrow">Furniture in the drawing</span>
              <FurnitureReview
                furniture={furniture}
                onAccept={acceptFurniture}
                onDiscard={() => setFurniture(null)}
              />
            </section>
          )}

          {proposal && (
            <section>
              <span className="eyebrow">Proposed walls</span>
              <ProposalReview
                proposal={proposal}
                units={units}
                onAccept={acceptProposal}
                rooms={reading?.rooms ?? []}
                scale={reading?.scale ?? null}
                scaleApplied={reading?.scaleApplied ?? false}
                onDiscard={() => {
                  setProposal(null)
                  setReading(null)
                }}
              />
            </section>
          )}

          <section>
            <span className="eyebrow">All walls on this floor</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => apply((p) => updateAllWalls(p, WALL_DEFAULTS.exterior))}
              >
                230 mm
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => apply((p) => updateAllWalls(p, WALL_DEFAULTS.interior))}
              >
                115 mm
              </button>
            </div>
          </section>
        </aside>

        {/* ---- Canvas ---------------------------------------------------- */}
        <div className="stage">
          <canvas ref={attachCanvas} />
          <p className="hint">{hint}</p>
          <div className="stage-actions">
            <button className="btn" onClick={() => viewerRef.current?.zoomToFit()}>
              Fit
            </button>
          </div>
        </div>

        {/* ---- Inspector -------------------------------------------------- */}
        <aside className="panel panel-right">
          <section>
            <span className="eyebrow">This floor</span>
            <div className="stat">
              <span className="muted">Rooms</span>
              <span className="mono">{rooms.length}</span>
            </div>
            <div className="stat">
              <span className="muted">Enclosed area</span>
              <span className="mono">{formatArea(totalArea(rooms), units)}</span>
            </div>
            <div className="stat">
              <span className="muted">Walls</span>
              <span className="mono">{Object.keys(floor.walls).length}</span>
            </div>
            <div className="stat">
              <span className="muted">Objects</span>
              <span className="mono">{Object.keys(floor.objects ?? {}).length}</span>
            </div>
          </section>

          <section>
            <span className="eyebrow">Rooms</span>
            {rooms.length === 0 ? (
              <p className="muted" style={{ fontSize: 12.5 }}>
                Close a loop of walls and the room appears here with its area.
              </p>
            ) : (
              <div className="room-list">
                {rooms.map((room, index) => (
                  <button
                    key={room.id}
                    className="room-row"
                    aria-current={selection?.kind === 'room' && selection.id === room.id}
                    onClick={() => setSelection({ kind: 'room', id: room.id })}
                  >
                    <span>{displayName(room, index, floor.roomNames)}</span>
                    <span className="muted mono" style={{ fontSize: 11.5 }}>
                      {formatArea(room.area, units)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {selectedRoom && (
            <section>
              <span className="eyebrow">Selected room</span>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="room-name">Name</label>
                <input
                  id="room-name"
                  value={floor.roomNames[selectedRoom.id] ?? ''}
                  placeholder={displayName(
                    selectedRoom,
                    rooms.indexOf(selectedRoom),
                    {},
                  )}
                  onChange={(e) =>
                    applyLive((p) => nameRoom(p, selectedRoom.id, e.target.value))
                  }
                  onBlur={() => setHistory((h) => commit(h, h.present))}
                />
              </div>
              <div className="stat">
                <span className="muted">Area</span>
                <span className="mono">{formatArea(selectedRoom.area, units)}</span>
              </div>
            </section>
          )}

          {selectedObject && (
            <ObjectInspector
              object={selectedObject}
              units={units}
              onChange={(patch: Partial<PlacedObject>) =>
                apply((p) => updateObject(p, selectedObject.id, patch))
              }
              onRemove={() => {
                apply((p) => removeObject(p, selectedObject.id))
                setSelection(null)
              }}
            />
          )}

          {selectedWall && (
            <section>
              <span className="eyebrow">Selected wall</span>
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="wall-thickness">Thickness</label>
                <input
                  id="wall-thickness"
                  defaultValue={formatLength(selectedWall.thickness, units)}
                  key={`${selectedWall.id}-t-${units}`}
                  onBlur={(e) => {
                    const metres = parseLength(e.target.value, units)
                    // Reject rather than guess: a thickness that cannot be
                    // parsed leaves the wall as it was and the field snaps back
                    // to the real value, so nothing is silently wrong.
                    if (metres && metres > 0.01 && metres < 2) {
                      apply((p) => updateWallIn(p, selectedWall.id, { thickness: metres }))
                    } else {
                      e.target.value = formatLength(selectedWall.thickness, units)
                    }
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="wall-height">Height</label>
                <input
                  id="wall-height"
                  defaultValue={formatLength(selectedWall.height, units)}
                  key={`${selectedWall.id}-h-${units}`}
                  onBlur={(e) => {
                    const metres = parseLength(e.target.value, units)
                    if (metres && metres > 0.5 && metres < 20) {
                      apply((p) => updateWallIn(p, selectedWall.id, { height: metres }))
                    } else {
                      e.target.value = formatLength(selectedWall.height, units)
                    }
                  }}
                />
              </div>
              <button
                className="btn btn-danger"
                onClick={() => {
                  apply((p) => removeWall(p, selectedWall.id))
                  setSelection(null)
                }}
              >
                Delete wall
              </button>
            </section>
          )}
        </aside>
      </div>
      )}

      {calibration && (
        <CalibrateDialog
          units={units}
          onCancel={() => setCalibration(null)}
          onConfirm={(metres) => {
            apply((p) => calibrateUnderlay(p, calibration.from, calibration.to, metres))
            setCalibration(null)
            // Back to drawing: calibration is a one-off, and leaving the tool
            // active means the next click starts another one.
            setTool('wall')
          }}
        />
      )}
    </div>
  )
}

/** Local helper so the import list does not grow a near-duplicate name. */
function updateWallIn(plan: Plan, wallId: string, patch: { thickness?: number; height?: number }) {
  return {
    ...plan,
    floors: plan.floors.map((f) =>
      f.id !== plan.activeFloorId
        ? f
        : { ...f, walls: { ...f.walls, [wallId]: { ...f.walls[wallId], ...patch } } },
    ),
  }
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: 'Up to date',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
}
