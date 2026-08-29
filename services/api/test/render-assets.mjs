import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RENDER_ASSET_CONTRACT,
  renderAssetsForScene,
} from '../src/lib/renderAssets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
let passed = 0
let failed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}: ${error.message}`)
  }
}

check('contract names versioned worker-owned artifacts', () => {
  assert.deepEqual(RENDER_ASSET_CONTRACT, {
    materialProfile: 'standard',
    materialArtifact: 'render-materials-v1',
    catalogueArtifact: 'catalogue-models-v1',
  })
})

check('the server resolves stored CAD evidence', () => {
  const seen = []
  const result = renderAssetsForScene(
    { cadModelJsonUrl: '/uploads/scene.building.json' },
    (url) => { seen.push(url); return `C:/storage${url}` },
  )
  assert.deepEqual(seen, ['/uploads/scene.building.json'])
  assert.equal(result.fixturesUrl, 'C:/storage/uploads/scene.building.json')
})

check('a scene without CAD evidence retains fixture boxes', () => {
  const result = renderAssetsForScene(
    {},
    () => { throw new Error('must not resolve') },
  )
  assert.equal(result.fixturesUrl, null)
})

check('the render route includes the asset contract in persisted job specs', () => {
  const route = readFileSync(resolve(ROOT, 'services/api/src/routes/render.js'), 'utf8')
  assert.match(route, /\.\.\.renderAssetsForScene\(scene, resolveUrl\)/)
})

check('material artifact references shipped files and valid material ids', () => {
  const artifactPath = resolve(ROOT, 'data/materials/render-materials.json')
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
  assert.equal(artifact._version, 1)
  assert.ok(Object.keys(artifact.surface_classes).length >= 30)
  for (const [klass, materialId] of Object.entries(artifact.surface_classes)) {
    assert.ok(artifact.materials[materialId], `${klass} -> missing ${materialId}`)
  }
  for (const material of Object.values(artifact.materials)) {
    for (const path of Object.values(material.texture ?? {})) {
      assert.ok(existsSync(resolve(dirname(artifactPath), path)), path)
    }
  }
})

check('catalogue artifact references model files shipped in the repository', () => {
  const artifact = JSON.parse(
    readFileSync(resolve(ROOT, 'data/catalogue-models.json'), 'utf8'),
  )
  for (const [id, item] of Object.entries(artifact.items)) {
    if (!item.file) continue
    const path = resolve(
      ROOT, 'apps/studio/public', item.file.replace(/^\//, ''),
    )
    assert.ok(existsSync(path), id)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
