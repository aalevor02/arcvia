export type ModelCaptureSource =
  | 'preserve-baked'
  | 'capture-plan'
  | 'capture-viewer'
  | 'preserve-stored'

export interface ModelCaptureState {
  hasBakedAtlas: boolean
  planHasWalls: boolean
  hasViewerModel: boolean
}

/**
 * Decide which geometry may safely become `scene.modelUrl`.
 *
 * A baked atlas is indexed against the exact mesh/UV layout that was sent to
 * the worker, so it must keep that export until the user bakes again. Plan
 * scenes are rebuilt with ceilings for an honest whole-building render;
 * imported and hybrid scenes must capture the viewer's composed model. An
 * unloaded model-only scene keeps its existing URL instead of replacing the
 * building with an empty plan export.
 */
export function modelCaptureSource(state: ModelCaptureState): ModelCaptureSource {
  if (state.hasBakedAtlas) return 'preserve-baked'
  if (state.planHasWalls) return 'capture-plan'
  if (state.hasViewerModel) return 'capture-viewer'
  return 'preserve-stored'
}

export function needsModelCapture(source: ModelCaptureSource): boolean {
  return source === 'capture-plan' || source === 'capture-viewer'
}
