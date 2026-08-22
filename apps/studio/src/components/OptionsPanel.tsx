import { useState } from 'react'

import { uploadImage } from '../lib/api'
import {
  composeFlooringOptions,
  offerableFinishes,
  type SceneOptions,
} from '../publish/options'
import type { FloorFinish } from '../plan/types'

interface Props {
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
export default function OptionsPanel({ value, onSave }: Props) {
  const available = offerableFinishes()
  const [offered, setOffered] = useState<FloorFinish[]>(
    () => value?.flooring?.choices.map((choice) => choice.id) ?? [],
  )
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  const dirty =
    JSON.stringify([...offered].sort()) !==
    JSON.stringify((value?.flooring?.choices.map((c) => c.id) ?? []).sort())

  async function handleSave() {
    setBusy(true)
    setStatus('Publishing the textures each choice needs…')
    try {
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

      await onSave(flooring ? { flooring } : null)
      setStatus(
        flooring
          ? `Visitors can choose between ${flooring.choices.length} floor finishes.`
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
