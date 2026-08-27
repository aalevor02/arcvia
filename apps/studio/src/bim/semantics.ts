/** Vendor-neutral BIM semantics used by every structured-model importer. */

export type BimSource = 'ifc' | 'revit-api' | 'autodesk-aps' | 'cad' | 'vision'

/** Stable native identity attached to editable geometry derived from BIM. */
export interface BimEntityProvenance {
  source: BimSource
  sourceId: string
  sourceClass?: string
}

export type BimElementKind =
  | 'wall'
  | 'curtain-wall'
  | 'door'
  | 'window'
  | 'opening'
  | 'slab'
  | 'roof'
  | 'column'
  | 'beam'
  | 'stair'
  | 'railing'
  | 'space'
  | 'furniture'
  | 'equipment'
  | 'foundation'
  | 'chimney'
  | 'plate'
  | 'ramp'
  | 'covering'
  | 'proxy'
  | 'unknown'

export interface BimRelations {
  /** Element that physically hosts this one; doors and windows usually host in a wall. */
  hostId?: string
  /** IFC opening filled by a door or window (`IfcRelFillsElement`). */
  fillsOpeningId?: string
  /** Spatial container such as a storey or space. */
  containerId?: string
  /** Reusable type/family definition. */
  typeId?: string
  /** Parent in IFC aggregation, such as building -> storey or assembly -> part. */
  parentId?: string
  /** IFC groups or systems this object is assigned to. */
  groupIds?: string[]
  /** Physical/logical IFC element connections, stored bidirectionally. */
  connectedIds?: string[]
  /** Spaces whose IFC boundaries reference this building element. */
  spaceIds?: string[]
}

export interface BimPoint3 {
  x: number
  y: number
  z: number
}

export interface BimTriangleMesh {
  /** World-space XYZ positions in metres, stored as packed triples. */
  positions: number[]
  /** Triangle indices into positions; every consecutive triple is one face. */
  indices: number[]
}

export interface BimElementGeometry {
  /** World-space bounds in metres. web-ifc's world is X/Z horizontal and Y up. */
  bounds: {
    min: BimPoint3
    max: BimPoint3
  }
  vertexCount: number
  partCount: number
  /** Exact measured boundary of an IFC space on the X/Z floor plane. */
  planLoop?: Array<{ x: number; y: number }>
  /** Exact transformed source geometry, retained only within the import budget. */
  mesh?: BimTriangleMesh
  /** Why an eligible element fell back to its measured bounds. */
  meshOmittedReason?: 'budget' | 'unavailable' | 'invalid'
  /**
   * Measured longitudinal axis projected onto the X/Z floor plane.
   * Present only when the horizontal geometry has a stable principal axis.
   */
  planAxis?: {
    from: { x: number; y: number }
    to: { x: number; y: number }
    length: number
    thickness: number
    height: number
  }
}

export type BimQuantityDimension = 'length' | 'area' | 'volume' | 'count' | 'mass' | 'time'

export interface BimQuantity {
  name: string
  dimension: BimQuantityDimension
  /** Exact numeric value carried by the IFC quantity. */
  sourceValue: number
  sourceUnit?: string
  /** SI-normalized value; absent when the source unit cannot be resolved safely. */
  valueSI?: number
  unitSI?: 'm' | 'm²' | 'm³' | 'count' | 'kg' | 's'
  setName?: string
  sourceQuantityId?: string
}

export interface BimMaterialLayer {
  sourceId?: string
  name?: string
  category?: string
  /** Exact thickness in the source model's length unit. */
  sourceThickness?: number
  sourceUnit?: string
  /** SI thickness; absent when the source unit cannot be resolved safely. */
  thicknessSI?: number
}

export interface BimMaterial {
  sourceId?: string
  name?: string
  category?: string
  /** Ordered compound layers, when the authoring model defines them. */
  layers: BimMaterialLayer[]
}

export interface BimElementInput {
  source: BimSource
  sourceId: string
  /** IFC entity name, for example `IfcWallStandardCase` or `IfcDoor`. */
  sourceClass?: string
  /** Native Revit/APS category, for example `OST_Walls` or `Doors`. */
  category?: string
  family?: string
  type?: string
  name?: string
  relations?: BimRelations
  geometry?: BimElementGeometry
  quantities?: BimQuantity[]
  materials?: BimMaterial[]
  /** Unmodified source data retained for audit and future mappings. */
  properties?: Readonly<Record<string, unknown>>
}

export type SemanticBasis = 'schema-class' | 'native-category' | 'type-label' | 'name-fallback'

export interface SemanticEvidence {
  basis: SemanticBasis
  value: string
  kind: Exclude<BimElementKind, 'unknown'>
  confidence: number
}

export interface BimElementSemantic {
  source: BimSource
  sourceId: string
  /** Original native class/category; retained even when Arcvia cannot map it yet. */
  sourceClass?: string
  kind: BimElementKind
  confidence: number
  evidence: SemanticEvidence[]
  /** Lower-priority signals that disagreed with the selected semantic kind. */
  conflicts: SemanticEvidence[]
  relations: BimRelations
  geometry?: BimElementGeometry
  quantities: BimQuantity[]
  materials: BimMaterial[]
  properties: Readonly<Record<string, unknown>>
}

/**
 * Auditable semantic data copied onto editable entities. Source identity stays
 * separate so render/picking paths can use it without carrying raw metadata.
 */
export interface BimEntitySnapshot {
  kind: BimElementKind
  confidence: number
  evidence: SemanticEvidence[]
  conflicts: SemanticEvidence[]
  relations: BimRelations
  quantities: BimQuantity[]
  materials: BimMaterial[]
  properties: Readonly<Record<string, unknown>>
}

const SCHEMA_CLASSES: Readonly<Record<string, Exclude<BimElementKind, 'unknown'>>> = {
  ifcwall: 'wall',
  ifcwallstandardcase: 'wall',
  ifccurtainwall: 'curtain-wall',
  ifcdoor: 'door',
  ifcwindow: 'window',
  ifcopeningelement: 'opening',
  ifcslab: 'slab',
  ifcroof: 'roof',
  ifccolumn: 'column',
  ifcbeam: 'beam',
  ifcmember: 'beam',
  ifcstair: 'stair',
  ifcstairflight: 'stair',
  ifcrailing: 'railing',
  ifcramp: 'ramp',
  ifcrampflight: 'ramp',
  ifcfooting: 'foundation',
  ifcpile: 'foundation',
  ifcplate: 'plate',
  ifcchimney: 'chimney',
  ifccovering: 'covering',
  ifcbuildingelementproxy: 'proxy',
  ifcspace: 'space',
  ifcfurniture: 'furniture',
  ifcfurnishingelement: 'furniture',
  ifcdistributionelement: 'equipment',
  ifcdistributioncontrolelement: 'equipment',
  ifcdistributionflowelement: 'equipment',
  ifcairterminal: 'equipment',
  ifcairterminalbox: 'equipment',
  ifcductfitting: 'equipment',
  ifcductsegment: 'equipment',
  ifcductsilencer: 'equipment',
  ifcunitaryequipment: 'equipment',
  ifcfan: 'equipment',
  ifcfilter: 'equipment',
  ifcpump: 'equipment',
  ifcvalve: 'equipment',
  ifcboiler: 'equipment',
  ifcchiller: 'equipment',
  ifccoil: 'equipment',
  ifcdamper: 'equipment',
  ifcheatexchanger: 'equipment',
}

const NATIVE_CATEGORIES: Readonly<Record<string, Exclude<BimElementKind, 'unknown'>>> = {
  walls: 'wall', wall: 'wall', curtainwalls: 'curtain-wall', curtainwallpanels: 'curtain-wall',
  doors: 'door', door: 'door', windows: 'window', window: 'window', openings: 'opening',
  floors: 'slab', floor: 'slab', slabs: 'slab', roofs: 'roof', roof: 'roof',
  structuralcolumns: 'column', columns: 'column', column: 'column',
  structuralframing: 'beam', beams: 'beam', beam: 'beam', stairs: 'stair', stair: 'stair',
  railings: 'railing', railing: 'railing', rooms: 'space', spaces: 'space', room: 'space',
  space: 'space', furniture: 'furniture', mechanicalequipment: 'equipment',
  electricalequipment: 'equipment', plumbingfixtures: 'equipment',
  foundations: 'foundation', foundation: 'foundation', footings: 'foundation',
  chimneys: 'chimney', chimney: 'chimney', plates: 'plate', plate: 'plate',
  ramps: 'ramp', ramp: 'ramp', coverings: 'covering', covering: 'covering',
}

const EXACT_LABELS: Readonly<Record<string, Exclude<BimElementKind, 'unknown'>>> = {
  ...NATIVE_CATEGORIES,
  partition: 'wall',
  glazing: 'window',
  doorway: 'door',
  void: 'opening',
}

function key(value: string): string {
  // Revit built-in categories commonly arrive as OST_Walls. Punctuation and
  // casing are transport details, not meaning.
  return value.trim().toLowerCase().replace(/^ost[_ -]?/, '').replace(/[^a-z0-9]/g, '')
}

function evidence(
  basis: SemanticBasis,
  value: string | undefined,
  dictionary: Readonly<Record<string, Exclude<BimElementKind, 'unknown'>>>,
  confidence: number,
): SemanticEvidence | null {
  if (!value) return null
  const kind = dictionary[key(value)]
  return kind ? { basis, value, kind, confidence } : null
}

/**
 * Resolve native BIM labels into Arcvia's canonical taxonomy.
 *
 * Priority is deliberate: an IFC entity is stronger than a UI category, which
 * is stronger than a type label. Names are ignored unless explicitly enabled;
 * otherwise "Window seat" is too easily turned into a window.
 */
export function classifyBimElement(
  input: BimElementInput,
  options: { allowNameFallback?: boolean } = {},
): BimElementSemantic {
  const candidates = [
    evidence('schema-class', input.sourceClass, SCHEMA_CLASSES, 1),
    evidence('native-category', input.category, NATIVE_CATEGORIES, 0.98),
    evidence('type-label', input.type, EXACT_LABELS, 0.82),
    options.allowNameFallback ? evidence('name-fallback', input.name, EXACT_LABELS, 0.55) : null,
  ].filter((item): item is SemanticEvidence => item !== null)

  const selected = candidates[0]
  return {
    source: input.source,
    sourceId: input.sourceId,
    sourceClass: input.sourceClass,
    kind: selected?.kind ?? 'unknown',
    confidence: selected?.confidence ?? 0,
    evidence: candidates,
    conflicts: selected ? candidates.slice(1).filter((item) => item.kind !== selected.kind) : [],
    relations: { ...input.relations },
    geometry: input.geometry,
    quantities: [...(input.quantities ?? [])],
    materials: (input.materials ?? []).map((material) => ({
      ...material,
      layers: material.layers.map((layer) => ({ ...layer })),
    })),
    properties: { ...input.properties },
  }
}

export function isHostedOpening(element: BimElementSemantic): boolean {
  return (
    (element.kind === 'door' || element.kind === 'window') &&
    Boolean(element.relations.hostId || element.relations.fillsOpeningId)
  )
}
