import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { CATALOGUE } from '../catalogue/items'
import type { AssetModel, CatalogueItem } from '../catalogue/types'
import type { Proposal } from '../plan/furnish'
import { measuredPlacementChoices } from '../plan/designFurnish'
import {
  conditionHubModel,
  hubPreviewUrl,
  searchHub,
  type HubAsset,
} from '../lib/hubClient'

/**
 * Browse the whole asset hub without leaving the editor.
 *
 * ── What this is next to the catalogue ──────────────────────────────────────
 * The catalogue above is the storefront: forty-odd conditioned, sized,
 * credit-tracked objects you can place. This is the warehouse behind it —
 * thousands of licence-clean assets. A raw hub model never enters a scene:
 * reviewed render items can choose one only after conditioning and after a
 * catalogue template supplies real dimensions, placement, and a fallback.
 *
 * What you CAN take away is a conditioned GLB: "Get GLB" asks the API to run
 * the same conditioner the catalogue uses, capped to web budgets, cached
 * server-side. The heavy scans the conditioner cannot land are refused with
 * the reason rather than attempted.
 *
 * Loaded on demand and shown collapsed: most editing sessions never open the
 * warehouse, and a closed <details> costs nothing — no fetch, no images.
 */

const KINDS = ['model', 'material', 'texture', 'hdri', 'audio'] as const
const PAGE = 30
type PlaceablePlacement = Exclude<CatalogueItem['placement'], 'in-wall'>
type PlaceableTemplate = CatalogueItem & { placement: PlaceablePlacement }

function isPlaceableTemplate(item: CatalogueItem): item is PlaceableTemplate {
  return item.placement !== 'in-wall'
}

const PLACEABLE_TEMPLATES = CATALOGUE
  .filter(isPlaceableTemplate)
  .sort((a, b) =>
    a.placement.localeCompare(b.placement) || a.name.localeCompare(b.name),
  )
const PLACEMENT_NAME = {
  floor: 'Floor',
  wall: 'Wall',
  ceiling: 'Ceiling',
} as const

export interface HubUse {
  target: Proposal
  template: CatalogueItem
  asset: HubAsset
  model: AssetModel
  attachmentIndex?: number
}

interface Props {
  target?: Proposal | null
  onUse?(selection: HubUse): void
  onCancelTarget?(): void
}

export function HubBrowserPanel({ target = null, onUse, onCancelTarget }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string>('model')
  const [cc0Only, setCc0Only] = useState(false)
  const [page, setPage] = useState<{ total: number; assets: HubAsset[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [attachmentId, setAttachmentId] = useState('')
  const template = PLACEABLE_TEMPLATES.find((item) => item.id === templateId) ?? null
  const attachmentChoices = template && target?.placementContext
    ? measuredPlacementChoices(template, target.placementContext)
    : []
  const needsAttachment = template?.placement === 'wall' || template?.placement === 'ceiling'
  const attachmentIndex = attachmentId === '' ? undefined : Number(attachmentId)

  useEffect(() => {
    if (!target) return
    setOpen(true)
    setKind('model')
    setQuery(target.hubQuery || target.observedItem || '')
    setTemplateId('')
    setAttachmentId('')
    requestAnimationFrame(() =>
      document.getElementById('asset-hub-panel')?.scrollIntoView({ behavior: 'smooth' }),
    )
  }, [target?.item, target?.room, target?.designKey])

  // Debounced: the hub answers from a cached manifest, but a keystroke per
  // request is still a request per keystroke.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      searchHub({
        q: query || undefined,
        kind: kind || undefined,
        licence: cc0Only ? 'cc0' : undefined,
        limit: PAGE,
      })
        .then((result) => {
          if (cancelled) return
          setPage(result)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setPage(null)
          setError(
            err instanceof ApiError && err.status === 503
              ? 'The asset hub is not on this machine.'
              : err instanceof Error
                ? err.message
                : 'Could not reach the hub.',
          )
        })
        .finally(() => !cancelled && setLoading(false))
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, kind, cc0Only])

  const loadMore = async () => {
    if (!page) return
    const more = await searchHub({
      q: query || undefined,
      kind: kind || undefined,
      licence: cc0Only ? 'cc0' : undefined,
      limit: PAGE,
      offset: page.assets.length,
    })
    setPage({ total: more.total, assets: [...page.assets, ...more.assets] })
  }

  return (
    <section id="asset-hub-panel">
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary style={{ cursor: 'pointer' }}>
          <span className="eyebrow">Asset hub</span>
          {page && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
              {page.total.toLocaleString()} match
            </span>
          )}
        </summary>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {target && (
            <div className="alert" style={{ fontSize: 11.5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>Choose a model for {target.observedItem || 'this render item'}</strong>
                <button className="btn" style={{ fontSize: 10, padding: '1px 5px' }} onClick={onCancelTarget}>
                  Cancel
                </button>
              </div>
              <label style={{ display: 'block', marginTop: 6 }}>
                <span className="muted">Use catalogue size and attachment type</span>
                <select
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value)
                    setAttachmentId('')
                  }}
                  aria-label="Catalogue size and placement template"
                  style={{ display: 'block', width: '100%', marginTop: 3 }}
                >
                  <option value="">Choose the matching object type...</option>
                  {PLACEABLE_TEMPLATES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {PLACEMENT_NAME[item.placement]} - {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {needsAttachment && (
                <label style={{ display: 'block', marginTop: 6 }}>
                  <span className="muted">
                    Choose measured {template?.placement === 'wall' ? 'wall face' : 'ceiling point'}
                  </span>
                  <select
                    value={attachmentId}
                    onChange={(e) => setAttachmentId(e.target.value)}
                    aria-label="Measured attachment target"
                    style={{ display: 'block', width: '100%', marginTop: 3 }}
                  >
                    <option value="">Choose the exact target...</option>
                    {attachmentChoices.map((choice) => (
                      <option key={choice.index} value={choice.index}>{choice.label}</option>
                    ))}
                  </select>
                  {attachmentChoices.length === 0 && (
                    <span className="muted" style={{ display: 'block', marginTop: 3 }}>
                      No measured target in this room can fit that template.
                    </span>
                  )}
                </label>
              )}
              <span className="muted" style={{ display: 'block', marginTop: 4 }}>
                The template supplies real dimensions and a measured floor,
                wall, or ceiling placement; the Hub model supplies appearance
                and licence provenance.
              </span>
            </div>
          )}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the whole hub…"
            aria-label="Search the asset hub"
          />

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label style={{ fontSize: 11.5, display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={cc0Only}
                onChange={(e) => setCc0Only(e.target.checked)}
              />
              CC0 only
            </label>
          </div>

          {error && (
            <p className="muted" style={{ fontSize: 12 }}>
              {error}
            </p>
          )}

          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 320, overflowY: 'auto' }}
          >
            {page?.assets.map((asset) => (
              <HubRow
                key={asset.ref}
                asset={asset}
                target={target}
                template={template}
                attachmentIndex={attachmentIndex}
                needsAttachment={needsAttachment}
                onUse={onUse}
              />
            ))}
            {page && page.assets.length === 0 && !loading && (
              <p className="muted" style={{ fontSize: 12 }}>
                Nothing in the hub matches that.
              </p>
            )}
          </div>

          {page && page.assets.length < page.total && (
            <button className="btn" style={{ fontSize: 11.5 }} onClick={() => void loadMore()}>
              Show {Math.min(PAGE, page.total - page.assets.length)} more of{' '}
              {(page.total - page.assets.length).toLocaleString()}
            </button>
          )}

          <p className="muted" style={{ fontSize: 11 }}>
            Browse or download a conditioned GLB. A render-review choice can
            also use one here after you supply a known catalogue footprint;
            dimensions and credits remain explicit.
          </p>
        </div>
      </details>
    </section>
  )
}

function HubRow({
  asset,
  target,
  template,
  attachmentIndex,
  needsAttachment,
  onUse,
}: {
  asset: HubAsset
  target: Proposal | null
  template: CatalogueItem | null
  attachmentIndex?: number
  needsAttachment: boolean
  onUse?: (selection: HubUse) => void
}) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle')
  const [note, setNote] = useState<string | null>(null)
  // Written once on failure and left: a preview that 404s once will 404 again.
  const failed = useRef(false)
  const [showImage, setShowImage] = useState(true)

  const getGlb = async () => {
    setState('working')
    setNote(null)
    try {
      const result = await conditionHubModel(asset.ref)
      setState('idle')
      setNote(`${(result.bytes / 1024).toFixed(0)} KB${result.cached ? ' (cached)' : ''}`)
      if (target && template && onUse) {
        onUse({ target, template, asset, model: result.model, attachmentIndex })
        return
      }
      // A plain navigation, not an anchor download attribute: the URL is
      // cross-origin (the API), and `download` is ignored cross-origin anyway.
      window.open(result.url, '_blank')
    } catch (err) {
      setState('failed')
      setNote(err instanceof Error ? err.message : 'Conditioning failed.')
    }
  }

  return (
    <div
      className="catalogue-row"
      style={{ display: 'flex', alignItems: 'center', flexDirection: 'row', gap: 9 }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'block',
          flex: 'none',
          width: 46,
          height: 35,
          borderRadius: 5,
          background: 'var(--panel-alt)',
          overflow: 'hidden',
        }}
      >
        {showImage && (
          <img
            src={hubPreviewUrl(asset)}
            alt=""
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => {
              if (!failed.current) {
                failed.current = true
                setShowImage(false)
              }
            }}
          />
        )}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {asset.name}
          </span>
          <span className="pill" style={{ fontSize: 10, flex: 'none' }}>
            {asset.licence.toUpperCase()}
          </span>
        </span>
        <span className="muted mono" style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {asset.source}
          {asset.polycount ? ` · ${(asset.polycount / 1000).toFixed(0)}k tris` : ''}
          {note ? ` · ${note}` : ''}
        </span>
      </span>

      <span style={{ display: 'flex', gap: 7, flex: 'none', alignItems: 'center' }}>
        {asset.kind === 'model' && (
          <button
            className="btn"
            style={{ fontSize: 10.5, padding: '2px 7px' }}
            disabled={state === 'working' || Boolean(
              target && (!template || (needsAttachment && attachmentIndex === undefined)),
            )}
            onClick={() => void getGlb()}
            title={target && (!template || (needsAttachment && attachmentIndex === undefined))
              ? needsAttachment && template
                ? 'Choose the measured attachment target first'
                : 'Choose the matching catalogue object type first'
              : target
                ? `Condition and use for ${target.observedItem || 'the reviewed item'}`
                : 'Condition to web budget and download'}
          >
            {state === 'working' ? 'Conditioning...' : target ? 'Use this' : 'Get GLB'}
          </button>
        )}
        <a
          href={asset.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="muted"
          style={{ fontSize: 10.5 }}
          title="Open the source page"
        >
          ↗
        </a>
      </span>
    </div>
  )
}
