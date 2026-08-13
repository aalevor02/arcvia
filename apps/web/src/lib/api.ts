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

const BASE = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8787'

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
    // A network-level failure is not the same as a rejected request, and the
    // user needs to be told which one happened.
    throw new ApiError('Could not reach the server. Check your connection.', 0)
  }

  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => ({}) as Record<string, unknown>)

  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === 'string' ? payload.message : 'Request failed.',
      response.status,
      typeof payload.code === 'string' ? payload.code : undefined,
    )
  }

  return payload as T
}

// ---- Token storage ---------------------------------------------------------
// Kept in this module so nothing else in the app touches storage keys directly.

const TOKEN_KEY = 'arcvia.token'
const USER_KEY = 'arcvia.user'
const ISSUED_KEY = 'arcvia.issued_at'

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
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(ISSUED_KEY)
}
