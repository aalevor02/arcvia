/**
 * What may be published, and what may not.
 *
 * Its own module so it can be tested without a network, a token, or Blender.
 * This is the one decision in the ingest path that cannot be caught later: a
 * non-commercial model renders exactly as well as a CC-BY one, right up until
 * someone notices it on a client's published page.
 */

/**
 * Allowed licences, keyed by the slug Sketchfab reports.
 *
 * An allow-list, not a block-list, and the difference is the whole point:
 * Sketchfab can add a licence type at any time, and a new one appearing should
 * stop the pipeline rather than sail through because nobody thought to ban it.
 *
 * `attribution` records whether shipping the model obliges us to credit the
 * author. Everything here except CC0 does — see apps/studio/src/catalogue/
 * credits.ts, which is what actually pays that debt.
 */
export const LICENCES = {
  cc0: { name: 'CC0 1.0 Public Domain', attribution: false },
  by: { name: 'CC Attribution 4.0', attribution: true },
  'by-sa': { name: 'CC Attribution-ShareAlike 4.0', attribution: true },
  // Deliberately absent, each for its own reason:
  //   by-nc, by-nc-sa, by-nc-nd  non-commercial. This is a commercial product;
  //                              a client walkthrough is a commercial use
  //                              however it is framed.
  //   by-nd, by-sa-nd            no derivatives. Decimating a model to 6,000
  //                              triangles is unambiguously a derivative.
  //   st, ed                     Sketchfab Standard and Editorial. Standard
  //                              forbids redistributing the model itself, and
  //                              serving a GLB to a browser is exactly that.
}

/**
 * Approve a licence, or refuse it with a reason.
 *
 * The reason matters. Someone hitting this is mid-task with a model they have
 * already decided they want; a bare refusal sends them hunting for a flag to
 * override it, while a reason sends them back to the search with a filter.
 */
export function checkLicence(licence) {
  const slug = String(licence?.slug ?? '').toLowerCase()
  const allowed = LICENCES[slug]
  if (allowed) return allowed

  const label = licence?.label ?? slug ?? 'unknown'
  const reason = slug.includes('nc')
    ? 'it is non-commercial, and this is a commercial product'
    : slug.includes('nd')
      ? 'it forbids derivatives, and conditioning the model creates one'
      : slug === 'st' || slug === 'ed'
        ? 'it forbids redistributing the model, which serving a GLB to a browser is'
        : 'it is not on the allow-list'

  throw new Error(
    `Refusing "${label}" — ${reason}.\n` +
      `Allowed: ${Object.values(LICENCES)
        .map((l) => l.name)
        .join(', ')}.\n` +
      'Filter Sketchfab searches by licence, or pick a different model.',
  )
}
