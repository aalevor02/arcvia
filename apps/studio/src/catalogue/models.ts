import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Real GLB furniture, replacing the parametric stand-ins.
 *
 * ── The shape of this, and why ──────────────────────────────────────────────
 * The catalogue's builders draw dimensioned boxes. That is genuinely useful —
 * it is what makes "does the sofa fit past the door" answerable — and it is
 * emphatically not what makes a render sell a flat. This is the upgrade path,
 * and it is designed so the stand-in is never *replaced by nothing*:
 *
 *   1. the plan builds instantly, with stand-ins, exactly as before
 *   2. any object naming a model starts loading in the background
 *   3. each model swaps in as it arrives
 *
 * So the editor is usable on the first frame and gets better, rather than
 * showing an empty room for however long a dozen GLBs take. A model that fails
 * to load leaves its stand-in in place, which is a correct room with plain
 * furniture rather than a room with a hole in it.
 *
 * ── The catalogue stays authoritative on size ───────────────────────────────
 * A downloaded model arrives at whatever scale and origin its author used —
 * centimetres, inches, origin at the centre of mass, lying on its side. Fitting
 * every model to the catalogue's own dimensions here means a placed sofa is
 * 2.1 m wide because the catalogue says a sofa is 2.1 m wide, whatever the
 * asset believes. Clearances stay meaningful, which is the one thing that must
 * not regress when the pretty models arrive.
 */

/** A loaded prototype, cloned per placement. */
const cache = new Map<string, Promise<THREE.Object3D | null>>()

/**
 * Every model load currently in flight.
 *
 * Tracked so callers can wait for the scene to settle. The bake in particular
 * must not run early: it exports whatever is in the scene *now*, so baking
 * mid-load produces an atlas of stand-ins that is then applied to the real
 * furniture — geometry and lighting from two different rooms.
 */
const inFlight = new Set<Promise<unknown>>()

/** Resolves when nothing is still loading. Safe to call when nothing is. */
export async function modelsSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight])
  }
}

/**
 * Load a GLB once and hand out clones.
 *
 * Cached by URL including failures — a missing model should be one failed
 * request, not one per placement. Forty dining chairs must not be forty
 * downloads either, which is the other half of why this is shared.
 */
function prototype(url: string): Promise<THREE.Object3D | null> {
  const existing = cache.get(url)
  if (existing) return existing

  const loading = new Promise<THREE.Object3D | null>((resolve) => {
    new GLTFLoader().setCrossOrigin('anonymous').load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (error) => {
        // Null so the caller keeps the stand-in — a room with plain furniture
        // beats a room with a hole in it. But say so: a silent null here means
        // a broken asset looks identical to one nobody placed, and the first
        // real asset this pipeline produced failed exactly this way.
        console.warn(`Arcvia: could not load ${url}`, error)
        resolve(null)
      },
    )
  })

  cache.set(url, loading)
  return loading
}

/**
 * Scale and seat a model to match a catalogue entry's dimensions.
 *
 * Uniform scale, deliberately. Stretching each axis to hit the catalogue box
 * exactly would guarantee the footprint but distort the object, and a sofa
 * squashed 15% along its length is more obviously wrong than a sofa that
 * leaves a few centimetres spare. So it fits *within* the box, touching on its
 * tightest axis.
 *
 * ── Scaling each axis to its own target was tried, and is worse ─────────────
 * The case for it is real: a king-size bed model already at the catalogue's
 * 0.6 m height cannot grow into a 1.83 m width under a uniform scale, so it
 * draws 0.91 m wide — a king rendering as a single, in the one dimension a plan
 * exists to check.
 *
 * Implemented and measured, it corrected 29 of 38 footprints and RUINED the
 * rest, because their plan orientation was wrong — a uniform scale is forgiving
 * of that, since it merely under-fills, while a per-axis scale BAKES IT IN and
 * stretches the model along axes it does not occupy.
 *
 * Chasing that found the quarter-turn bug below, and measuring every asset's
 * plan aspect found only three genuinely transposed models rather than the many
 * the experiment implied. Both are now fixed, so this is worth revisiting — but
 * on measurement rather than on the argument alone, because the argument was
 * right and the result was still worse.
 *
 * ── A warning was tried too, and dropped ────────────────────────────────────
 * Comparing the model's plan aspect against its slot's does identify assets
 * that cannot fill their footprint. It fired on 28 of 38 — 74% — because many
 * catalogue depths are nominal rather than measured: a television is listed at
 * 60 mm and its model includes a stand, so it reads 5555% out of proportion and
 * nothing is wrong with either.
 *
 * A warning that fires on three quarters of a catalogue is noise, and this
 * repository already has that lesson written down about render checks: one that
 * fires on good frames teaches the reader to ignore all of them. The thumbnails
 * are the better signal, because a person can SEE which assets are wrong.
 *
 * Then it is centred horizontally and sat on the floor, because the parametric
 * builders all draw upward from y=0 and everything downstream — placement,
 * elevation, wall snapping — assumes that.
 */
function fit(
  model: THREE.Object3D,
  catalogueSize: { width: number; height: number; depth: number },
  upAxis: 'y' | 'z' = 'y',
  /** The facing correction that will be applied AFTER this, in degrees. */
  yaw = 0,
): void {
  // Stand a Z-up model up BEFORE measuring it. Measuring first and rotating
  // after would fit the object's depth to the catalogue's height, which is the
  // bug this exists to remove.
  if (upAxis === 'z') model.rotation.x = -Math.PI / 2

  /**
   * ── A quarter turn swaps which catalogue dimension is which ──────────────
   * `yaw` is applied after this, deliberately: it turns the model about its own
   * centre once fitting has seated it, so a facing correction cannot move the
   * object off its placement.
   *
   * For 180 degrees that is harmless. For 90 or 270 it is not, because the
   * rotation TRANSPOSES the footprint: a counter fitted to 2.4 x 0.6 and then
   * turned a quarter comes to rest occupying 0.6 x 2.4, with its long axis
   * across the wall it was drawn along. Two catalogue assets carry yaw 270 and
   * both were doing this.
   *
   * So the fit targets the dimensions the model will END UP in. The rotation
   * still happens afterwards; it is only what "width" means that changes.
   */
  const quarterTurn = Math.abs(Math.round(yaw / 90)) % 2 === 1
  const size = quarterTurn
    ? { width: catalogueSize.depth, height: catalogueSize.height, depth: catalogueSize.width }
    : catalogueSize

  const box = new THREE.Box3().setFromObject(model)
  const extent = box.getSize(new THREE.Vector3())
  if (extent.x <= 0 || extent.y <= 0 || extent.z <= 0) return

  /**
   * ── An axis with no size carries no information about scale ──────────────
   * A rug, a mirror and a wall light are geometrically flat: 12 mm against a
   * 2.4 m width. Dividing a near-zero target by a near-zero extent produces a
   * ratio with no meaning, and `Math.min` then hands the whole model that
   * ratio. The rug arrived ONE CENTIMETRE ACROSS — a valid GLB, no error, and
   * it reads as a loading failure rather than a scaling one.
   *
   * `condition_asset.py` learned this at ingest in 678a521 and its message
   * states the rule: "an axis the model has no size on carries no information
   * about how big it should be, so it now takes no part in the decision."
   * This function fits AGAIN at run time and never got the same guard, so a
   * correctly conditioned rug was collapsed on load anyway.
   *
   * Flat is a proportion, not a measurement — 12 mm is flat on a rug and is
   * the whole object on a sheet of paper — so the threshold is relative to the
   * model's own largest extent, exactly as the ingest-side check does it.
   */
  const largest = Math.max(extent.x, extent.y, extent.z)
  const FLAT = 0.02

  const carries = {
    x: extent.x / largest > FLAT,
    y: extent.y / largest > FLAT,
    z: extent.z / largest > FLAT,
  }

  // Every axis flat is not a model, it is a point. Leave it alone rather than
  // divide by nothing.
  if (!carries.x && !carries.y && !carries.z) return

  const own = {
    x: size.width / extent.x,
    y: size.height / extent.y,
    z: size.depth / extent.z,
  }

  const informed = (['x', 'y', 'z'] as const).filter((axis) => carries[axis])
  const scale = Math.min(...informed.map((axis) => own[axis]))
  model.scale.setScalar(scale)

  // Re-measured after scaling rather than arithmetic on the old box: a model
  // with a non-identity transform on its root would make that arithmetic wrong
  // in a way that only shows up on a handful of assets.
  const scaled = new THREE.Box3().setFromObject(model)
  const centre = scaled.getCenter(new THREE.Vector3())

  model.position.x -= centre.x
  model.position.z -= centre.z
  model.position.y -= scaled.min.y
}

/**
 * Replace stand-ins with real models, in place.
 *
 * Walks the built scene for groups tagged with a model URL, loads each, and
 * swaps its children. Returns how many were upgraded, which is worth surfacing
 * — "34 of 40 objects using real models" tells a user something true about
 * what they are looking at.
 *
 * `onSwap` fires per model rather than once at the end so the viewport can
 * redraw as each arrives. Waiting for all of them means a room that sits
 * visibly stale until the slowest download finishes.
 */
export function upgradeModels(
  root: THREE.Object3D,
  onSwap?: () => void,
): Promise<number> {
  const pending: Promise<boolean>[] = []

  root.traverse((child) => {
    const url = child.userData?.modelUrl
    if (typeof url !== 'string' || url.length === 0) return

    const size = child.userData.modelSize as
      | { width: number; height: number; depth: number }
      | undefined
    if (!size) return

    // The asset's own facing correction, applied to the instance rather than
    // to the placement — it describes the model, not where the user put it, so
    // it must survive the object being rotated.
    const yaw = Number(child.userData.modelYaw ?? 0)
    const upAxis = child.userData.modelUpAxis === 'z' ? 'z' : 'y'

    pending.push(
      prototype(url).then((loaded) => {
        if (!loaded) return false

        const instance = loaded.clone(true)
        fit(instance, size, upAxis, yaw)
        if (yaw !== 0) {
          // Wrapped, so the correction turns the model about its own centre
          // *after* fitting has seated it. Rotating the fitted object directly
          // would swing it around the group origin and slide it across the
          // floor.
          const holder = new THREE.Group()
          holder.add(instance)
          holder.rotation.y = (yaw * Math.PI) / 180
          child.clear()
          child.add(holder)
          child.userData.upgraded = true
          onSwap?.()
          return true
        }

        instance.traverse((mesh) => {
          if (!(mesh instanceof THREE.Mesh)) return
          mesh.castShadow = true
          mesh.receiveShadow = true
        })

        // The stand-in goes only once its replacement is built and fitted. Any
        // failure above leaves the room furnished rather than empty.
        child.clear()
        child.add(instance)
        child.userData.upgraded = true
        onSwap?.()
        return true
      }),
    )
  })

  if (pending.length === 0) return Promise.resolve(0)

  const all = Promise.all(pending)
  inFlight.add(all)

  return all
    .then((results) => results.filter(Boolean).length)
    .finally(() => {
      inFlight.delete(all)
    })
}

/** Drop the cache. Only for tests — a shared prototype is the point. */
export function clearModelCache(): void {
  cache.clear()
}
