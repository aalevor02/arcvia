import { PanoramaViewer as PanoramaRenderer } from '@arcvia/viewer'
import { useEffect, useRef } from 'react'

interface Props {
  src: string
  onClose(): void
}

/** Modal shell around the shared interactive equirectangular renderer. */
export default function PanoramaViewer({ src, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const panorama = new PanoramaRenderer({ canvas, src })
    return () => panorama.dispose()
  }, [src])

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="panorama-title"
        ref={dialogRef}
        tabIndex={-1}
        style={{ width: 'min(1000px, 96vw)', padding: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 id="panorama-title">360 panorama</h2>
            <p className="muted" style={{ marginTop: 3, fontSize: 12 }}>
              Drag to look around. Use the wheel to zoom.
            </p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <canvas
          ref={canvasRef}
          aria-label="Interactive 360 panorama"
          style={{
            display: 'block',
            width: '100%',
            height: 'min(70vh, 620px)',
            marginTop: 12,
            borderRadius: 8,
            cursor: 'grab',
            touchAction: 'none',
          }}
        />
      </div>
    </div>
  )
}
