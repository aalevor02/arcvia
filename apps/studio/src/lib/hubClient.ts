import { apiBase, request } from './api'

/**
 * The asset hub, from the editor's side of the glass.
 *
 * The hub is this machine's licence-gated asset warehouse — thousands of
 * CC0/CC-BY models, materials and HDRIs. The editor browses it read-only:
 * search, previews, licence, and one write-shaped action — asking the API to
 * condition a model down to web budgets and hand back a URL. Nothing here
 * places hub assets into scenes; the catalogue stays the only source of
 * placeable objects, because everything in it has been sized, decimated and
 * credit-tracked, and hub assets have not.
 */

export interface HubAsset {
  ref: string
  name: string
  kind: 'model' | 'material' | 'texture' | 'hdri' | 'audio'
  source: string
  sourceUrl: string
  licence: string
  licenceName: string
  attribution: boolean
  authors: string[]
  polycount: number | null
  path: string
  previewUrl: string
}

export interface HubPage {
  total: number
  updated: string
  assets: HubAsset[]
}

export interface HubSearch {
  q?: string
  kind?: string
  source?: string
  licence?: 'cc0' | 'credit'
  limit?: number
  offset?: number
}

export function searchHub(params: HubSearch): Promise<HubPage> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return request<HubPage>(`/assets/hub?${query}`)
}

/** Absolute URL for an asset's preview image — for an <img src>. */
export const hubPreviewUrl = (asset: HubAsset): string => `${apiBase}${asset.previewUrl}`

export interface Conditioned {
  url: string
  triangles: number | null
  bytes: number
  cached: boolean
}

/**
 * Ask the API to condition one hub model to a web budget.
 *
 * Instant on a cache hit; otherwise a real Blender run, tens of seconds, and
 * queued behind any other conditioning in flight — the caller should show
 * that honestly rather than spin as if it were a fetch.
 */
export async function conditionHubModel(ref: string, budget?: number): Promise<Conditioned> {
  const result = await request<Conditioned>('/assets/hub/condition', {
    method: 'POST',
    body: { ref, budget },
  })
  return { ...result, url: `${apiBase}${result.url}` }
}
