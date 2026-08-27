import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type * as WebIfc from 'web-ifc'
import { extractOpenIfcMetadata } from '../src/bim/ifcMetadata'
import { createIfcPlanProposal, planFromIfcProposal } from '../src/bim/ifcPlanProposal'
import type { BimElementKind } from '../src/bim/semantics'

interface Fixture {
  file: string
  bytes: number
  sha256: string
  requiredKinds: BimElementKind[]
}

interface Manifest {
  source: { license: string; commit: string }
  files: Fixture[]
}

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, detail = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'ifc')
const nodeRequire = createRequire(join(process.cwd(), 'package.json'))
const { IfcAPI } = nodeRequire('web-ifc') as typeof WebIfc
const manifest = JSON.parse(
  await readFile(join(fixtureDir, 'manifest.json'), 'utf8'),
) as Manifest

check('corpus has an explicit reusable licence', manifest.source.license.includes('Attribution 4.0'))
check('corpus is pinned to a full commit', /^[0-9a-f]{40}$/.test(manifest.source.commit))

const api = new IfcAPI()
await api.Init(undefined, true)

for (const fixture of manifest.files) {
  const bytes = await readFile(join(fixtureDir, fixture.file))
  const digest = createHash('sha256').update(bytes).digest('hex')
  check(`${fixture.file}: byte size is pinned`, bytes.byteLength === fixture.bytes)
  check(`${fixture.file}: checksum is pinned`, digest === fixture.sha256)

  const modelID = api.OpenModel(bytes)
  check(`${fixture.file}: opens in web-ifc`, modelID >= 0)
  if (modelID < 0) continue

  try {
    const result = await extractOpenIfcMetadata(api, modelID, {
      includeProperties: fixture.file === 'IFC4-building-architecture.ifc',
      includeGeometry:
        fixture.file === 'IFC4-wall-opening-window.ifc'
        || fixture.file === 'IFC4-building-structural.ifc'
        || fixture.file.endsWith('building-architecture.ifc'),
      includeMeshes: fixture.file === 'IFC4-building-structural.ifc',
      meshVertexBudget: 100_000,
    })
    check(`${fixture.file}: schema is reported`, result.schema.startsWith('IFC'))
    check(`${fixture.file}: native object records are preserved`,
      result.records.length > result.elements.length,
      `records=${result.records.length}, elements=${result.elements.length}`)
    check(`${fixture.file}: preserved record ids are unique`,
      new Set(result.records.map((record) => record.sourceId)).size === result.records.length)
    check(`${fixture.file}: spatial structure survives even when not editable`,
      result.records.some((record) => record.sourceClass?.toUpperCase() === 'IFCBUILDINGSTOREY'))
    const kinds = new Set(result.elements.map((element) => element.kind))
    for (const kind of fixture.requiredKinds) {
      check(`${fixture.file}: contains ${kind}`, kinds.has(kind), [...kinds].join(', '))
    }
    if (fixture.file === 'IFC4-wall-opening-window.ifc') {
      const window = result.elements.find((element) => element.kind === 'window')
      check(`${fixture.file}: window fills an opening`, Boolean(window?.relations.fillsOpeningId))
      check(`${fixture.file}: window resolves its wall host`, Boolean(window?.relations.hostId))
      const wall = result.elements.find((element) => element.kind === 'wall')
      check(`${fixture.file}: wall geometry is measured in metres`,
        Boolean(wall?.geometry?.planAxis && wall.geometry.planAxis.length > 1))
      check(`${fixture.file}: wall thickness is measured`,
        Boolean(wall?.geometry?.planAxis && wall.geometry.planAxis.thickness > 0.05))
      check(`${fixture.file}: compound wall material layer is normalized to metres`,
        wall?.materials[0]?.layers[0]?.sourceThickness === 300
        && wall.materials[0].layers[0].thicknessSI === 0.3)
      const proposal = createIfcPlanProposal(result, fixture.file)
      check(`${fixture.file}: measured wall becomes a plan proposal`,
        proposal.storeys.reduce((sum, storey) => sum + storey.walls.length, 0) > 0)
      check(`${fixture.file}: hosted window becomes an opening proposal`,
        proposal.storeys.reduce((sum, storey) => sum + storey.openings.length, 0) > 0)
      const plan = planFromIfcProposal(proposal)
      check(`${fixture.file}: proposal becomes editable Arcvia geometry`,
        plan.floors.some((floor) => Object.keys(floor.walls).length > 0))
    }
    if (fixture.file === 'IFC4-building-architecture.ifc') {
      const quantities = result.elements.flatMap((element) => element.quantities)
      check(`${fixture.file}: source quantity sets are extracted`, quantities.length > 0)
      check(`${fixture.file}: millimetre lengths normalize to metres`,
        quantities.some((quantity) =>
          quantity.dimension === 'length'
          && quantity.sourceUnit === 'mm'
          && quantity.valueSI !== undefined
          && quantity.valueSI < quantity.sourceValue))
      check(`${fixture.file}: area and volume units normalize independently`,
        quantities.some((quantity) => quantity.dimension === 'area' && quantity.unitSI === 'm²')
        && quantities.some((quantity) => quantity.dimension === 'volume' && quantity.unitSI === 'm³'))
      check(`${fixture.file}: direct material associations are retained`,
        result.elements.some((element) =>
          element.materials.some((material) => Boolean(material.name))))
      const measuredSpaces = result.elements.filter((element) =>
        element.kind === 'space' && element.geometry?.planLoop)
      check(`${fixture.file}: IfcSpace floor boundaries are measured from source triangles`,
        measuredSpaces.length > 0)
      const spaceProposal = createIfcPlanProposal(result, fixture.file)
      check(`${fixture.file}: measured spaces survive proposal conversion`,
        spaceProposal.storeys.some((storey) => storey.spaces.length > 0))
    }
    if (fixture.file === 'IFC4-building-structural.ifc') {
      const proposal = createIfcPlanProposal(result, fixture.file)
      check(`${fixture.file}: beams and roofs become measured reference solids`,
        proposal.storeys.some((storey) =>
          storey.components.some((component) =>
            component.kind === 'beam' || component.kind === 'roof')))
      check(`${fixture.file}: eligible components retain exact triangles`,
        proposal.storeys.some((storey) =>
          storey.components.some((component) =>
            Boolean(component.mesh?.positions.length && component.mesh.indices.length))))
      const plan = planFromIfcProposal(proposal)
      check(`${fixture.file}: reference solids persist in the Arcvia plan`,
        plan.floors.some((floor) => Object.keys(floor.bimComponents).length > 0))
      check(`${fixture.file}: exact triangles persist in the Arcvia plan`,
        plan.floors.some((floor) =>
          Object.values(floor.bimComponents).some((component) =>
            component.representation === 'mesh' && Boolean(component.mesh))))
      const boundsOnly = await extractOpenIfcMetadata(api, modelID, {
        includeProperties: false,
        includeGeometry: true,
        includeMeshes: true,
        meshVertexBudget: 0,
      })
      const eligibleGeometry = boundsOnly.elements
        .filter((element) =>
          ['beam', 'roof', 'foundation', 'chimney', 'proxy'].includes(element.kind))
        .map((element) => element.geometry)
        .filter((geometry) => geometry !== undefined)
      check(`${fixture.file}: exhausted mesh budget falls back atomically to bounds`,
        eligibleGeometry.length > 0
        && eligibleGeometry.every((geometry) =>
          !geometry.mesh && geometry.meshOmittedReason === 'budget'))
    }
  } finally {
    api.CloseModel(modelID)
  }
}

api.Dispose()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
