import { extractOpenIfcMetadata, type IfcMetadataApi } from '../src/bim/ifcMetadata'
import { isHostedOpening } from '../src/bim/semantics'

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

const names = new Map<number, string>([
  [1, 'IFCWALL'],
  [2, 'IFCDOOR'],
  [3, 'IFCWINDOW'],
  [10, 'IFCRELVOIDSELEMENT'],
  [11, 'IFCRELFILLSELEMENT'],
  [12, 'IFCRELCONTAINEDINSPATIALSTRUCTURE'],
  [13, 'IFCRELDEFINESBYTYPE'],
  [14, 'IFCRELAGGREGATES'],
  [15, 'IFCRELASSIGNSTOGROUP'],
  [20, 'IFCOBJECTDEFINITION'],
  [21, 'IFCBUILDINGSTOREY'],
  [30, 'IFCSIUNIT'],
  [31, 'IFCRELNESTS'],
  [32, 'IFCRELCONNECTSELEMENTS'],
  [33, 'IFCRELSPACEBOUNDARY'],
])
const codes = new Map([...names].map(([code, name]) => [name, code]))
const ids = new Map<number, number[]>([
  [1, [100]],
  [2, [101]],
  [3, [102]],
  [10, [200]],
  [11, [201, 202]],
  [12, [203]],
  [13, [204]],
  [14, [205]],
  [15, [206]],
  [20, []],
  [21, [300]],
  [30, [700, 701, 702]],
  [31, [207]],
  [32, [208]],
  [33, [209]],
])
const h = (value: number) => ({ value })
const lines = new Map<number, Record<string, unknown>>([
  [100, { GlobalId: { value: 'wall-guid' }, Name: { value: 'External wall' } }],
  [101, { GlobalId: { value: 'door-guid' }, Name: { value: 'D01' } }],
  [102, { GlobalId: { value: 'window-guid' }, Name: { value: 'W01' } }],
  [200, { RelatingBuildingElement: h(100), RelatedOpeningElement: h(150) }],
  [201, { RelatingOpeningElement: h(150), RelatedBuildingElement: h(101) }],
  [202, { RelatingOpeningElement: h(151), RelatedBuildingElement: h(102) }],
  [203, { RelatingStructure: h(300), RelatedElements: [h(100), h(101), h(102)] }],
  [204, { RelatingType: h(400), RelatedObjects: [h(100)] }],
  [205, { RelatingObject: h(301), RelatedObjects: [h(300)] }],
  [206, { RelatingGroup: h(600), RelatedObjects: [h(101)] }],
  [300, { GlobalId: { value: 'storey-guid' }, Name: { value: 'Ground Floor' } }],
  [700, { UnitType: { value: 'LENGTHUNIT' }, Prefix: { value: 'MILLI' }, Name: { value: 'METRE' } }],
  [701, { UnitType: { value: 'AREAUNIT' }, Prefix: null, Name: { value: 'SQUARE_METRE' } }],
  [702, { UnitType: { value: 'VOLUMEUNIT' }, Prefix: null, Name: { value: 'CUBIC_METRE' } }],
  [207, { RelatingObject: h(500), RelatedObjects: [h(100)] }],
  [208, { RelatingElement: h(100), RelatedElement: h(101) }],
  [209, { RelatingSpace: h(350), RelatedBuildingElement: h(100) }],
])

const api: IfcMetadataApi = {
  properties: {
    getPropertySets: async (_modelID, elementID) => elementID === 100 ? [{
      expressID: 800,
      Name: { value: 'Qto_WallBaseQuantities' },
      Quantities: [
        { expressID: 801, Name: { value: 'Length' }, LengthValue: { value: 4000 } },
        { expressID: 802, Name: { value: 'NetSideArea' }, AreaValue: { value: 12 } },
        { expressID: 803, Name: { value: 'NetVolume' }, VolumeValue: { value: 2.4 } },
      ],
    }] : [],
    getTypeProperties: async () => [],
    getMaterialsProperties: async () => [],
  },
  GetModelSchema: () => 'IFC4',
  GetIfcEntityList: () => [...names.keys()],
  GetNameFromTypeCode: (type) => names.get(type) ?? 'UNKNOWN',
  GetTypeCodeFromName: (name) => codes.get(name) ?? 0,
  GetLineIDsWithType: (_modelID, type, includeInherited) => {
    const values = type === 20 && includeInherited ? [100, 101, 102, 300] : ids.get(type) ?? []
    return { size: () => values.length, get: (index) => values[index] ?? 0 }
  },
  GetLine: (_modelID, expressID) => lines.get(expressID) ?? {},
}

const result = await extractOpenIfcMetadata(api, 0, { includeProperties: true })

check('schema is preserved', result.schema === 'IFC4')
check('all IFC types are counted', result.typeCounts.IFCWALL === 1 && result.typeCounts.IFCRELFILLSELEMENT === 2)
check('only mapped building elements enter the semantic inventory', result.elements.length === 3)
check('all native object definitions are preserved', result.records.length === 4)
check('unsupported storey record keeps its native class',
  result.records.some((item) =>
    item.sourceId === '300' && item.sourceClass === 'IFCBUILDINGSTOREY' && item.kind === 'unknown'))
check('unsupported storey retains native identity fields',
  result.records.find((item) => item.sourceId === '300')?.properties.name === 'Ground Floor')

const wall = result.elements.find((item) => item.kind === 'wall')
const door = result.elements.find((item) => item.kind === 'door')
const window = result.elements.find((item) => item.kind === 'window')

check('wall retains its GlobalId', wall?.properties.globalId === 'wall-guid')
check('mapped wall also retains its native class', wall?.sourceClass === 'IFCWALL')
check('project length unit is read independently', result.units.length?.toSI === 0.001)
check('project area unit does not inherit the length prefix', result.units.area?.toSI === 1)
check('wall length quantity is normalized from mm to m',
  wall?.quantities.find((quantity) => quantity.name === 'Length')?.valueSI === 4)
check('wall source quantity remains unchanged',
  wall?.quantities.find((quantity) => quantity.name === 'Length')?.sourceValue === 4000)
check('wall area and volume quantities remain in their declared SI units',
  wall?.quantities.find((quantity) => quantity.name === 'NetSideArea')?.valueSI === 12
  && wall?.quantities.find((quantity) => quantity.name === 'NetVolume')?.valueSI === 2.4)
check('spatial containment is indexed', door?.relations.containerId === '300')
check('type assignment is indexed', wall?.relations.typeId === '400')
check('spatial aggregation is indexed',
  result.records.find((item) => item.sourceId === '300')?.relations.parentId === '301')
check('system/group assignment is indexed', door?.relations.groupIds?.[0] === '600')
check('nested assembly parent is indexed',
  wall?.relations.parentId === '500')
check('element connections are indexed bidirectionally',
  wall?.relations.connectedIds?.includes('101') === true
  && door?.relations.connectedIds?.includes('100') === true)
check('space-boundary membership is indexed', wall?.relations.spaceIds?.[0] === '350')
check('door fill relationship is indexed', door?.relations.fillsOpeningId === '150')
check('door inherits its opening wall host', door?.relations.hostId === '100')
check('window fill relationship is indexed', window?.relations.fillsOpeningId === '151')
check('an unhosted opening does not invent a host', window?.relations.hostId === undefined)
check('a filled door is recognised as hosted', door !== undefined && isHostedOpening(door))
check('valid fixture produces no warnings', result.warnings.length === 0)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
