import { build } from 'esbuild'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Generate Blender's material bridge from the Studio surface catalogue. */
const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = join(ROOT, 'apps/studio/src/catalogue/surfaces.ts')
const PUBLIC = join(ROOT, 'apps/studio/public')
const OUT = join(ROOT, 'data/materials/render-materials.json')
const dir = await mkdtemp(join(tmpdir(), 'arcvia-materials-'))
const bundle = join(dir, 'surfaces.mjs')

await build({
  entryPoints: [ENTRY], outfile: bundle, bundle: true,
  format: 'esm', platform: 'neutral', logLevel: 'silent',
})
const { SURFACE_MAPS } = await import(pathToFileURL(bundle).href)

const defaults = {
  'floor-wood': { base_color_srgb: '#9A7652', roughness: 0.55 },
  'floor-tile': { base_color_srgb: '#B5B7B5', roughness: 0.45 },
  wall: { base_color_srgb: '#E6E0D5', roughness: 0.82 },
  ceiling: { base_color_srgb: '#F2F0EA', roughness: 0.88 },
  fabric: { base_color_srgb: '#777A7D', roughness: 0.9 },
  wood: { base_color_srgb: '#966E48', roughness: 0.55 },
  stone: { base_color_srgb: '#57545A', roughness: 0.28 },
  paving: { base_color_srgb: '#878A86', roughness: 0.72 },
  brick: { base_color_srgb: '#985A45', roughness: 0.8 },
  concrete: { base_color_srgb: '#858784', roughness: 0.8 },
  metal: { base_color_srgb: '#73777C', roughness: 0.32, metallic: 0.8 },
}

const materials = {}
const missing = []
for (const surface of SURFACE_MAPS) {
  const texture = {
    base_color: `../../apps/studio/public${surface.map}`,
    roughness: `../../apps/studio/public${surface.roughnessMap}`,
    normal_gl: `../../apps/studio/public${surface.normalMap}`,
  }
  for (const served of [surface.map, surface.roughnessMap, surface.normalMap]) {
    const path = join(PUBLIC, served.replace(/^\//, ''))
    if (!await stat(path).then((s) => s.isFile()).catch(() => false)) {
      missing.push(`${surface.id} -> ${served}`)
    }
  }
  materials[surface.id] = {
    name: surface.name, ...defaults[surface.id],
    tile_metres: surface.tileMetres, texture,
    provenance: {
      note: surface.note, licence: surface.licence,
      author: surface.author, source: surface.source,
    },
  }
}
Object.assign(materials, {
  glass: { name: 'Clear architectural glass', base_color_srgb: '#D7EDF0', roughness: 0.08 },
  water: { name: 'Pool water', base_color_srgb: '#3A94A8', roughness: 0.12 },
  grass: { name: 'Procedural turf', base_color_srgb: '#557B42', roughness: 0.9 },
  planting: { name: 'Procedural planting', base_color_srgb: '#416633', roughness: 0.9 },
})

// Exhaustive for glb.py's current outputs, plus the next geometry seams.
const surface_classes = {
  internal_wall: 'wall', external_wall: 'wall', wallface_reveal: 'wall',
  ceiling: 'ceiling', roof: 'concrete', plinth: 'stone',
  parapet_coping: 'stone', floor_bath: 'floor-tile',
  floor_bedroom: 'floor-wood', floor_corridor: 'floor-tile',
  floor_dining: 'floor-tile', floor_kitchen: 'floor-tile',
  floor_living: 'floor-tile', floor_lobby: 'floor-tile',
  floor_parking: 'paving', floor_pooja: 'stone',
  floor_store: 'floor-tile', floor_toilet: 'floor-tile',
  floor_utility: 'floor-tile', floor_stair: 'stone',
  floor_balcony: 'paving', floor_verandah: 'paving',
  floor_courtyard: 'paving', driveway: 'paving',
  water_body: 'water', lawn: 'grass', planting_bed: 'planting',
  glazing: 'glass', window_frame: 'metal', railing: 'metal',
  grill: 'metal', gate: 'metal', counter: 'stone',
}

await mkdir(resolve(OUT, '..'), { recursive: true })
await writeFile(OUT, JSON.stringify({
  _generated: 'node tools/cad-engine/gen-render-materials.mjs',
  _source: 'apps/studio/src/catalogue/surfaces.ts',
  _version: 1,
  _note: 'Texture paths are relative to this production Blender bridge.',
  materials, surface_classes,
}, null, 2) + '\n', 'utf8')
await rm(dir, { recursive: true, force: true })

console.log(`wrote ${OUT}`)
console.log(`  ${Object.keys(materials).length} materials, ${Object.keys(surface_classes).length} surface classes`)
if (missing.length) {
  console.error(`\n  ${missing.length} referenced texture file(s) are missing:`)
  for (const item of missing) console.error(`    ${item}`)
  process.exit(1)
}
