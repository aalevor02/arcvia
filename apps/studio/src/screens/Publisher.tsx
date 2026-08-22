import { useEffect, useState } from 'react'
import type { Project } from '@arcvia/publication'

import {
  createPublication,
  deletePublication,
  getPublication,
  getScene,
  listPublications,
  listScenes,
  publishPublication,
  siteOrigin,
  unpublishPublication,
  updatePublication,
  type PublicationListItem,
  type SceneListItem,
} from '../lib/api'
import { composeProject, type TypeInput } from '../publish/compose'

/**
 * Composing and publishing the site a client opens.
 *
 * ── What this screen is for ─────────────────────────────────────────────────
 * A scene is one building. What an architect hands over is a project: several
 * unit types, a master plan, and the copy that surrounds them. This is where
 * those are put together and where the link is made.
 *
 * ── Why composing is a button and not something that happens on save ────────
 * Composing reads the drawings and rewrites every room schedule. That is the
 * right behaviour and it must be deliberate, because it discards anything a
 * person changed by hand and because it reports things they need to read —
 * unnamed rooms, unclassified rooms, an area that is measured rather than
 * certified. A step that quietly rewrites a document and hides its warnings is
 * worse than one nobody ran.
 */

/** The authored half: fields no drawing can supply. */
const COPY_FIELDS = [
  { key: 'script', label: 'Script name', hint: 'The italic word in the logo — "Casa" in "Casa Altinho".' },
  { key: 'place', label: 'Place', hint: 'Shown beside the name. "Saipem, Goa".' },
  { key: 'tagline', label: 'Tagline', hint: 'One line. Also used as the page description.' },
  { key: 'developer', label: 'Developer', hint: 'Who is selling it.' },
  { key: 'developerNote', label: 'Developer note', hint: 'The line above the developer, e.g. "Developed by".' },
  { key: 'rera', label: 'RERA number', hint: 'Printed in the footer. A regulator will look for it.' },
  { key: 'architect', label: 'Architect', hint: 'Credited in the footer.' },
  { key: 'disclaimer', label: 'Disclaimer', hint: 'The small print under everything.' },
] as const

interface Props {
  onBack: () => void
}

export default function Publisher({ onBack }: Props) {
  const [publications, setPublications] = useState<PublicationListItem[] | null>(null)
  const [scenes, setScenes] = useState<SceneListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [copy, setCopy] = useState<Partial<Project>>({})
  const [contacts, setContacts] = useState<{ region: string; name: string; phone: string }[]>([])
  /** Scene id → what to call that unit type on the published page. */
  const [types, setTypes] = useState<{ sceneId: string; name: string; summary: string }[]>([])

  const [warnings, setWarnings] = useState<string[] | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState(false)
  const [slug, setSlug] = useState('')
  const [newName, setNewName] = useState('')
  /** Two-step delete, matching the dashboard's. No native dialog. */
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    void listPublications().then(setPublications).catch(() => setPublications([]))
    void listScenes().then(setScenes).catch(() => setScenes([]))
  }, [])

  /** Load one publication into the form. */
  async function open(id: string) {
    setSelectedId(id)
    setWarnings(null)
    setStatus('')
    try {
      const publication = await getPublication(id)
      setName(publication.name)
      setPublished(publication.published)
      setSlug(publication.slug)

      const project = publication.project
      setCopy(project ?? {})
      setContacts(project?.contacts ?? [])
      // Unit types are reconstructed from the composed project rather than
      // stored separately, so the form always reflects what was actually
      // published rather than an intention that was never composed.
      setTypes(
        (project?.villaTypes ?? []).map((type) => ({
          // The scene a type came from is not recorded on the published payload
          // — it is a studio concern and a client has no use for it. Matching
          // by name is a best effort; an unmatched one is left blank so the
          // author can point it at the right scene rather than silently
          // composing from the wrong one.
          sceneId: scenes.find((scene) => scene.name === type.name)?.id ?? '',
          name: type.name,
          summary: type.summary,
        })),
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open that project.')
    }
  }

  /**
   * Create, from an inline field rather than `window.prompt`.
   *
   * The dashboard's delete does the same thing with its own confirm state, and
   * for the same two reasons: a native dialog cannot be styled to look like the
   * rest of the product, and it blocks the page — which stops anything driving
   * the studio, including the browser test that verifies this screen.
   */
  async function handleCreate() {
    const proposed = newName.trim()
    if (!proposed) return
    setBusy(true)
    try {
      const made = await createPublication(proposed)
      setNewName('')
      setPublications(await listPublications())
      await open(made.id)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not create that project.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Read the drawings, rebuild the schedules, save.
   *
   * The warnings are shown and kept on screen rather than logged: every one of
   * them is about a number or a name that will appear on a page a buyer reads.
   */
  async function handleCompose() {
    if (!selectedId) return
    setBusy(true)
    setStatus('Reading the drawings…')
    try {
      const chosen = types.filter((type) => type.sceneId && type.name.trim())
      if (chosen.length === 0) {
        setStatus('Add at least one unit type, and give it a scene and a name.')
        setWarnings(null)
        return
      }

      // Fetched one at a time rather than in parallel: this runs against a
      // laptop API and a project with six types would otherwise open six
      // concurrent reads of a full plan for no gain a person can perceive.
      const inputs: TypeInput[] = []
      for (const type of chosen) {
        const scene = await getScene(type.sceneId)
        inputs.push({
          scene: {
            id: scene.id,
            name: scene.name,
            plan: scene.plan,
            modelUrl: scene.modelUrl,
            hdriUrl: scene.hdriUrl,
            views: scene.views?.map((view) => ({
              id: view.id,
              name: view.name,
              position: view.position,
              rotation: view.rotation,
            })),
          },
          name: type.name.trim(),
          summary: type.summary,
        })
      }

      const { project, warnings: found } = composeProject(name, inputs, { ...copy, contacts })
      await updatePublication(selectedId, { project })

      setWarnings(found)
      setStatus(`Composed ${project.villaTypes.length} unit type(s) and saved.`)
      setPublications(await listPublications())
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not compose the project.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePublish() {
    if (!selectedId) return
    setBusy(true)
    try {
      const result = await publishPublication(selectedId)
      setPublished(true)
      setSlug(result.publication.slug)
      setStatus('Published.')
      setPublications(await listPublications())
    } catch (error) {
      // The API refuses to publish an uncomposed project, which is the message
      // worth surfacing verbatim — it tells the author exactly what to do next.
      setStatus(error instanceof Error ? error.message : 'Could not publish.')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnpublish() {
    if (!selectedId) return
    setBusy(true)
    try {
      await unpublishPublication(selectedId)
      setPublished(false)
      setStatus('Unpublished. The link is kept, so republishing returns the same address.')
      setPublications(await listPublications())
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!selectedId) return
    setBusy(true)
    try {
      await deletePublication(selectedId)
      setConfirmDelete(false)
      setSelectedId(null)
      setPublications(await listPublications())
      setStatus('Deleted.')
    } finally {
      setBusy(false)
    }
  }

  const clientUrl = slug ? new URL(`/p/${slug}/`, siteOrigin()).toString() : ''

  return (
    <div className="dashboard-inner">
      <div className="dashboard-head">
        <div>
          <h1 style={{ margin: 0 }}>Publish</h1>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            Put several buildings together into the site a client opens.
          </p>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={onBack}>
          Back to projects
        </button>
      </div>

      <div className="pub">
        {/* ---- The list ---- */}
        <section className="card pub-list">
          <span className="eyebrow">Projects</span>
          {publications === null ? (
            <p className="muted">Loading…</p>
          ) : publications.length === 0 ? (
            <p className="note">No published projects yet.</p>
          ) : (
            publications.map((publication) => (
              <button
                key={publication.id}
                className="btn pub-item"
                onClick={() => void open(publication.id)}
                style={{
                  borderColor: publication.id === selectedId ? 'var(--accent)' : undefined,
                }}
              >
                <span style={{ display: 'block' }}>{publication.name}</span>
                <span className="note">
                  {publication.unitTypes} type{publication.unitTypes === 1 ? '' : 's'}
                  {publication.published ? ' · live' : ' · draft'}
                </span>
              </button>
            ))
          )}
          <div className="pub-new">
            <input
              value={newName}
              placeholder="New project name"
              aria-label="New project name"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate()
              }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={busy || !newName.trim()}>
              Add
            </button>
          </div>
        </section>

        {/* ---- The one being edited ---- */}
        {selectedId === null ? (
          <section className="card">
            <p className="note">Choose a project on the left, or make one.</p>
          </section>
        ) : (
          <div>
            <div className="stat-strip">
              <div>
                <span className="k">Unit types</span>
                <span className="v">{types.length}</span>
              </div>
              <div>
                <span className="k">Status</span>
                <span className="v" style={{ color: published ? 'var(--signal)' : undefined }}>
                  {published ? 'Live' : 'Draft'}
                </span>
              </div>
              <div>
                <span className="k">To check</span>
                <span className="v" style={{ color: warnings?.length ? 'var(--warn)' : undefined }}>
                  {warnings === null ? '—' : warnings.length}
                </span>
              </div>
            </div>

            <section className="card">
              <span className="eyebrow">Unit types</span>
              <p className="note">
                Each one is a scene. Its floors, rooms and areas come from the drawing every time you
                compose.
              </p>
              {types.map((type, index) => (
                <div key={index} className="row-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) auto' }}>
                  <select
                    value={type.sceneId}
                    onChange={(event) => {
                      const next = [...types]
                      next[index] = { ...type, sceneId: event.target.value }
                      setTypes(next)
                    }}
                  >
                    <option value="">Choose a scene…</option>
                    {scenes.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={type.name}
                    placeholder="What the client calls it"
                    onChange={(event) => {
                      const next = [...types]
                      next[index] = { ...type, name: event.target.value }
                      setTypes(next)
                    }}
                  />
                  <button
                    className="icon-btn"
                    aria-label="Remove this unit type"
                    onClick={() => setTypes(types.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="btn" onClick={() => setTypes([...types, { sceneId: '', name: '', summary: '' }])}>
                Add a unit type
              </button>
            </section>

            <section className="card">
              <span className="eyebrow">Copy</span>
              <p className="note">Not in any drawing, so none of it can be derived.</p>
              <div className="form-grid">
                {COPY_FIELDS.map((field) => (
                  // The explanation is a tooltip rather than a line under every
                  // field. Eight captions stacked under eight inputs is the
                  // wall of text; the guidance is still there for whoever wants
                  // it, without being read eight times by everyone who does not.
                  <label key={field.key} title={field.hint}>
                    <span>{field.label}</span>
                    <input
                      value={(copy[field.key] as string | undefined) ?? ''}
                      onChange={(event) => setCopy({ ...copy, [field.key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="card">
              <span className="eyebrow">Contacts</span>
              <p className="note">
                Without one, a visitor who wants to buy cannot. This is the only part of the footer
                that does something.
              </p>
              {contacts.map((contact, index) => (
                <div key={index} className="row-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr)) auto' }}>
                  {(['region', 'name', 'phone'] as const).map((field) => (
                    <input
                      key={field}
                      value={contact[field]}
                      placeholder={field}
                      onChange={(event) => {
                        const next = [...contacts]
                        next[index] = { ...contact, [field]: event.target.value }
                        setContacts(next)
                      }}
                    />
                  ))}
                  <button
                    className="icon-btn"
                    aria-label="Remove this contact"
                    onClick={() => setContacts(contacts.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="btn" onClick={() => setContacts([...contacts, { region: '', name: '', phone: '' }])}>
                Add a contact
              </button>
            </section>

            <section className="card">
              <span className="eyebrow">Compose &amp; publish</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={() => void handleCompose()} disabled={busy}>
                  Read drawings &amp; save
                </button>
                {published ? (
                  <button className="btn" onClick={() => void handleUnpublish()} disabled={busy}>
                    Unpublish
                  </button>
                ) : (
                  <button className="btn" onClick={() => void handlePublish()} disabled={busy}>
                    Publish
                  </button>
                )}
                <span className="spacer" />
                {confirmDelete ? (
                  <>
                    <button className="btn btn-danger" onClick={() => void handleDelete()} disabled={busy}>
                      Really delete
                    </button>
                    <button className="btn" onClick={() => setConfirmDelete(false)} disabled={busy}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
                    Delete
                  </button>
                )}
              </div>

              {status ? (
                <p className="note" style={{ marginTop: 8 }}>
                  {status}
                </p>
              ) : null}

              {published && clientUrl ? (
                <p style={{ marginTop: 8, fontSize: 12.5 }}>
                  <a href={clientUrl} target="_blank" rel="noreferrer" className="mono">
                    {clientUrl}
                  </a>
                </p>
              ) : null}
            </section>

            {warnings !== null ? (
              <section>
                <span className="eyebrow">Before this goes to a client</span>
                {warnings.length === 0 ? (
                  <p className="note">Nothing to check.</p>
                ) : (
                  // Listed rather than counted. "12 warnings" is a number
                  // somebody dismisses; "the RERA number has not been written
                  // yet" is a thing they fix.
                  <ul className="checks">
                    {warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
