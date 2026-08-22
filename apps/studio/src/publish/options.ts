import * as THREE from 'three'

import { buildObject } from '../catalogue/build'
import { CATALOGUE, itemById } from '../catalogue/items'
import { upgradeModels, modelsSettled } from '../catalogue/models'
import { exportGlb } from '../plan/exportGlb'
import { FLOOR_FINISHES, type FloorFinish, type Plan } from '../plan/types'
import { surfaceMapsFor, type SurfaceMaps } from '../catalogue/surfaces'
import type { PlacedObject } from '../catalogue/types'

/**
 * Client options — what a visitor may reconfigure on the published page.
 *
 * ── What this is, and the constraint that shapes all of it ──────────────────
 * The published walkthrough loads an exported GLB from the API's storage. It is
 * a different origin from the studio, and a visitor has no session — so every
 * texture a choice needs must be reachable from THAT page, which means stored
 * alongside the model, not referenced back into the studio's own /surfaces
 * directory. A configurator whose textures 404 for exactly the person it was
 * built for — the client — would be the worst version of the split-half
 * failure this repo keeps finding: it works in the studio, where nobody needs
 * it, and fails on the published page, where everybody does.
 *
 * So composing options is an act of PUBLISHING assets: each offered finish's
 * three maps are uploaded to the API (content-hashed, so re-saving is free) and
 * the option stores those URLs. The scene carries everything the page needs,
 * the same way it carries its credits.
 *
 * ── Why the choice list is authored, not automatic ──────────────────────────
 * Offering every finish to every client is a decision about somebody's product.
 * A developer selling a spec finish does not want a visitor turning the villa's
 * floors to concrete; one selling choice does. The author picks, per scene.
 */

/** One selectable finish, self-contained: everything the page needs to apply it. */
export interface FinishChoice {
  id: FloorFinish
  name: string
  /** Stored (API-served) URLs, uploaded at compose time. */
  maps: { color: string; roughness: string; normal: string }
  /** Metres one tile covers, so the page can keep texel density right. */
  tileMetres: number
  /** Attribution, same shape the credits system uses. */
  licence: string
  author: string
  source: string
}

export interface SceneOptions {
  flooring?: {
    label: string
    choices: FinishChoice[]
  }
  /**
   * Switchable objects: a placed object and the alternatives a visitor may
   * swap it for.
   *
   * ── Why the alternatives live in a SEPARATE GLB ─────────────────────────
   * glTF has no visibility flag, so a hidden variant exported into the main
   * model arrives visible — and the main model is exactly what the render
   * worker fetches for a PAID render. Variants riding in it would put two
   * sofas through each other in the output a client pays for.
   *
   * So the scene's model stays exactly what the author built, and the
   * alternatives are exported to their own file that only the published page
   * ever loads. The page toggles visibility between the original group and
   * the variant groups; nothing else in the product knows variants exist.
   */
  objects?: {
    /** Stored URL of the GLB holding every variant, positioned in place. */
    variantsUrl: string
    groups: ObjectOptionGroup[]
  }
}

export interface ObjectChoice {
  /** Catalogue item id, or 'original' for the object as placed. */
  id: string
  name: string
  licence?: string
  author?: string
  source?: string
}

export interface ObjectOptionGroup {
  /** The placed object this group switches. */
  objectId: string
  /** What the picker calls it — the item's name, or the author's label. */
  label: string
  /** Always starts with 'original'. */
  choices: ObjectChoice[]
}

/**
 * The finishes that CAN be offered.
 *
 * A procedural finish — grass is one — has no image files to upload: its maps
 * are drawn on a canvas at runtime inside the studio. The published page cannot
 * run that generator, so offering it would produce a button that does nothing.
 * Excluded here, once, rather than guarded in three places.
 */
export function offerableFinishes(): { id: FloorFinish; name: string; maps: SurfaceMaps }[] {
  const out: { id: FloorFinish; name: string; maps: SurfaceMaps }[] = []
  for (const finish of FLOOR_FINISHES) {
    const maps = surfaceMapsFor(finish.id)
    if (maps) out.push({ id: finish.id, name: finish.name, maps })
  }
  return out
}

/**
 * Compose the stored options for a set of offered finishes.
 *
 * `upload` is injected rather than imported so this stays a pure module the
 * test suite can exercise without a server: the studio passes the real
 * uploader, the test passes a recorder.
 */
export async function composeFlooringOptions(
  offered: FloorFinish[],
  upload: (studioUrl: string) => Promise<string>,
): Promise<SceneOptions['flooring'] | undefined> {
  const available = offerableFinishes()
  const chosen = available.filter((finish) => offered.includes(finish.id))

  // One choice is not a choice. A panel with a single button reads as a broken
  // panel, so the option only exists once there are genuinely alternatives.
  if (chosen.length < 2) return undefined

  const choices: FinishChoice[] = []
  for (const finish of chosen) {
    const { maps } = finish
    choices.push({
      id: finish.id,
      name: finish.name,
      maps: {
        // Uploaded one by one rather than Promise.all: the API stores by
        // content hash, so repeats are cheap, and three concurrent multipart
        // posts per finish against a laptop server buys nothing but log noise.
        color: await upload(maps.map),
        roughness: await upload(maps.roughnessMap),
        normal: await upload(maps.normalMap),
      },
      tileMetres: maps.tileMetres,
      licence: maps.licence,
      author: maps.author,
      source: maps.source,
    })
  }

  return { label: 'Flooring', choices }
}

/**
 * The name a variant's group carries inside the variants GLB.
 *
 * No punctuation the exporter could eat: the colon in `object:o1` measurably
 * does not survive export, so this scheme is alphanumerics and underscores
 * only, and the page matches names with punctuation stripped from both sides
 * anyway.
 */
export const variantGroupId = (objectId: string, itemId: string): string =>
  `variant_${objectId}_${itemId}`

/**
 * Alternatives worth offering for one placed object: same category, has a
 * model, is not the item itself.
 *
 * Same category because that is what "an alternative" means on a plan — a
 * visitor choosing between sofas, not between a sofa and a wardrobe — and has
 * a model because a parametric stand-in swapped in next to real furniture
 * reads as a bug, not a choice.
 */
export function alternativesFor(itemId: string): { id: string; name: string }[] {
  const item = itemById(itemId)
  if (!item) return []
  return CATALOGUE.filter(
    (candidate) =>
      candidate.category === item.category && candidate.id !== itemId && Boolean(candidate.model),
  ).map((candidate) => ({ id: candidate.id, name: candidate.name }))
}

/**
 * Build, export and upload the variants GLB, and describe its groups.
 *
 * Each alternative is built through the studio's own `buildObject` at the
 * original's exact position, rotation and elevation, then upgraded to its real
 * model through the same call the editor makes — so a variant IS what placing
 * that item there would have produced, not an approximation of it.
 *
 * ── One honest limitation, stated rather than discovered ────────────────────
 * Variants carry no baked lightmap: the bake ran over the scene as built, and
 * these objects were not in it. In a baked walkthrough a swapped-in variant is
 * lit by the dimmed real-time rig, so it reads slightly flatter than the
 * furniture around it. Fixing that properly means baking per variant
 * combination, which is a render-farm feature, not a page one.
 */
export async function composeObjectOptions(
  plan: Plan,
  wanted: { objectId: string; alternatives: string[] }[],
  uploadGlb: (blob: Blob) => Promise<string>,
): Promise<SceneOptions['objects'] | undefined> {
  // Resolve each requested object against the plan it actually sits on.
  const placedById = new Map<string, { object: PlacedObject; elevation: number }>()
  for (const floor of plan.floors) {
    for (const object of Object.values(floor.objects)) {
      placedById.set(object.id, { object, elevation: floor.elevation })
    }
  }

  const scene = new THREE.Scene()
  const groups: ObjectOptionGroup[] = []

  for (const request of wanted) {
    const placed = placedById.get(request.objectId)
    if (!placed) continue

    const original = itemById(placed.object.item)
    if (!original) continue

    const choices: ObjectChoice[] = [{ id: 'original', name: original.name }]

    for (const itemId of request.alternatives) {
      const item = itemById(itemId)
      // Silently dropping a request is the failure this repo collects, but so
      // is shipping a button for an item that no longer exists. Skip AND keep
      // going: the group survives with the alternatives that are real.
      if (!item || !item.model) continue

      const variant = buildObject(
        {
          ...placed.object,
          id: variantGroupId(request.objectId, itemId),
          item: itemId,
          // The alternative keeps ITS OWN catalogue size — a visitor comparing
          // a 2.1 m sofa with a 1.5 m one should see the difference, not two
          // objects stretched to agree.
          size: undefined,
        },
        placed.elevation,
      )
      if (!variant) continue

      scene.add(variant)
      choices.push({
        id: itemId,
        name: item.name,
        licence: item.model.licence,
        author: item.model.author,
        source: item.model.source,
      })
    }

    if (choices.length > 1) {
      groups.push({
        objectId: request.objectId,
        label: placed.object.label ?? original.name,
        choices,
      })
    }
  }

  if (groups.length === 0) return undefined

  // Real models, through the same calls the editor makes.
  await upgradeModels(scene)
  await modelsSettled()

  const { blob } = await exportGlb(scene)
  const variantsUrl = await uploadGlb(blob)

  return { variantsUrl, groups }
}
