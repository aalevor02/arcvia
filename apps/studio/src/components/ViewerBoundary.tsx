import { Component, type ErrorInfo, type ReactNode } from 'react'
import { describeViewerFailure } from '../plan/viewerFailure'

interface Props {
  children: ReactNode
  /** Called when the user asks to go back to the plan. */
  onLeave?(): void
}

interface State {
  error: unknown
}

/**
 * Keep a failed 3D view from taking the whole studio with it.
 *
 * The studio had no error boundary at all, so a throw inside `SceneView`
 * unmounted the entire React tree: no plan, no room list, no tools, no message,
 * just a blank page. Observed on the owner's machine while testing an upload,
 * where Chrome refused a WebGL context after several losses. Everything was
 * still saved and nothing on screen said so.
 *
 * A boundary is the only thing React offers here — an exception during render
 * or in a mount effect cannot be caught by a try/catch around the JSX. It is
 * scoped to the viewer rather than the app so a failure keeps the 2D editor
 * alive, which is the part that still works and the part holding the user's
 * unsaved attention.
 *
 * The wording lives in `describeViewerFailure` so it can be tested; this is the
 * plumbing around it.
 */
export class ViewerBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Kept: the boundary swallows the throw, and a swallowed error that is
    // never printed is how a reproducible fault becomes a rumour.
    console.error('3D view failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children

    const failure = describeViewerFailure(this.state.error)
    return (
      <div className="viewer-failed" style={{ padding: 24, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>{failure.title}</h2>
        <p>{failure.detail}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {failure.canRetry && (
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          )}
          {this.props.onLeave && (
            <button className="btn" onClick={this.props.onLeave}>
              Back to the plan
            </button>
          )}
        </div>
      </div>
    )
  }
}
