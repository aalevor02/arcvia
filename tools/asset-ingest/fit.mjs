/**
 * Fitting an asset to the space the plan actually has.
 *
 * `scale.mjs` answers "how big is this model really?". This answers the next
 * question: "the room has 2.4 m of free wall — what do we put there?"
 *
 * ── The rule that makes this non-trivial ────────────────────────────────────
 * Scaling a model to fill a gap is one line of code and almost always wrong.
 * Real objects do not stretch, and which ones do is domain knowledge, not
 * geometry:
 *
 *   RIGID    A door leaf is 900 mm. A WC pan projects 700 mm. A fridge is the
 *            size the factory made it. Squeezing one to fit produces a drawing
 *            that cannot be built — and worse, one that LOOKS buildable, so the
 *            error survives to site. If it does not fit, that is a finding
 *            about the plan, not a problem with the asset.
 *
 *   STEPPED  A sofa comes as a 2-seat or a 3-seat, a bed as single/queen/king.
 *            The right response to a short wall is a different product, not a
 *            squashed one. So: swap to the largest variant that fits.
 *
 *   ELASTIC  A rug, a curtain run, a kitchen counter, a railing, a shelf run
 *            genuinely are made to length. These may be resized — within
 *            limits, because a 6 m curtain is a curtain and a 60 m one is a
 *            mistake somewhere upstream.
 *
 * Getting this wrong in the elastic direction is the more expensive mistake,
 * because it is invisible: a stretched sofa renders beautifully.
 *
 *   node tools/asset-ingest/fit.test.mjs
 */

/**
 * How each catalogue category responds to a space that is not its nominal size.
 *
 * Keyed on the catalogue's own `CATEGORIES` plus the shape hints it carries, so
 * this stays readable next to `apps/studio/src/catalogue/items.ts`.
 */
export const ELASTICITY = {
  // Openings and fixtures are manufactured sizes.
  'Doors & windows': { mode: 'rigid' },
  Bathroom: { mode: 'rigid' },
  Kitchen: { mode: 'stepped' },

  // Furniture comes in product sizes, not lengths.
  Seating: { mode: 'stepped' },
  Beds: { mode: 'stepped' },
  Tables: { mode: 'stepped' },
  Storage: { mode: 'stepped' },

  // Made-to-length goods.
  Decor: { mode: 'elastic', min: 0.5, max: 2.0 },
  Lighting: { mode: 'elastic', min: 0.7, max: 1.4 },
  Outdoor: { mode: 'elastic', min: 0.5, max: 2.5 },
}

/** Categories with no entry are treated as stepped: the cautious middle. */
export const DEFAULT_ELASTICITY = { mode: 'stepped' }

/**
 * Clearance kept between an object and the thing it sits against, in metres.
 *
 * Not decoration: furniture drawn hard against a wall reads as embedded in it
 * once the wall has thickness and a skirting, which is exactly the artefact
 * that makes an automatic dressing look automatic.
 */
export const CLEARANCE = 0.02

export function elasticityOf(category) {
  return ELASTICITY[category] ?? DEFAULT_ELASTICITY
}

/** Does `size` sit inside `envelope`, allowing for clearance? */
export function fitsWithin(size, envelope) {
  return (
    size.width + CLEARANCE <= envelope.width &&
    size.depth + CLEARANCE <= envelope.depth &&
    (envelope.height === undefined || size.height <= envelope.height)
  )
}

/**
 * Choose what to place in `envelope`, given a wanted item and the catalogue.
 *
 * `variants` are other catalogue items that serve the same purpose — the
 * caller supplies them, because "same purpose" is a catalogue question and not
 * a geometric one. They are tried largest-first.
 *
 * Returns one of:
 *   { action: 'as-is'   }  it already fits
 *   { action: 'swapped' }  a smaller variant fits; `item` is the replacement
 *   { action: 'scaled'  }  elastic, and resized by `factor`
 *   { action: 'refused' }  nothing fits, and `reason` says why
 *
 * It never returns a scaled rigid or stepped item. That is the whole point.
 */
export function fitToEnvelope(item, envelope, variants = []) {
  if (!item?.size) return { action: 'refused', reason: 'item has no size' }
  if (!envelope?.width || !envelope?.depth) {
    return { action: 'refused', reason: 'envelope has no usable dimensions' }
  }

  if (fitsWithin(item.size, envelope)) return { action: 'as-is', item }

  const rule = elasticityOf(item.category)

  if (rule.mode === 'rigid') {
    // The finding is about the plan. Say so in terms someone can act on.
    const short = [
      item.size.width + CLEARANCE > envelope.width
        ? `${(item.size.width + CLEARANCE - envelope.width).toFixed(2)} m too wide`
        : null,
      item.size.depth + CLEARANCE > envelope.depth
        ? `${(item.size.depth + CLEARANCE - envelope.depth).toFixed(2)} m too deep`
        : null,
    ].filter(Boolean)
    return {
      action: 'refused',
      reason: `${item.name ?? item.id} is a manufactured size and is ${short.join(' and ')}`,
      rigid: true,
    }
  }

  if (rule.mode === 'stepped') {
    const smaller = variants
      .filter((v) => v.id !== item.id && v.size)
      .filter((v) => fitsWithin(v.size, envelope))
      .sort((a, b) => b.size.width * b.size.depth - a.size.width * a.size.depth)[0]

    if (smaller) return { action: 'swapped', item: smaller, from: item.id }
    return {
      action: 'refused',
      reason: `no ${item.category ?? 'catalogue'} variant fits ` +
        `${envelope.width.toFixed(2)} x ${envelope.depth.toFixed(2)} m`,
    }
  }

  // Elastic. Uniform, because scaling one axis to fit deforms the product into
  // something no manufacturer sells.
  const factor = Math.min(
    (envelope.width - CLEARANCE) / item.size.width,
    (envelope.depth - CLEARANCE) / item.size.depth,
  )

  if (!(factor > 0)) return { action: 'refused', reason: 'envelope is not positive' }
  if (factor < (rule.min ?? 0.5) || factor > (rule.max ?? 2.0)) {
    return {
      action: 'refused',
      reason: `would need to scale ${factor.toFixed(2)}x, outside the ` +
        `${rule.min}–${rule.max}x this category is made in`,
    }
  }

  return {
    action: 'scaled',
    item,
    factor: +factor.toFixed(4),
    size: {
      width: +(item.size.width * factor).toFixed(4),
      depth: +(item.size.depth * factor).toFixed(4),
      height: +(item.size.height * factor).toFixed(4),
    },
  }
}
