/**
 * Single API client for the whole marketing site.
 *
 * The reference architecture we studied split its backend across eight separate
 * API Gateway deployments, each with its own base URL hard-coded into the
 * frontend bundle. That means eight CORS configs, eight deploy pipelines, and a
 * frontend that breaks in eight different ways.
 *
 * Here there is one base URL. The backend is free to *become* several services
 * later — that is a routing concern behind the gateway, not something the
 * browser should ever know about.
 */

const API_PORT = 8787

/**
 * Where the API lives.
 *
 * An explicit PUBLIC_API_URL always wins — that is what production uses.
 *
 * Without one, we derive the API host from *the page's own hostname* rather
 * than hard-coding `localhost`. This matters the moment anyone opens the site
 * from a second device: on a phone at `http://192.168.1.36:4321`, `localhost`
 * means the phone, so every request dies. Deriving the host means the same
 * build works from the dev machine and from any device on the network, with no
 * rebuild and no IP baked into the bundle.
 */
function resolveApiBase(): string {
  const configured = import.meta.env.PUBLIC_API_URL
  if (configured) return String(configured).replace(/\/$/, '')

  if (typeof window === 'undefined') return `http://localhost:${API_PORT}`
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`
}

const BASE = resolveApiBase()

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Attach the stored bearer token. Defaults to true. */
  auth?: boolean
}

export async function api<T = unknown>(
  path: string,
  { body, auth = true, headers, ...init }: RequestOptions = {},
): Promise<T> {
  const finalHeaders = new Headers(headers)

  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders.set('Content-Type', 'application/json')
  }

  if (auth) {
    const token = getToken()
    if (token) finalHeaders.set('Authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: finalHeaders,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    })
  } catch {
    // `fetch` rejects identically for a dead server and for a CORS refusal —
    // the browser deliberately withholds the difference from scripts. So the
    // message names both possibilities instead of asserting the wrong one, and
    // logs the URL that was actually attempted, which is the single most useful
    // fact when the cause turns out to be a stale API host.
    console.error(
      `[api] request to ${BASE}${path} failed. Either the API is not running, ` +
        `or it refused this origin (${globalThis.location?.origin}) via CORS.`,
    )
    throw new ApiError(
      'Could not reach the server. It may be offline, or not accepting requests from this address.',
      0,
    )
  }

  if (response.status === 204) {
    if (auth) touchSession()
    return undefined as T
  }

  const payload = await response.json().catch(() => ({}) as Record<string, unknown>)

  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === 'string' ? payload.message : 'Request failed.',
      response.status,
      typeof payload.code === 'string' ? payload.code : undefined,
    )
  }

  // A successful authenticated call is what "activity" means for the sliding
  // half of the session policy — see auth.ts's isAuthenticated.
  if (auth) touchSession()
  return payload as T
}

// ---- Token storage ---------------------------------------------------------
// Kept in this module so nothing else in the app touches storage keys directly.

const TOKEN_KEY = 'arcvia.token'
const USER_KEY = 'arcvia.user'
const ISSUED_KEY = 'arcvia.issued_at'
const LAST_SEEN_KEY = 'arcvia.last_seen'

export interface StoredUser {
  uid: string
  email: string
  name: string
  organisationId: string | null
  planId: string
  credits: number
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function getUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as StoredUser) : null
  } catch {
    return null
  }
}

export function getIssuedAt(): number | null {
  const raw = localStorage.getItem(ISSUED_KEY)
  return raw ? Number(raw) : null
}

export function saveSession(token: string, user: StoredUser): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  localStorage.setItem(ISSUED_KEY, String(Date.now()))
  localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(ISSUED_KEY)
  localStorage.removeItem(LAST_SEEN_KEY)
}

/** When the session last did something. Falls back to issue time. */
export function getLastSeen(): number | null {
  const raw = localStorage.getItem(LAST_SEEN_KEY)
  const parsed = raw === null ? NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : getIssuedAt()
}

/** Record activity for the sliding half of the session policy. */
export function touchSession(): void {
  try {
    if (localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
    }
  } catch {
    /* storage unavailable — the auth check will fall back to issue time */
  }
}
