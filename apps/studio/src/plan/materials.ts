import * as THREE from 'three'

/**
 * Surface materials, generated rather than downloaded.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Untextured geometry reads as a diagram no matter how good the lighting is.
 * Every surface returning the same flat grey removes the single strongest cue
 * the eye uses to tell a room from a model of a room: that different things are
 * made of different stuff.
 *
 * ── Why procedural and not a texture library ────────────────────────────────
 * The reference product serves a CDN of photographed maps. Those are better,
 * and they are also an asset pipeline this codebase does not have. Canvas-drawn
 * maps cost nothing to ship, need no network, and get most of the way there —
 * because at walking distance what sells a floor is the *scale and direction of
 * its grain*, not the fidelity of individual pixels.
 *
 * Each generator returns albedo plus a matching roughness map. Roughness is
 * what makes a material read as a material under moving light: polished stone
 * throws a highlight that travels, plaster does not. A single colour map with
 * uniform roughness still looks like plastic.
 */

/** Canvas size for generated maps. 512 is ample at architectural viewing distance. */
const SIZE = 512

/**
 * Whether textures can be generated at all.
 *
 * They need a DOM canvas, and the geometry builders that use these materials
 * are also exercised in Node by the test suite — where `document` does not
 * exist. Rather than let that hard-dependency make the geometry untestable
 * headlessly, materials fall back to flat colours when there is no DOM.
 *
 * This is the right split: a texture is a *rendering* concern, and the tests
 * assert shape — wall positions, opening cuts, room areas. Nothing they check
 * depends on what a surface looks like.
 */
const CAN_DRAW = typeof document !== 'undefined' && typeof document.createElement === 'function'

/** Flat stand-ins, used only when there is no DOM to draw maps on. */
const FLAT: Record<string, number> = {
  'floor-wood': 0xa8794f,
  'floor-tile': 0xcac6c0,
  wall: 0xd8d4cc,
  ceiling: 0xeceef1,
  fabric: 0x76809a,
  wood: 0xa8794f,
  stone: 0xcac6c0,
  metal: 0xb9c0cb,
  glass: 0xcfe3ee,
  plant: 0x4e7c42,
  white: 0xf1f3f6,
  water: 0x2f7f9e,
  grass: 0x5f8a4a,
  paving: 0xa8a49d,
  brick: 0x9a5f47,
  concrete: 0x9d9d99,
}

function canvas(): { ctx: CanvasRenderingContext2D; el: HTMLCanvasElement } {
  const el = document.createElement('canvas')
  el.width = SIZE
  el.height = SIZE
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('This browser cannot provide a 2D canvas context.')
  return { ctx, el }
}

function toTexture(el: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(el)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  // Albedo is colour and must be decoded; roughness is data and must not be,
  // or the surface comes out uniformly too smooth.
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = 8
  return texture
}

/**
 * Derive a tangent-space normal map from an albedo canvas.
 *
 * ── Why bother, when there is already a roughness map ────────────────────────
 * Roughness controls how *sharp* a reflection is. It cannot make a surface
 * catch light, because as far as the shader is concerned the surface is still
 * perfectly flat: every pixel of a wall has the same normal, so every pixel
 * responds to a light identically and the wall reads as a painted plane. It is
 * the difference between a photograph of plaster and a photograph of a
 * photograph of plaster.
 *
 * A normal map perturbs the normal per pixel, so grain, grout lines and stipple
 * each get their own tiny highlight and shadow that move as the camera moves.
 * That motion is a large part of what the eye uses to decide a surface is real.
 *
 * Derived from the albedo's own luminance rather than authored separately: the
 * patterns here are already drawn as light-and-dark — a grout line is darker, a
 * plank seam is darker — so luminance is a serviceable height field, and the
 * relief lines up with the colour by construction. A real PBR set would ship a
 * measured height map; this costs one Sobel pass and no download.
 */
function normalFrom(source: HTMLCanvasElement, strength: number): THREE.Texture {
  const { ctx, el } = canvas()
  const from = source.getContext('2d')
  if (!from) return toTexture(el, false)

  const src = from.getImageData(0, 0, SIZE, SIZE).data
  const out = ctx.createImageData(SIZE, SIZE)

  // Luminance up front: the Sobel below reads nine neighbours per pixel, so
  // computing it inline would do the same work nine times over.
  const height = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < SIZE * SIZE; i++) {
    height[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255
  }

  // Wrapped sampling. These textures tile, so reading past an edge has to come
  // back around — clamping instead leaves a visible seam of flat normal down
  // every repeat boundary.
  const at = (x: number, y: number) =>
    height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))

      // Z is fixed at 1 and the gradients are scaled against it, so `strength`
      // is literally how steep the relief is.
      const nx = dx * strength
      const ny = dy * strength
      const length = Math.hypot(nx, ny, 1)

      const at4 = (y * SIZE + x) * 4
      // Encoded from [-1,1] to [0,1]: a flat surface is the familiar (128,128,255).
      out.data[at4] = ((nx / length) * 0.5 + 0.5) * 255
      out.data[at4 + 1] = ((ny / length) * 0.5 + 0.5) * 255
      out.data[at4 + 2] = ((1 / length) * 0.5 + 0.5) * 255
      out.data[at4 + 3] = 255
    }
  }

  ctx.putImageData(out, 0, 0)
  // Never sRGB. A normal map is three encoded vector components; decoding it as
  // colour bends every normal toward the surface and the relief goes slack.
  return toTexture(el, false)
}

/** Deterministic noise, so a rebuild does not reshuffle every surface. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

// ---- Generators ------------------------------------------------------------

/** Plank flooring: long boards with grain, a seam every plank, subtle tone drift. */
function woodFloor(): { map: THREE.Texture; roughness: THREE.Texture } {
  const { ctx, el } = canvas()
  const random = seeded(7)

  const PLANKS = 6
  const plankHeight = SIZE / PLANKS

  for (let i = 0; i < PLANKS; i++) {
    // Each board a slightly different tone — a floor of identical boards
    // reads as wallpaper.
    const shade = 34 + random() * 16
    ctx.fillStyle = `hsl(28, 38%, ${shade}%)`
    ctx.fillRect(0, i * plankHeight, SIZE, plankHeight)

    // Grain: long, low-contrast strokes along the board.
    ctx.strokeStyle = `hsla(26, 40%, ${shade - 9}%, .5)`
    ctx.lineWidth = 1
    for (let g = 0; g < 26; g++) {
      const y = i * plankHeight + random() * plankHeight
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.bezierCurveTo(SIZE * 0.3, y + (random() - 0.5) * 5, SIZE * 0.7, y + (random() - 0.5) * 5, SIZE, y)
      ctx.stroke()
    }

    // The seam between boards.
    ctx.fillStyle = 'rgba(0,0,0,.30)'
    ctx.fillRect(0, i * plankHeight, SIZE, 1.5)

    // Staggered butt joint, so the boards do not all end in a line.
    const joint = random() * SIZE
    ctx.fillRect(joint, i * plankHeight, 1.5, plankHeight)
  }

  // Roughness: seams and grain are rougher than the board face, which is what
  // makes a highlight break across a plank instead of sliding over it.
  const rough = canvas()
  rough.ctx.fillStyle = '#9a9a9a'
  rough.ctx.fillRect(0, 0, SIZE, SIZE)
  rough.ctx.drawImage(el, 0, 0)
  rough.ctx.globalCompositeOperation = 'saturation'
  rough.ctx.fillStyle = '#808080'
  rough.ctx.fillRect(0, 0, SIZE, SIZE)

  return { map: toTexture(el, true), roughness: toTexture(rough.el, false) }
}

/** Painted plaster: near-flat, with just enough tonal drift to catch light. */
function plaster(hue: number, lightness: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const { ctx, el } = canvas()
  const random = seeded(19)

  ctx.fillStyle = `hsl(${hue}, 12%, ${lightness}%)`
  ctx.fillRect(0, 0, SIZE, SIZE)

  // Broad, very soft mottling. Anything crisp here reads as dirt.
  for (let i = 0; i < 90; i++) {
    const r = 40 + random() * 90
    const x = random() * SIZE
    const y = random() * SIZE
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r)
    const delta = (random() - 0.5) * 5
    gradient.addColorStop(0, `hsla(${hue}, 12%, ${lightness + delta}%, .5)`)
    gradient.addColorStop(1, `hsla(${hue}, 12%, ${lightness + delta}%, 0)`)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  const rough = canvas()
  rough.ctx.fillStyle = '#d4d4d4' // matt emulsion
  rough.ctx.fillRect(0, 0, SIZE, SIZE)

  return { map: toTexture(el, true), roughness: toTexture(rough.el, false) }
}

/** Large-format tile with grout lines — kitchens, bathrooms, balconies. */
function tile(): { map: THREE.Texture; roughness: THREE.Texture } {
  const { ctx, el } = canvas()
  const random = seeded(43)

  const TILES = 4
  const size = SIZE / TILES
  const grout = 3

  ctx.fillStyle = '#b9b4ad'
  ctx.fillRect(0, 0, SIZE, SIZE)

  for (let x = 0; x < TILES; x++) {
    for (let y = 0; y < TILES; y++) {
      const shade = 79 + random() * 7
      ctx.fillStyle = `hsl(35, 8%, ${shade}%)`
      ctx.fillRect(x * size + grout, y * size + grout, size - grout * 2, size - grout * 2)

      // Faint veining, so a wall of tiles is not a grid of identical squares.
      ctx.strokeStyle = `hsla(35, 10%, ${shade - 11}%, .5)`
      ctx.lineWidth = 1
      for (let v = 0; v < 3; v++) {
        ctx.beginPath()
        ctx.moveTo(x * size + random() * size, y * size)
        ctx.lineTo(x * size + random() * size, y * size + size)
        ctx.stroke()
      }
    }
  }

  // Grout is matt; the tile face is polished. That contrast is most of what
  // makes tile look like tile under a moving camera.
  const rough = canvas()
  rough.ctx.fillStyle = '#c8c8c8'
  rough.ctx.fillRect(0, 0, SIZE, SIZE)
  rough.ctx.fillStyle = '#2e2e2e'
  for (let x = 0; x < TILES; x++) {
    for (let y = 0; y < TILES; y++) {
      rough.ctx.fillRect(x * size + grout, y * size + grout, size - grout * 2, size - grout * 2)
    }
  }

  return { map: toTexture(el, true), roughness: toTexture(rough.el, false) }
}

/** Woven fabric, for upholstery. */
/**
 * Turf.
 *
 * ── Why not `fabric` with a green hue ───────────────────────────────────────
 * That was the first attempt and it is wrong in a way worth recording: `fabric`
 * fixes saturation at 14%, which is right for undyed linen and makes grass look
 * like a dust sheet. A lawn's whole visual signature is that it is SATURATED and
 * unevenly so — mown bands, wear, and blades catching light at different angles.
 *
 * Blades are drawn as short strokes at scattered angles rather than as noise,
 * because at grazing angles a lawn's texture is directional; uniform noise reads
 * as carpet.
 */
function turf(): { map: THREE.Texture; roughness: THREE.Texture } {
  const { ctx, el } = canvas()
  const random = seeded(41)

  ctx.fillStyle = 'hsl(96, 34%, 30%)'
  ctx.fillRect(0, 0, SIZE, SIZE)

  // Broad tonal drift first: mown bands and dry patches, under the blades.
  for (let i = 0; i < 90; i++) {
    const r = 30 + random() * 80
    ctx.fillStyle = `hsla(${88 + random() * 20}, ${28 + random() * 16}%, ${24 + random() * 14}%, .35)`
    ctx.beginPath()
    ctx.arc(random() * SIZE, random() * SIZE, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.lineWidth = 1
  for (let i = 0; i < 5200; i++) {
    const x = random() * SIZE
    const y = random() * SIZE
    const length = 3 + random() * 5
    const angle = -Math.PI / 2 + (random() - 0.5) * 1.1
    ctx.strokeStyle = `hsla(${92 + random() * 22}, ${34 + random() * 22}%, ${22 + random() * 24}%, .75)`
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
    ctx.stroke()
  }

  const map = toTexture(el, true)

  // Grass is uniformly matt. The variation that matters is in the normal, not
  // in the gloss — a lawn with shiny patches reads as wet, permanently.
  const { ctx: rough, el: roughEl } = canvas()
  rough.fillStyle = '#e6e6e6'
  rough.fillRect(0, 0, SIZE, SIZE)

  return { map, roughness: toTexture(roughEl, false) }
}

function fabric(hue: number, lightness: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const { ctx, el } = canvas()

  ctx.fillStyle = `hsl(${hue}, 14%, ${lightness}%)`
  ctx.fillRect(0, 0, SIZE, SIZE)

  // A visible weave at close range; at walking distance it just softens the
  // surface, which is the point.
  const step = 4
  ctx.strokeStyle = `hsla(${hue}, 14%, ${lightness - 8}%, .55)`
  ctx.lineWidth = 1
  for (let i = 0; i < SIZE; i += step) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i, SIZE)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i + step / 2)
    ctx.lineTo(SIZE, i + step / 2)
    ctx.stroke()
  }

  const rough = canvas()
  rough.ctx.fillStyle = '#e8e8e8' // fabric scatters; almost no specular
  rough.ctx.fillRect(0, 0, SIZE, SIZE)

  return { map: toTexture(el, true), roughness: toTexture(rough.el, false) }
}

// ---- Material registry -----------------------------------------------------

/**
 * Every surface the studio can build.
 *
 * ── Why this is a value and not only a type ─────────────────────────────────
 * `SurfaceKind` was a bare union, so nothing at run time could enumerate it and
 * the test that checks every kind is accounted for had to keep its OWN
 * hand-written copy of the list. That test's whole purpose is to fail when a
 * kind is added and not wired up — and when three were added it passed, because
 * the list it checked against was the one nobody had updated either.
 *
 * Declared as a const array with the type derived from it, so the two cannot
 * disagree: adding a kind here is the only way to add one at all, and every
 * consumer sees it immediately.
 */
export const SURFACE_KINDS = [
  'floor-wood',
  'floor-tile',
  'wall',
  'ceiling',
  'fabric',
  'wood',
  'stone',
  'metal',
  'glass',
  'plant',
  'white',
  // ---- Outdoor -------------------------------------------------------------
  // A site is half the drawing on almost every residential project this tool
  // will see — the villa it was measured against is 125 m² indoor against
  // 128 m² outdoor — and until now nothing could be made of anything that
  // belongs outside a wall.
  'water',
  'grass',
  'paving',
  // ---- Wall build-ups ------------------------------------------------------
  // Every wall was plaster. A drawing that distinguishes a 230 mm brick
  // external from a 115 mm partition should be able to say so in the model, and
  // exposed brick and fair-faced concrete are both finishes people specify.
  'brick',
  'concrete',
] as const

export type SurfaceKind = (typeof SURFACE_KINDS)[number]

const cache = new Map<SurfaceKind, THREE.MeshStandardMaterial>()

/**
 * One material instance per surface kind, shared by every mesh that uses it.
 *
 * Three does not deduplicate materials. A room with two hundred objects each
 * holding its own would compile two hundred shader programs for what is really
 * a dozen, and the first frame would visibly stall.
 */
export function surface(kind: SurfaceKind): THREE.MeshStandardMaterial {
  const existing = cache.get(kind)
  if (existing) return existing

  const material = build(kind)
  cache.set(kind, material)
  return material
}

/**
 * Which surfaces this session has actually built.
 *
 * The cache is populated on demand by `surface()`, so its keys are precisely
 * the kinds some piece of geometry asked for — which is the honest answer to
 * "whose material is on this page". Listing the whole catalogue instead would
 * credit authors whose work is not in the scene, and deriving it from the plan
 * would duplicate the decisions the builders already made.
 *
 * Cumulative across rebuilds within a session: switching the floor finish
 * leaves both floors in the cache, so both get credited. That errs toward
 * naming an author too often, which is the safe direction for an attribution
 * obligation.
 */
export function usedSurfaces(): SurfaceKind[] {
  return [...cache.keys()]
}

function build(kind: SurfaceKind): THREE.MeshStandardMaterial {
  if (!CAN_DRAW) {
    return new THREE.MeshStandardMaterial({
      color: FLAT[kind] ?? 0xb0b6be,
      roughness: kind === 'metal' ? 0.32 : kind === 'glass' ? 0.05 : 0.85,
      metalness: kind === 'metal' ? 0.85 : 0,
      transparent: kind === 'glass',
      opacity: kind === 'glass' ? 0.22 : 1,
    })
  }

  /**
   * Assemble a textured PBR material.
   *
   * All three maps share one repeat, always. They are generated from the same
   * canvas and describe the same surface, so any mismatch means the grain,
   * the shine and the relief drift apart across a wall — which looks like
   * nothing in particular and is very hard to trace back.
   *
   * `tilesPerMetre` is expressed as metres-per-tile at the call sites because
   * that is how the decision is actually made ("planks repeat every 1.2 m"),
   * and it keeps the scale identical in every room. A floor whose planks change
   * size between rooms is instantly wrong.
   */
  const textured = (
    map: THREE.Texture,
    roughness: THREE.Texture,
    repeat: number,
    normalStrength: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {},
  ): THREE.MeshStandardMaterial => {
    const normal = normalFrom(map.image as HTMLCanvasElement, normalStrength)
    for (const texture of [map, roughness, normal]) texture.repeat.set(repeat, repeat)

    return new THREE.MeshStandardMaterial({
      map,
      roughnessMap: roughness,
      normalMap: normal,
      roughness: 1,
      metalness: 0,
      ...extra,
    })
  }

  switch (kind) {
    case 'floor-wood': {
      const { map, roughness } = woodFloor()
      // Mild relief: planed timber is nearly flat, and the seams between
      // boards do most of the work.
      return textured(map, roughness, 1 / 1.2, 1.6)
    }
    case 'floor-tile': {
      const { map, roughness } = tile()
      // Strongest of the set: grout sits several millimetres below the tile
      // face, and that recess is what stops a tiled floor reading as a printed
      // grid.
      return textured(map, roughness, 1 / 2.4, 2.8)
    }
    case 'wall': {
      const { map, roughness } = plaster(38, 82)
      // Plaster stipple. Enough to break up a large flat wall under a raking
      // light, not enough to look like sandpaper.
      return textured(map, roughness, 1 / 3, 2.2)
    }
    case 'ceiling': {
      const { map, roughness } = plaster(0, 92)
      // Gentler than the walls: a painted ceiling is the flattest surface in
      // most rooms, and it is lit almost entirely by bounce.
      return textured(map, roughness, 1 / 3, 1.3)
    }
    case 'fabric': {
      // Warm oatmeal, not navy.
      //
      // A dark saturated blue is the wrong default for upholstery and badly
      // wrong for curtains: a 2.3 m panel of it beside a bright window becomes
      // the darkest thing in the frame, so the eye goes straight to it and
      // reads the room as a set of coloured blocks. Undyed linen is both the
      // commonest real finish and the one that lets everything else be seen.
      const { map, roughness } = fabric(34, 70)
      // The weave is the whole point of the material, so let it read.
      return textured(map, roughness, 2, 2.4)
    }
    case 'wood': {
      const { map, roughness } = woodFloor()
      return textured(map, roughness, 1, 1.6, { roughness: 0.85 })
    }
    case 'stone': {
      const { map, roughness } = tile()
      return textured(map, roughness, 0.5, 2.2, { roughness: 0.6 })
    }
    case 'metal':
      return new THREE.MeshStandardMaterial({ color: 0xb9c0cb, roughness: 0.32, metalness: 0.85 })
    case 'glass':
      return new THREE.MeshStandardMaterial({
        color: 0xcfe3ee,
        roughness: 0.05,
        metalness: 0,
        transparent: true,
        opacity: 0.22,
      })
    case 'plant':
      return new THREE.MeshStandardMaterial({ color: 0x4e7c42, roughness: 0.85, metalness: 0 })
    case 'white':
      return new THREE.MeshStandardMaterial({ color: 0xf1f3f6, roughness: 0.5, metalness: 0 })

    /**
     * Pool water.
     *
     * ── Why this is a shader property and not a photograph ────────────────
     * The same reason glass is. What makes water read as water is that you see
     * THROUGH it to a floor that is the wrong colour and the wrong distance
     * away, and that it throws a moving highlight. A photograph of water is a
     * photograph of whatever was under it that day, pinned flat.
     *
     * Near-zero roughness and a low opacity, so the pool floor shows through
     * and the sky lands on the surface as a specular sheet. Deliberately not
     * animated: a still pool in a plan view reads correctly, and a scrolling
     * normal map is a frame-rate cost paid on every scene that has one.
     */
    case 'water':
      return new THREE.MeshStandardMaterial({
        color: 0x2f7f9e,
        roughness: 0.04,
        metalness: 0.1,
        transparent: true,
        opacity: 0.72,
      })

    /**
     * Turf.
     *
     * Procedural because the hub has no grass — its texture harvest was
     * filtered to interiors, the same decision that left it with 301 indoor
     * HDRIs and no skies. A photographed lawn is a better answer and is one
     * `hub.mjs fetch ambientcg:Grass###` away; this is the honest stand-in
     * until someone takes it.
     */
    case 'grass': {
      const { map, roughness } = turf()
      return textured(map, roughness, 1 / 1.5, 2.4, { roughness: 0.95 })
    }

    /**
     * Paving.
     *
     * Reuses the tile generator at a coarser repeat: a paving slab is 600 mm
     * where a floor tile is 300, and the grout between them is wider and
     * deeper. `catalogue/surfaces` can replace this with photographed
     * PavingStones, of which the hub has eighteen.
     */
    case 'paving': {
      const { map, roughness } = tile()
      return textured(map, roughness, 1 / 1.2, 3, { roughness: 0.9 })
    }

    /**
     * Exposed brickwork.
     *
     * The procedural stand-in reuses the tile generator, which draws a grid
     * rather than a running bond — wrong in the detail and right in the thing
     * that matters at room distance, which is the scale and direction of the
     * courses. `catalogue/surfaces` replaces it with photographed brick.
     */
    case 'brick': {
      const { map, roughness } = tile()
      return textured(map, roughness, 1 / 0.9, 3.4, { roughness: 0.95 })
    }

    /**
     * Fair-faced concrete.
     *
     * Plaster's generator at a coarser repeat and lower relief: concrete is
     * plaster's near neighbour visually — an even mineral surface with fine
     * variation — and differs mostly in tone and in having almost no texture at
     * all.
     */
    case 'concrete': {
      const { map, roughness } = plaster(210, 62)
      return textured(map, roughness, 1 / 2, 0.9, { roughness: 0.92 })
    }
  }
}

/** Release every generated texture and material. Called on viewer teardown. */
export function disposeSurfaces(): void {
  for (const material of cache.values()) {
    material.map?.dispose()
    material.roughnessMap?.dispose()
    // Every textured surface here also carries a normal map — `normalFrom`
    // derives one for each, and `catalogue/surfaceUpgrade` replaces it with a
    // photographed one. Omitting it leaked a third of the textures this module
    // creates, and three does not free GPU memory on its own.
    material.normalMap?.dispose()
    material.dispose()
  }
  cache.clear()
}
