import { useEffect, useState, type FormEvent } from 'react'
import { currentUser } from '../lib/auth'
import {
  fetchOrganisation,
  inviteMember,
  removeMember,
  type OrgSummary,
} from '../lib/account'

type Load =
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: OrgSummary }

/**
 * Team members for an organisation.
 *
 * The reference product puts this behind a page called
 * `/post-payment-add-accounts` — it is reachable only immediately after paying,
 * which means someone who closes that tab has no route back to their own team
 * list. Here it is a permanent page reachable from the account menu.
 */
export default function TeamManager() {
  const [load, setLoad] = useState<Load>(() =>
    currentUser() ? { kind: 'loading' } : { kind: 'signed-out' },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)

  const me = currentUser()

  const refresh = () =>
    fetchOrganisation()
      .then((data) => setLoad({ kind: 'ready', data }))
      .catch((err) =>
        setLoad({
          kind: 'error',
          message:
            err instanceof Error ? err.message : 'Could not load your team.',
        }),
      )

  useEffect(() => {
    if (load.kind === 'loading') void refresh()
  }, [load.kind])

  if (load.kind === 'signed-out') {
    return (
      <div className="card text-center">
        <h3 className="h3">Sign in to manage your team</h3>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a href="/login/?next=/team/" className="btn-primary">
            Sign in
          </a>
          <a href="/register/" className="btn-secondary">
            Create an account
          </a>
        </div>
      </div>
    )
  }

  if (load.kind === 'loading') {
    return (
      <div className="card" aria-busy="true">
        <div className="h-4 w-40 animate-pulse rounded bg-surface-alt" />
        <div className="mt-4 h-24 animate-pulse rounded bg-surface-alt" />
      </div>
    )
  }

  if (load.kind === 'error') {
    return (
      <div className="card">
        <p className="alert-error" role="alert">
          {load.message}
        </p>
      </div>
    )
  }

  const { organisation, members } = load.data
  const isOwner = members.find((m) => m.uid === me?.uid)?.isOwner ?? false
  const seatsLeft =
    organisation.seatLimit === null
      ? null
      : Math.max(0, organisation.seatLimit - organisation.seatsUsed)

  const onInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setNotice(null)

    const form = event.currentTarget
    const data = new FormData(form)
    const name = String(data.get('name') ?? '').trim()
    const email = String(data.get('email') ?? '').trim().toLowerCase()

    if (!email) {
      setError('Enter an email address.')
      return
    }

    setBusy(true)
    try {
      const result = await inviteMember({ name, email })
      form.reset()
      // The warning is deliberately surfaced as a notice, not an error: the
      // invitation *worked*. Treating an advisory as a failure is how people
      // end up inviting the same person three times.
      setNotice(
        result.warning
          ? `${result.member.email} invited. ${result.warning}`
          : `${result.member.email} invited.`,
      )
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that invite.')
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (uid: string) => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await removeMember(uid)
      setPendingRemoval(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove them.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="card">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="h3">{organisation.name}</h3>
          <span className="pill">
            {organisation.seatsUsed}
            {organisation.seatLimit === null
              ? ' members'
              : ` of ${organisation.seatLimit} seats used`}
          </span>
        </div>

        <ul className="mt-5 divide-y divide-line border-y border-line">
          {members.map((m) => (
            <li
              key={m.uid}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {m.name}
                  {m.uid === me?.uid && (
                    <span className="ml-2 text-xs font-normal text-ink-soft">
                      you
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-soft">{m.email}</p>
              </div>

              <div className="flex items-center gap-3">
                {m.isOwner && <span className="pill">Owner</span>}

                {isOwner && !m.isOwner && (
                  // Two-step, because removing a member deletes their account
                  // and there is no undo. A single click on a row you did not
                  // mean to touch should not be able to do that.
                  pendingRemoval === m.uid ? (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onRemove(m.uid)}
                        className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingRemoval(null)}
                        className="text-xs text-ink-soft hover:underline"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPendingRemoval(m.uid)}
                      className="text-xs text-ink-soft hover:text-danger hover:underline"
                    >
                      Remove
                    </button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {isOwner ? (
        <form onSubmit={onInvite} className="card space-y-4">
          <h3 className="h3">Invite someone</h3>

          {seatsLeft === 0 && (
            <p className="alert-info">
              Every seat on your plan is in use. Remove a member to free one up.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="member-name" className="label">
                Name
              </label>
              <input
                id="member-name"
                name="name"
                type="text"
                autoComplete="off"
                className="field"
                placeholder="Optional"
              />
            </div>
            <div>
              <label htmlFor="member-email" className="label">
                Work email
              </label>
              <input
                id="member-email"
                name="email"
                type="email"
                autoComplete="off"
                required
                className="field"
                placeholder="them@practice.com"
              />
            </div>
          </div>

          {error && (
            <p className="alert-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="alert-ok" role="status">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || seatsLeft === 0}
            className="btn-primary"
          >
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
      ) : (
        <p className="alert-info">
          Only the account owner can invite or remove members.
        </p>
      )}
    </div>
  )
}
