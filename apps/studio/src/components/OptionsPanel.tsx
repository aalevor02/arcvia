import { useState } from 'react'

import { uploadImage, uploadScene } from '../lib/api'
import { itemById } from '../catalogue/items'
import {
  alternativesFor,
  composeFlooringOptions,
  composeObjectOptions,
  offerableFinishes,
  type SceneOptions,
} from '../publish/options'
import type { FloorFinish, Plan } from '../plan/types'

interface Props {
  /** The plan, for listing placed objects a visitor could switch. */
  plan: Plan
  /** The scene's stored options, so reopening shows what is already offered. */
  value: SceneOptions | null
  /** Called with the composed options once every texture is uploaded. */
  onSave(options: SceneOptions | null): Promise<void>
}

/**
 * Choosing what a client may reconfigure.
 *
 * ── Why saving here does real work ──────────────────────────────────────────
 * The published page is another origin with no session, so every texture an
 * offered finish needs must be uploaded into the API's storage before the
 * option exists. Saving is therefore a compose step, not a preference toggle —
 * a few hundred kilobytes per finish, once, content-hashed so saving again is
 * free. The button says what it is doing rather than pretending to be instant.
 *
 * ── Why a finish can be missing from this list ──────────────────────────────
 * Grass is procedural: its maps are drawn on a canvas inside the studio, and
 * the published page cannot run that generator. Offering it would ship a
 * button that does nothing, so `offerableFinishes` excludes it at the source.
 */
export default function OptionsPanel({ plan, value, onSave }: Props) {
  const available = offerableFinishes()
  const [offered, setOffered] = useState<FloorFinish[]>(
    () => value?.flooring?.choices.map((choice) => choice.id) ?? [],
  )
  /** objectId -> alternative item ids the visitor may switch to. */
  const [objectGroups, setObjectGroups] = useState<Record<string, string[]>>(() => {
    const groups: Record<string, string[]> = {}
    for (const group of value?.objects?.groups ?? []) {
      groups[group.objectId] = group.choices.filter((c) => c.id !== 'original').map((c) => c.id)
    }
    return groups
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  // Placed objects a visitor could plausibly switch: they carry a real model
  // (a parametric stand-in beside real furniture reads as a bug, not a choice)
  // and their category holds at least one alternative that does too.
  const switchable = plan.floors.flatMap((floor) =>
    Object.values(floor.objects)
      .map((object) => ({ object, item: itemById(object.item) }))
      .filter((entry) => entry.item?.model && alternativesFor(entry.item.id).length > 0),
  )

  const storedGroups: Record<string, string[]> = {}
  for (const group of value?.objects?.groups ?? []) {
    storedGroups[group.objectId] = group.choices
      .filter((c) => c.id !== 'original')
      .map((c) => c.id)
  }
  const dirty =
    JSON.stringify([...offered].sort()) !==
      JSON.stringify((value?.flooring?.choices.map((c) => c.id) ?? []).sort()) ||
    JSON.stringify(objectGroups) !== JSON.stringify(storedGroups)

  async function handleSave() {
    setBusy(true)
    setStatus('Publishing the textures each choice needs…')
    try {
      const objectRequests = Object.entries(objectGroups)
        .map(([objectId, alternatives]) => ({ objectId, alternatives }))
        .filter((group) => group.alternatives.length > 0)

      const objects = await composeObjectOptions(plan, objectRequests, async (blob) => {
        const stored = await uploadScene(blob)
        return stored.url
      })

      const flooring = await composeFlooringOptions(offered, async (studioUrl) => {
        // The map lives in the studio's own public directory; fetch the bytes
        // and ship them on unchanged. The server sniffs, so nothing declared
        // here is trusted anyway.
        const response = await fetch(studioUrl)
        if (!response.ok) throw new Error(`Could not read ${studioUrl} (${response.status}).`)
        const blob = await response.blob()
        const stored = await uploadImage(blob, studioUrl.split('/').pop() ?? 'map.jpg')
        return stored.url
      })

      const next: SceneOptions | null =
        flooring || objects
          ? { ...(flooring ? { flooring } : {}), ...(objects ? { objects } : {}) }
          : null
      await onSave(next)

      const parts: string[] = []
      if (flooring) parts.push(`${flooring.choices.length} floor finishes`)
      if (objects) parts.push(`${objects.groups.length} switchable object(s)`)
      setStatus(
        parts.length
          ? `Visitors can choose: ${parts.join(', ')}.`
          : offered.length === 1
            ? 'One finish is not a choice — pick at least two, or none.'
            : 'Visitors see the scene exactly as you built it.',
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save the options.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <span className="eyebrow">Client options</span>
      <p className="note">
        Let a visitor switch the flooring on the published page. Pick two or more
        to offer a choice; pick none to publish the scene as built.
      </p>

      {available.map((finish) => (
        <label
          key={finish.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 6 }}
        >
          <input
            type="checkbox"
            checked={offered.includes(finish.id)}
            onChange={(event) =>
              setOffered(
                event.target.checked
                  ? [...offered, finish.id]
                  : offered.filter((id) => id !== finish.id),
              )
            }
            style={{ width: 'auto' }}
          />
          {finish.name}
        </label>
      ))}

      {switchable.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="note">Furniture a visitor may swap:</p>
          {switchable.map(({ object, item }) => (
            <details key={object.id} style={{ marginTop: 6, fontSize: 12.5 }}>
              <summary style={{ cursor: 'pointer' }}>
                {object.label ?? item!.name}
                {objectGroups[object.id]?.length
                  ? ` — ${objectGroups[object.id].length} alternative(s)`
                  : ''}
              </summary>
              {alternativesFor(item!.id).map((alt) => (
                <label
                  key={alt.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 4,
                    paddingLeft: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={objectGroups[object.id]?.includes(alt.id) ?? false}
                    onChange={(event) => {
                      const current = objectGroups[object.id] ?? []
                      setObjectGroups({
                        ...objectGroups,
                        [object.id]: event.target.checked
                          ? [...current, alt.id]
                          : current.filter((id) => id !== alt.id),
                      })
                    }}
                    style={{ width: 'auto' }}
                  />
                  {alt.name}
                </label>
              ))}
            </details>
          ))}
        </div>
      )}

      <button
        className="btn"
        onClick={() => void handleSave()}
        disabled={busy || !dirty}
        style={{ marginTop: 10 }}
      >
        {busy ? 'Publishing textures…' : 'Save options'}
      </button>

      {status ? (
        <p className="note" style={{ marginTop: 6 }}>
          {status}
        </p>
      ) : null}
    </section>
  )
}
