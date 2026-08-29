import { createHmac, timingSafeEqual } from 'node:crypto'

export const PUBLIC_ASSET_FIELDS = new Set([
  'modelUrl',
  'lightsUrl',
  'hdriUrl',
  'bakedUrl',
  'panoramaUrl',
])

const DEFAULT_TTL_MS = 15 * 60 * 1000

function signingSecret(env = process.env) {
  return String(
    env.PUBLIC_ASSET_SECRET
      ?? env.JWT_SECRET
      ?? 'dev-only-public-asset-secret-change-me',
  )
}

function payload(scene, field, expires) {
  return [
    scene.id,
    scene.publishedSlug,
    scene.accessCodeHash,
    field,
    scene[field],
    expires,
  ].join('\n')
}

function signature(scene, field, expires, secret) {
  return createHmac('sha256', secret)
    .update(payload(scene, field, expires))
    .digest('base64url')
}

export function protectedAssetUrl(
  scene,
  field,
  { now = Date.now(), ttlMs = DEFAULT_TTL_MS, secret = signingSecret() } = {},
) {
  if (!PUBLIC_ASSET_FIELDS.has(field) || !scene[field]) return null
  const expires = now + ttlMs
  const sig = signature(scene, field, expires, secret)
  return (
    `/scenes/public/${encodeURIComponent(scene.publishedSlug)}/assets/`
    + `${encodeURIComponent(field)}?expires=${expires}&sig=${encodeURIComponent(sig)}`
  )
}

export function verifyProtectedAsset(
  scene,
  field,
  expiresInput,
  signatureInput,
  { now = Date.now(), secret = signingSecret() } = {},
) {
  if (!scene?.published || !scene?.accessCodeHash || !PUBLIC_ASSET_FIELDS.has(field)) {
    return false
  }
  const expires = Number(expiresInput)
  if (!Number.isSafeInteger(expires) || expires <= now || expires - now > DEFAULT_TTL_MS) {
    return false
  }
  const supplied = Buffer.from(String(signatureInput ?? ''))
  const expected = Buffer.from(signature(scene, field, expires, secret))
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
