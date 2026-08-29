/**
 * Detection accepts only object keys under Arcvia's configured CDN origin.
 *
 * Run: node test/detect-storage-key.mjs
 */

process.env.S3_PUBLIC_URL = 'https://cdn.example.test/arcvia'
const { storageKey } = await import('../src/routes/detect.js')

let passed = 0
let failed = 0
const ok = (label, condition) => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}`)
  }
}

ok('bare object keys remain accepted', storageKey('plans/example.png') === 'plans/example.png')
ok(
  'configured CDN URLs become storage keys',
  storageKey('https://cdn.example.test/arcvia/plans/example.png') === 'plans/example.png',
)
ok(
  'a different origin with the same path is refused',
  storageKey('https://evil.example/arcvia/plans/example.png') === null,
)
ok('a URL outside the configured CDN path is refused', storageKey('https://cdn.example.test/other.png') === null)
ok('malformed URLs are refused', storageKey('https://%') === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
