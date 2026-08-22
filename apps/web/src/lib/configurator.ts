import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * The client-side configurator: switching finishes on a published walkthrough.
 *
 * ── What arrives, and what can be done with it ──────────────────────────────
 * The page loads an exported GLB. Its meshes keep the names the studio gave
 * them — `slab:<roomId>`, `wall:<wallId>`, `ceiling:<roomId>` — which is the
 * entire contract this module runs on: a finish choice is applied to every
 * mesh whose name says it is a floor slab. No ids are exchanged, no schema
 * links the GLB to the options; the names ARE the schema.
 *
 * ⚠ Half of them, anyway. Names survive export; their PUNCTUATION does not.
 * Measured on a real round trip: `slab:room…` comes back as `slabroom…` — the
 * exporter strips the colon, and a prefix match written against the studio's
 * naming never fires on the published page. It failed silently: the picker
 * rendered, the click did nothing, and every texture had loaded perfectly.
 * So the match is on the bare word, which survives both spellings.
 *
 * The textures each choice needs were uploaded to the API when the author
 * composed the options (see the studio's `publish/options.ts`), so everything
 * here is same-origin with the model and needs no session.
 *
 * ── The three texture details that silently break this ─────────────────────
 * Each is invisible in code review and obvious on screen, so they are named:
 *
 *   flipY      glTF textures are not flipped; `TextureLoader` flips by
 *              default. Leave it and every swapped floor is mirrored top to
 *              bottom — grain runs the wrong way, nobody can say why.
 *   colorSpace the colour map is sRGB and must be decoded; roughness and
 *              normal maps are data and must NOT be, or the floor goes
 *              plastic-smooth and the relief goes slack. Same rule the studio
 *              applies, restated here because this code cannot import it.
 *   repeat     slab UVs are in metres (the extrude uses plan coordinates), so
 *              the correct repeat is exactly 1/tileMetres — absolute, not
 *              relative to whatever the outgoing texture wore.
 *
 * ── What is deliberately left alone ─────────────────────────────────────────
 * `lightMap`. A baked scene carries its lighting in a second channel, and a
 * finish switch that discarded the bake would turn the room flat the moment a
 * visitor touched anything. Only map, roughnessMap and normalMap move.
 */

export interface FinishChoice {
  id: string
  name: string
  maps: { color: string; roughness: string; normal: string }
  tileMetres: number
  licence: string
  author: string
  source: string
}

export interface ObjectChoice {
  id: string
  name: string
  licence?: string
  author?: string
  source?: string
}

export interface ObjectOptionGroup {
  objectId: string
  label: string
  choices: ObjectChoice[]
}

export interface SceneOptions {
  flooring?: { label: string; choices: FinishChoice[] }
  objects?: { variantsUrl: string; groups: ObjectOptionGroup[] }
}

/**
 * Names compared with punctuation stripped from BOTH sides.
 *
 * The exporter's sanitizer eats some characters and keeps others — the colon
 * in `object:o1` dies, the commas in a room id survive — and which is which is
 * an implementation detail of three.js. Normalising both sides makes the match
 * immune to whatever it decides.
 */
const normalise = (name: string): string => name.replace(/[^a-zA-Z0-9]/g, '')

const loader = new THREE.TextureLoader()

/** Loaded textures by URL, so flicking between two choices is instant. */
const cache = new Map<string, Promise<THREE.Texture>>()

function load(url: string, srgb: boolean, repeat: number): Promise<THREE.Texture> {
  const key = `${url}@${repeat}|${srgb}`
  const existing = cache.get(key)
  if (existing) return existing

  const loading = loader.loadAsync(url).then((texture) => {
    texture.flipY = false
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(repeat, repeat)
    texture.anisotropy = 8
    return texture
  })
  cache.set(key, loading)
  return loading
}

/** Every distinct material worn by a mesh whose name starts with the prefix. */
function materialsUnder(root: THREE.Object3D, prefix: string): THREE.MeshStandardMaterial[] {
  const found = new Set<THREE.MeshStandardMaterial>()
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    // The exporter may hang the name on the mesh or on a parent node it
    // created; checking the chain costs nothing and misses nothing.
    let node: THREE.Object3D | null = child
    let matches = false
    while (node) {
      if (node.name.startsWith(prefix)) {
        matches = true
        break
      }
      node = node.parent
    }
    if (!matches) return

    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) found.add(material)
    }
  })
  return [...found]
}

/**
 * Apply one finish to every floor slab in the model.
 *
 * All three maps arrive before anything changes: a floor wearing the new
 * colour under the old relief for half a second reads as a glitch, and on a
 * slow connection half a second is optimistic.
 *
 * Resolves false — leaving the scene as it was — if any texture fails.
 */
export async function applyFlooring(
  root: THREE.Object3D,
  choice: FinishChoice,
  resolveUrl: (url: string) => string,
): Promise<boolean> {
  const repeat = choice.tileMetres > 0 ? 1 / choice.tileMetres : 1

  let color: THREE.Texture
  let roughness: THREE.Texture
  let normal: THREE.Texture
  try {
    ;[color, roughness, normal] = await Promise.all([
      load(resolveUrl(choice.maps.color), true, repeat),
      load(resolveUrl(choice.maps.roughness), false, repeat),
      load(resolveUrl(choice.maps.normal), false, repeat),
    ])
  } catch {
    // Keep what is on screen. A visitor who taps a broken choice should see
    // the room unchanged, not a floor with holes in it.
    return false
  }

  const materials = materialsUnder(root, 'slab')
  if (materials.length === 0) return false

  for (const material of materials) {
    material.map = color
    material.roughnessMap = roughness
    material.normalMap = normal
    // The maps replace the finish; the bake, if there is one, stays.
    material.needsUpdate = true
  }
  return true
}

/** The variants GLB, loaded once, the first time a visitor switches anything. */
let variantsRoot: Promise<THREE.Object3D | null> | null = null

function ensureVariants(url: string, attach: THREE.Object3D): Promise<THREE.Object3D | null> {
  if (variantsRoot) return variantsRoot
  variantsRoot = new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      // Everything arrives visible — glTF has no visibility flag, which is the
      // whole reason variants live in their own file. Hide the lot before the
      // scene ever renders them; choices reveal one at a time.
      gltf.scene.traverse((child) => {
        if (normalise(child.name).startsWith('objectvariant')) child.visible = false
      })
      attach.add(gltf.scene)
      return gltf.scene as THREE.Object3D
    })
    .catch(() => {
      // The original furniture is still on screen and still correct. A picker
      // that cannot fetch its variants degrades to a scene without options,
      // not to a scene with holes.
      variantsRoot = null
      return null
    })
  return variantsRoot
}

/**
 * Show one choice of an object group and hide the others.
 *
 * The original is a group in the MAIN model named `object:<id>`; each variant
 * is a group in the variants file named `object:variant_<id>_<item>` (built
 * through the same builder, hence the same prefix). Visibility is the entire
 * mechanism: geometry never moves, materials never change, and the bake on the
 * original — if there is one — is exactly as the author left it.
 */
export function applyObjectChoice(
  root: THREE.Object3D,
  variants: THREE.Object3D,
  group: ObjectOptionGroup,
  choiceId: string,
): void {
  const originalName = normalise(`object${group.objectId}`)
  root.traverse((child) => {
    if (normalise(child.name) === originalName) child.visible = choiceId === 'original'
  })

  for (const choice of group.choices) {
    if (choice.id === 'original') continue
    const variantName = normalise(`objectvariant_${group.objectId}_${choice.id}`)
    variants.traverse((child) => {
      if (normalise(child.name) === variantName) child.visible = choice.id === choiceId
    })
  }
}

/**
 * Build the picker and wire it to the viewer.
 *
 * Plain DOM, no framework — this runs inside the published page, which is an
 * Astro island of vanilla script, and a dependency added here is shipped to
 * every client walkthrough ever published.
 */
export function mountConfigurator(
  container: HTMLElement,
  options: SceneOptions,
  getRoot: () => THREE.Object3D | null,
  resolveUrl: (url: string) => string,
  onApplied?: () => void,
): void {
  const flooring = options.flooring
  const objects = options.objects
  const hasFlooring = Boolean(flooring && flooring.choices.length >= 2)
  const hasObjects = Boolean(objects && objects.groups.length > 0)
  if (!hasFlooring && !hasObjects) return

  const wrap = document.createElement('div')
  wrap.className = 'configurator'

  if (hasObjects && objects) {
    for (const group of objects.groups) {
      const row = document.createElement('div')
      row.className = 'configurator-row'

      const rowLabel = document.createElement('span')
      rowLabel.className = 'configurator-label'
      rowLabel.textContent = group.label
      row.appendChild(rowLabel)

      let pressed: HTMLButtonElement | null = null

      for (const choice of group.choices) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = choice.name
        button.setAttribute('aria-pressed', String(choice.id === 'original'))
        if (choice.id === 'original') pressed = button
        if (choice.author) {
          button.title = `${choice.name} — ${choice.author}${choice.licence ? ` (${choice.licence})` : ''}`
        }

        button.addEventListener('click', () => {
          const root = getRoot()
          if (!root) return
          button.disabled = true
          void ensureVariants(resolveUrl(objects.variantsUrl), root).then((variants) => {
            button.disabled = false
            if (!variants) return
            applyObjectChoice(root, variants, group, choice.id)
            pressed?.setAttribute('aria-pressed', 'false')
            button.setAttribute('aria-pressed', 'true')
            pressed = button
            onApplied?.()
          })
        })

        row.appendChild(button)
      }
      wrap.appendChild(row)
    }
  }

  if (!hasFlooring || !flooring) {
    container.appendChild(wrap)
    return
  }

  const label = document.createElement('span')
  label.className = 'configurator-label'
  label.textContent = flooring.label
  wrap.appendChild(label)

  let active: HTMLButtonElement | null = null

  for (const choice of flooring.choices) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = choice.name
    button.setAttribute('aria-pressed', 'false')
    // The credit rides on the control itself: hovering "Marble" says whose
    // marble, which keeps the attribution honest without a second panel.
    button.title = `${choice.name} — ${choice.author} (${choice.licence})`

    button.addEventListener('click', () => {
      const root = getRoot()
      if (!root) return
      button.disabled = true
      void applyFlooring(root, choice, resolveUrl).then((applied) => {
        button.disabled = false
        if (!applied) return
        // Pressed state follows what is actually on screen, not what was
        // clicked — a failed load must not move the highlight.
        active?.setAttribute('aria-pressed', 'false')
        button.setAttribute('aria-pressed', 'true')
        active = button
        onApplied?.()
      })
    })

    wrap.appendChild(button)
  }

  container.appendChild(wrap)
}
