import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
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
 * thousands of licence-clean assets — and it is browse-only on purpose.
 * Placing a raw hub model would put a 300k-triangle scan with 4K textures
 * into a scene every visitor downloads; the way an asset earns placement is
 * through the ingest pipeline, which sizes and decimates it first.
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

export function HubBrowserPanel() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string>('model')
  const [cc0Only, setCc0Only] = useState(false)
  const [page, setPage] = useState<{ total: number; assets: HubAsset[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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
    <section>
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
            {page?.assets.map((asset) => <HubRow key={asset.ref} asset={asset} />)}
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
            The warehouse behind the catalogue — browse and take a conditioned
            GLB. Placing in scenes stays catalogue-only, where sizes and
            credits are guaranteed.
          </p>
        </div>
      </details>
    </section>
  )
}

function HubRow({ asset }: { asset: HubAsset }) {
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
            disabled={state === 'working'}
            onClick={() => void getGlb()}
            title="Condition to web budget and download"
          >
            {state === 'working' ? 'Conditioning…' : 'Get GLB'}
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
