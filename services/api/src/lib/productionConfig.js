import { isAbsolute } from 'node:path'

const value = (env, name) => String(env[name] ?? '').trim()

function secureUrl(raw, name, errors, { allowHttp = false } = {}) {
  if (!raw) {
    errors.push(`${name} is required`)
    return null
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    errors.push(`${name} must be an absolute URL`)
    return null
  }
  if (parsed.username || parsed.password || parsed.hash) {
    errors.push(`${name} must not contain credentials or a fragment`)
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    errors.push(`${name} must use HTTPS`)
  }
  return parsed
}

function required(env, name, errors) {
  if (!value(env, name)) errors.push(`${name} is required`)
}

function secret(env, name, errors) {
  const configured = value(env, name)
  if (!configured) errors.push(`${name} is required`)
  else if (configured.length < 32) errors.push(`${name} must contain at least 32 characters`)
}

function boundedInteger(env, name, fallback, minimum, maximum, errors) {
  const parsed = Number(value(env, name) || fallback)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

/**
 * Validate the complete production contract without opening network
 * connections or revealing configured values.
 */
export function productionConfiguration(env = process.env) {
  const errors = []
  const warnings = []

  if (value(env, 'NODE_ENV') !== 'production') {
    errors.push('NODE_ENV must be production')
  }
  secret(env, 'JWT_SECRET', errors)
  secret(env, 'WORKER_SECRET', errors)

  const site = secureUrl(value(env, 'PUBLIC_SITE_URL'), 'PUBLIC_SITE_URL', errors)
  const origins = value(env, 'ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (!origins.length) errors.push('ALLOWED_ORIGINS must list the production web origins')
  const parsedOrigins = origins
    .map((origin, index) => secureUrl(origin, `ALLOWED_ORIGINS[${index}]`, errors))
    .filter(Boolean)
  if (new Set(origins).size !== origins.length) {
    errors.push('ALLOWED_ORIGINS contains duplicates')
  }
  if (site && !parsedOrigins.some((origin) => origin.origin === site.origin)) {
    errors.push('ALLOWED_ORIGINS must include PUBLIC_SITE_URL')
  }

  if (value(env, 'DB_PROVIDER') !== 'sqlite') {
    errors.push('DB_PROVIDER must be sqlite for the current single-instance production API')
  }
  const dbPath = value(env, 'DB_PATH')
  if (!dbPath) errors.push('DB_PATH is required')
  else if (!isAbsolute(dbPath)) errors.push('DB_PATH must be an absolute persistent-volume path')

  if (value(env, 'STORAGE_PROVIDER') !== 's3') {
    errors.push('STORAGE_PROVIDER must be s3 in production')
  }
  required(env, 'S3_BUCKET', errors)
  required(env, 'S3_REGION', errors)
  secureUrl(value(env, 'S3_PUBLIC_URL'), 'S3_PUBLIC_URL', errors)
  const access = value(env, 'S3_ACCESS_KEY_ID') || value(env, 'AWS_ACCESS_KEY_ID')
  const secretKey =
    value(env, 'S3_SECRET_ACCESS_KEY') || value(env, 'AWS_SECRET_ACCESS_KEY')
  if (Boolean(access) !== Boolean(secretKey)) {
    errors.push('S3 static credentials must include both access key and secret, or neither')
  }
  const uploadDir = value(env, 'UPLOAD_DIR')
  if (!uploadDir) errors.push('UPLOAD_DIR is required for CAD staging')
  else if (!isAbsolute(uploadDir)) {
    errors.push('UPLOAD_DIR must be an absolute persistent-volume path')
  }

  if (value(env, 'SMS_PROVIDER').toLowerCase() !== 'twilio') {
    errors.push('SMS_PROVIDER must be twilio')
  }
  required(env, 'TWILIO_ACCOUNT_SID', errors)
  if (!value(env, 'TWILIO_AUTH_TOKEN') && !value(env, 'SMS_API_KEY')) {
    errors.push('TWILIO_AUTH_TOKEN is required')
  }
  required(env, 'TWILIO_FROM_NUMBER', errors)

  if (value(env, 'MAIL_PROVIDER').toLowerCase() !== 'resend') {
    errors.push('MAIL_PROVIDER must be resend')
  }
  if (!value(env, 'RESEND_API_KEY') && !value(env, 'MAIL_API_KEY')) {
    errors.push('RESEND_API_KEY is required')
  }
  const from = value(env, 'MAIL_FROM')
  if (!from) errors.push('MAIL_FROM is required')
  else if (!/.+@.+\..+/.test(from)) errors.push('MAIL_FROM must contain a sender email address')

  for (const name of ['PUBLIC_API_URL', 'VITE_API_URL', 'VITE_SITE_URL']) {
    secureUrl(value(env, name), name, errors)
  }

  const renderMode = value(env, 'RENDER_MODE')
  if (!['local', 'remote'].includes(renderMode)) {
    errors.push('RENDER_MODE must be local or remote')
  } else if (renderMode === 'remote') {
    secureUrl(value(env, 'RENDER_WORKER_URL'), 'RENDER_WORKER_URL', errors)
  } else {
    const blender = value(env, 'BLENDER_PATH')
    if (!blender) errors.push('BLENDER_PATH is required for a local render worker')
    else if (!isAbsolute(blender)) errors.push('BLENDER_PATH must be absolute')
    warnings.push('Local rendering shares API capacity; use a remote GPU worker before scaling traffic')
  }
  boundedInteger(env, 'RENDER_CONCURRENCY', 1, 1, 4, errors)
  boundedInteger(env, 'RENDER_HEAVY_CONCURRENCY', 1, 1, 2, errors)
  boundedInteger(env, 'RENDER_DAILY_CAP', 500, 1, 10000, errors)
  boundedInteger(env, 'RENDER_TIMEOUT_MS', 600000, 60000, 3600000, errors)
  boundedInteger(env, 'BAKE_TIMEOUT_MS', 2700000, 300000, 7200000, errors)

  secureUrl(value(env, 'FLOORPLAN_URL'), 'FLOORPLAN_URL', errors, { allowHttp: true })
  const aiProvider = value(env, 'FLOORPLAN_AI_PROVIDER').toLowerCase()
  if (aiProvider === 'openai') required(env, 'OPENAI_API_KEY', errors)
  else if (!['auto', 'nvidia'].includes(aiProvider)) {
    errors.push('FLOORPLAN_AI_PROVIDER must be openai, nvidia, or auto')
  }
  required(env, 'FLOORPLAN_MODEL', errors)

  if (value(env, 'DB_PROVIDER') === 'sqlite') {
    warnings.push('SQLite permits one API instance; migrate to PostgreSQL before horizontal scaling')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      origins: origins.length,
      renderMode: renderMode || null,
      storageProvider: value(env, 'STORAGE_PROVIDER') || null,
      databaseProvider: value(env, 'DB_PROVIDER') || null,
      smsProvider: value(env, 'SMS_PROVIDER') || null,
      mailProvider: value(env, 'MAIL_PROVIDER') || null,
    },
  }
}
