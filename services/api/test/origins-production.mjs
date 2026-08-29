/**
 * Production origins refuse ambiguous or development-only defaults.
 *
 * Run: node test/origins-production.mjs
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const moduleUrl = new URL('../src/lib/origins.js', import.meta.url).href

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

async function boot(overrides = {}) {
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ALLOWED_ORIGINS
  delete env.PUBLIC_SITE_URL
  Object.assign(env, overrides)
  try {
    const { stdout } = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({ allowed: m.isOriginAllowed('https://studio.example.com'), refused: m.isOriginAllowed('https://evil.example') }))`,
      ],
      { env, timeout: 10000 },
    )
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

const missing = await boot()
ok('production refuses implicit development origins', !missing.ok)
ok('missing configuration names ALLOWED_ORIGINS', missing.stderr.includes('ALLOWED_ORIGINS'))

const missingSite = await boot({ ALLOWED_ORIGINS: 'https://studio.example.com' })
ok('production requires the public site origin', !missingSite.ok)
ok('missing configuration names PUBLIC_SITE_URL', missingSite.stderr.includes('PUBLIC_SITE_URL'))

const insecure = await boot({
  ALLOWED_ORIGINS: 'http://studio.example.com',
  PUBLIC_SITE_URL: 'https://example.com',
})
ok('production refuses an HTTP browser origin', !insecure.ok)
ok('the refusal explains the HTTPS requirement', insecure.stderr.includes('HTTPS'))

const valid = await boot({
  ALLOWED_ORIGINS: 'https://example.com,https://studio.example.com',
  PUBLIC_SITE_URL: 'https://example.com',
})
ok('explicit HTTPS production origins boot', valid.ok, valid.stderr.slice(0, 160))
const result = valid.ok ? JSON.parse(valid.stdout) : {}
ok('the configured studio origin is allowed', result.allowed === true)
ok('an unconfigured origin is refused', result.refused === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
