import { productionConfiguration } from '../src/lib/productionConfig.js'

let passed = 0
let failed = 0
function ok(name, condition) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}`)
  }
}

const valid = {
  NODE_ENV: 'production',
  JWT_SECRET: 'j'.repeat(48),
  WORKER_SECRET: 'w'.repeat(48),
  PUBLIC_SITE_URL: 'https://arcvia.example',
  ALLOWED_ORIGINS: 'https://arcvia.example,https://studio.arcvia.example',
  DB_PROVIDER: 'sqlite',
  DB_PATH: '/var/lib/arcvia/arcvia.sqlite',
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'arcvia-production',
  S3_REGION: 'ap-south-1',
  S3_PUBLIC_URL: 'https://cdn.arcvia.example',
  UPLOAD_DIR: '/var/lib/arcvia/staging',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_AUTH_TOKEN: 'twilio-test',
  TWILIO_FROM_NUMBER: '+910000000000',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're-test',
  MAIL_FROM: 'Arcvia <delivery@arcvia.example>',
  PUBLIC_API_URL: 'https://api.arcvia.example',
  VITE_API_URL: 'https://api.arcvia.example',
  VITE_SITE_URL: 'https://arcvia.example',
  RENDER_MODE: 'remote',
  RENDER_WORKER_URL: 'https://render.arcvia.example',
  RENDER_CONCURRENCY: '1',
  RENDER_HEAVY_CONCURRENCY: '1',
  RENDER_DAILY_CAP: '500',
  RENDER_TIMEOUT_MS: '600000',
  BAKE_TIMEOUT_MS: '2700000',
  ARCVIA_MAX_ATLAS_SIZE: '4096',
  FLOORPLAN_URL: 'http://floorplan.internal:8090',
  FLOORPLAN_AI_PROVIDER: 'openai',
  FLOORPLAN_MODEL: '/models/floorplan.onnx',
  OPENAI_API_KEY: 'test-key',
}

const accepted = productionConfiguration(valid)
ok('a complete production configuration passes', accepted.ok)
ok('the summary reports providers without secret values',
  accepted.summary.smsProvider === 'twilio'
    && accepted.summary.mailProvider === 'resend'
    && !JSON.stringify(accepted.summary).includes('test-key'))

const missing = productionConfiguration({ NODE_ENV: 'production' })
ok('missing production inputs fail together', !missing.ok && missing.errors.length > 15)
ok('missing secrets are named but never printed',
  missing.errors.includes('JWT_SECRET is required')
    && !missing.errors.some((error) => error.includes('dev-only')))

const origins = productionConfiguration({
  ...valid,
  ALLOWED_ORIGINS: 'http://arcvia.example,https://studio.arcvia.example',
})
ok('HTTP browser origins are refused', origins.errors.some((error) => error.includes('HTTPS')))
ok('the public site must be present in CORS origins',
  origins.errors.some((error) => error.includes('include PUBLIC_SITE_URL')))

ok('short signing secrets are refused',
  productionConfiguration({ ...valid, JWT_SECRET: 'short' }).errors
    .some((error) => error.includes('at least 32')))
ok('relative database paths are refused',
  productionConfiguration({ ...valid, DB_PATH: './arcvia.sqlite' }).errors
    .some((error) => error.includes('DB_PATH must be an absolute')))
ok('relative CAD staging paths are refused',
  productionConfiguration({ ...valid, UPLOAD_DIR: './staging' }).errors
    .some((error) => error.includes('UPLOAD_DIR must be an absolute')))
ok('half-configured S3 credentials are refused',
  productionConfiguration({ ...valid, S3_ACCESS_KEY_ID: 'id' }).errors
    .some((error) => error.includes('both access key and secret')))
ok('unsupported delivery providers are refused',
  !productionConfiguration({ ...valid, SMS_PROVIDER: 'console' }).ok)
ok('a gapped mail sender is refused',
  !productionConfiguration({ ...valid, MAIL_FROM: 'Arcvia' }).ok)
ok('remote rendering requires an HTTPS worker',
  !productionConfiguration({ ...valid, RENDER_WORKER_URL: 'http://render.local' }).ok)
ok('render concurrency is bounded',
  !productionConfiguration({ ...valid, RENDER_CONCURRENCY: '20' }).ok)
ok('the atlas memory ceiling must be a power of two',
  !productionConfiguration({ ...valid, ARCVIA_MAX_ATLAS_SIZE: '3000' }).ok)
ok('OpenAI adjudication requires its server-side key',
  !productionConfiguration({ ...valid, OPENAI_API_KEY: '' }).ok)
ok('local rendering requires an absolute Blender path',
  !productionConfiguration({ ...valid, RENDER_MODE: 'local', BLENDER_PATH: 'blender' }).ok)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
