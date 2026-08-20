import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { assignLightmapUVs, applyLightmap } from './lightmapUV'

/**
 * The lightmap bake round trip.
 *
 * ── What this buys ──────────────────────────────────────────────────────────
 * Real-time lighting gives a bright side and a dark side. It cannot give colour
 * bleeding between surfaces, contact darkening where a sofa meets the floor, or
 * light that has bounced twice — and those are most of what makes an interior
 * read as photographed rather than rendered. Baking computes them once, offline,
 * with a path tracer, and stores the answer in a texture.
 *
 * ── The shape of the trip ───────────────────────────────────────────────────
 *   1. Lay out lightmap UVs here, deterministically  (lightmapUV.ts)
 *   2. Export the scene to GLB carrying them
 *   3. Upload it, point the scene record at it, queue a bake
 *   4. Poll — Cycles is minutes, not seconds
 *   5. Load the returned atlas and multiply it over the materials
 *
 * Step 1 is what keeps step 5 cheap: because both ends already agree on the
 * layout, only an image comes back. If the baker owned the layout the geometry
 * would have to return with it, which is why a Shapespark export ships tens of
 * megabytes of buffers alongside its lightmaps.
 */

/**
 * How hard the returned atlas is driven when applied.
 *
 * An exposure control, not a correction. Blender bakes irradiance in watts per
 * square metre; Three.js multiplies a lightMap into a shading term that wants
 * to land near 1 for a well-lit surface. The two scales have no fixed
 * relationship, so *some* factor is unavoidable and this is where it lives.
 *
 * Tuned against a room lit only through two windows, which is the dim end of
 * the range — an interior really is far darker than outdoors, and taking the
 * physically-correct number straight to screen produces a room that looks like
 * dusk. Raise it for scenes with artificial lighting baked in.
 */
const BAKED_EXPOSURE = 2.2

export interface BakeProgress {
  status: string
  progress: number
  note?: string
}

/**
 * Export a scene to a GLB blob, with lightmap UVs assigned.
 *
 * Returns the cell count too, purely so the caller can report something honest
 * about atlas density — a 40-object scene shares one 2048px atlas, which is
 * about 320px per object, and that is worth saying out loud before someone
 * concludes the bake is low quality.
 */
export async function exportForBake(
  scene: THREE.Object3D,
): Promise<{ blob: Blob; grid: number; meshes: number }> {
  // Clone first. Assigning UVs mutates geometry, and the live scene is the one
  // on screen — rewriting its attributes mid-session would be felt.
  const clone = scene.clone(true)
  const layout = assignLightmapUVs(clone)

  const exporter = new GLTFExporter()
  const binary = await exporter.parseAsync(clone, {
    binary: true,
    // Without this the second UV set is dropped and the worker receives
    // geometry it has to unwrap itself — which silently defeats the whole
    // arrangement.
    includeCustomExtensions: false,
    onlyVisible: false,
  })

  return {
    blob: new Blob([binary as ArrayBuffer], { type: 'model/gltf-binary' }),
    grid: layout.grid,
    meshes: layout.meshes,
  }
}

/**
 * Load a baked atlas and multiply it over the scene's materials.
 *
 * The atlas is served from the API's storage, which is a different origin to
 * the studio, so the texture load needs CORS — the upload route sets no
 * restrictive headers, and the image is not read back, so this is only about
 * the loader not tainting a canvas it never touches.
 */
export function loadAndApply(
  scene: THREE.Object3D,
  url: string,
  intensity = BAKED_EXPOSURE,
): Promise<number> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().setCrossOrigin('anonymous').load(
      url,
      (texture) => resolve(applyLightmap(scene, texture, intensity)),
      undefined,
      () => reject(new Error('The baked lightmap could not be loaded.')),
    )
  })
}
