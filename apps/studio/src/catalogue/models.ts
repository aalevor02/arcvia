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
 * Then it is centred horizontally and sat on the floor, because the parametric
 * builders all draw upward from y=0 and everything downstream — placement,
 * elevation, wall snapping — assumes that.
 */
function fit(model: THREE.Object3D, size: { width: number; height: number; depth: number }): void {
  const box = new THREE.Box3().setFromObject(model)
  const extent = box.getSize(new THREE.Vector3())
  if (extent.x <= 0 || extent.y <= 0 || extent.z <= 0) return

  const scale = Math.min(size.width / extent.x, size.height / extent.y, size.depth / extent.z)
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

    pending.push(
      prototype(url).then((loaded) => {
        if (!loaded) return false

        const instance = loaded.clone(true)
        fit(instance, size)

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
