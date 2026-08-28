import { CLEARANCE, elasticityOf, fitToEnvelope, fitsWithin } from './fit.mjs'

/**
 * Fitting assets to the space a plan actually has.
 *
 * The expensive failure here is invisible: a stretched sofa renders
 * beautifully, and a door squeezed to fit produces a drawing that looks
 * buildable and is not. So the tests are mostly about what must NOT happen.
 *
 *   node tools/asset-ingest/fit.test.mjs
 */

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// Real catalogue entries, sizes copied from apps/studio/src/catalogue/items.ts.
const sofa3 = { id: 'sofa-3', name: 'Sofa, 3 seat', category: 'Seating', size: { width: 2.1, depth: 0.9, height: 0.82 } }
const sofa2 = { id: 'sofa-2', name: 'Sofa, 2 seat', category: 'Seating', size: { width: 1.5, depth: 0.9, height: 0.82 } }
const armchair = { id: 'armchair', name: 'Armchair', category: 'Seating', size: { width: 0.85, depth: 0.85, height: 0.82 } }
const door = { id: 'door-internal', name: 'Door, internal', category: 'Doors & windows', size: { width: 0.9, depth: 0.06, height: 2.1 } }
const rug = { id: 'rug', name: 'Rug', category: 'Decor', size: { width: 2.0, depth: 1.4, height: 0.01 } }

const seating = [sofa3, sofa2, armchair]

// ---- Basics ---------------------------------------------------------------

ok('an item that fits is left alone',
  fitToEnvelope(sofa3, { width: 3.0, depth: 1.2 }, seating).action === 'as-is')

ok('clearance is enforced, not just raw size',
  !fitsWithin(sofa3.size, { width: 2.1, depth: 0.9 }),
  `needs ${CLEARANCE} m spare`)

ok('an exact-fit-plus-clearance envelope fits',
  fitsWithin(sofa3.size, { width: 2.1 + CLEARANCE, depth: 0.9 + CLEARANCE }))

// ---- Rigid: manufactured sizes never bend ---------------------------------

{
  const got = fitToEnvelope(door, { width: 0.8, depth: 0.06 }, [])
  ok('a door in too small an opening is refused, not squeezed',
    got.action === 'refused' && got.rigid === true, got.reason)
  ok('the refusal says how short the opening is by',
    /too wide/.test(got.reason ?? ''), got.reason)
}

ok('a rigid item is never scaled',
  fitToEnvelope(door, { width: 0.5, depth: 0.06 }, []).action !== 'scaled')

// ---- Stepped: swap the product, do not squash it --------------------------

{
  // A 1.8 m alcove cannot take a 3-seat sofa. It can take a 2-seat.
  const got = fitToEnvelope(sofa3, { width: 1.8, depth: 1.0 }, seating)
  ok('a short wall gets a smaller sofa, not a scaled one',
    got.action === 'swapped' && got.item.id === 'sofa-2',
    `${got.action} ${got.item?.id ?? ''}`)
  ok('the swap records what it replaced', got.from === 'sofa-3')
}

{
  // Only the armchair fits 1.0 m.
  const got = fitToEnvelope(sofa3, { width: 1.0, depth: 1.0 }, seating)
  ok('the largest variant that fits is chosen',
    got.action === 'swapped' && got.item.id === 'armchair', got.item?.id)
}

{
  const got = fitToEnvelope(sofa3, { width: 0.4, depth: 0.4 }, seating)
  ok('when no variant fits, it refuses', got.action === 'refused', got.reason)
}

ok('a stepped item is never scaled',
  fitToEnvelope(sofa3, { width: 1.8, depth: 1.0 }, seating).action !== 'scaled')

ok('with no variants offered, stepped refuses rather than scaling',
  fitToEnvelope(sofa3, { width: 1.8, depth: 1.0 }, []).action === 'refused')

// ---- Elastic: made-to-length goods may resize -----------------------------

{
  const got = fitToEnvelope(rug, { width: 1.5, depth: 1.4 }, [])
  ok('a rug is resized to the room', got.action === 'scaled', got.reason ?? got.action)
  ok('the resize is uniform, not per-axis',
    got.size && Math.abs(got.size.width / rug.size.width - got.size.depth / rug.size.depth) < 1e-6,
    `${got.size?.width} x ${got.size?.depth}`)
  ok('the scaled rug fits its envelope',
    got.size && fitsWithin(got.size, { width: 1.5, depth: 1.4 }))
}

{
  // Beyond what the category is made in.
  const got = fitToEnvelope(rug, { width: 0.4, depth: 0.3 }, [])
  ok('an absurd shrink is refused, not applied',
    got.action === 'refused', `${got.action} ${got.factor ?? ''}`)
  ok('the refusal quotes the limits', /made in/.test(got.reason ?? ''), got.reason)
}

// ---- Degenerate input -----------------------------------------------------

ok('an item with no size is refused',
  fitToEnvelope({ id: 'x', category: 'Decor' }, { width: 1, depth: 1 }).action === 'refused')
ok('an envelope with no size is refused',
  fitToEnvelope(rug, { width: 0, depth: 0 }).action === 'refused')
ok('a missing envelope is refused',
  fitToEnvelope(rug, null).action === 'refused')

// ---- The elasticity table -------------------------------------------------

ok('doors are rigid', elasticityOf('Doors & windows').mode === 'rigid')
ok('bathroom fittings are rigid', elasticityOf('Bathroom').mode === 'rigid')
ok('seating is stepped', elasticityOf('Seating').mode === 'stepped')
ok('decor is elastic', elasticityOf('Decor').mode === 'elastic')
ok('an unknown category defaults to stepped, the cautious middle',
  elasticityOf('Gribbles').mode === 'stepped')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
