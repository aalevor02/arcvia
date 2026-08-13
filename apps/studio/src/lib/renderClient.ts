const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export type RenderPreset = 'preview' | 'isometric' | 'full' | 'bake'

export interface RenderUpdate {
  status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled'
  progress: number
  outputUrl?: string | null
  error?: string | null
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('arcvia.token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function submitRender(input: {
  sceneId: string
  preset: RenderPreset
  camera: { position: unknown; rotation: unknown }
}): Promise<{ jobId: string; creditsRemaining: number }> {
  const response = await fetch(`${API}/render/jobs`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      sceneId: input.sceneId,
      preset: input.preset,
      cameraPosition: input.camera.position,
      cameraRotation: input.camera.rotation,
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
  await fetch(`${API}/render/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  })
}
