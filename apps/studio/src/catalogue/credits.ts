import { environmentByUrl } from './environments'
import { itemById } from './items'
import { surfaceMapsFor } from './surfaces'
import type { AssetModel, PlacedObject } from './types'

/**
 * Who has to be credited for what is in a scene.
 *
 * ── Why this is code and not a checklist ────────────────────────────────────
 * Nearly every free architectural model is CC-BY: usable commercially, on
 * condition the author is named. Nothing enforces it. The model loads, the room
 * renders, the client is delighted, and the obligation goes unmet on a page now
 * published on the open web — with the author's name still in the file
 * metadata, which is how these things get noticed.
 *
 * Deriving the credit list from the scene, every time it is published, is the
 * only version that cannot drift. A human-maintained list is wrong the first
 * time somebody swaps a sofa.
 */

export interface Credit extends AssetModel {
  /** How many placements in this scene use it, for "x3" in the list. */
  uses: number
  /**
   * What kind of asset owes the credit.
   *
   * A scene's obligations do not all come from its furniture, and treating
   * them as if they did is what left environments and surfaces uncredited for
   * as long as they existed.
   */
  kind: 'model' | 'environment' | 'surface'
}

/**
 * The scene's assets that are not placed objects.
 *
 * ── Why these have to be passed in ──────────────────────────────────────────
 * A model is in the scene because someone placed it, so the placement list is
 * the whole truth about the furniture. The environment and the surfaces are
 * not placed: the environment is one field on the scene, and the surfaces are
 * shared materials bound by whatever geometry got built. Neither is discoverable
 * from `objects`, which is exactly why both went uncredited.
 */
export interface SceneAssets {
  /** The scene's `hdriUrl`, if one has been chosen. */
  environmentUrl?: string | null
  /**
   * Surface kinds this scene actually built materials for.
   *
   * `usedSurfaces()` in plan/materials.ts reports them: the material cache is
   * populated on demand, so its keys are precisely the surfaces the geometry
   * asked for. Crediting the catalogue instead would name authors whose work is
   * not on the page.
   */
  surfaces?: readonly string[]
}

/**
 * Credits for everything placed on the given floors.
 *
 * Deduplicated by URL, because forty dining chairs are one obligation and one
 * line, not forty. Sorted by author so the list reads as a list of people
 * rather than a list of furniture — which is what a credit is for.
 */
export function creditsFor(objects: PlacedObject[], assets: SceneAssets = {}): Credit[] {
  const byUrl = new Map<string, Credit>()

  for (const object of objects) {
    // A per-placement override has no catalogue entry behind it and therefore
    // no licence on record. It is deliberately *not* silently credited to the
    // catalogue item it replaced — that would attach one author's name to
    // another author's work, which is worse than omitting it.
    if (object.customUrl) continue

    const model = itemById(object.item)?.model
    if (!model) continue

    const existing = byUrl.get(model.url)
    if (existing) existing.uses += 1
    else byUrl.set(model.url, { ...model, uses: 1, kind: 'model' })
  }

  // The environment lights every frame of the walkthrough, so it is used by the
  // scene rather than by any object in it. One entry, however many rooms.
  const environment = environmentByUrl(assets.environmentUrl ?? null)
  if (environment && !byUrl.has(environment.url)) {
    byUrl.set(environment.url, {
      url: environment.url,
      licence: environment.licence,
      author: environment.author,
      source: environment.source,
      uses: 1,
      kind: 'environment',
    })
  }

  for (const kind of assets.surfaces ?? []) {
    const surface = surfaceMapsFor(kind as never)
    if (!surface) continue

    // ── Keyed on the SOURCE, not on the file ──────────────────────────────
    // The identity of an obligation is the asset it is owed for, and the
    // ingest tool writes one set of files per surface *id* rather than per
    // source material. `wall` and `ceiling` are both Plaster001 and have
    // different map URLs, so keying on the file credited one author twice for
    // one asset — caught by the assertion below in credits.test.ts, not by
    // anything at runtime.
    //
    // Models keep using their own URL because two GLBs are two assets even
    // when one person made both, and the page links each to its own source.
    if (byUrl.has(surface.source)) {
      byUrl.get(surface.source)!.uses += 1
      continue
    }
    byUrl.set(surface.source, {
      url: surface.map,
      licence: surface.licence,
      author: surface.author,
      source: surface.source,
      uses: 1,
      kind: 'surface',
    })
  }

  return [...byUrl.values()].sort((a, b) =>
    a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Placements using a model nobody can be credited for.
 *
 * Surfaced rather than blocked: someone dropping in their own GLB of their own
 * product does not owe anyone a credit, and refusing to publish would be wrong.
 * But "we could not identify a licence for 3 models" is worth saying before a
 * page goes public, because the other reason to see this message is that
 * somebody pasted a URL they found.
 */
export function uncredited(objects: PlacedObject[]): PlacedObject[] {
  return objects.filter((object) => Boolean(object.customUrl))
}

/**
 * The credit list as a single line of plain text.
 *
 * For places that cannot render a panel — an export footer, a PDF, an embed.
 * Licence names are included per author because a scene routinely mixes CC-BY
 * with CC0 and with a bought library, and a blanket "CC-BY" across the lot
 * would be a false statement about the ones that are not.
 */
export function creditLine(credits: Credit[]): string {
  if (credits.length === 0) return ''
  return credits.map((c) => `${c.author} (${c.licence})`).join(' · ')
}
