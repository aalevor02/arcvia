import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGenerator } from 'ts-json-schema-generator'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = resolve(packageRoot, 'schema', 'building-1.json')
const config = {
  path: resolve(packageRoot, 'src', 'schema.ts'),
  tsconfig: resolve(packageRoot, 'tsconfig.json'),
  type: 'BuildingModel',
  expose: 'export',
  jsDoc: 'extended',
  topRef: true,
  additionalProperties: false,
  skipTypeCheck: false,
}

const checkedIn = JSON.parse(await readFile(schemaPath, 'utf8'))
const generated = createGenerator(config).createSchema(config.type)

assert.deepEqual(
  checkedIn,
  generated,
  'building-1.json is stale; run npm run generate:schema --workspace=@arcvia/building-model',
)
assert.equal(checkedIn.$schema, 'http://json-schema.org/draft-07/schema#')
assert.equal(checkedIn.$ref, '#/definitions/BuildingModel')
assert.deepEqual(checkedIn.definitions.BuildingModel.required, [
  'schema',
  'id',
  'name',
  'units',
  'up',
  'status',
  'sources',
  'frames',
  'unit',
  'sourceOrigin',
  'northAngle',
  'storeys',
  'storeyLinks',
  'definitions',
  'annotations',
  'residuals',
  'patches',
  'quality',
])
const objectDefinitions = Object.entries(checkedIn.definitions)
  .filter(([, definition]) => definition.type === 'object')

assert.ok(objectDefinitions.length > 0, 'the contract must contain object definitions')
for (const [name, definition] of objectDefinitions) {
  assert.equal(
    definition.additionalProperties,
    false,
    `${name} must reject fields outside the TypeScript contract`,
  )
}

assert.equal(checkedIn.definitions.P2.minItems, 2)
assert.equal(checkedIn.definitions.P2.maxItems, 2)
assert.equal(checkedIn.definitions.BuildingModel.properties.schema.const, 'arcvia.building/1')
assert.equal(checkedIn.definitions.BuildingModel.properties.units.const, 'm')
assert.equal(checkedIn.definitions.BuildingModel.properties.up.const, 'z')

console.log('building-model JSON Schema matches the strict TypeScript contract')
