const API_PORT = 8787

/**
 * Derive the API host from the page's own hostname unless told otherwise.
 * Hard-coding `localhost` breaks the moment the studio is opened from another
 * device on the network — see the same note in apps/web/src/lib/api.ts.
 */
const API: string = import.meta.env.VITE_API_URL
  ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
  : `${window.location.protocol}//${window.location.hostname}:${API_PORT}`

export type RenderPreset = 'preview' | 'isometric' | 'full' | 'panorama' | 'bake' | 'ai'

export interface RenderUpdate {
  status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled'
  progress: number
  outputUrl?: string | null
  error?: string | null
  /**
   * Milliseconds since the job started, or null if it is not running.
   *
   * The only honest thing to show during a bake. `bpy.ops.object.bake()` is a
   * single call that reports nothing until it returns, so `progress` stays at 0
   * for the whole run — and a bar frozen at 0% for six minutes reads as a
   * hang, not as work in progress.
   */
  elapsedMs?: number | null
  /**
   * Diagnostics the worker printed about itself: `device` (CUDA / HIP / CPU),
   * `bake_uv` (prebaked or smart-project), `bake_cells` (the atlas grid).
   *
   * `device` is worth showing while a bake runs: on a machine without a CUDA
   * or HIP device Cycles falls back to the CPU, and that single fact explains
   * essentially every "why is this so slow" question.
   */
  markers?: Record<string, string>
}

function authHeaders({ json = false }: { json?: boolean } = {}): HeadersInit {
  const token = localStorage.getItem('arcvia.token')
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function submitRender(input: {
  sceneId: string
  preset: RenderPreset
  camera: { position: unknown; rotation: unknown }
  /**
   * The scene already carries lightmap UVs, so bake into those rather than
   * unwrapping fresh ones. Only meaningful for the bake preset, and only true
   * when the studio generated the geometry — a model imported from elsewhere
   * has no such channel and genuinely does need unwrapping.
   */
  prebakedUv?: boolean
  /** A stored viewport capture. Only the 'ai' preset uses one. */
  captureUrl?: string
  /** Which photoreal treatment to apply. */
  style?: string
  /** Free text from the author, appended after the style. */
  note?: string
}): Promise<{ jobId: string; creditsRemaining: number }> {
  const response = await fetch(`${API}/render/jobs`, {
    method: 'POST',
    headers: authHeaders({ json: true }),
    body: JSON.stringify({
      sceneId: input.sceneId,
      preset: input.preset,
      cameraPosition: input.camera.position,
      cameraRotation: input.camera.rotation,
      prebakedUv: input.prebakedUv ?? false,
      captureUrl: input.captureUrl,
      style: input.style,
      note: input.note,
    }),
  })

  const payload = await response.json().catch(() => ({}))

  if (response.status === 402) {
    throw new Error(
      `${payload.message} Renders refresh at the start of each month.`,
    )
  }
  if (!response.ok) {
    throw new Error(payload.message ?? 'Could not start the render.')
  }

  return payload
}

/**
 * Poll a job to completion.
 *
 * Backs off from 1s to 5s. A bake can run for minutes, and hammering the API
 * once a second for the whole duration is pure waste — but the first few
 * seconds are when a fast preview finishes, so it starts tight.
 */
export async function pollRender(
  jobId: string,
  onUpdate: (update: RenderUpdate) => void,
  { timeoutMs = 15 * 60 * 1000 }: { timeoutMs?: number } = {},
): Promise<RenderUpdate> {
  const startedAt = Date.now()
  let interval = 1000

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('The render is taking unusually long. Check back shortly.')
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
    interval = Math.min(interval * 1.35, 5000)

    const response = await fetch(`${API}/render/jobs/${jobId}`, {
      headers: authHeaders(),
    })

    // A transient 5xx mid-render should not throw away a job that is still
    // running — keep polling and let the timeout be the only hard stop.
    if (!response.ok) continue

    const update = (await response.json()) as RenderUpdate
    onUpdate(update)

    if (['done', 'failed', 'cancelled'].includes(update.status)) return update
  }
}

export async function cancelRender(jobId: string): Promise<void> {
  const response = await fetch(`${API}/render/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message ?? 'Could not cancel the render.')
  }
}
