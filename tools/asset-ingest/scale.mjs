import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Real-world scale for a hub model that has no catalogue slot.
 *
 * ── The hole this fills ─────────────────────────────────────────────────────
 * `apps/studio/src/catalogue/items.ts` is the only place in this product that
 * knows how big a thing actually is — a 3-seat sofa is 2.1 m because that is
 * what a 3-seat sofa is. `condition_asset.py` takes those numbers as
 * authoritative and scales the model to them.
 *
 * The catalogue has 64 slots. The hub has ~3,600 models. Every model outside
 * those 64 reaches a room through `assetHub.js`, which calls the conditioner
 * with `--input --output --budget` and NO size — so, by the conditioner's own
 * documented rule, it "keeps the model's authored scale". That is fine for The
 * Base Mesh, which authors in metres. It is not fine for a Sketchfab scan
 * authored in centimetres, which arrives in the room a hundred times too big.
 *
 * The bug is not that a wrong number is computed. It is that NO number is
 * computed, and an unknown is treated as a metre. This module supplies the
 * missing number, or refuses to.
 *
 * ── Why inference rather than metadata ──────────────────────────────────────
 * Because the metadata is not there. A hub `.asset.json` carries ref, name,
 * licence, authors, polycount, bytes — and no dimensions. Poly Haven publishes
 * dimensions (in MILLIMETRES; `from-hub.mjs:310` divides by 1000) but the
 * harvest never persisted them, and Sketchfab, the largest source, does not
 * publish size at all. So the only evidence available at conditioning time is
 * the geometry itself plus the name the author gave it.
 *
 * The method: measure the model, then ask which unit interpretation puts it at
 * a plausible physical size for the kind of thing its name says it is. A "Tv
 * Unit" 180 units across is centimetres; the same model 1.8 across is metres.
 * Exactly one reading is usually sensible, and when none or several are, this
 * module says so rather than picking.
 *
 *   node tools/asset-ingest/scale.test.mjs
 */

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/**
 * glTF node transforms are NOT optional to handle.
 *
 * Accessor `min`/`max` are in the mesh's own space. A node above the mesh may
 * carry a scale — and exporters routinely push a unit conversion up there
 * rather than baking it into vertices, which is exactly the case this module
 * exists to catch. Reading accessor bounds alone would therefore measure the
 * model in a space nothing renders in, and would be wrong precisely on the
 * files that matter most.
 */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice()

  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]

  // Quaternion to column-major 4x4, scale folded into the basis columns.
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
  const xx = qx * x2, xy = qx * y2, xz = qx * z2
  const yy = qy * y2, yz = qy * z2, zz = qz * z2
  const wx = qw * x2, wy = qw * y2, wz = qw * z2

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

/** Column-major 4x4 multiply, matching glTF's storage order. */
function multiply(a, b) {
  const out = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = sum
    }
  }
  return out
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/** Parse a .glb container or a .gltf document into its JSON. */
export function parseGltf(buffer, file = '') {
  const isGlb =
    buffer.length >= 12 && buffer.readUInt32LE(0) === 0x46546c67 // "glTF"

  if (!isGlb) return JSON.parse(buffer.toString('utf8'))

  const jsonLength = buffer.readUInt32LE(12)
  const json = buffer.slice(20, 20 + jsonLength).toString('utf8')
  if (!json.trim()) throw new Error(`${basename(file)}: GLB has no JSON chunk.`)
  return JSON.parse(json)
}

/**
 * The model's extent in its OWN authored units, world-transformed.
 *
 * Returns null when the file carries no positional bounds at all — a document
 * with no meshes, or accessors written without `min`/`max`. Both are legal
 * glTF and neither can be measured, so neither is guessed at.
 */
export function measureGltf(gltf) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let sawBounds = false

  const visit = (nodeIndex, parent) => {
    const node = gltf.nodes?.[nodeIndex]
    if (!node) return
    const world = multiply(parent, nodeMatrix(node))

    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        const accessor = gltf.accessors?.[prim.attributes?.POSITION]
        if (!accessor?.min || !accessor?.max) continue
        sawBounds = true

        // Transform all eight corners: under rotation the axis-aligned box of
        // the transformed corners is correct, while transforming min and max
        // alone is not.
        for (let corner = 0; corner < 8; corner++) {
          const point = [
            corner & 1 ? accessor.max[0] : accessor.min[0],
            corner & 2 ? accessor.max[1] : accessor.min[1],
            corner & 4 ? accessor.max[2] : accessor.min[2],
          ]
          const [x, y, z] = transformPoint(world, point)
          lo[0] = Math.min(lo[0], x); hi[0] = Math.max(hi[0], x)
          lo[1] = Math.min(lo[1], y); hi[1] = Math.max(hi[1], y)
          lo[2] = Math.min(lo[2], z); hi[2] = Math.max(hi[2], z)
        }
      }
    }

    for (const child of node.children ?? []) visit(child, world)
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const scene = gltf.scenes?.[gltf.scene ?? 0]
  const roots = scene?.nodes ?? gltf.nodes?.map((_, i) => i) ?? []
  for (const root of roots) visit(root, identity)

  if (!sawBounds) return null
  return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] }
}

export async function measureModel(file) {
  return measureGltf(parseGltf(await readFile(file), file))
}

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

/**
 * Unit readings worth testing, as metres per authored unit.
 *
 * Feet are deliberately absent. A foot (0.3048) sits close enough to a third of
 * a metre that it competes with metres on almost every band and would turn
 * confident answers into ambiguous ones. Inches earn their place because
 * furniture is genuinely authored in them and 0.0254 is far from every other
 * candidate.
 */
export const UNITS = [
  { unit: 'm', factor: 1 },
  { unit: 'cm', factor: 0.01 },
  { unit: 'mm', factor: 0.001 },
  { unit: 'in', factor: 0.0254 },
]

// Increment whenever the interpretation written to conditioning sidecars
// changes. Cache entries without this version must be regenerated.
export const SCALE_VERSION = 1

/**
 * Plausible size of a real thing, by the words its name might use.
 *
 * `min`/`max` bound the model's LARGEST dimension in metres. The bands are
 * deliberately generous: their job is to separate a metre reading from a
 * centimetre one — a 100x gap — not to validate that a sofa is a good sofa.
 * A band tight enough to reject an unusual sofa would reject a correct one.
 *
 * Order matters: the first keyword found in the name wins, so specific terms
 * are listed before the general ones they contain.
 */
export const BANDS = [
  { category: 'door', words: ['door'], min: 0.6, max: 2.6 },
  { category: 'window', words: ['window'], min: 0.3, max: 3.0 },
  { category: 'wardrobe', words: ['wardrobe', 'almirah', 'closet'], min: 0.9, max: 3.0 },
  { category: 'bookshelf', words: ['bookshelf', 'bookcase', 'shelving', 'shelf'], min: 0.4, max: 2.6 },
  { category: 'sofa', words: ['sofa', 'couch', 'settee'], min: 1.0, max: 3.6 },
  { category: 'armchair', words: ['armchair', 'recliner'], min: 0.6, max: 1.4 },
  { category: 'chair', words: ['chair', 'stool', 'bench'], min: 0.3, max: 1.8 },
  { category: 'bed', words: ['bed', 'mattress', 'cot'], min: 0.8, max: 2.6 },
  { category: 'table', words: ['table', 'desk'], min: 0.3, max: 3.6 },
  { category: 'cabinet', words: ['cabinet', 'dresser', 'sideboard', 'unit', 'drawer'], min: 0.3, max: 3.0 },
  { category: 'fridge', words: ['fridge', 'refrigerator', 'freezer'], min: 0.5, max: 2.2 },
  { category: 'appliance', words: ['oven', 'stove', 'hob', 'microwave', 'washer', 'washing', 'dishwasher'], min: 0.3, max: 1.8 },
  { category: 'sanitary', words: ['toilet', 'wc', 'basin', 'sink', 'washbasin', 'urinal', 'bidet'], min: 0.25, max: 1.4 },
  { category: 'bath', words: ['bathtub', 'bath', 'shower'], min: 0.7, max: 2.4 },
  { category: 'tv', words: ['tv', 'television', 'monitor', 'screen'], min: 0.3, max: 2.2 },
  { category: 'lamp', words: ['lamp', 'sconce', 'chandelier', 'pendant', 'light'], min: 0.08, max: 2.0 },
  { category: 'rug', words: ['rug', 'carpet', 'mat'], min: 0.4, max: 5.0 },
  { category: 'planter', words: ['pot', 'planter', 'vase'], min: 0.05, max: 1.4 },
  { category: 'tree', words: ['tree', 'palm', 'shrub', 'bush', 'hedge'], min: 0.2, max: 14.0 },
  { category: 'car', words: ['car', 'vehicle', 'suv', 'truck'], min: 2.5, max: 7.0 },
  { category: 'person', words: ['person', 'people', 'human', 'man', 'woman', 'figure'], min: 1.2, max: 2.2 },
  { category: 'decor', words: ['book', 'bottle', 'cup', 'mug', 'plate', 'bowl', 'cushion', 'pillow'], min: 0.04, max: 0.8 },

  // ── Added from evidence, not from imagination ──────────────────────────────
  // The bands above were written from the catalogue's own categories. Surveying
  // the 3,597 hub models showed 75.8% falling to `unknown-kind`, so the words
  // below were taken from the most frequent unmatched names that are actually
  // archviz content. See `docs/HANDOFF-CURATION.md` for the survey.
  //
  // The Indian-residential entries matter as much as the generic ones: a
  // ceiling fan and a split AC are in essentially every room this product will
  // ever draw, and neither had a band.
  { category: 'fan', words: ['fan'], min: 0.3, max: 1.6 },
  { category: 'ac', words: ['ac', 'aircon', 'conditioner', 'hvac', 'radiator'], min: 0.4, max: 2.2 },
  { category: 'mirror', words: ['mirror'], min: 0.15, max: 2.4 },
  { category: 'artwork', words: ['painting', 'artwork', 'poster', 'canvas', 'picture'], min: 0.15, max: 3.0 },
  { category: 'curtain', words: ['curtain', 'blind', 'drape'], min: 0.4, max: 4.0 },
  { category: 'counter', words: ['counter', 'worktop', 'countertop', 'kitchen'], min: 0.5, max: 5.0 },
  { category: 'stairs', words: ['stair', 'staircase', 'steps', 'ladder'], min: 0.5, max: 6.0 },
  { category: 'railing', words: ['railing', 'balustrade', 'handrail', 'fence'], min: 0.3, max: 6.0 },
  { category: 'column', words: ['column', 'pillar', 'beam'], min: 0.1, max: 6.0 },
  { category: 'signage', words: ['sign', 'signage', 'nameplate'], min: 0.1, max: 3.0 },
  { category: 'glassware', words: ['glass', 'glasses', 'jar', 'kettle', 'teapot', 'pan', 'pot'], min: 0.04, max: 0.6 },
  { category: 'food', words: ['apple', 'bread', 'cake', 'burger', 'fruit', 'food', 'wine'], min: 0.03, max: 0.5 },
  { category: 'towel', words: ['towel', 'linen', 'blanket', 'throw'], min: 0.2, max: 2.4 },
  { category: 'bin', words: ['bin', 'basket', 'trash', 'dustbin'], min: 0.15, max: 1.2 },
  { category: 'clock', words: ['clock'], min: 0.08, max: 0.8 },
  { category: 'frame', words: ['frame'], min: 0.1, max: 2.5 },
  { category: 'box', words: ['box', 'crate'], min: 0.05, max: 1.5 },
  { category: 'stand', words: ['stand', 'rack', 'holder'], min: 0.15, max: 2.2 },
  { category: 'tile', words: ['tile', 'panel', 'slab'], min: 0.05, max: 3.0 },
]

/** The band whose words the name mentions first, or null if none do. */
export function bandFor(name) {
  const haystack = String(name ?? '').toLowerCase()
  for (const band of BANDS) {
    // Word-boundary match: "unit" must not fire inside "united", and the "tv"
    // band must not fire inside "tvorba". Hyphens and underscores are
    // separators, which is how every asset name in the hub is written.
    for (const word of band.words) {
      const pattern = new RegExp(`(^|[^a-z0-9])${word}($|[^a-z0-9])`, 'i')
      if (pattern.test(haystack)) return band
    }
  }
  return null
}

/**
 * WHAT TO DO WHEN THE EVIDENCE IS NOT DECISIVE.
 *
 * This is the judgement call in the module, and it is deliberately one small
 * function so it can be changed without touching anything else.
 *
 * `candidates` are the unit readings that land inside the band — so:
 *   1  → decisive.
 *   0  → the model is not a plausible size under ANY reading. Either the name
 *        misleads (a "table lamp" matched `table`) or the geometry is odd.
 *   2+ → the band is wide enough that two readings both look sensible. In
 *        practice this is metres-vs-inches on a band spanning more than 39x.
 *
 * The house rule elsewhere in this tool is that an empty slot beats a
 * confident wrong one (`from-hub.mjs:26`), and the same reasoning applies with
 * more force here: a refused asset is a gap in a room, while a wrongly scaled
 * one is a sofa through a wall in front of a client.
 */
export function resolve(candidates) {
  if (candidates.length === 1) return { pick: candidates[0], reason: 'decisive' }
  if (candidates.length === 0) return { pick: null, reason: 'no-plausible-unit' }
  return { pick: null, reason: 'ambiguous' }
}

/**
 * Infer the real-world size of a measured model.
 *
 * Returns `{ ok: true, ... }` with metres the conditioner can be given, or
 * `{ ok: false, reason }`. It never falls back to "assume metres" — that
 * assumption is the bug this module exists to remove.
 */
export function inferScale(name, extents) {
  if (!extents) return { ok: false, reason: 'unmeasurable', name }

  const largest = Math.max(extents.x, extents.y, extents.z)
  if (!(largest > 0)) return { ok: false, reason: 'degenerate', name }

  const band = bandFor(name)
  if (!band) return { ok: false, reason: 'unknown-kind', name, largest }

  const candidates = UNITS.filter(({ factor }) => {
    const metres = largest * factor
    return metres >= band.min && metres <= band.max
  })

  const { pick, reason } = resolve(candidates)
  if (!pick) {
    return {
      ok: false,
      reason,
      name,
      category: band.category,
      largest,
      considered: candidates.map((c) => c.unit),
    }
  }

  return {
    ok: true,
    version: SCALE_VERSION,
    reason,
    name,
    category: band.category,
    unit: pick.unit,
    factor: pick.factor,
  }
}

/** Measure a file and infer its scale in one step. */
export async function scaleOf(file, name) {
  return inferScale(name ?? basename(file), await measureModel(file))
}
