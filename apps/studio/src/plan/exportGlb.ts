import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/**
 * Getting an Arcvia scene out as a GLB.
 *
 * Two destinations, one exporter:
 *
 *   the render worker   — needs lightmap UVs, because the worker bakes into
 *                         the channel it is sent (see lightmapUV.ts)
 *   another application — needs nothing of the sort, because it will unwrap
 *                         and bake with its own conventions
 *
 * ── On exporting to a third-party walkthrough tool ──────────────────────────
 * Shapespark, and tools like it, import GLB and do their own baking. That makes
 * them a *destination*, not a competitor to the part of this codebase that
 * matters: the plan is still authored here, the dimensions are still real, the
 * catalogue is still the catalogue. Only the final render moves.
 *
 * Supporting that properly is worth more than pretending it does not exist. A
 * studio with a Shapespark licence should be able to draw in Arcvia and publish
 * through the renderer they have already paid for — and if the exported GLB is
 * good, Arcvia is upstream of their whole pipeline rather than competing with
 * one piece of it.
 */

export interface GlbExport {
  blob: Blob
  meshes: number
  triangles: number
}

/** Count what is actually being shipped, for an honest size report. */
function measure(root: THREE.Object3D): { meshes: number; triangles: number } {
  let meshes = 0
  let triangles = 0

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    meshes += 1
    const index = child.geometry.getIndex()
    const position = child.geometry.getAttribute('position')
    triangles += index ? index.count / 3 : position ? position.count / 3 : 0
  })

  return { meshes, triangles: Math.round(triangles) }
}

/**
 * Export a scene graph to a binary glTF.
 *
 * `onlyVisible: false` on purpose. Anything hidden in the viewport for the sake
 * of working comfortably — a ceiling switched off so the orbit camera can see
 * in — is still part of the building, and an export that silently omits the
 * ceilings produces a room that leaks daylight from above when the receiving
 * tool bakes it.
 */
export async function exportGlb(scene: THREE.Object3D): Promise<GlbExport> {
  const exporter = new GLTFExporter()
  const binary = await exporter.parseAsync(scene, {
    binary: true,
    includeCustomExtensions: false,
    onlyVisible: false,
  })

  return {
    blob: new Blob([binary as ArrayBuffer], { type: 'model/gltf-binary' }),
    ...measure(scene),
  }
}

/**
 * Hand a blob to the browser as a file.
 *
 * The object URL is revoked on the next tick rather than immediately: the
 * download is started by the click, but revoking in the same task can cancel it
 * in some browsers before the fetch has begun. A timeout of zero is enough, and
 * not revoking at all leaks the whole blob for the lifetime of the document —
 * which for a 3 MB scene, re-exported while iterating, adds up quickly.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** `Bake check 1787…` -> `bake-check-1787.glb`. */
export function filenameFor(sceneName: string): string {
  const slug = sceneName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'scene'}.glb`
}
