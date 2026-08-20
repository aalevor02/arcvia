import * as THREE from 'three'

/**
 * Lightmap UVs, generated on the client.
 *
 * ── Why here and not in Blender ─────────────────────────────────────────────
 * The obvious pipeline is: send geometry to the baker, let it unwrap and bake,
 * send the geometry *back* with its new UV channel, and load that. That is what
 * Shapespark does, and it is why a published walkthrough there ships 27 MB of
 * geometry buffers alongside its lightmaps — the geometry has to come back
 * because only the baker knows the layout.
 *
 * This codebase does not have that constraint, because it *generates* its own
 * geometry and can therefore lay out the UVs deterministically before sending
 * anything. Both sides then agree on the layout without exchanging it, so the
 * bake round-trip carries geometry one way and a single image back — a few
 * hundred kilobytes instead of tens of megabytes.
 *
 * The rule that makes it work: **the packing here and the packing in
 * `render.py` must produce the same cell for the same mesh index.** Both use a
 * ceil(sqrt(n)) grid in mesh-traversal order. Change one and you must change
 * the other, or the bake lands on the wrong surfaces — which renders as light
 * leaking from the wrong room and is maddening to diagnose.
 */

/** Fraction of each cell left empty, so the bake margin cannot bleed between. */
const CELL_INSET = 0.06

/**
 * Assign a non-overlapping `uv2` to every mesh in the group.
 *
 * Returns the grid size, which the baker needs in its spec.
 */
export function assignLightmapUVs(root: THREE.Object3D): { grid: number; meshes: number } {
  const meshes: THREE.Mesh[] = []
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) meshes.push(child)
  })

  if (meshes.length === 0) return { grid: 0, meshes: 0 }

  // The side of a square grid, not a count of occupied cells: 5 meshes get a
  // 3x3 grid and leave four cells empty.
  const grid = Math.ceil(Math.sqrt(meshes.length))

  meshes.forEach((mesh, index) => {
    const column = index % grid
    const row = Math.floor(index / grid)

    const uv = unwrap(mesh.geometry)
    packIntoCell(uv, column, row, grid)

    // glTF calls this TEXCOORD_1; Three calls it uv1 (r152+) or uv2 (earlier).
    // Setting both keeps the exporter and the material happy across versions.
    mesh.geometry.setAttribute('uv1', uv)
    mesh.geometry.setAttribute('uv2', uv.clone())
  })

  return { grid, meshes: meshes.length }
}

/**
 * Produce a 0-1 unwrap for one geometry.
 *
 * Box-projected: each vertex is projected onto whichever of the three axis
 * planes its normal most nearly faces. That is not a good general unwrap — it
 * seams badly on curved surfaces — but every surface that matters for a
 * lightmap here is a flat axis-aligned face of a wall, slab or box, and for
 * those it is exact and produces no distortion at all.
 *
 * The alternative, an angle-based unwrap, needs an actual UV solver. That is
 * what Blender's smart_project is for, and moving it here would mean shipping
 * one to the browser.
 */
function unwrap(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const position = geometry.getAttribute('position')
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const normal = geometry.getAttribute('normal')

  const uv = new Float32Array(position.count * 2)

  // Normalise into the geometry's own bounding box, so a 6 m wall and a 0.4 m
  // shelf both fill their cell. Lightmap texel density is then per-object
  // rather than per-metre — the trade every real-time lightmapper makes,
  // because the alternative is a wall consuming the whole atlas.
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const size = new THREE.Vector3()
  box.getSize(size)
  // Guard flat axes: a slab has zero thickness in one direction and dividing
  // by it produces NaN UVs, which bake as a black object.
  const safe = (v: number) => (v > 1e-6 ? v : 1)

  for (let i = 0; i < position.count; i++) {
    const nx = Math.abs(normal.getX(i))
    const ny = Math.abs(normal.getY(i))
    const nz = Math.abs(normal.getZ(i))

    const x = position.getX(i) - box.min.x
    const y = position.getY(i) - box.min.y
    const z = position.getZ(i) - box.min.z

    let u: number
    let v: number

    if (ny >= nx && ny >= nz) {
      // Floor or ceiling facing: project onto XZ.
      u = x / safe(size.x)
      v = z / safe(size.z)
    } else if (nx >= nz) {
      // Facing along X: project onto ZY.
      u = z / safe(size.z)
      v = y / safe(size.y)
    } else {
      // Facing along Z: project onto XY.
      u = x / safe(size.x)
      v = y / safe(size.y)
    }

    uv[i * 2] = u
    uv[i * 2 + 1] = v
  }

  return new THREE.BufferAttribute(uv, 2)
}

/** Squeeze a 0-1 unwrap into one cell of the atlas grid. */
function packIntoCell(
  uv: THREE.BufferAttribute,
  column: number,
  row: number,
  grid: number,
): void {
  const step = 1 / grid
  const inset = step * CELL_INSET
  const span = step - inset * 2

  for (let i = 0; i < uv.count; i++) {
    // Clamp before scaling: a projected vertex can land marginally outside
    // 0-1 through floating point, and outside its cell it would sample a
    // neighbour's lighting.
    const u = Math.min(1, Math.max(0, uv.getX(i)))
    const v = Math.min(1, Math.max(0, uv.getY(i)))

    uv.setXY(i, column * step + inset + u * span, row * step + inset + v * span)
  }
}

/**
 * Apply a baked atlas to a scene that was unwrapped by `assignLightmapUVs`.
 *
 * The atlas is attached as `lightMap`, which Three multiplies over the material
 * — so the base colour and textures survive and the bake supplies the lighting
 * on top. Attaching it as `map` instead would replace the material and throw
 * away the very textures the bake was lighting.
 */
export function applyLightmap(
  root: THREE.Object3D,
  texture: THREE.Texture,
  intensity = 1,
): number {
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace

  // Sample the *second* UV set, not the first.
  //
  // This one line is the whole feature. Since r152 a texture chooses its UV
  // attribute with `channel`, and it defaults to 0 — the albedo UVs, which run
  // 0-1 across every individual face. A lightmap sampled with those reads the
  // entire atlas onto every surface: each wall gets a smeared patchwork of
  // every *other* object's bake, which is unmistakably wrong on screen and
  // gives no clue where it comes from.
  //
  // The packed coordinates live in `uv1` (channel 1), which is what
  // `assignLightmapUVs` writes and what glTF carries as TEXCOORD_1.
  texture.channel = 1
  texture.needsUpdate = true

  let applied = 0

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    if (!child.geometry.getAttribute('uv1')) return

    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue

      // Cloned per mesh: materials are shared across the whole scene, and a
      // shared material carrying one mesh's lightmap would light every other
      // mesh with it.
      const lit = material.clone()
      lit.lightMap = texture
      lit.lightMapIntensity = intensity
      child.material = lit
      applied++
    }
  })

  return applied
}
