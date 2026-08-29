import {
  protectedAssetUrl,
  verifyProtectedAsset,
} from '../src/lib/publicAssetAccess.js'
import { keyOfOwnUpload } from '../src/lib/storage.js'

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

const secret = 's'.repeat(48)
const now = 1_800_000_000_000
const scene = {
  id: 'scene-1',
  published: true,
  publishedSlug: 'villa',
  accessCodeHash: 'scrypt$hash-one',
  modelUrl: '/uploads/scenes/u/model.glb',
}
const signed = protectedAssetUrl(scene, 'modelUrl', { now, secret })
const parsed = new URL(signed, 'https://api.example')

ok('a protected URL contains no raw storage key', !signed.includes('/uploads/'))
ok('a protected URL names only the publication and field',
  parsed.pathname === '/scenes/public/villa/assets/modelUrl')
ok('a fresh signature verifies',
  verifyProtectedAsset(
    scene,
    'modelUrl',
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
    { now: now + 1000, secret },
  ))
ok('a tampered field is refused',
  !verifyProtectedAsset(
    scene,
    'bakedUrl',
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
    { now: now + 1000, secret },
  ))
ok('an expired URL is refused',
  !verifyProtectedAsset(
    scene,
    'modelUrl',
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
    { now: now + 16 * 60 * 1000, secret },
  ))
ok('changing the access code revokes outstanding URLs',
  !verifyProtectedAsset(
    { ...scene, accessCodeHash: 'scrypt$hash-two' },
    'modelUrl',
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
    { now: now + 1000, secret },
  ))
ok('unpublishing revokes outstanding URLs',
  !verifyProtectedAsset(
    { ...scene, published: false },
    'modelUrl',
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
    { now: now + 1000, secret },
  ))
ok('a safe owned URL resolves to its storage key',
  keyOfOwnUpload('/uploads/scenes/u/model.glb') === 'scenes/u/model.glb')
ok('a traversal-shaped URL has no storage key',
  keyOfOwnUpload('/uploads/../../secret') === null)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
