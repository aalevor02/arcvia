import { useEffect, useRef, useState } from 'react'
import brand from '@arcvia/brand'
import plans from '@arcvia/brand/plans'
import { currentUser, logout } from '../lib/auth'
import { copyText, fetchReferral } from '../lib/account'
import { openStudioUrl } from '../lib/links'
import type { StoredUser } from '../lib/api'

/**
 * The header's right-hand side.
 *
 * ── Why this is an island and the rest of the header is not ─────────────────
 * The site is statically generated, so the HTML is identical for every visitor
 * — it cannot know at build time whether the person loading it is signed in.
 * Only this one control differs, so only this one control ships JavaScript.
 *
 * ── Why it is mounted `client:only` and reads storage synchronously ─────────
 * The session lives in localStorage, which does not exist at build time. Three
 * ways to handle that, and only one of them is free of a visible glitch:
 *
 *   Render signed-out, correct in useEffect  → every signed-in user sees
 *                                              "Sign in" flash on every page.
 *   Render nothing, fill in useEffect        → the header jumps when it fills.
 *   client:only + a synchronous initialiser  → the first paint is already
 *                                              correct.
 *
 * The third is what this does. The cost is that the slot is empty in the
 * static HTML, so the header reserves the space in CSS — see Header.astro.
 */
export default function AccountMenu() {
  // Synchronous, not an effect: this runs before the first paint, so the menu
  // never renders a state that is about to be replaced.
  const [user, setUser] = useState<StoredUser | null>(() => currentUser())
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Re-check when the tab regains focus. Sign out in one tab and this one
  // would otherwise keep offering an account menu backed by a dead token.
  useEffect(() => {
    const sync = () => setUser(currentUser())
    window.addEventListener('focus', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  // The referral code is fetched only when the menu is actually opened. It is
  // one more request per page load otherwise, on every page, for a value most
  // visits never look at.
  useEffect(() => {
    if (!open || code !== null) return
    let cancelled = false
    fetchReferral()
      .then((r) => !cancelled && setCode(r.code))
      .catch(() => !cancelled && setCode(''))
    return () => {
      cancelled = true
    }
  }, [open, code])

  // Close on outside click and on Escape. Both, because a dropdown that only
  // handles one of them feels broken in the other case.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) {
    return (
      <div className="flex items-center gap-3">
        <a href="/login/" className="hidden text-sm font-medium sm:inline-flex">
          Sign in
        </a>
        <a href="/register/" className="btn-primary !px-4 !py-2">
          Get started free
        </a>
      </div>
    )
  }

  // `planFor` rather than indexing with our own fallback: it is the function
  // that owns this decision, including the billing-off case where the plan a
  // user carries is not the plan they are on.
  const plan = plans.planFor(user.planId)
  const initial = (user.name || user.email).charAt(0).toUpperCase()

  const onCopy = async () => {
    if (!code) return
    setCopied(await copyText(code))
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="grid h-9 w-9 place-items-center rounded-full bg-accent text-sm font-semibold text-white"
      >
        <span aria-hidden="true">{initial}</span>
        <span className="sr-only">Account menu</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-ink-soft">{user.email}</p>
          </div>

          <dl className="border-b border-line px-4 py-3 text-sm">
            <div className="flex items-center justify-between py-1">
              <dt className="text-ink-soft">Plan</dt>
              <dd className="font-medium">{plan.label}</dd>
            </div>
            <div className="flex items-center justify-between py-1">
              <dt className="text-ink-soft">Credits</dt>
              <dd className="font-medium tabular-nums">
                {/* Unlimited-in-practice allowances read badly as "100000".
                    While billing is off the number is not a limit anyone is
                    tracking, so say what is true instead of printing it. */}
                {plans.billingEnabled
                  ? user.credits.toLocaleString()
                  : 'Unmetered'}
              </dd>
            </div>
          </dl>

          <div className="border-b border-line px-4 py-3">
            <p className="text-xs text-ink-soft">Your referral code</p>
            <button
              type="button"
              onClick={onCopy}
              disabled={!code}
              className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface-alt px-3 py-2 text-left transition-colors hover:bg-accent-soft disabled:opacity-60"
            >
              <span className="font-mono text-sm tracking-wider">
                {code === null ? '····' : code || 'Unavailable'}
              </span>
              <span className="text-xs font-medium text-accent">
                {copied ? 'Copied' : 'Copy'}
              </span>
            </button>
          </div>

          <nav className="py-1.5 text-sm">
            <a role="menuitem" href={openStudioUrl()} className={ITEM}>
              Open the studio
            </a>
            <a role="menuitem" href="/team/" className={ITEM}>
              Team members
            </a>
            <a role="menuitem" href="/referral/" className={ITEM}>
              Referrals
            </a>
            <button
              role="menuitem"
              type="button"
              onClick={logout}
              className={`${ITEM} w-full text-left text-danger`}
            >
              Sign out
            </button>
          </nav>
        </div>
      )}
    </div>
  )
}

const ITEM = 'block px-4 py-2 transition-colors hover:bg-surface-alt'
