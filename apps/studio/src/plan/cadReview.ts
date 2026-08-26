import type { CadSummary, CadVerifyCheck, CadWallLayerSummary } from '../lib/api'

const LEVEL_RANK: Record<CadVerifyCheck['level'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
}

/**
 * Findings the reviewer must see before accepting a reconstruction.
 *
 * Blocking checks normally fail the server-side job before it reaches Studio,
 * but keeping them here makes the client safe if a stored or older job includes
 * one. Informational measurements remain available separately and never force
 * an extra decision.
 */
export function cadReviewChecks(
  summary: CadSummary | null,
  includeInfo = false,
): CadVerifyCheck[] {
  return (summary?.verifyChecks ?? [])
    .filter((check) => includeInfo || check.level !== 'info')
    .slice()
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
}

export function cadReviewRequired(summary: CadSummary | null): boolean {
  return cadReviewChecks(summary).length > 0
}

/** Largest source-layer contributions to the wall run under review. */
export function cadWallLayers(
  summary: CadSummary | null,
  limit = 5,
): CadWallLayerSummary[] {
  return [...(summary?.wallLayers ?? [])]
    .filter((layer) => Number.isFinite(layer.billableLength) && layer.billableLength > 0)
    .sort((a, b) =>
      b.indoorLength - a.indoorLength ||
      b.billableLength - a.billableLength ||
      a.layer.localeCompare(b.layer))
    .slice(0, Math.max(0, limit))
}
