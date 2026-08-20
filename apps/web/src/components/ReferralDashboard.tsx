import { useEffect, useState } from 'react'
import brand from '@arcvia/brand'
import { currentUser } from '../lib/auth'
import { copyText, fetchReferral, type ReferralSummary } from '../lib/account'

type State =
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ReferralSummary }

/**
 * The signed-in half of the referral page.
 *
 * The explanatory half above it is static Astro — it is identical for everyone
 * and should not cost a byte of JavaScript. Only the part that differs per
 * account lives here.
 */
export default function ReferralDashboard() {
  const [state, setState] = useState<State>(() =>
    currentUser() ? { kind: 'loading' } : { kind: 'signed-out' },
  )
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)

  useEffect(() => {
    if (state.kind !== 'loading') return
    let cancelled = false
    fetchReferral()
      .then((data) => !cancelled && setState({ kind: 'ready', data }))
      .catch(
        (err) =>
          !cancelled &&
          setState({
            kind: 'error',
            message:
              err instanceof Error ? err.message : 'Could not load your code.',
          }),
      )
    return () => {
      cancelled = true
    }
  }, [state.kind])

  const copy = async (what: 'code' | 'link', value: string) => {
    if (await copyText(value)) {
      setCopied(what)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  if (state.kind === 'signed-out') {
    return (
      <div className="card text-center">
        <h3 className="h3">Sign in to get your code</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Every account has a referral code from the moment it is created. There
          is nothing to apply for.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a href="/register/" className="btn-primary">
            Create a free account
          </a>
          <a href="/login/?next=/referral/" className="btn-secondary">
            Sign in
          </a>
        </div>
      </div>
    )
  }

  if (state.kind === 'loading') {
    return (
      <div className="card" aria-busy="true">
        <div className="h-4 w-32 animate-pulse rounded bg-surface-alt" />
        <div className="mt-4 h-12 animate-pulse rounded bg-surface-alt" />
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="card">
        <p className="alert-error" role="alert">
          {state.message}
        </p>
      </div>
    )
  }

  const { data } = state

  return (
    <div className="space-y-5">
      <div className="card">
        <h3 className="h3">Your referral code</h3>

        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
          <button
            type="button"
            onClick={() => copy('code', data.code)}
            className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-alt px-4 py-3 transition-colors hover:bg-accent-soft"
          >
            <span className="font-mono text-lg font-semibold tracking-[0.2em]">
              {data.code}
            </span>
            <span className="text-xs font-medium text-accent">
              {copied === 'code' ? 'Copied' : 'Copy'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => copy('link', data.link)}
            // min-w-0 on the button as well as the label: a grid item's default
            // min-width is `auto`, so without it the button refuses to shrink
            // below its content and pushes the whole page wider than the phone.
            className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-line px-4 py-3 text-left transition-colors hover:bg-surface-alt"
          >
            {/* `truncate` cannot do anything inside a flex row unless the item
                is allowed to shrink past its content width — that is what
                min-w-0 grants. Without it the ellipsis never appears and the
                URL simply overflows. */}
            <span className="min-w-0 truncate text-sm text-ink-soft">
              {data.link}
            </span>
            <span className="shrink-0 text-xs font-medium text-accent">
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </span>
          </button>
        </div>

        <p className="hint">
          The link prefills the code on the signup form, so nobody has to type
          it.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <Stat label="Signed up" value={String(data.total)} />
        <Stat
          label="Active accounts"
          value={String(data.converted)}
          hint={
            data.payoutsEnabled ? undefined : 'Counted, not yet paid out'
          }
        />
        <Stat
          label={data.payoutsEnabled ? 'Earned' : 'Payouts'}
          value={
            data.payoutsEnabled
              ? `₹${data.earnings?.paid.toLocaleString('en-IN') ?? 0}`
              : 'Not yet'
          }
          hint={
            data.payoutsEnabled
              ? undefined
              : `${brandRate(data.rate)} once billing starts`
          }
        />
      </div>

      <div className="card">
        <h3 className="h3">Who you've referred</h3>
        {data.joined.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            Nobody yet. Share your link with a practice that would rather send a
            walkthrough than a PDF.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {data.joined.map((j) => (
              <li
                key={`${j.organisation}-${j.joinedAt}`}
                className="flex items-center justify-between gap-4 py-3"
              >
                <span className="text-sm font-medium">{j.organisation}</span>
                <time
                  dateTime={j.joinedAt}
                  className="text-xs text-ink-soft tabular-nums"
                >
                  {new Date(j.joinedAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!data.payoutsEnabled && (
        <p className="alert-info">
          <strong className="text-ink">Payouts are not live yet.</strong>{' '}
          {brand.name} is free, so there is no subscription revenue to share a
          percentage of. Referrals are being recorded from today — so when
          billing does start, the people you have already introduced count.
        </p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}

/** 0.1 -> '10% recurring'. Formatting only; the rate itself comes from the API. */
const brandRate = (rate: number) => `${Math.round(rate * 100)}% recurring`
