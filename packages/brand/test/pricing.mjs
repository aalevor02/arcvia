/**
 * Nothing may be charged for without appearing on the price list.
 *
 * ── The failure this pins down ─────────────────────────────────────────────
 * `pricing.astro` read its COSTS from `creditCost`, so no published number
 * could drift from what the code charges. But it named its own six rows, and
 * that list fell behind the tariff: nine priced actions, six on the page.
 *
 * The one that mattered was `cadReconstruct` at 3 credits. A user could be
 * charged for CAD reconstruction and find no price for it anywhere, before or
 * after paying — not a drifted number, a charge with no published price.
 *
 * The page now enumerates the tariff, so this suite only has to defend the one
 * invariant that makes that safe: every key in `creditCost` reaches the table.
 *
 * Run: node test/pricing.mjs
 */

import {
  creditCost,
  creditLabel,
  labelFor,
  meteredActions,
} from '../plans.config.mjs'

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

console.log('\n-- every charged action reaches the price list --')

const rows = meteredActions()
const listed = new Set(rows.map((r) => r.action))
const missing = Object.keys(creditCost).filter((a) => !listed.has(a))

ok('no priced action is absent from the table', missing.length === 0, missing.join(', '))
ok('and the counts match exactly',
  rows.length === Object.keys(creditCost).length,
  `${rows.length} rows vs ${Object.keys(creditCost).length} actions`)

// THE SPECIFIC REGRESSION. Named rather than left to the general check, because
// this is the one that was actually being charged unlisted.
const cad = rows.find((r) => r.action === 'cadReconstruct')
ok('cadReconstruct is on the price list', Boolean(cad))
ok('at the price it actually charges', cad?.cost === creditCost.cadReconstruct,
  `${cad?.cost} vs ${creditCost.cadReconstruct}`)

console.log('\n-- every row carries the price the code charges --')
for (const row of rows) {
  ok(`${row.action} is listed at its tariff`, row.cost === creditCost[row.action],
    `${row.cost}`)
}

console.log('\n-- a new action cannot hide behind a missing label --')
// The important half. Adding a priced action and forgetting its label must
// produce an awkwardly spelled row, never a hidden charge.
ok('an unlabelled action still gets a readable label',
  labelFor('someNewAction') === 'Some New Action', labelFor('someNewAction'))
ok('a labelled action uses its label',
  labelFor('lightmapBake') === creditLabel.lightmapBake)
ok('every action currently has a real label, not a fallback',
  Object.keys(creditCost).every((a) => a in creditLabel),
  Object.keys(creditCost).filter((a) => !(a in creditLabel)).join(', '))

console.log('\n-- free actions are shown, not filtered --')
// "Reading a drawing is free" is a deliberate product decision that creditCost
// argues for in its own comment: charging for a survey makes people guess
// instead of check. A table that hides the free rows makes the paid ones look
// like the whole product.
const free = rows.filter((r) => r.cost === 0)
ok('free actions appear on the list', free.length > 0, `${free.length} free`)
ok('including the CAD survey specifically',
  free.some((r) => r.action === 'cadSurvey'))

console.log('\n-- ordering is cheapest first, so the table reads --')
const costs = rows.map((r) => r.cost)
ok('costs ascend', costs.every((c, i) => i === 0 || costs[i - 1] <= c), costs.join(' '))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
