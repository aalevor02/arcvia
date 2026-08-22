import * as THREE from 'three'

import { surface } from '../plan/materials'
import { SURFACE_MAPS, type SurfaceMaps } from './surfaces'

/**
 * Swap photographed maps onto the surfaces the canvas drew.
 *
 * ── Why this can be so small ────────────────────────────────────────────────
 * `surface(kind)` returns ONE cached material per kind, shared by every mesh
 * that uses it — a deliberate decision in `plan/materials.ts`, so that a room
 * with two hundred objects compiles a dozen shaders rather than two hundred.
 *
 * That sharing is what makes this a swap rather than a rebuild. Assigning three
 * textures to that single instance upgrades every wall, floor and worktop in
 * the scene at once, and nothing that holds a reference to the material has to
 * know it happened. There is no traversal here for the same reason
 * `upgradeModels` needs one: models are per-object, materials are per-kind.
 *
 * ── The procedural maps are not a placeholder ───────────────────────────────
 * They stay. They are what the headless geometry tests run against, what
 * renders on the first frame before anything has downloaded, and what a surface
 * keeps when a map fails to arrive. This is the same three-tier arrangement
 * `models.ts` uses, and the bottom tier is load-bearing.
 */

/** Loaded once per kind, including failures — a broken map is one 404, not one per call. */
const upgraded = new Map<string, Promise<boolean>>()

/**
 * Whether textures can be loaded at all.
 *
 * `plan/materials.ts` falls back to flat colours without a DOM so the geometry
 * stays testable in Node. The same has to hold here: `TextureLoader` needs an
 * `Image`, and the tests assert wall positions and room areas, none of which
 * depends on what a surface looks like.
 */
const CAN_LOAD = typeof document !== 'undefined' && typeof document.createElement === 'function'

const loader = CAN_LOAD ? new THREE.TextureLoader() : null

function load(url: string, srgb: boolean, repeat: number): Promise<THREE.Texture | null> {
  if (!loader) return Promise.resolve(null)

  return new Promise((resolve) => {
    loader.load(
      url,
      (texture) => {
        // Albedo is colour and must be decoded; roughness and normals are data
        // and must not be, or every surface comes out too smooth and lit from
        // slightly the wrong direction. `materials.ts` makes the same
        // distinction about its own generated maps.
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(repeat, repeat)
        texture.anisotropy = 8
        resolve(texture)
      },
      undefined,
      (error) => {
        // Null so the caller keeps the procedural map. Said out loud, because a
        // silent null makes a broken asset look exactly like a surface nobody
        // configured — the mistake `models.ts` records having made once already.
        console.warn(`Arcvia: could not load surface map ${url}`, error)
        resolve(null)
      },
    )
  })
}

/**
 * Load one surface's three maps and put them on its shared material.
 *
 * All or nothing, per surface. A colour map without its normal map is not a
 * partial upgrade, it is a surface whose shine and relief describe a different
 * material from its grain — which reads as nothing in particular and is very
 * hard to trace back. Better to keep the procedural set, which at least agrees
 * with itself.
 */
async function upgradeOne(spec: SurfaceMaps): Promise<boolean> {
  // The catalogue stores metres-per-tile because that is how the decision is
  // made ("boards repeat every 2 m"); three wants repeats-per-unit, and the
  // plan's UVs are in metres. Same conversion `materials.ts` does at its own
  // call sites.
  const repeat = spec.tileMetres > 0 ? 1 / spec.tileMetres : 1

  const [map, roughnessMap, normalMap] = await Promise.all([
    load(spec.map, true, repeat),
    load(spec.roughnessMap, false, repeat),
    load(spec.normalMap, false, repeat),
  ])

  if (!map || !roughnessMap || !normalMap) {
    for (const texture of [map, roughnessMap, normalMap]) texture?.dispose()
    return false
  }

  const material = surface(spec.id)

  // Release the canvas maps we are replacing. Three frees no GPU memory on its
  // own, and these are three textures per surface across eight surfaces on a
  // path that can run more than once.
  const outgoing = [material.map, material.roughnessMap, material.normalMap]

  material.map = map
  material.roughnessMap = roughnessMap
  material.normalMap = normalMap
  // Scalars are left exactly as `materials.ts` set them. `metal` is metalness
  // 0.85 and `glass` is transparent, and those are properties of the surface
  // rather than of the maps — clobbering them here would quietly undo a
  // decision made in another file.
  material.needsUpdate = true

  for (const texture of outgoing) texture?.dispose()

  return true
}

/**
 * Upgrade every surface the catalogue has maps for.
 *
 * Returns how many are now photographed, which is worth surfacing for the same
 * reason `upgradeModels` returns its count: it tells the user something true
 * about what they are looking at.
 *
 * `onSwap` fires per surface rather than once at the end, so the viewport
 * redraws as each arrives instead of sitting stale until the slowest finishes.
 *
 * Safe to call repeatedly — it is invoked from an effect that re-runs on every
 * plan change, and the materials it mutates are global. Each kind resolves once
 * and every later call gets the same promise.
 */
export function upgradeSurfaces(onSwap?: () => void): Promise<number> {
  if (!CAN_LOAD) return Promise.resolve(0)

  const pending = SURFACE_MAPS.map((spec) => {
    const existing = upgraded.get(spec.id)
    if (existing) return existing

    const work = upgradeOne(spec).then((ok) => {
      if (ok) onSwap?.()
      return ok
    })
    upgraded.set(spec.id, work)
    return work
  })

  return Promise.all(pending).then((results) => results.filter(Boolean).length)
}

/**
 * Forget what has been loaded.
 *
 * Only for tests and for `disposeSurfaces`, which throws away the cached
 * materials these were attached to — keeping the promises after that would hand
 * out textures belonging to disposed materials.
 */
export function clearSurfaceUpgrades(): void {
  upgraded.clear()
}
