import { itemById } from './items'
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
}

/**
 * Credits for everything placed on the given floors.
 *
 * Deduplicated by URL, because forty dining chairs are one obligation and one
 * line, not forty. Sorted by author so the list reads as a list of people
 * rather than a list of furniture — which is what a credit is for.
 */
export function creditsFor(objects: PlacedObject[]): Credit[] {
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
    else byUrl.set(model.url, { ...model, uses: 1 })
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
