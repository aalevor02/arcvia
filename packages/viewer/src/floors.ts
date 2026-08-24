/**
 * Which storeys a loaded model contains, derived from the model itself.
 *
 * ── Why the model and not the scene record ─────────────────────────────────
 * The published page receives `publicPayload`, which deliberately carries no
 * plan — and a CAD-imported scene never had one. The one thing every
 * multi-storey scene DOES carry is its geometry, and both producers name it
 * recognisably:
 *
 *   - the CAD engine emits one mesh set per storey: `storey0_walls`,
 *     `storey1_floors`, … (build/glb.py)
 *   - the studio's plan builder emits one group per floor: `floor:<id>`
 *     (buildGeometry.ts), children positioned at the floor's elevation
 *
 * Anything else — single-mesh uploads, third-party GLBs — yields no buckets,
 * and no buckets (or one) means no switcher: a single-storey walkthrough
 * looks exactly as it always did.
 *
 * The walking level is each bucket's bounding-box floor (`min.y`). For a CAD
 * storey that is the slab base; for a plan floor it is the slab underside,
 * a few centimetres below the finished floor — both within a step of where
 * feet belong, and `eyeHeight` rides on top either way.
 */

export interface FloorBox {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export interface FloorLevel {
  /** Human label, ordinal from the lowest storey up: "Floor 1", "Floor 2"… */
  label: string
  /** World-space y of the walking surface. */
  level: number
  /** Horizontal centre of the storey, for placing the visitor on arrival. */
  centre: { x: number; z: number }
}

const STOREY = /^storey(\d+)(?:_|$)/
const PLAN_FLOOR = /^floor:(.+)$/
//: The hand-authored villa exports name one object per floor with a readable
//: slug — `floor_lower-ground`, `floor_stilt` — which the dollhouse view in
//: apps/visualisation already relies on. Those slugs are worth more than an
//: ordinal, so they become the label directly.
const SLUG_FLOOR = /^floor_(.+)$/

/** True when this node name identifies storey geometry worth bucketing. */
export function isFloorNode(name: string): boolean {
  return STOREY.test(name) || PLAN_FLOOR.test(name) || SLUG_FLOOR.test(name)
}

/**
 * Group named nodes into storeys and order them bottom-up.
 *
 * Returns [] for fewer than two storeys — a switcher with one button is
 * furniture, and the caller's `hidden` flag keys off emptiness.
 */
export function deriveFloors(nodes: { name: string; box: FloorBox }[]): FloorLevel[] {
  const buckets = new Map<string, { box: FloorBox; slug: string | null }>()

  for (const { name, box } of nodes) {
    const storey = STOREY.exec(name)
    const plan = PLAN_FLOOR.exec(name)
    const slug = !storey && !plan ? SLUG_FLOOR.exec(name) : null
    if (!storey && !plan && !slug) continue
    const key = storey
      ? `storey:${storey[1]}`
      : plan
        ? `floor:${plan[1]}`
        : `slug:${slug![1]}`

    const held = buckets.get(key)
    if (!held) {
      buckets.set(key, {
        box: { min: { ...box.min }, max: { ...box.max } },
        slug: slug ? slug[1] : null,
      })
    } else {
      const b = held.box
      b.min.x = Math.min(b.min.x, box.min.x)
      b.min.y = Math.min(b.min.y, box.min.y)
      b.min.z = Math.min(b.min.z, box.min.z)
      b.max.x = Math.max(b.max.x, box.max.x)
      b.max.y = Math.max(b.max.y, box.max.y)
      b.max.z = Math.max(b.max.z, box.max.z)
    }
  }

  if (buckets.size < 2) return []

  return [...buckets.values()]
    .sort((a, b) => a.box.min.y - b.box.min.y)
    .map(({ box, slug }, i) => ({
      // A slug written by a person beats an ordinal invented here:
      // "lower-ground" → "Lower ground".
      label: slug
        ? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')
        : `Floor ${i + 1}`,
      level: box.min.y,
      centre: {
        x: (box.min.x + box.max.x) / 2,
        z: (box.min.z + box.max.z) / 2,
      },
    }))
}
