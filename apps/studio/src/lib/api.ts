import type { Plan } from '../plan/types'
import type { SceneView, Hotspot, Branding } from '../plan/presentation'

/**
 * Studio API client.
 *
 * Deliberately mirrors `apps/web/src/lib/api.ts` rather than sharing it: the
 * two apps ship separately, and a shared package would put the marketing site's
 * session handling into the editor bundle for no benefit. The one thing that
 * must stay identical is the storage key, so a sign-in on the site carries into
 * the studio — hence the constant below rather than an inline string.
 */

const API_PORT = 8787
const TOKEN_KEY = 'arcvia.token'
const USER_KEY = 'arcvia.user'

/**
 * Derive the API host from the page's own hostname unless told otherwise.
 * Hard-coding `localhost` breaks the moment the studio is opened from another
 * device on the network — on a phone, `localhost` is the phone.
 */
const BASE: string = import.meta.env.VITE_API_URL
  ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
  : `${window.location.protocol}//${window.location.hostname}:${API_PORT}`

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export interface StudioUser {
  uid: string
  email: string
  name: string
  credits: number
}

/**
 * Trade a hand-off ticket from the site for a session here.
 *
 * The studio is a separate origin, so the site's localStorage is invisible to
 * it — the session cannot simply be read across. The site mints a single-use,
 * thirty-second ticket and forwards it in the URL; this exchanges it.
 *
 * Returns true if a session was established.
 */
export async function redeemHandoff(ticket: string): Promise<boolean> {
  try {
    const result = await request<{ token: string; user: StudioUser }>(
      '/auth/handoff/redeem',
      { method: 'POST', body: { ticket } },
    )
    localStorage.setItem(TOKEN_KEY, result.token)
    localStorage.setItem(USER_KEY, JSON.stringify(result.user))
    return true
  } catch {
    // An expired or already-spent ticket is not an error worth interrupting
    // anyone over — it happens on any refresh of a hand-off URL. The caller
    // falls through to the signed-out screen, which is the correct outcome.
    return false
  }
}

export function getUser(): StudioUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as StudioUser) : null
  } catch {
    return null
  }
}

/**
 * `body` is widened to `unknown` and JSON-encoded here, so callers pass objects
 * rather than pre-stringifying at every call site. `Omit` is required, not
 * cosmetic: intersecting with `RequestInit` directly keeps the original
 * `BodyInit` type and rejects every plain object.
 */
type Request = Omit<RequestInit, 'body'> & { body?: unknown }

async function request<T>(path: string, init: Request = {}): Promise<T> {
  const { body, headers, ...rest } = init
  const finalHeaders = new Headers(headers)

  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) finalHeaders.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // `fetch` rejects identically for a dead server and a CORS refusal, so the
    // message names both rather than asserting the wrong one.
    throw new ApiError(
      'Could not reach the server. It may be offline, or refusing this origin.',
      0,
    )
  }

  if (response.status === 204) return undefined as T

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === 'string' ? payload.message : 'Request failed.',
      response.status,
    )
  }

  return payload as T
}

// ---- Scenes ----------------------------------------------------------------

/** What the dashboard list returns. Note: no `plan` — see the API's listItem. */
export interface SceneListItem {
  id: string
  name: string
  updatedAt: string
  createdAt: string
  published: boolean
  publishedSlug: string | null
  modelUrl: string | null
  floorCount: number
  hasPlan: boolean
}

/** The full record, returned when a project is opened. */
export interface Scene extends Omit<SceneListItem, 'floorCount' | 'hasPlan'> {
  plan: Plan | null
  lightsUrl: string | null
  /** The baked lightmap atlas, once a bake has completed. */
  bakedUrl: string | null
  hdriUrl: string | null
  floorPlanUrl: string | null
  /** Presentation: where a client is taken, what they are told, whose name is on it. */
  views?: SceneView[]
  hotspots?: Hotspot[]
  branding?: Branding | null
}

export const listScenes = () =>
  request<{ scenes: SceneListItem[] }>('/scenes/').then((r) => r.scenes)

export const getScene = (id: string) =>
  request<{ scene: Scene }>(`/scenes/${id}`).then((r) => r.scene)

export const createScene = (name: string) =>
  request<{ scene: SceneListItem }>('/scenes/', {
    method: 'POST',
    body: { name },
  }).then((r) => r.scene)

export const updateScene = (id: string, patch: Partial<Scene>) =>
  request<{ scene: SceneListItem }>(`/scenes/${id}`, {
    method: 'PATCH',
    body: patch,
  }).then((r) => r.scene)

/**
 * Publish a scene and get back the link a client opens.
 *
 * Separate from `updateScene` because publishing is not an edit — it changes
 * who can see the scene, and it is the one action in the editor with
 * consequences outside the account.
 */
export const publishScene = (id: string) =>
  request<{ scene: SceneListItem; url: string }>(`/scenes/${id}/publish`, {
    method: 'POST',
  })

export const unpublishScene = (id: string) =>
  request<{ scene: SceneListItem }>(`/scenes/${id}/unpublish`, { method: 'POST' })

export const deleteScene = (id: string) =>
  request<void>(`/scenes/${id}`, { method: 'DELETE' })

/**
 * Duplicate a project.
 *
 * Client-side rather than a server route, because "duplicate" is exactly
 * "create, then copy the fields across" and the server has no better view of
 * what a copy means. The name suffix is worked out against the existing list so
 * two duplicates in a row do not collide on the unique-name constraint.
 */
export async function duplicateScene(
  source: SceneListItem,
  existing: SceneListItem[],
): Promise<SceneListItem> {
  const name = uniqueName(`${source.name} copy`, existing.map((s) => s.name))
  const created = await createScene(name)

  const full = await getScene(source.id)
  return updateScene(created.id, {
    plan: full.plan,
    modelUrl: full.modelUrl,
    lightsUrl: full.lightsUrl,
    hdriUrl: full.hdriUrl,
    floorPlanUrl: full.floorPlanUrl,
  })
}

// ---- Uploads ---------------------------------------------------------------

export interface StoredFile {
  key: string
  /** Path, not an absolute URL — see the note below on why. */
  url: string
  bytes: number
  contentType: string
}

/**
 * Upload a floor-plan raster.
 *
 * Uses FormData, so `Content-Type` is left unset deliberately: the browser has
 * to add its own `multipart/form-data; boundary=…`, and setting the header by
 * hand produces a body the server cannot parse. That is why this does not go
 * through `request()`, which always sets a JSON content type.
 */
export async function uploadFloorplan(file: File): Promise<StoredFile> {
  const body = new FormData()
  body.append('file', file)

  const token = getToken()
  const response = await fetch(`${BASE}/uploads/floorplan`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === 'string' ? payload.message : 'Upload failed.',
      response.status,
    )
  }

  const stored = payload as unknown as StoredFile

  // The API returns a path so the same stored record works behind any host.
  // Absolutising it here — against the API origin, not the page's — is what
  // makes the image load at all, since the studio is served from a different
  // port to the API.
  return { ...stored, url: stored.url.startsWith('/') ? BASE + stored.url : stored.url }
}

/** `Villa` -> `Villa copy` -> `Villa copy 2` -> `Villa copy 3`. */
export function uniqueName(base: string, taken: string[]): string {
  const lower = taken.map((t) => t.toLowerCase())
  if (!lower.includes(base.toLowerCase())) return base

  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`
    if (!lower.includes(candidate.toLowerCase())) return candidate
  }
  // Practically unreachable; better than looping forever.
  return `${base} ${Date.now()}`
}

// ---- Floor-plan detection --------------------------------------------------

export interface DetectionAvailability {
  available: boolean
  detector: { backend: string; model_loaded: boolean } | null
}

/**
 * Is the reader running?
 *
 * Asked before offering the button, because the detector is a separate Python
 * process that someone has to start. Offering an action that will certainly
 * fail, and only saying so afterwards, wastes a credit's worth of goodwill.
 */
export const detectorAvailable = () =>
  request<DetectionAvailability>('/detect/health').catch(
    (): DetectionAvailability => ({ available: false, detector: null }),
  )

/** Run detection against an already-uploaded drawing. */
export const detectFloorplan = (url: string) =>
  request<import('../plan/detections').DetectionResult>('/detect/', {
    method: 'POST',
    body: { url },
  })

/**
 * Upload generated scene geometry, on its way to the render worker.
 *
 * Separate from `uploadFloorplan` because the two differ in every way that
 * matters — size limit, storage prefix, lifetime — and a single function with a
 * "kind" flag would just be those differences spelled out at the call site.
 */
export async function uploadScene(blob: Blob): Promise<StoredFile> {
  const body = new FormData()
  body.append('file', blob, 'scene.glb')

  const token = getToken()
  const response = await fetch(`${BASE}/uploads/scene`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === 'string' ? payload.message : 'Scene upload failed.',
      response.status,
    )
  }

  // Returned as stored — a path, not absolutised. Unlike a floor-plan raster
  // this URL's consumer is the API itself, which resolves it against its own
  // storage root. Absolutising here would write whichever hostname this browser
  // happens to be using into the scene record, so a scene saved from a phone on
  // the LAN would be unreachable from the same machine on localhost.
  return payload as unknown as StoredFile
}

/** Absolutise a stored path against the API origin, for loading in the page. */
export const storedUrl = (path: string): string =>
  path.startsWith('/') ? BASE + path : path

/**
 * Where a published walkthrough lives.
 *
 * The studio and the public viewer are different origins — 5173 and 4321 in
 * development, a subdomain and the main site in production — so a link built
 * from `window.location` would send clients to a page the studio does not
 * serve. `VITE_SITE_URL` names the real one; the fallback keeps the host and
 * swaps the port, which is what makes it work from a phone on the LAN as well
 * as from localhost.
 */
export function siteOrigin(): string {
  const configured = import.meta.env.VITE_SITE_URL
  if (configured) return String(configured).replace(/\/$/, '')
  return `${window.location.protocol}//${window.location.hostname}:4321`
}
