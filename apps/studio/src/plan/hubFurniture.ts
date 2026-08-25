import type { AssetModel, CatalogueItem } from '../catalogue/types'
import { placeInMeasuredRoom } from './designFurnish'
import type { Proposal } from './furnish'

/**
 * Turn one unresolved render observation into a normal reviewed proposal.
 *
 * The Hub model supplies appearance and provenance; a real catalogue item
 * supplies physical size, attachment class, 2D symbol, and the fallback shown
 * while the GLB loads. That split is the safety gate: conditioning alone does
 * not prove that a mesh is a chair, how large it should be, or where it hangs.
 *
 * Wall and ceiling templates require the measured room context carried by the
 * render proposal. Older/legacy rows without it may still resolve to a floor
 * template at their existing in-room position, but can never fabricate an
 * attachment target.
 */
export function resolveHubFurniture(
  proposal: Proposal,
  template: CatalogueItem,
  model: AssetModel,
  assetName: string,
  attachmentIndex?: number,
): Proposal | null {
  if (!proposal.reviewOnly || proposal.evidence !== 'unresolved') return null
  if (template.placement === 'in-wall') return null
  if (!model.url || !model.licence || !model.author || !model.source) return null

  const measured = proposal.placementContext
    ? placeInMeasuredRoom(template, proposal.placementContext, attachmentIndex)
    : null
  if (template.placement !== 'floor' && !measured) return null

  const observed = proposal.observedItem?.trim()
  const chosen = assetName.trim() || template.name
  return {
    ...proposal,
    item: template.id,
    position: measured?.position ?? proposal.position,
    rotation: measured?.rotation ?? proposal.rotation,
    reviewOnly: false,
    evidence: 'rendered',
    customModel: model,
    label: observed || chosen,
    confidence: Math.max(0.6, proposal.confidence),
    because: `${proposal.because}; reviewed as ${template.name} using ${chosen}`,
  }
}
