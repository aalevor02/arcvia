import * as THREE from 'three'

import { buildObject } from './build'
import { upgradeModels, modelsSettled } from './models'
import type { CatalogueItem, PlacedObject } from './types'

/**
 * A picture of what you are about to place.
 *
 * ── Why these are rendered rather than downloaded ───────────────────────────
 * The obvious source is the asset library, and it has none: a hub model folder
 * holds `scene.gltf`, `scene.bin` and `textures`, and no preview at all. Poly
 * Haven has thumbnails on its site but they are of THEIR asset, not of the one
 * this catalogue actually ships — which has been decimated, re-scaled to the
 * catalogue's dimensions and re-oriented since.
 *
 * So the picture is made from the thing itself, through the same path the
 * editor uses: `buildObject` for the shape, `upgradeModels` for the real GLB.
 * A thumbnail here is by construction the object that lands in the plan. It
 * cannot go stale, because there is nothing to keep in step.
 *
 * ── Why nothing is committed to disk ────────────────────────────────────────
 * Sixty-three PNGs in the repository would be sixty-three things to regenerate
 * whenever a size, a tone or a model changed, and the failure mode of forgetting
 * is a catalogue that shows the old sofa. Rendering costs a few milliseconds per
 * item for geometry this simple.
 *
 * ── The panel keeps its dimensions ──────────────────────────────────────────
 * This adds to the row, it does not replace what is on it. The panel's own note
 * is right that "will it fit" is the question people open it to ask, and a
 * thumbnail answers a different one — "is this the thing I mean". Both are worth
 * a row; only one of them was there.
 */

const WIDTH = 128
const HEIGHT = 96

/** Rendered thumbnails, by catalogue id. Includes failures, as `null`. */
const cache = new Map<string, Promise<string | null>>()

/**
 * One renderer for every thumbnail, created on first use.
 *
 * ── Why this is shared and must be ──────────────────────────────────────────
 * A browser caps live WebGL contexts at around sixteen, and silently drops the
 * OLDEST when a new one exceeds it. A renderer per item would therefore work
 * perfectly for the first sixteen rows of the catalogue and then start blanking
 * the ones already drawn, with no error anywhere — a failure that looks like a
 * scrolling bug.
 *
 * So there is one, it renders in turn, and the canvas is read back to a data URL
 * before the next item touches it.
 */
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null

function ensureRenderer(): boolean {
  if (renderer) return true
  if (typeof document === 'undefined') return false

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH * 2
  canvas.height = HEIGHT * 2

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // Required to read the canvas back: without it the drawing buffer may be
      // cleared before `toDataURL` runs, and the thumbnail comes out blank on
      // some drivers and correct on others.
      preserveDrawingBuffer: true,
    })
  } catch {
    // No WebGL at all — a software-rendering VM, a locked-down browser. The
    // catalogue still works; it just has no pictures.
    return false
  }

  // ── A lost context must not be reused ───────────────────────────────────
  // `ensureRenderer` returns early when `renderer` is set, and a renderer whose
  // context has been lost is still set. Without this it keeps "succeeding" and
  // every thumbnail after the loss is blank — no exception, nothing logged.
  //
  // Contexts are lost for ordinary reasons: the GPU process restarts, the
  // machine sleeps, or another tab takes the last of the ~16 the browser
  // allows. `preventDefault` is what makes the loss recoverable at all; the
  // rest tears down so the next call rebuilds from scratch.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    renderer = null
    scene = null
    camera = null
    // The pictures rendered before the loss are still valid data URLs and are
    // kept. Only the queue's idea of a working renderer is thrown away.
  })

  renderer.setSize(WIDTH, HEIGHT, false)
  renderer.setPixelRatio(2)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  scene = new THREE.Scene()

  // Lit like a product shot rather than like a room: a key from the front left
  // so the front face is the bright one, a fill to keep the far side from going
  // to black, and a hemisphere so nothing is unlit. No shadows — at 128 px they
  // cost a shadow map and read as noise.
  const key = new THREE.DirectionalLight(0xfff4e6, 2.6)
  key.position.set(-3, 5, 6)
  const fill = new THREE.DirectionalLight(0xdce8ff, 0.9)
  fill.position.set(4, 2, -3)
  scene.add(key, fill, new THREE.HemisphereLight(0xdfe9f5, 0x4a4a48, 1.5))

  camera = new THREE.PerspectiveCamera(30, WIDTH / HEIGHT, 0.05, 100)
  return true
}

/**
 * Frame the object, whatever size it is.
 *
 * The catalogue spans a 0.04 m tap and a 12 m lap pool, so a fixed camera would
 * render one of them as a dot and lose the other off frame. Distance comes from
 * the bounding sphere and the field of view, which is exact rather than tuned.
 */
function frame(object: THREE.Object3D): void {
  if (!camera) return

  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return

  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const fov = (camera.fov * Math.PI) / 180
  // Fit the sphere in the NARROWER of the two axes, or a wide object overflows
  // vertically the moment the panel is not 4:3.
  const fitHeight = sphere.radius / Math.sin(fov / 2)
  const fitWidth = sphere.radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect))
  const distance = Math.max(fitHeight, fitWidth) * 1.08

  // Three-quarter view from slightly above: the angle that shows a front, a
  // side and a top, which is what makes a chair legible as a chair.
  const direction = new THREE.Vector3(-0.62, 0.5, 1).normalize()
  camera.position.copy(sphere.center).addScaledVector(direction, distance)
  camera.lookAt(sphere.center)
  camera.updateProjectionMatrix()
}

async function render(item: CatalogueItem): Promise<string | null> {
  if (!ensureRenderer() || !renderer || !scene || !camera) return null

  const placed: PlacedObject = {
    id: `thumb-${item.id}`,
    item: item.id,
    position: { x: 0, y: 0 },
    rotation: 0,
  }

  const group = buildObject(placed, 0)
  // An opening has no geometry of its own — the hole is cut by the wall builder
  // — so there is nothing to photograph. Null rather than an empty frame.
  if (!group) return null

  scene.add(group)
  try {
    // The real model, through the same call the editor makes. Awaited here
    // rather than skipped: a thumbnail of the stand-in when a model exists is
    // exactly the mismatch this is meant to remove.
    await upgradeModels(group)
    await modelsSettled()

    frame(group)
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  } catch {
    return null
  } finally {
    // Always removed, including on failure: a group left in the scene appears
    // behind every later thumbnail.
    scene.remove(group)
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose()
    })
  }
}

/**
 * The thumbnail for one catalogue item, rendered once.
 *
 * Serialised through a single promise chain rather than run in parallel: they
 * all share one renderer and one scene, so two at once would photograph each
 * other.
 */
let queue: Promise<unknown> = Promise.resolve()

export function thumbnailFor(item: CatalogueItem): Promise<string | null> {
  const existing = cache.get(item.id)
  if (existing) return existing

  const work = queue.then(() => render(item)).catch(() => null)
  queue = work
  cache.set(item.id, work)

  // ── A failure is not an answer, so it is not kept ────────────────────────
  // This cache used to hold failures for the life of the page. `render`
  // returns null for transient reasons as well as permanent ones — most of
  // all `upgradeModels`, which fetches real GLBs over the network, and a lost
  // WebGL context, which blanks the renderer without throwing anywhere useful.
  //
  // Cached, one bad moment removed that item's picture until the next reload,
  // and reloading is what made it come back — which is exactly the symptom
  // seen: a catalogue that has thumbnails on one load and not the next, with
  // nothing in the console either time.
  //
  // Successes are still cached forever; there is nothing to invalidate. Only
  // the nulls are dropped, so the next panel that asks tries again.
  void work.then((result) => {
    if (result === null && cache.get(item.id) === work) cache.delete(item.id)
  })

  return work
}

/** For tests, and for a catalogue that has been edited in place. */
export function clearThumbnailCache(): void {
  cache.clear()
}
