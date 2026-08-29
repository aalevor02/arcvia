/** Versioned, server-owned assets understood by the Blender worker. */
export const RENDER_ASSET_CONTRACT = Object.freeze({
  materialProfile: 'standard',
  materialArtifact: 'render-materials-v1',
  catalogueArtifact: 'catalogue-models-v1',
})

/**
 * Add reconstruction evidence without trusting a URL from the request body.
 * A missing sidecar is optional: the GLB can still render with fixture boxes.
 */
export function renderAssetsForScene(scene, resolveUrl) {
  const fixturesUrl = scene?.cadModelJsonUrl
    ? resolveUrl(scene.cadModelJsonUrl)
    : null
  return { ...RENDER_ASSET_CONTRACT, fixturesUrl }
}
