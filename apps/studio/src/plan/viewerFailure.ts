/**
 * What to tell someone whose 3D view just died.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The studio had NO error boundary anywhere, so a throw inside `SceneView`
 * unmounted the whole React tree and the user was left looking at a blank page
 * — no plan, no room list, no tools, no message. Everything they had just
 * imported was still saved, and nothing on screen said so.
 *
 * Observed on the owner's own machine while testing an upload:
 *
 *     THREE.WebGLRenderer: Context Lost.
 *     THREE.WebGLRenderer: A WebGL context could not be created.
 *       Reason: Web page caused context loss and was blocked
 *     Error: Error creating WebGL context.
 *       at new SceneViewer (packages/viewer/src/SceneViewer.ts:129)
 *     The above error occurred in the <SceneView> component
 *
 * That sequence is not a bug in the scene. Chrome drops a WebGL context when
 * the machine is short of graphics memory, and after a page has lost several it
 * REFUSES to grant another — "caused context loss and was blocked". A modest
 * box running the editor, a renderer and a couple of dev servers reaches that
 * honestly, and the only thing that should follow is a sentence explaining it.
 *
 * The message is split out from the boundary component so the wording, and the
 * decision about what is worth retrying, can be tested. The component itself is
 * four lines of React around this.
 */

export interface ViewerFailure {
  title: string
  detail: string
  /** Whether trying again has any prospect of working. */
  canRetry: boolean
}

/** Chrome's own wording when it will not grant another context. */
const BLOCKED = /context loss and was blocked|context could not be created/i
const WEBGL = /webgl|context lost|error creating webgl/i

export function describeViewerFailure(error: unknown): ViewerFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')

  if (BLOCKED.test(message)) {
    return {
      title: 'The 3D view ran out of graphics memory.',
      detail:
        'The browser stopped granting this page a graphics context, which it ' +
        'does when the machine is short of video memory. Your plan is saved ' +
        'and unaffected — the 2D editor still works. Closing other tabs or ' +
        'heavy applications and reloading usually brings the 3D view back.',
      // Retrying in place cannot work: the block is on the page, not the scene.
      // Offering a button that always fails is worse than not offering one.
      canRetry: false,
    }
  }

  if (WEBGL.test(message)) {
    return {
      title: 'The 3D view lost its graphics context.',
      detail:
        'This usually clears on its own. Your plan is saved and the 2D editor ' +
        'is unaffected.',
      canRetry: true,
    }
  }

  return {
    title: 'The 3D view could not be drawn.',
    detail:
      `Your plan is saved and the 2D editor is unaffected. The error was: ` +
      `${message || 'no message given'}.`,
    canRetry: true,
  }
}
