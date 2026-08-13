import { useEffect, useRef, useState } from 'react'
import { SceneViewer, type LightSpec } from './viewer/SceneViewer'
import { submitRender, pollRender, type RenderPreset } from './lib/renderClient'

const PRESETS: { id: RenderPreset; label: string; credits: number; note: string }[] = [
  { id: 'preview', label: 'Preview', credits: 1, note: '240px · 4 samples' },
  { id: 'isometric', label: 'Isometric', credits: 3, note: '1920×1080 · 32 samples' },
  { id: 'full', label: 'Full still', credits: 5, note: '2560×1440 · 128 samples' },
  { id: 'bake', label: 'Lightmap bake', credits: 25, note: 'Whole scene · slow' },
]

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<SceneViewer | null>(null)

  const [status, setStatus] = useState('Load a model to begin')
  const [stats, setStats] = useState<{ triangles: number; objects: number } | null>(null)
  const [exposure, setExposure] = useState(1)
  const [job, setJob] = useState<{ id: string; status: string; progress: number } | null>(null)
  const [lights] = useState<LightSpec[]>([])

  useEffect(() => {
    if (!canvasRef.current) return

    const viewer = new SceneViewer({
      canvas: canvasRef.current,
      onProgress: (f) => setStatus(`Loading… ${Math.round(f * 100)}%`),
      onReady: (info) => {
        setStats(info)
        setStatus('Ready')
      },
      onError: (err) => setStatus(err.message),
    })
    viewerRef.current = viewer

    // StrictMode mounts effects twice in development. Without this teardown the
    // first viewer keeps its WebGL context and rAF loop alive forever, and you
    // end up debugging a "phantom" renderer that is not the one on screen.
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !viewerRef.current) return

    const url = URL.createObjectURL(file)
    setStatus('Loading…')
    await viewerRef.current.loadModel(url)
    URL.revokeObjectURL(url)
  }

  async function handleRender(preset: RenderPreset) {
    const viewer = viewerRef.current
    if (!viewer) return

    setStatus(`Submitting ${preset}…`)
    try {
      const { jobId } = await submitRender({
        sceneId: new URLSearchParams(location.search).get('scene') ?? '',
        preset,
        camera: viewer.cameraSpec(),
      })

      setJob({ id: jobId, status: 'queued', progress: 0 })

      // Poll rather than hold a socket open. A bake can take minutes, and a
      // dropped websocket mid-render is a worse failure than a missed poll.
      const result = await pollRender(jobId, (update) =>
        setJob({ id: jobId, status: update.status, progress: update.progress }),
      )

      setStatus(
        result.status === 'done' ? 'Render complete' : `Render ${result.status}`,
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Render failed')
      setJob(null)
    }
  }

  return (
    <div style={styles.shell}>
      <aside style={styles.panel}>
        <h1 style={styles.brand}>Arcvia Studio</h1>

        <section style={styles.section}>
          <label style={styles.label}>Model</label>
          <input
            type="file"
            accept=".glb,.gltf,.fbx"
            onChange={handleFile}
            style={styles.input}
          />
          {stats && (
            <p style={styles.meta}>
              {stats.objects.toLocaleString()} objects ·{' '}
              {stats.triangles.toLocaleString()} triangles
            </p>
          )}
        </section>

        <section style={styles.section}>
          <label style={styles.label}>
            Exposure <span style={styles.mono}>{exposure.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min="0.1"
            max="3"
            step="0.05"
            value={exposure}
            onChange={(e) => {
              const value = Number(e.target.value)
              setExposure(value)
              viewerRef.current?.setExposure(value)
            }}
            style={{ width: '100%' }}
          />
        </section>

        <section style={styles.section}>
          <label style={styles.label}>Render</label>
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handleRender(preset.id)}
              disabled={Boolean(job) || !stats}
              style={styles.presetButton}
            >
              <span>
                <strong>{preset.label}</strong>
                <br />
                <span style={styles.meta}>{preset.note}</span>
              </span>
              <span style={styles.credits}>{preset.credits}cr</span>
            </button>
          ))}
        </section>

        {job && (
          <section style={styles.section}>
            <label style={styles.label}>
              {job.status} · {job.progress}%
            </label>
            <div style={styles.track}>
              <div style={{ ...styles.fill, width: `${job.progress}%` }} />
            </div>
          </section>
        )}

        <p style={{ ...styles.meta, marginTop: 'auto' }}>{status}</p>
      </aside>

      <div style={styles.stage}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  shell: { display: 'grid', gridTemplateColumns: '280px 1fr', height: '100%' },
  panel: {
    background: 'var(--panel)',
    borderRight: '1px solid var(--line)',
    padding: '20px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 22,
    overflowY: 'auto',
  },
  brand: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'var(--ink-soft)',
  },
  input: { fontSize: 12, color: 'var(--ink-soft)' },
  meta: { fontSize: 11, color: 'var(--ink-soft)' },
  mono: { fontFamily: 'ui-monospace, monospace', color: 'var(--ink)' },
  presetButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '9px 11px',
    borderRadius: 8,
    border: '1px solid var(--line)',
    background: 'transparent',
    color: 'var(--ink)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 12,
  },
  credits: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    color: 'var(--accent)',
  },
  track: { height: 4, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' },
  fill: { height: '100%', background: 'var(--accent)', transition: 'width .3s' },
  stage: { position: 'relative', overflow: 'hidden' },
}
