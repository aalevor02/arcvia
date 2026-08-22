import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  createScene,
  deleteScene,
  duplicateScene,
  listScenes,
  siteOrigin,
  uniqueName,
  type SceneListItem,
} from '../lib/api'
import { NewProjectDialog, type ProjectStart } from '../components/NewProjectDialog'

type Sort = 'modified' | 'name'

interface Props {
  onOpen(id: string, start?: ProjectStart): void
  /**
   * Open the publisher.
   *
   * A separate destination rather than an action on a project, because a
   * published site is made of several of them — putting it on a row would
   * imply one building is one client site, which is the misunderstanding the
   * publisher exists to fix.
   */
  onPublish(): void
}

/**
 * The project list — what you land on after signing in.
 *
 * Mirrors the reference's dashboard (name / last modified / published / more
 * actions, with search and sort) because that is a good design for the job, and
 * because anyone moving between the two products should not have to relearn it.
 */
export default function Dashboard({ onOpen, onPublish }: Props) {
  const [scenes, setScenes] = useState<SceneListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('modified')
  const [ascending, setAscending] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  /**
   * True when the list failed because the session is gone, not because the
   * request failed.
   *
   * Worth distinguishing: everything else is worth retrying, and this one
   * cannot be — there is no sign-in form in the studio and there should not be.
   */
  const [signedOut, setSignedOut] = useState(false)

  const refresh = () =>
    listScenes()
      .then((list) => {
        setScenes(list)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load projects.')
        setSignedOut(err instanceof ApiError && err.status === 401)
        // Stop the list loading. Leaving `scenes` null renders "Loading…"
        // underneath the error forever, which tells the user two different
        // things at once — the request is still going, and it already failed.
        setScenes([])
      })

  useEffect(() => {
    void refresh()
  }, [])

  const visible = useMemo(() => {
    if (!scenes) return []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? scenes.filter((s) => s.name.toLowerCase().includes(needle))
      : scenes

    const sorted = [...filtered].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : a.updatedAt.localeCompare(b.updatedAt),
    )
    return ascending ? sorted : sorted.reverse()
  }, [scenes, query, sort, ascending])

  async function handleCreate(start: ProjectStart, name: string) {
    setBusy('create')
    try {
      const scene = await createScene(
        uniqueName(name.trim(), (scenes ?? []).map((s) => s.name)),
      )
      setDialog(false)
      // Every start lands in the same editor — the choice selects the editor's
      // opening state, not a different screen. Routing them apart would
      // duplicate the whole editor to vary one first action.
      onOpen(scene.id, start)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.')
    } finally {
      setBusy(null)
    }
  }

  async function handleDuplicate(scene: SceneListItem) {
    setBusy(scene.id)
    try {
      await duplicateScene(scene, scenes ?? [])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not duplicate.')
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(id: string) {
    setBusy(id)
    try {
      await deleteScene(id)
      setConfirmDelete(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-body">
        <div className="dashboard-inner">
          <div className="dashboard-head">
            <div>
              <h1>Your projects</h1>
              <p className="muted" style={{ marginTop: 6 }}>
                Pick up where you left off, or start something new.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onPublish}>
                Publish a site
              </button>
              <button className="btn btn-primary" onClick={() => setDialog(true)}>
                + Create new project
              </button>
            </div>
          </div>

          <div className="search">
            <input
              type="search"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search projects"
            />
          </div>

          {error && (
            <div className="alert alert-error" role="alert" style={{ marginTop: 16 }}>
              <p style={{ margin: 0 }}>{error}</p>
              {/*
                Sign-in lives on the marketing site, deliberately — one flow,
                one place for reset and rate limiting, and the hand-off carries
                the session back here. But a message saying "sign in again"
                with nothing to click is a dead end, because there is no form
                on this origin and no way for the user to know that.
              */}
              {signedOut && (
                <p style={{ margin: '8px 0 0' }}>
                  <a className="btn btn-primary" href={`${siteOrigin()}/login/`}>
                    Sign in
                  </a>
                </p>
              )}
            </div>
          )}

          <div className="table">
            <div className="row row-head">
              <span>Project</span>
              <button
                onClick={() => {
                  if (sort === 'modified') setAscending((v) => !v)
                  else {
                    setSort('modified')
                    setAscending(false)
                  }
                }}
                style={{ textAlign: 'left', font: 'inherit', letterSpacing: 'inherit' }}
                aria-label={`Sort by last modified, ${ascending ? 'oldest' : 'newest'} first`}
              >
                Last modified {sort === 'modified' ? (ascending ? '↑' : '↓') : ''}
              </button>
              <span>Published</span>
              <span style={{ textAlign: 'right' }}>Actions</span>
            </div>

            {scenes === null ? (
              <div className="empty">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="empty">
                <strong>{query ? 'No projects match that' : 'No projects yet'}</strong>
                {query ? 'Try a different search.' : 'Create one to get started.'}
              </div>
            ) : (
              visible.map((scene) => (
                <div key={scene.id} className="row row-item">
                  <span className="row-name">
                    <button onClick={() => onOpen(scene.id)}>{scene.name}</button>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {scene.floorCount > 0
                        ? `${scene.floorCount} floor${scene.floorCount === 1 ? '' : 's'}`
                        : 'Empty'}
                    </span>
                  </span>

                  <span className="muted mono" style={{ fontSize: 12 }}>
                    {formatWhen(scene.updatedAt)}
                  </span>

                  <span>
                    {scene.published ? (
                      <span className="pill pill-live">● Live</span>
                    ) : (
                      <span className="pill">Draft</span>
                    )}
                  </span>

                  <span className="row-actions">
                    {confirmDelete === scene.id ? (
                      <>
                        <button
                          className="icon-btn btn-danger"
                          disabled={busy === scene.id}
                          onClick={() => void handleDelete(scene.id)}
                        >
                          Confirm
                        </button>
                        <button className="icon-btn" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="icon-btn"
                          disabled={busy === scene.id}
                          onClick={() => void handleDuplicate(scene)}
                          title="Duplicate this project"
                        >
                          Duplicate
                        </button>
                        {/* Two-step, because deleting a project takes the plan
                            with it and there is no undo across a reload. */}
                        <button
                          className="icon-btn btn-danger"
                          onClick={() => setConfirmDelete(scene.id)}
                          title="Delete this project"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {dialog && (
        <NewProjectDialog
          busy={busy === 'create'}
          onCancel={() => setDialog(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}

/**
 * Relative for anything recent, absolute once it stops being useful.
 *
 * "3 days ago" is what you want on a project you touched this week; "12 Mar
 * 2026" is what you want on one from last year, because by then the relative
 * form ("11 months ago") has stopped carrying information.
 */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'

  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} d ago`

  return new Date(then).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
