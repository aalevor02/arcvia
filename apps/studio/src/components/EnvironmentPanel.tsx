import type { SceneViewer } from '@arcvia/viewer'

import {
  ENVIRONMENTS,
  ENVIRONMENT_KINDS,
  environmentByUrl,
  type EnvironmentPreset,
} from '../catalogue/environments'

interface Props {
  viewer: SceneViewer | null
  /** The scene's stored `hdriUrl`, or null while it has never been set. */
  value: string | null
  onChange: (url: string | null) => void
}

/**
 * Choosing the light a scene is seen and rendered in.
 *
 * ── Why this panel is the whole point of the environment catalogue ──────────
 * `hdriUrl` was persisted on the scene, forwarded by the API, fetched by the
 * worker and loaded into a real Blender world — and nothing anywhere wrote it.
 * Every layer of the feature existed except the one that lets a person choose,
 * so `apply_environment` took its no-environment branch on every render this
 * product had ever done. This is that missing half.
 *
 * ── Why it stores a URL rather than an id ───────────────────────────────────
 * The scene already has a `hdriUrl` field that the render worker reads, and it
 * is a URL because the worker resolves it to a file on disk. Storing an id here
 * and translating would put the catalogue between the studio and the renderer
 * for no gain, and would silently drop any environment not in the catalogue —
 * an uploaded one, later.
 *
 * `environmentByUrl` therefore returns undefined rather than throwing for a URL
 * that is not one of ours: that is a scene lit by something else, not an error.
 *
 * ── Why the preview is a thumbnail and not a swatch ─────────────────────────
 * These are photographs of places. "Golden hour" and "Sunset" are two warm low
 * suns and no colour chip distinguishes them, but the pictures do instantly —
 * which is the same reason the ingest tool ships a tone-mapped preview beside
 * every map.
 */
export default function EnvironmentPanel({ viewer, value, onChange }: Props) {
  const current = environmentByUrl(value)

  function pick(preset: EnvironmentPreset) {
    // Persist first so the choice survives a reload even if the viewer is not
    // up yet — this panel renders before the canvas has finished initialising.
    onChange(preset.url)

    // `loadEnvironment` resolves false when the map could not be loaded, having
    // kept whatever was lighting the scene. Nothing to undo here: the selection
    // is what the scene is *set* to, and the viewer failing to show it is a
    // rendering problem rather than a reason to forget what the user chose.
    void viewer?.loadEnvironment(preset.url)
  }

  return (
    <section>
      <span className="eyebrow">Environment</span>

      {ENVIRONMENT_KINDS.map(({ id, label }) => {
        const group = ENVIRONMENTS.filter((preset) => preset.kind === id)
        if (group.length === 0) return null

        return (
          <div key={id} style={{ marginTop: 8 }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              {label}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {group.map((preset) => {
                const selected = current?.id === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => pick(preset)}
                    // The note says what the light *does*, so it is worth having
                    // on hover as well as the name.
                    title={`${preset.name} — ${preset.note}`}
                    aria-pressed={selected}
                    style={{
                      padding: 0,
                      border: selected ? '2px solid var(--accent)' : '1px solid var(--line)',
                      borderRadius: 4,
                      overflow: 'hidden',
                      background: 'none',
                      cursor: 'pointer',
                      display: 'block',
                      textAlign: 'left',
                    }}
                  >
                    <img
                      src={preset.thumbnail}
                      alt=""
                      loading="lazy"
                      style={{ display: 'block', width: '100%', aspectRatio: '2 / 1' }}
                    />
                    <span
                      style={{
                        display: 'block',
                        padding: '3px 5px',
                        fontSize: 11,
                        lineHeight: 1.2,
                      }}
                    >
                      {preset.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {current ? (
        <p className="hint" style={{ marginTop: 8 }}>
          {current.note}
          {current.sun ? (
            <>
              {' '}
              Sun {current.sun.elevation.toFixed(0)}&deg; above the horizon.
            </>
          ) : (
            ' No direct sun, so nothing casts a hard shadow.'
          )}
        </p>
      ) : (
        // Said rather than left blank. A scene with no environment renders
        // against the worker's default sky, and that is worth knowing before
        // someone pays for a render and wonders where the light came from.
        <p className="hint" style={{ marginTop: 8 }}>
          No environment chosen. Renders use a plain default sky.
        </p>
      )}

      {/* All twelve are CC0 today and owe nobody, but the panel says where they
          came from rather than presenting them as this product's own. */}
      {current ? (
        <p className="hint" style={{ marginTop: 4, opacity: 0.75 }}>
          {current.author} &middot; {current.licence}
        </p>
      ) : null}
    </section>
  )
}
