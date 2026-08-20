/**
 * The shape of a published visualisation.
 *
 * Everything on screen comes from one of these objects. A second project is a
 * second data file, not a second codebase — which is the whole reason the
 * reference system could stand up a new client site in a day.
 */

export interface Room {
  name: string
  /** Metres. Omitted for spaces the drawings label without a dimension. */
  width?: number
  depth?: number
  /** Circulation, service and outdoor spaces are listed but not counted as habitable. */
  kind?: 'habitable' | 'service' | 'outdoor' | 'circulation'
}

export interface Floor {
  id: string
  label: string
  /** Built-up area of this level, in square metres. */
  area: number
  /** Path to the cropped plan drawing. */
  plan: string
  rooms: Room[]
}

export interface VillaType {
  id: string
  name: string
  /** Unit codes that share this drawing set. */
  appliesTo: string[]
  totalSbua: number
  floors: Floor[]
  /** Render slugs, most representative first. */
  renders: string[]
  summary: string
  /** Present once a walkthrough has been baked for this type. */
  walkthrough?: WalkthroughScene
}

export interface WalkthroughScene {
  /** GLB with baked lightmaps applied. */
  model: string
  /** Equirectangular environment, if the scene uses one. */
  environment?: string
  eyeHeight: number
  views: {
    id: string
    name: string
    position: [number, number, number]
    rotation: [number, number]
  }[]
  minimap?: { image: string; floorId: string }
}

export interface Unit {
  code: string
  typeId: string
  row: string
  /** Percentage-space polygon over the site plan image, [x, y] pairs 0-100. */
  polygon: [number, number][]
  status: 'available' | 'held' | 'sold'
  /** Compass orientation of the unit's main outlook, for the detail panel. */
  facing?: string
}

export interface SiteLabel {
  text: string
  x: number
  y: number
}

export interface GalleryItem {
  slug: string
  caption: string
  group: 'exterior' | 'interior' | 'aerial' | 'landscape'
}

export interface Project {
  slug: string
  name: string
  script: string
  place: string
  developer: string
  developerNote: string
  tagline: string
  rera: string
  architect: string

  intro: { heading: string; body: string[] }
  sections: { id: string; kicker: string; heading: string; body: string[]; image: string }[]

  stats: { label: string; value: string }[]

  sitePlan: {
    image: string
    imageSmall: string
    units: Unit[]
    labels: SiteLabel[]
  }

  villaTypes: VillaType[]
  gallery: GalleryItem[]
  locationMap: { image: string; note: string[] }

  contacts: { region: string; name: string; phone: string }[]
  offices: { label: string; lines: string[] }[]
  disclaimer: string
}
