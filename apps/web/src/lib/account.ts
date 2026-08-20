import { api } from './api'

/**
 * Account-scoped reads used by the header menu and the referral page.
 *
 * Kept out of `auth.ts` on purpose: that module owns *session lifecycle*
 * (register, sign in, expiry) and is imported by pages that must work while
 * signed out. This one only ever runs for a signed-in user.
 */

export interface ReferralJoin {
  organisation: string
  joinedAt: string
  converted: boolean
}

export interface ReferralSummary {
  code: string
  link: string
  total: number
  converted: number
  joined: ReferralJoin[]
  rate: number
  /**
   * `null` while billing is off — meaning "there is nothing billed to share
   * yet", which is a different statement from "you have earned ₹0".
   */
  earnings: { currency: string; pending: number; paid: number } | null
  payoutsEnabled: boolean
}

export function fetchReferral(): Promise<ReferralSummary> {
  return api<ReferralSummary>('/referral/me')
}

/** Check a code before it is submitted. Unauthenticated — used on signup. */
export function validateReferralCode(
  code: string,
): Promise<{ valid: boolean; organisation: string | null }> {
  return api(`/referral/validate/${encodeURIComponent(code)}`, { auth: false })
}

export interface OrgMember {
  uid: string
  name: string
  email: string
  credits: number
  isOwner: boolean
}

export interface OrgSummary {
  organisation: {
    id: string
    name: string
    referralCode: string
    seatsUsed: number
    /** `null` means unlimited. */
    seatLimit: number | null
  }
  members: OrgMember[]
}

export function fetchOrganisation(): Promise<OrgSummary> {
  return api<OrgSummary>('/organisations/me')
}

export interface InviteResult {
  member: Pick<OrgMember, 'uid' | 'name' | 'email'>
  /**
   * Non-blocking advisory — e.g. the address looks like a personal one. The
   * invitation succeeded either way; this is shown, not thrown.
   */
  warning: string | null
}

export function inviteMember(input: {
  name: string
  email: string
}): Promise<InviteResult> {
  return api('/organisations/members', { method: 'POST', body: input })
}

export function removeMember(uid: string): Promise<void> {
  return api(`/organisations/members/${uid}`, { method: 'DELETE' })
}

/**
 * Copy text to the clipboard, with a fallback for insecure origins.
 *
 * `navigator.clipboard` is gated on a secure context. This site is opened over
 * plain http on the LAN constantly during development (`http://192.168.1.36`),
 * where the modern API is simply absent — so "Copy referral code", the single
 * most-used control in the account menu, would silently do nothing exactly
 * where it gets tested most.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const el = document.createElement('textarea')
    el.value = text
    // Off-screen rather than hidden: `display:none` elements cannot be
    // selected, so the copy would fail silently.
    el.style.position = 'fixed'
    el.style.top = '-9999px'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
