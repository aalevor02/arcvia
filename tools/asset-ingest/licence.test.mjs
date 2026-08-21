import { checkLicence, LICENCES, licenceSlug } from './licence.mjs'

/**
 * The licence gate.
 *
 * The single most consequential piece of logic in the ingest tool, and the one
 * with no runtime symptom: a non-commercial model renders exactly as well as a
 * CC-BY one, right up until somebody notices it on a client's published page.
 * Nothing downstream can catch a mistake here, so it is caught here.
 *
 *   node tools/asset-ingest/licence.test.mjs
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

/** Run the gate against a whole licence object, in either Sketchfab shape. */
const acceptsLicence = (licence) => {
  try {
    return checkLicence(licence)
  } catch {
    return null
  }
}

const accepts = (slug) => {
  try {
    return checkLicence({ slug, label: slug })
  } catch {
    return null
  }
}

// ---- What may ship ---------------------------------------------------------
{
  ok('CC0 is accepted', Boolean(accepts('cc0')))
  ok('CC0 needs no attribution', accepts('cc0')?.attribution === false)

  ok('CC-BY is accepted', Boolean(accepts('by')))
  ok('CC-BY requires attribution', accepts('by')?.attribution === true)

  ok('CC-BY-SA is accepted', Boolean(accepts('by-sa')))
  ok('CC-BY-SA requires attribution', accepts('by-sa')?.attribution === true)
}

// ---- What may not ----------------------------------------------------------
// Each of these would render perfectly and be a licence breach.
{
  for (const slug of ['by-nc', 'by-nc-sa', 'by-nc-nd']) {
    ok(`${slug} is refused as non-commercial`, accepts(slug) === null)
  }
  for (const slug of ['by-nd', 'by-sa-nd']) {
    ok(`${slug} is refused as no-derivatives`, accepts(slug) === null)
  }
  for (const slug of ['st', 'ed']) {
    ok(`Sketchfab "${slug}" is refused as no-redistribution`, accepts(slug) === null)
  }
}

// ---- Unknown licences fail closed ------------------------------------------
// The important property. Sketchfab can add a licence type at any time, and a
// block-list would wave it through because nobody had thought to ban it yet.
{
  ok('an unrecognised licence is refused', accepts('by-nc-nd-2050') === null)
  ok('a missing licence is refused', accepts(undefined) === null)
  ok('an empty licence is refused', accepts('') === null)

  // Case is not a licence decision.
  ok('licence slugs are matched case-insensitively', Boolean(accepts('CC0')))
}

// ---- The refusal explains itself -------------------------------------------
// Someone hitting this is mid-task with a model they want. A bare "refused"
// sends them looking for a flag to override it; a reason sends them back to
// the search with a filter.
{
  let message = ''
  try {
    checkLicence({ slug: 'by-nc', label: 'CC Attribution-NonCommercial' })
  } catch (error) {
    message = error.message
  }
  ok('the refusal names the licence', message.includes('CC Attribution-NonCommercial'))
  ok('the refusal gives the reason', message.includes('non-commercial'))
  ok('the refusal lists what is allowed', message.includes('CC0'))
}

ok('every allowed licence declares an attribution stance',
  Object.values(LICENCES).every((l) => typeof l.attribution === 'boolean'))

// ---- Search results carry a label, not a slug ------------------------------
// The two Sketchfab endpoints disagree: `/models/{uid}` returns `license.slug`,
// `/search` returns `license.label` and no slug at all. Reading only the slug
// fails closed — correctly, and also refuses the entire library, which is how
// the batch picker came back with zero candidates for all 37 items.
{
  ok('a slug is used when present', licenceSlug({ slug: 'by' }) === 'by')
  ok('a slug is lowercased', licenceSlug({ slug: 'CC0' }) === 'cc0')

  ok('a CC-BY label maps to by', licenceSlug({ label: 'CC Attribution' }) === 'by')
  ok('a CC0 label maps to cc0', licenceSlug({ label: 'CC0 Public Domain' }) === 'cc0')
  ok(
    'a ShareAlike label maps to by-sa',
    licenceSlug({ label: 'CC Attribution-ShareAlike' }) === 'by-sa',
  )
  ok('labels are trimmed and case-folded', licenceSlug({ label: '  cc attribution  ' }) === 'by')

  // The trap this mapping exists to avoid. "CC Attribution-NonCommercial"
  // *starts with* "CC Attribution", so prefix or `includes` matching would
  // approve precisely the licences the allow-list is there to keep out.
  for (const label of [
    'CC Attribution-NonCommercial',
    'CC Attribution-NonCommercial-ShareAlike',
    'CC Attribution-NoDerivs',
  ]) {
    ok(`"${label}" is not mistaken for CC Attribution`, licenceSlug({ label }) === null)
    ok(`and "${label}" is refused outright`, acceptsLicence({ label }) === null)
  }

  ok('an unknown label is refused', licenceSlug({ label: 'Some New Licence' }) === null)
  ok('a missing licence object is refused', licenceSlug(undefined) === null)
  ok('a label-only CC-BY is accepted', Boolean(acceptsLicence({ label: 'CC Attribution' })))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
