import {
  api,
  saveSession,
  clearSession,
  getUser,
  getToken,
  getIssuedAt,
  getLastSeen,
  touchSession,
  type StoredUser,
} from './api'

interface AuthResponse {
  token: string
  user: StoredUser
  otpSent?: boolean
  /** Present only in development when no SMS provider is configured. */
  devCode?: string
}

export interface RegisterInput {
  name: string
  email: string
  organisation: string
  phone: string
  password: string
  /**
   * Optional. An unknown code is ignored by the server rather than rejected —
   * a typo here must never be the reason a signup fails.
   */
  referralCode?: string
}

/** Where the development-only OTP is parked for the verify page to display. */
export const DEV_CODE_KEY = 'arcvia.dev_otp'

export async function register(input: RegisterInput): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/register', {
    method: 'POST',
    body: input,
    auth: false,
  })
  saveSession(result.token, result.user)

  // sessionStorage, not localStorage: this is a throwaway development
  // convenience and it should not outlive the tab.
  if (result.devCode) {
    try {
      sessionStorage.setItem(DEV_CODE_KEY, result.devCode)
    } catch {
      /* private mode — the code is still in the server log */
    }
  }

  return result
}

export async function login(
  email: string,
  password: string,
): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  })
  saveSession(result.token, result.user)
  return result
}

export interface OtpSendResult {
  sent: boolean
  phone?: string
  expiresInSeconds?: number
  alreadyVerified?: boolean
  /** Present only in development when no SMS provider is configured. */
  devCode?: string
}

/**
 * Request a code for the signed-in user.
 *
 * Note what is *not* here: no `+91` prefixing. The client used to add it, which
 * meant passing back an already-normalised number produced `+91+9198…` and a
 * silent 400. The server owns normalisation now; callers send whatever they
 * have, including nothing at all to reuse the number already on the account.
 */
export async function sendOtp(phone?: string): Promise<OtpSendResult> {
  return api<OtpSendResult>('/auth/otp/send', {
    method: 'POST',
    body: phone ? { phone } : {},
  })
}

export async function verifyOtp(code: string): Promise<{ verified: boolean }> {
  return api<{ verified: boolean }>('/auth/otp/verify', {
    method: 'POST',
    body: { code },
  })
}

export function logout(): void {
  clearSession()
  window.location.href = '/'
}

// ---- Password reset --------------------------------------------------------

export interface ForgotResult {
  sent: boolean
  message: string
  /** Present only in development when no mail provider is configured. */
  devToken?: string
}

/**
 * Ask for a reset link.
 *
 * Note the return type: this never reports "no such account". The server
 * deliberately answers identically either way so the endpoint cannot be used
 * to enumerate who has an account here, and the client must not invent a
 * distinction the server refused to make.
 */
export async function requestPasswordReset(
  email: string,
): Promise<ForgotResult> {
  return api<ForgotResult>('/auth/password/forgot', {
    method: 'POST',
    body: { email },
    auth: false,
  })
}

/** Redeem a reset token. Signs the session in on success. */
export async function resetPassword(
  token: string,
  password: string,
): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/password/reset', {
    method: 'POST',
    body: { token, password },
    auth: false,
  })
  saveSession(result.token, result.user)
  return result
}

/**
 * How long a stored session stays valid in the browser.
 *
 * ── Why this is not just `return getToken() !== null` ────────────────────────
 * The reference product we studied stored a session start timestamp and then
 * never read it. In practice that means: sign in once on a shared machine in a
 * site office, and the session is live forever. For a tool that holds unbuilt
 * project drawings and client data, that is a real exposure.
 *
 * The trade-off is a genuine one and it is yours to make, because it depends on
 * how your customers actually work:
 *
 *   • A HARD expiry (session dies N hours after issue, full stop) is the
 *     strongest option. It also logs out an architect in the middle of a long
 *     modelling session, which they will hate.
 *
 *   • A SLIDING expiry (session dies after N hours of *inactivity*, refreshed
 *     on each call) never interrupts someone who is working. But an idle tab on
 *     an unlocked machine can keep itself alive indefinitely.
 *
 *   • A HYBRID caps total lifetime *and* idles out — e.g. dies after 30 days
 *     absolute, or 12 hours idle, whichever comes first. More code, best
 *     behaviour.
 *
 * Site offices and shared workstations are common in this industry, which
 * pushes toward shorter. Long modelling sessions push toward sliding.
 */
// DECIDED (owner, 2026-08-24): the HYBRID. An architect's long modelling
// session never idles out under them (activity keeps the sliding half fresh),
// a forgotten login on a site-office machine dies within a working day of
// being left alone, and even a tab that somehow keeps touching itself dies at
// the absolute ceiling.
export const SESSION_IDLE_MS = 1000 * 60 * 60 * 12 // 12 hours without activity
export const SESSION_ABSOLUTE_MS = 1000 * 60 * 60 * 24 * 30 // 30 days, full stop

/** @deprecated the hybrid policy replaced the single knob; kept for callers. */
export const SESSION_MAX_AGE_MS = SESSION_ABSOLUTE_MS

export function isAuthenticated(): boolean {
  const token = getToken()
  const user = getUser()
  if (!token || !user) return false

  const issuedAt = getIssuedAt()
  if (issuedAt === null) return false

  // Absolute first: no amount of activity extends a session past the ceiling.
  if (Date.now() - issuedAt > SESSION_ABSOLUTE_MS) {
    clearSession()
    return false
  }

  // Then idle: "activity" is a successful authenticated API call or an auth
  // check like this one — api.ts touches the timestamp on the first, and the
  // touch below covers someone who reopens the site within the idle window
  // without yet calling anything.
  const lastSeen = getLastSeen() ?? issuedAt
  if (Date.now() - lastSeen > SESSION_IDLE_MS) {
    clearSession()
    return false
  }

  touchSession()
  return true
}

export function currentUser(): StoredUser | null {
  return isAuthenticated() ? getUser() : null
}
