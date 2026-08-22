import { FLOOR_FINISHES, type FloorFinish } from '../plan/types'
import { surfaceMapsFor, type SurfaceMaps } from '../catalogue/surfaces'

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
