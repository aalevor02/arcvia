import { useEffect, useState } from 'react'
import type { SceneViewer } from '@arcvia/viewer'
import { uploadImage } from '../lib/api'
import {
  slugId,
  upsertView,
  removeView,
  reorderView,
  removeHotspot,
  type Hotspot,
  type Presentation,
  type SceneView,
} from '../plan/presentation'

interface Props {
  viewer: SceneViewer | null
  presentation: Presentation
  onChange: (next: Presentation) => void
  /** True while the author is picking a point in the 3D view for a hotspot. */
  placing: boolean
  onPlacingChange: (placing: boolean) => void
  /** The declared SBUA in m², or null while none has been entered. */
  sbua: number | null
  onSbuaChange: (next: number | null) => void
}

/**
 * Authoring the presentation: named views, hotspots, branding.
 *
 * ── Why this is a separate panel and not part of Render ─────────────────────
 * Rendering is about how the scene *looks*. This is about how it is *shown* —
 * where a client is taken, what they are told, whose name is on it. They are
 * used at different points: you light a scene once and then arrange the
 * presentation repeatedly, per client, without touching the lighting.
 */
export default function PresentationPanel({
  viewer,
  presentation,
  onChange,
  placing,
  onPlacingChange,
  sbua,
  onSbuaChange,
}: Props) {
  const [viewName, setViewName] = useState('')
  // Typed freely, committed on blur — half-typed numbers must not be saved.
  const [sbuaDraft, setSbuaDraft] = useState(sbua === null ? '' : String(sbua))

  // The stored figure arrives after mount, with the scene.
  useEffect(() => {
    setSbuaDraft(sbua === null ? '' : String(sbua))
  }, [sbua])

  function commitSbua() {
    const value = Number(sbuaDraft)
    if (sbuaDraft.trim() === '' || !Number.isFinite(value) || value <= 0) {
      setSbuaDraft('')
      onSbuaChange(null)
      return
    }
    onSbuaChange(value)
  }

  const { views, hotspots, branding } = presentation

  function captureView() {
    if (!viewer) return

    // Named from the box, or numbered. Numbering from the count rather than
    // from a running counter means deleting "View 2" and capturing again
    // reuses the name, which is what someone tidying up expects.
    const name = viewName.trim() || `View ${views.length + 1}`
    onChange({ ...presentation, views: upsertView(views, viewer.currentView(name)) })
    setViewName('')
  }

  return (
    <>
      <section>
        <span className="eyebrow">Views</span>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
          Move the camera where you want it, then capture. Clients get these as
          buttons, in this order.
        </p>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={viewName}
            placeholder="Kitchen"
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && captureView()}
            style={{ flex: 1, fontSize: 12 }}
          />
          <button className="btn" onClick={captureView} disabled={!viewer}>
            Capture
          </button>
        </div>

        {views.length === 0 ? (
          <p className="muted" style={{ fontSize: 11.5 }}>
            No views yet — the walkthrough will open on an overview.
          </p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {views.map((view: SceneView, index: number) => (
              <div key={view.id} className="stat" style={{ gap: 4 }}>
                <button
                  className="linklike"
                  style={{ flex: 1, textAlign: 'left', fontSize: 12.5 }}
                  onClick={() => viewer?.goToView(view)}
                  title="Go to this view"
                >
                  {view.name}
                </button>
                <button
                  className="btn btn-tiny"
                  disabled={index === 0}
                  onClick={() => onChange({ ...presentation, views: reorderView(views, view.id, -1) })}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="btn btn-tiny"
                  disabled={index === views.length - 1}
                  onClick={() => onChange({ ...presentation, views: reorderView(views, view.id, 1) })}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  className="btn btn-tiny"
                  onClick={() => onChange({ ...presentation, views: removeView(views, view.id) })}
                  title="Remove"
                >
                  ⌫
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <span className="eyebrow">Hotspots</span>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
          Labels pinned to the model — a finish, a dimension, a spec.
        </p>

        <button
          className={placing ? 'btn btn-primary' : 'btn'}
          style={{ width: '100%' }}
          onClick={() => onPlacingChange(!placing)}
          disabled={!viewer}
        >
          {placing ? 'Click a surface… (Esc to stop)' : 'Add a hotspot'}
        </button>

        {hotspots.map((hotspot: Hotspot) => (
          <div key={hotspot.id} style={{ marginTop: 8 }}>
            <div className="stat" style={{ gap: 4 }}>
              <input
                value={hotspot.title}
                onChange={(e) =>
                  onChange({
                    ...presentation,
                    hotspots: hotspots.map((h) =>
                      h.id === hotspot.id ? { ...h, title: e.target.value } : h,
                    ),
                  })
                }
                style={{ flex: 1, fontSize: 12 }}
              />
              <button
                className="btn btn-tiny"
                onClick={() =>
                  onChange({ ...presentation, hotspots: removeHotspot(hotspots, hotspot.id) })
                }
                title="Remove"
              >
                ⌫
              </button>
            </div>
            <input
              value={hotspot.body ?? ''}
              placeholder="Detail (optional)"
              onChange={(e) =>
                onChange({
                  ...presentation,
                  hotspots: hotspots.map((h) =>
                    h.id === hotspot.id ? { ...h, body: e.target.value } : h,
                  ),
                })
              }
              style={{ width: '100%', fontSize: 11.5, marginTop: 4 }}
            />
          </div>
        ))}
      </section>

      <section>
        <span className="eyebrow">Branding</span>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
          Per scene, not per account — an agency delivering to three developers
          needs three logos.
        </p>

        <label style={{ display: 'block', fontSize: 11.5, marginTop: 6 }}>
          Accent colour
          <input
            type="color"
            value={branding?.accent ?? '#2f6df6'}
            onChange={(e) =>
              onChange({
                ...presentation,
                branding: { ...(branding ?? {}), accent: e.target.value },
              })
            }
            style={{ display: 'block', width: '100%', height: 30, marginTop: 4 }}
          />
        </label>

        {/*
          The developer's logo, shown on the published page's top bar.

          ── The missing producer, again ──────────────────────────────────
          The published page has rendered `branding.logoUrl` since hotspots
          landed, and nothing anywhere could set it — the same shape as
          `hdriUrl` and `scene.credits`: a complete consumer, no producer.
          This is the producer. The file goes through the same upload route
          as floor plans, so the page serves it from the API like everything
          else it shows.
        */}
        <label style={{ display: 'block', fontSize: 11.5, marginTop: 8 }}>
          Developer logo
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              void uploadImage(file, file.name)
                .then((stored) =>
                  onChange({
                    ...presentation,
                    branding: { ...(branding ?? {}), logoUrl: stored.url },
                  }),
                )
                .catch(() => {
                  /* the save indicator already reports failed writes */
                })
            }}
            style={{ display: 'block', marginTop: 4, width: '100%' }}
          />
          {branding?.logoUrl ? (
            <span className="note" style={{ display: 'block', marginTop: 2 }}>
              Logo set.{' '}
              <button
                type="button"
                className="btn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() =>
                  onChange({
                    ...presentation,
                    branding: { ...(branding ?? {}), logoUrl: undefined },
                  })
                }
              >
                Remove
              </button>
            </span>
          ) : null}
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={Boolean(branding?.hideCredit)}
            onChange={(e) =>
              onChange({
                ...presentation,
                branding: { ...(branding ?? {}), hideCredit: e.target.checked },
              })
            }
          />
          <span style={{ fontSize: 12 }}>Hide the Arcvia credit</span>
        </label>
      </section>

      <section>
        <span className="eyebrow">Areas</span>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
          The plan gives a measured area (to wall centrelines). SBUA is a
          commercial figure only you can supply — the published page shows it
          under that name only once it is entered here.
        </p>
        <label style={{ display: 'block', fontSize: 11.5 }}>
          Super built-up area, m²
          <input
            type="number"
            min={0}
            step="0.01"
            value={sbuaDraft}
            placeholder="e.g. 417.99"
            onChange={(e) => setSbuaDraft(e.target.value)}
            onBlur={commitSbua}
          />
        </label>
      </section>
    </>
  )
}

/** Build a hotspot from a picked point, numbered so it is never nameless. */
export function hotspotAt(
  point: { x: number; y: number; z: number },
  existing: Hotspot[],
): Hotspot {
  const title = `Point ${existing.length + 1}`
  return {
    id: slugId(title, `hotspot-${existing.length + 1}`),
    title,
    position: [point.x, point.y, point.z],
  }
}
