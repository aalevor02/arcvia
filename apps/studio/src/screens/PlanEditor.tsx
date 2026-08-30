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
  commitFrom,
  duplicateFloor,
  emptyPlan,
  initialHistory,
  loadPlan,
  moveVertex,
  nameRoom,
  setRoomFinish,
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
import {
  FLOOR_FINISHES,
  WALL_DEFAULTS,
  WALL_TYPES,
  wallTypeById,
  type FloorFinish,
  type Plan,
  type Underlay,
  type Vec2,
  type WallTypeId,
} from '../plan/types'
import {
  formatArea,
  formatLength,
  parseLength,
  readUnitPreference,
  writeUnitPreference,
  type UnitSystem,
} from '../lib/format'
import { cadModel, detectFloorplan, getScene, updateScene, type CadSummary, type Scene } from '../lib/api'
import { cadStoreys, furnishFromCad, type CadModel } from '../plan/cadFurnish'
import { planFromCad } from '../plan/cadPlan'
import { furnishFromDesign, planAsMeasuredModel } from '../plan/designFurnish'
import { placeFurniture } from '../plan/placeFurniture'
import {
  designFurnitureKey,
  designsOf,
  type DesignSpec,
} from '../plan/deckDesign'
import ImportPanel from '../components/ImportPanel'
import { SceneChannel, type Peer } from '../lib/realtime'
import { assessDetection, shouldTryOutlines } from '../plan/detectionQuality'
import { proposeFurnitureForImport, type Proposal } from '../plan/furnish'
import {
  automaticScalePerPixel,
  convertDetections,
  namesFromDrawing,
  roomsCovered,  type DetectedObject,  type DetectedRoom,
} from '../plan/detections'
import { openingsFromDetection } from '../plan/detectedOpenings'
import {
  type DetectedScale,
  type ProposedWall,
} from '../plan/detections'
import SceneView from './SceneView'
import { UnderlayPanel } from '../components/UnderlayPanel'
import { CalibrateDialog } from '../components/CalibrateDialog'
import { ProposalReview } from '../components/ProposalReview'
import { FurnitureReview } from '../components/FurnitureReview'
import { CataloguePanel } from '../components/CataloguePanel'
import { HubBrowserPanel, type HubUse } from '../components/HubBrowserPanel'
import { ObjectInspector } from '../components/ObjectInspector'
import type { PlacedObject } from '../catalogue/types'
import { resolveHubFurniture } from '../plan/hubFurniture'
import { BimWorkspacePanel } from '../components/BimWorkspacePanel'

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
  const unitsRef = useRef<UnitSystem>(readUnitPreference())

  const [scene, setScene] = useState<Scene | null>(null)
  const [history, setHistory] = useState<History>(() => initialHistory(emptyPlan()))
  // 'draw' opens on the wall tool ready to trace; the import starts open on
  // Select, because the first thing to do there is bring something in rather
  // than draw over an empty grid.
  const [tool, setTool] = useState<Tool>(start === 'draw' || !start ? 'wall' : 'select')
  // Read once, lazily: the initialiser runs on every render otherwise, and
  // this one touches localStorage.
  const [units, setUnits] = useState<UnitSystem>(readUnitPreference)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [hint, setHint] = useState('Click to start a wall.')
  const [save, setSave] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(true)
  /** The engine's account of a CAD import, shown until dismissed. */
  const [importSummary, setImportSummary] = useState<string | null>(null)
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
  const furnitureRef = useRef<Proposal[] | null>(null)
  const [hubTarget, setHubTarget] = useState<Proposal | null>(null)
  const latestDesignsRef = useRef<DesignSpec[]>([])
  const reviewedDesignKeysRef = useRef<string[]>([])
  const designReviewKeysRef = useRef<string[] | null>(null)
  const cadModelCacheRef = useRef<{ url: string; model: CadModel } | null>(null)
  /** Cancels an older async offer when another render is applied meanwhile. */
  const designOfferRunRef = useRef(0)
  /**
   * A multi-storey CAD import reviews one storey's furniture at a time —
   * each batch carries its source storey and acceptance creates/targets that
   * floor automatically. This holds the fetched model and where review has
   * got to, so the next non-empty storey is offered after each decision.
   */
  const cadFurnishRef = useRef<{ model: CadModel; storeys: number[]; at: number } | null>(null)
  const [furnitureHeading, setFurnitureHeading] = useState<string | null>(null)

  const [reading, setReading] = useState<{
    rooms: DetectedRoom[]
    /** The reader's door gaps, kept so `acceptProposal` can cut them. */
    objects: DetectedObject[]
    scale: DetectedScale | null
    scaleApplied: boolean
    /** What the vision adjudicator did — "dropped 4 walls — bed (95%)". */
    notes: string[]
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
  /** The plan the server last acknowledged, for the unmount flush. */
  const lastSavedRef = useRef<Plan | null>(null)
  const sceneIdRef = useRef<string | null>(null)

  // ---- Live co-editing -----------------------------------------------------
  const channelRef = useRef<SceneChannel | null>(null)
  /** True while a REMOTE snapshot is being applied, so the send-effect below
   *  does not echo it straight back to the room. */
  const applyingRemoteRef = useRef(false)
  /** A remote snapshot that arrived mid-gesture, held until the drag releases —
   *  replacing the plan under a live gesture clobbers its baseline. */
  const pendingRemoteRef = useRef<Plan | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])

  function showFurniture(next: Proposal[] | null, heading: string | null = null) {
    furnitureRef.current = next
    setFurniture(next)
    setFurnitureHeading(heading)
    if (!next) setHubTarget(null)
  }

  function markDesignFurnitureReviewed(keys: string[]) {
    if (keys.length === 0) return
    const reviewed = [...new Set([...reviewedDesignKeysRef.current, ...keys])]
    reviewedDesignKeysRef.current = reviewed
    designReviewKeysRef.current = null
    setScene((current) => current ? { ...current, designFurnitureReviewed: reviewed } : current)
    void updateScene(sceneId, { designFurnitureReviewed: reviewed }).catch(() =>
      setError('The furniture review decision could not be saved.'),
    )
  }

  function useHubAsset({ target, template, asset, model, attachmentIndex }: HubUse) {
    const current = furnitureRef.current
    if (!current) return
    const next = current.map((piece) => {
      const sameReviewRow = piece.reviewOnly &&
        piece.item === target.item &&
        piece.room === target.room &&
        piece.designKey === target.designKey
      if (!sameReviewRow) return piece
      return resolveHubFurniture(piece, template, model, asset.name, attachmentIndex) ?? piece
    })
    showFurniture(next, furnitureHeading)
    setHubTarget(null)
  }

  async function offerDesignFurniture(
    designs: DesignSpec[],
    sourcePlan: Plan = planRef.current,
    sourceScene: Scene | null = scene,
  ) {
    latestDesignsRef.current = designs
    const run = ++designOfferRunRef.current
    const url = sourceScene?.cadModelJsonUrl
    if (furnitureRef.current) return

    const pending = designs.filter(
      (design) => !reviewedDesignKeysRef.current.includes(designFurnitureKey(design)),
    )
    if (pending.length === 0) return

    let model = url && cadModelCacheRef.current?.url === url
      ? cadModelCacheRef.current.model
      : null
    if (!model && url) {
      model = await cadModel(url)
      if (!model) return
      cadModelCacheRef.current = { url, model }
    }
    if (!model) model = planAsMeasuredModel(sourcePlan)
    if (run !== designOfferRunRef.current || furnitureRef.current) return

    const pieces = furnishFromDesign(model, pending, sourcePlan)
    const keys = [...new Set(pieces.map((piece) => piece.designKey).filter(Boolean) as string[])]
    if (pieces.length === 0) {
      // Nothing actionable: rooms were already furnished, no matching room
      // polygon existed, or the observed item has no safe floor asset.
      markDesignFurnitureReviewed(pending.map(designFurnitureKey))
      return
    }
    designReviewKeysRef.current = keys
    showFurniture(
      pieces,
      'Seen in the deck renders. Items are real observations; positions are arranged inside measured room boundaries.',
    )
    setImportSummary(
      `${pieces.length} furniture item${pieces.length === 1 ? '' : 's'} seen in the deck renders — ` +
        'switch to 2D to review and place them.',
    )
  }

  // ---- Load ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    getScene(sceneId)
      .then(async (loaded) => {
        if (cancelled) return
        setScene(loaded)
        sceneIdRef.current = loaded.id
        let initial = loadPlan(loaded.plan)

        // Older CAD imports saved only a GLB and building.json, leaving the
        // editor's plan empty. Hydrate those scenes on open as well as new
        // imports, so returning from 3D never loses the drawing.
        if (loaded.cadModelJsonUrl && !planHasWalls(initial)) {
          const model = await cadModel(loaded.cadModelJsonUrl)
          if (cancelled) return
          const hydrated = model ? planFromCad(model) : null
          if (model) {
            cadModelCacheRef.current = { url: loaded.cadModelJsonUrl, model }
          }
          if (hydrated) {
            initial = hydrated
            void updateScene(sceneId, { plan: hydrated }).catch(() =>
              setError('The reconstructed 2D plan could not be saved.'),
            )
          }
        }
        lastSavedRef.current = initial
        setHistory(initialHistory(initial))
        const designs = designsOf(loaded.design)
        latestDesignsRef.current = designs
        reviewedDesignKeysRef.current = loaded.designFurnitureReviewed ?? []
        if (loaded.cadModelJsonUrl && designs.length > 0) {
          void offerDesignFurniture(designs, initial, loaded)
        }
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

  /**
   * The state the current gesture started from.
   *
   * Captured on the FIRST live frame and spent by `finishGesture`. Without it
   * the pre-drag plan exists nowhere once `applyLive` has replaced `present`,
   * and gesture-end used to call `commit(h, h.present)` — a comparison of
   * present with itself, a guaranteed no-op. No drag ever reached the undo
   * stack; Ctrl+Z after moving a wall deleted the action before the move.
   */
  const gestureBaseRef = useRef<Plan | null>(null)

  const applyLive = useCallback((fn: (plan: Plan) => Plan) => {
    setHistory((h) => {
      if (gestureBaseRef.current === null) gestureBaseRef.current = h.present
      // `future` cleared, exactly as `commit` clears it: editing after an undo
      // abandons the branch. Spreading it through kept redo alive pointing at
      // a state the user had already edited away from — and autosave would
      // then happily persist the resurrected branch.
      return { ...h, present: fn(h.present), future: [] }
    })
    setSave('dirty')
  }, [])

  /**
   * Apply a plan a collaborator just sent.
   *
   * Two rules, both from the collision hazards the studio already knows:
   * (1) if a gesture is live, DO NOT replace the plan now — it would clobber
   * the gesture baseline and the user's drag would finish against the wrong
   * plan; buffer it and let `finishGesture` apply it on release. (2) applying
   * it must NOT mark the plan dirty, or autosave would immediately PATCH back
   * what we just received and two clients ping-pong; so `lastSavedRef` is set
   * to the incoming plan and the state is left 'saved'. `applyingRemoteRef`
   * stops the send-effect echoing it to the room.
   */
  const applyRemotePlan = useCallback((incoming: unknown) => {
    const next = loadPlan(incoming)
    if (gestureBaseRef.current !== null) {
      pendingRemoteRef.current = next
      return
    }
    applyingRemoteRef.current = true
    lastSavedRef.current = next
    setHistory((h) => ({ ...h, present: next }))
    setSave('saved')
  }, [])

  /** Close the open gesture, recording one undo entry for the whole drag. */
  const finishGesture = useCallback(() => {
    setHistory((h) => commitFrom(h, gestureBaseRef.current))
    gestureBaseRef.current = null
    // A snapshot that arrived mid-drag was held; apply it now the gesture is
    // closed. The user's own edit committed first (above), then the peer's
    // lands on top — last-writer-wins, and the buffering kept the drag intact.
    if (pendingRemoteRef.current) {
      const buffered = pendingRemoteRef.current
      pendingRemoteRef.current = null
      applyRemotePlan(buffered)
    }
  }, [applyRemotePlan])

  // ---- Live co-editing: connect while the scene is open --------------------
  useEffect(() => {
    const channel = new SceneChannel(sceneId, {
      onPlan: (incoming) => applyRemotePlan(incoming),
      onPresence: (roster) => setPeers(roster),
      onStatus: (status) => {
        // Losing the socket means the roster is stale; clear it so the "N
        // others" chip does not claim company that has gone.
        if (status === 'closed') setPeers([])
      },
    })
    channel.connect()
    channelRef.current = channel
    return () => {
      channel.close()
      channelRef.current = null
      setPeers([])
    }
  }, [sceneId, applyRemotePlan])

  // ---- Live co-editing: broadcast local edits ------------------------------
  // Fires on every plan change, and decides what NOT to send:
  //   - a REMOTE apply, or we would echo a peer's edit straight back;
  //   - a live gesture frame (gestureBaseRef set), or a drag floods the room at
  //     60 messages a second. finishGesture's commit is a plan change with the
  //     gesture already closed, so the finished drag sends exactly once.
  useEffect(() => {
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false
      return
    }
    if (gestureBaseRef.current !== null) return
    channelRef.current?.sendPlan(plan)
  }, [plan])

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
      onCommit: () => finishGesture(),
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
    // Remembered across projects and reloads. Choosing feet once should not
    // have to be done again on the next drawing.
    writeUnitPreference(units)
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
      // What THIS write carries. The completion below must judge itself
      // against it: on a fast connection the response can land after a newer
      // edit re-armed its own timer, and setting 'saved' then re-runs this
      // effect, whose cleanup tears that newer timer down — the newer edit is
      // never written and the UI says Saved. Found by the audit; the fix is
      // that a save only claims 'saved' for the plan it actually sent.
      const sent = plan
      try {
        await updateScene(scene.id, { plan: sent })
        lastSavedRef.current = sent
        setSave(planRef.current === sent ? 'saved' : 'dirty')
      } catch (err) {
        setSave('error')
        setError(err instanceof Error ? err.message : 'Could not save.')
      }
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [save, plan, scene])

  /**
   * Flush the plan when the editor unmounts with unsaved work.
   *
   * "Back to projects" is a pushState navigation — beforeunload never fires —
   * and it used to land inside the autosave debounce and simply discard the
   * edit. Deliberately its own unmount-only effect rather than the autosave
   * cleanup, which runs on every keystroke.
   *
   * Fire-and-forget: the component is gone, so there is nowhere to report a
   * failure — but a write that usually lands beats a write that was never made.
   */
  useEffect(() => {
    return () => {
      const id = sceneIdRef.current
      if (id && planRef.current !== lastSavedRef.current) {
        void updateScene(id, { plan: planRef.current }).catch(() => {})
      }
    }
  }, [])

  // Warn before losing unsaved work.
  //
  // Admits everything EXCEPT the states where none exists. This used to list
  // the states where work exists instead — 'dirty' and 'saving' — and the list
  // was wrong: after a FAILED save the state is 'error', which is precisely
  // when unsaved work exists, and the guard disarmed.
  useEffect(() => {
    if (save === 'saved' || save === 'idle') return
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
      const detectedScale = result.scale
      // Only printed, measured dimensions can calibrate automatically. A scale
      // inferred from wall and door priors remains useful evidence, but it must
      // be confirmed by the person who knows the drawing.
      const metresPerPixel = automaticScalePerPixel(detectedScale, result.width)
      if (metresPerPixel !== null && !underlay.calibrated) {
        traced = { ...underlay, scale: metresPerPixel, calibrated: true }
        apply((current) => rescaleUnderlay(current, metresPerPixel))
        scaleApplied = true
      }

      let walls = convertDetections(result, traced)
      setReading({
        rooms: result.rooms ?? [],
        objects: result.objects ?? [],
        scale: detectedScale ?? null,
        scaleApplied,
        notes: result.notes ?? [],
      })

      // Furniture comes out of the same read. The detector had to decide which
      // outlines were fittings in order to keep them out of the walls, so the
      // work is already done — making the user run a second pass for it would
      // be charging twice for one answer.
      const pieces = proposeFurnitureForImport(result, traced)
      showFurniture(pieces.length > 0 ? pieces : null)

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
      const encloses = (candidate: typeof walls) =>
        detectRooms(
          activeFloor(
            candidate.reduce(
              (draft, w) =>
                addWall(draft, w.a, w.b, {
                  thickness: w.thickness,
                  height: WALL_DEFAULTS.interior.height,
                  snapRadius: 0.15,
                }),
              emptyPlan(),
            ),
          ),
        )

      let enclosed = encloses(walls)
      let rooms = enclosed.length

      // Last resort, and only from a standing start of nothing.
      //
      // A styled presentation sheet hides most of its walls under furniture and
      // shading, so the face pass can return a dozen strokes that enclose
      // nothing at all. Measured on a real upload: 12 walls, 13 of 17 vertices
      // dangling, a median gap of 1.71 m between them. No corner tolerance
      // closes that -- the walls are metres apart, not centimetres -- but the
      // same response carried nine closed room outlines.
      //
      // Deliberately NOT the default: those outlines are a contour pass, and on
      // markup 2 the contour calls an open lift lobby a room. Running this when
      // the walls already enclose something would seal circulation that is
      // visibly open. Gated on zero, it cannot: markup 2's walls close the lift
      // shaft, so this never executes there.
      //
      // ⚠ KNOWN LIMIT, measured 2026-08-29 and NOT solved. On a sheet holding
      // several drawings this rescue will close outlines taken from an
      // elevation or a section as though they were rooms. On a real four-panel
      // CIVILMIX sheet it produced 14 rooms and 109.7 m2 spanning two storeys,
      // an elevation and a section. The guard for that is gated on rooms === 0,
      // so it is consulted BELOW before the rescue rather than after — but on
      // that sheet it does not fire either: the reader found 26 walls in total
      // and `PLAN_MIN_WALLS` needs three clusters of six, so under-detection
      // defeats the detector of under-detection.
      //
      // REFUTED alternative, so nobody spends the afternoon on it again:
      // clustering the ROOM POLYGONS instead of the walls does not separate
      // them. Measured over three drawings — the acceptance deck (one plan)
      // gives 2 X-groups and 2 Y-groups, `4.png` (one plan) gives 2 and 1, and
      // the four-panel sheet gives 1 and 3. A single plan shows the same
      // signature as four, and the multi-panel sheet does not even separate on
      // the axis its panels are arranged along. There is no threshold there.
      //
      // So the user is told instead. That is worse than detecting it and better
      // than implying it cannot happen.
      // ASSESS BEFORE RESCUING. The several-plans-on-one-sheet guard is gated
      // on `rooms === 0`, so manufacturing rooms below would make its condition
      // permanently false and silence it on exactly the sheets it exists for.
      // Measured on a real four-panel sheet: the rescue produced 14 rooms and
      // 109.7 m2 spanning two storeys, an elevation and a section, and the
      // verdict came back "ok". Zero rooms is unusable and obvious; fourteen
      // confident rooms built partly out of a section drawing is wrong and
      // invisible, which is the worse failure.
      const beforeRescue = assessDetection(walls, rooms)
      const severalPlans = !beforeRescue.ok && (beforeRescue.clusters ?? 0) >= 3

      // WHEN TO RESCUE: not "did the walls enclose anything" but "how much of
      // the drawing did they account for". The measurement behind that, and the
      // two guards on it, are in shouldTryOutlines -- including the held-out
      // villa markup, the one case where the walls are right and the outlines
      // would seal open circulation.
      const before = roomsCovered(enclosed, result.rooms ?? [], traced)
      const drawnSpaces = before.drawn

      let closedFromOutlines = false
      if (!severalPlans && shouldTryOutlines({ rooms, ...before })) {
        const fromOutlines = convertDetections(result, traced, { useRoomPolygons: true })
        const outlineRooms = encloses(fromOutlines)
        const after = roomsCovered(outlineRooms, result.rooms ?? [], traced)
        if (outlineRooms.length > 0 && after.covered > before.covered) {
          walls = fromOutlines
          enclosed = outlineRooms
          rooms = outlineRooms.length
          closedFromOutlines = true
        }
      }

      // `beforeRescue` when the rescue was declined, so the reason the user is
      // given is the multi-plan one and not a downstream symptom of it.
      const verdict = severalPlans ? beforeRescue : assessDetection(walls, rooms)
      if (closedFromOutlines) {
        // Said plainly, because it changes what the user is accepting. These
        // walls trace the reader's room outlines rather than lines measured on
        // the drawing, so they are a starting point to correct, not a survey.
        setError(
          `The walls in this drawing accounted for ${before.covered} of the ` +
          `${drawnSpaces} spaces it shows, so the plan was closed using the ` +
          `${rooms} room outline${rooms === 1 ? '' : 's'} the reader ` +
          `found instead. Those are traced from shaded areas rather than ` +
          `measured from lines — check the walls before you build on them. ` +
          `If this sheet holds more than one drawing, crop it to a single ` +
          `floor plan and read it again: outlines from an elevation or a ` +
          `section will have been closed as if they were rooms.`,
        )
      } else if (!verdict.ok) {
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
      proposal.reduce((next, wall) => {
        // A balcony parapet and an interior partition are the same two lines on
        // the drawing, and this is where they used to become the same wall:
        // every proposal took interior height regardless. The reader's verdict
        // rides on `kind`, so a railing arrives as a railing and is built to
        // guard height rather than boxing the balcony in.
        const railing = wall.kind === 'railing' || wall.kind === 'boundary'
        const build = railing ? wallTypeById('railing') : undefined
        return addWall(next, wall.a, wall.b, {
          thickness: build?.thickness ?? wall.thickness,
          height: build?.height ?? WALL_DEFAULTS.interior.height,
          type: build?.id,
          snapRadius: 0.15,
        })
      }, current),
    )

    // Give the rooms the names the drawing already carries. The CAD path does
    // this (cadPlan.ts) and the IFC path does this (ifcPlanProposal.ts); the
    // raster path did not, so a plan that plainly reads SHOWER / TOILET / PATIO
    // arrived as Room 1, Room 2, Room 3 -- after the reader had gone to the
    // trouble of OCRing those very labels and using them to pick which
    // binarisation to trust.
    const outlines = reading?.rooms ?? []
    const traced = activeFloor(plan).underlay
    if (traced && (outlines.length > 0 || reading)) {
      // Names and doorways in ONE step, because both read the floor the walls
      // above just produced and neither is worth its own undo.
      apply((current) => {
        const floor = activeFloor(current)
        let next = current

        if (outlines.length > 0) {
          const names = namesFromDrawing(detectRooms(floor), outlines, traced)
          next = Object.entries(names).reduce<typeof current>(
            (plan, [roomId, name]) => nameRoom(plan, roomId, String(name)),
            next,
          )
        }

        // Cut the doorways the reader measured. Until this ran, every gap it
        // found was dropped between the reader and the model: an uploaded
        // drawing built a solid box with no way from one room to the next.
        // Only gaps with a wall actually standing in them are cut -- a gap
        // between two walls that stop either side of it is already a hole, and
        // cutting there would put a second doorway beside the real one. The
        // measurement that settles it is in detectedOpenings.ts.
        if (reading) {
          next = openingsFromDetection(reading.objects, traced, floor).reduce<typeof current>(
            (plan, opening) =>
              addObject(plan, {
                item: opening.item,
                position: opening.position,
                rotation: opening.rotation,
                wallId: opening.wallId,
                size: opening.size,
              }),
            next,
          )
        }

        return next
      })
    }

    setProposal(null)
  }

  /** Place the furniture the drawing showed, as one undoable step. */
  function acceptFurniture() {
    if (!furniture) return
    const designKeys = designReviewKeysRef.current
    const actionable = furniture.filter((piece) => !piece.reviewOnly)
    if (actionable.length > 0) apply((current) => placeFurniture(current, actionable))
    showFurniture(null)
    if (designKeys) markDesignFurnitureReviewed(designKeys)

    // A multi-storey CAD import: the next storey's batch is offered as its
    // own review rather than merged — each batch lands on its recorded plan
    // floor, and the helper creates that floor when it does not exist yet.
    const pending = cadFurnishRef.current
    if (pending) {
      for (let next = pending.at + 1; next < pending.storeys.length; next++) {
        const pieces = furnishFromCad(pending.model, { storey: pending.storeys[next] })
        if (pieces.length > 0) {
          pending.at = next
          const heading =
            `Storey ${next + 1} of ${pending.storeys.length} from the drawing — ` +
              'it will be placed on its source floor.'
          showFurniture(pieces, heading)
          return
        }
      }
      cadFurnishRef.current = null
      setFurnitureHeading(null)
      void offerDesignFurniture(latestDesignsRef.current)
    }
  }

  function discardFurniture() {
    const designKeys = designReviewKeysRef.current
    showFurniture(null)
    cadFurnishRef.current = null
    if (designKeys) markDesignFurnitureReviewed(designKeys)
  }

  // ---- Derived -------------------------------------------------------------
  const floor = activeFloor(plan)
  const rooms = useMemo(() => detectRooms(floor), [floor])
  const selectedRoom = selection?.kind === 'room' ? rooms.find((r) => r.id === selection.id) : null
  const selectedWall = selection?.kind === 'wall' ? floor.walls[selection.id] : null
  const selectedObject =
    selection?.kind === 'object' ? (floor.objects?.[selection.id] ?? null) : null

  /**
   * Nothing interactive until the scene has actually arrived.
   *
   * The canvas used to mount immediately, wall tool pre-armed, while getScene
   * was still in flight — and the load's `setHistory(initialHistory(...))`
   * then replaced whatever the user had already drawn. On a slow connection
   * that is fifteen seconds of drawing, silently discarded by the screen's own
   * loading code. A blank grid that accepts input it will throw away is worse
   * than a spinner.
   */
  if (!scene) {
    return (
      <div className="editor">
        <header className="topbar">
          <button className="btn" onClick={onBack}>
            ← Projects
          </button>
          <strong style={{ fontSize: 14 }}>{error ? 'Could not open this project' : 'Loading…'}</strong>
        </header>
        <div className="editor-body" style={{ display: 'grid', placeItems: 'center' }}>
          {error ? (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="muted">Opening the plan…</p>
          )}
        </div>
      </div>
    )
  }

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

        {/* Who else is in this scene. One dot per collaborator, tinted with the
            colour the server assigned their cursor, so the strip and the
            cursors on the plan agree. Hidden when alone. */}
        {peers.length > 0 && (
          <span
            className="presence"
            title={peers.map((p) => p.name).join(', ') + ' also editing'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {peers.slice(0, 5).map((p) => (
              <span
                key={p.userId}
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: p.colour,
                  display: 'inline-block',
                }}
              />
            ))}
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {peers.length} {peers.length === 1 ? 'other' : 'others'}
            </span>
          </span>
        )}

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

      {/* The import step the two upload starts used to apologise for. On
          landing, the model path goes on the SCENE — not just on screen — and
          the editor jumps to the 3D view, because the model is the thing the
          user came to see. */}
      {notice && (start === 'model' || start === 'cad') && (
        <ImportPanel
          kind={start}
          onDismiss={() => setNotice(false)}
          onLanded={async (
            modelUrl,
            summary: CadSummary | null,
            modelJsonUrl?: string | null,
            sourceDocumentUrl?: string | null,
          ) => {
            setNotice(false)
            let reconstructedModel: CadModel | null = null
            let importedPlan: Plan | null = null

            if (start === 'cad') {
              if (!modelJsonUrl) {
                setError(
                  'The reconstruction produced no editable plan data. Nothing was opened in 3D.',
                )
                return
              }
              reconstructedModel = await cadModel(modelJsonUrl)
              importedPlan = reconstructedModel ? planFromCad(reconstructedModel) : null
              if (!reconstructedModel || !importedPlan) {
                setError(
                  'The reconstruction could not produce verified 2D walls. Nothing was opened in 3D.',
                )
                return
              }
            }

            // cadModelUrl as well as modelUrl, and only for the CAD door: the
            // bake flow overwrites modelUrl with its combined export, and the
            // 3D view needs the pristine reconstruction to compose furniture
            // over. A plain GLB import sets it too — same hybrid semantics.
            const stored = {
              modelUrl,
              cadModelUrl: modelUrl,
              cadModelJsonUrl: modelJsonUrl ?? null,
              ...(importedPlan ? { plan: importedPlan } : {}),
              ...(sourceDocumentUrl ? { floorPlanUrl: sourceDocumentUrl } : {}),
            }
            try {
              await updateScene(sceneId, stored)
            } catch {
              setError('The reconstructed model finished, but could not be saved to this scene.')
              return
            }
            const landedScene = scene ? { ...scene, ...stored } : null
            setScene(landedScene)

            if (importedPlan) {
              lastSavedRef.current = importedPlan
              setHistory(initialHistory(importedPlan))
              setSave('saved')
              setSelection(null)
            }

            // The drawing's own furniture, through the same review the raster
            // path uses. The engine classified every block to a catalogue item
            // while it built the model, so proposing costs one JSON fetch —
            // and a reconstruction whose JSON is missing simply proposes
            // nothing, exactly like a drawing with no blocks.
            if (modelJsonUrl) {
              const offerCadFurniture = (model: CadModel) => {
                if (!model) return
                cadModelCacheRef.current = { url: modelJsonUrl, model }
                const storeys = cadStoreys(model)
                const pieces = furnishFromCad(model, { storey: storeys[0] ?? 0 })
                if (pieces.length === 0) {
                  void offerDesignFurniture(latestDesignsRef.current, planRef.current, landedScene)
                  return
                }
                cadFurnishRef.current = { model, storeys, at: 0 }
                const heading =
                  storeys.length > 1
                    ? `Storey 1 of ${storeys.length} from the drawing — it will be placed on its source floor.`
                    : null
                showFurniture(pieces, heading)
              }
              if (reconstructedModel) offerCadFurniture(reconstructedModel)
              else void cadModel(modelJsonUrl).then((model) => {
                if (model) offerCadFurniture(model)
              })
            }

            if (summary && (summary.storeys ?? 0) > 1) {
              // A two-storey villa reported with one storey's room count reads
              // as half the building going missing.
              setImportSummary(
                `Loaded ${summary.storeys} storeys into 2D for review` +
                  (summary.storeyNames?.length ? ` (${summary.storeyNames.join(', ')})` : '') +
                  `: ${summary.roomsAllStoreys ?? 0} rooms, ${summary.wallsAllStoreys ?? 0} walls in all.`,
              )
            } else if (summary) {
              setImportSummary(
                `Loaded into 2D for review: ${summary.rooms ?? 0} rooms (${summary.named ?? 0} named), ` +
                  `${summary.walls ?? 0} walls, ${summary.openings ?? 0} openings` +
                  (summary.unit ? ` — unit: ${summary.unit}` : '') + '.' +
                  // The review itself lives in the 2D sidebar, and the import
                  // has just switched to 3D — without this line the proposals
                  // sit unseen behind a view the user has no reason to leave.
                  (summary.fixtures
                    ? ` ${summary.fixtures} furniture placements read from the drawing — switch to 2D to review them.`
                    : ''),
              )
            }
            // A CAD/PDF reconstruction is evidence to review, not permission
            // to jump into 3D. The 3D tab is an explicit user decision after
            // walls, rooms and openings are visible in 2D. Plain GLB imports
            // still open in 3D because they have no 2D plan by definition.
            setMode(importedPlan ? '2d' : '3d')
          }}
        />
      )}

      {importSummary && mode === '3d' && (
        <p className="alert" style={{ margin: 12, display: 'flex', gap: 12 }}>
          <span style={{ flex: 1 }}>{importSummary}</span>
          <button className="icon-btn" onClick={() => setImportSummary(null)}>
            Dismiss
          </button>
        </p>
      )}

      {mode === '3d' ? (
        <SceneView
          plan={plan}
          sceneId={sceneId}
          sceneName={scene?.name}
          onDesignsChanged={(designs) => void offerDesignFurniture(designs)}
        />
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

          <BimWorkspacePanel
            plan={plan}
            onReplacePlan={(next) => apply(() => next)}
          />

          <HubBrowserPanel
            target={hubTarget}
            onUse={useHubAsset}
            onCancelTarget={() => setHubTarget(null)}
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
            onOpenRenders={() => setMode('3d')}
            onDeck={({ url }) => {
              // Keep the original PDF on the scene, not only its extracted
              // plan page on the underlay. SceneView reads this field to find
              // and analyse the render pages; without this callback a mixed
              // plan/render deck became indistinguishable from a lone image.
              setScene((current) => current ? { ...current, floorPlanUrl: url } : current)
              void updateScene(sceneId, { floorPlanUrl: url }).catch(() =>
                setError('The PDF was read, but its render pages could not be saved to this project.'),
              )
            }}
          />

          {furniture && (
            <section>
              <span className="eyebrow">Furniture review</span>
              <FurnitureReview
                furniture={furniture}
                heading={furnitureHeading ?? undefined}
                onAccept={acceptFurniture}
                onDiscard={discardFurniture}
                onFindAsset={setHubTarget}
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
                notes={reading?.notes ?? []}
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
                  onBlur={finishGesture}
                />
              </div>
              <div className="field">
                <label htmlFor="room-finish">Floor finish</label>
                <select
                  id="room-finish"
                  value={floor.roomFinishes?.[selectedRoom.id] ?? ''}
                  onChange={(e) =>
                    apply((p) =>
                      setRoomFinish(
                        p,
                        selectedRoom.id,
                        (e.target.value || null) as FloorFinish | null,
                      ),
                    )
                  }
                >
                  {/* Empty is not "none" — it is "whatever the project uses",
                      so a project-wide change still reaches this room. */}
                  <option value="">Project default</option>
                  {FLOOR_FINISHES.map((finish) => (
                    <option key={finish.id} value={finish.id}>
                      {finish.name}
                    </option>
                  ))}
                </select>
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
                <label htmlFor="wall-type">Build-up</label>
                <select
                  id="wall-type"
                  value={selectedWall.type ?? ''}
                  onChange={(e) => {
                    const type = wallTypeById(e.target.value as WallTypeId)
                    // Choosing a build-up sets the thickness, because that is
                    // the point of naming one. It does not keep owning it —
                    // see the note on `Wall.type`: the survey wins afterwards.
                    apply((p) =>
                      updateWallIn(p, selectedWall.id, {
                        type: type?.id,
                        ...(type ? { thickness: type.thickness } : {}),
                        // A type with its own height sets it for the same
                        // reason: a railing is 1.0 m because that is what a
                        // railing IS, not because of the storey it sits on.
                        // Types without one leave the wall's height alone.
                        ...(type?.height ? { height: type.height } : {}),
                      }),
                    )
                  }}
                >
                  <option value="">Plastered masonry (unspecified)</option>
                  {WALL_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
                {selectedWall.type && (
                  <p className="note" style={{ marginTop: 4 }}>
                    {wallTypeById(selectedWall.type)?.note}
                  </p>
                )}
              </div>
              <div className="field">
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
function planHasWalls(plan: Plan): boolean {
  return plan.floors.some((floor) => Object.keys(floor.walls).length > 0)
}

function updateWallIn(
  plan: Plan,
  wallId: string,
  patch: { thickness?: number; height?: number; type?: WallTypeId | undefined },
) {
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
