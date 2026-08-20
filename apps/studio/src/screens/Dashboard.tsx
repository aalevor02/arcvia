import { useEffect, useMemo, useState } from 'react'
import {
  createScene,
  deleteScene,
  duplicateScene,
  listScenes,
  uniqueName,
  type SceneListItem,
} from '../lib/api'
import { NewProjectDialog, type ProjectStart } from '../components/NewProjectDialog'

type Sort = 'modified' | 'name'

interface Props {
  onOpen(id: string, start?: ProjectStart): void
}

/**
 * The project list — what you land on after signing in.
 *
 * Mirrors the reference's dashboard (name / last modified / published / more
 * actions, with search and sort) because that is a good design for the job, and
 * because anyone moving between the two products should not have to relearn it.
 */
export default function Dashboard({ onOpen }: Props) {
  const [scenes, setScenes] = useState<SceneListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('modified')
  const [ascending, setAscending] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = () =>
    listScenes()
      .then((list) => {
        setScenes(list)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load projects.'))

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
            <button className="btn btn-primary" onClick={() => setDialog(true)}>
              + Create new project
            </button>
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
            <p className="alert alert-error" role="alert" style={{ marginTop: 16 }}>
              {error}
            </p>
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
