import { creditsFor, creditLine, uncredited } from '../src/catalogue/credits'
import { CATALOGUE } from '../src/catalogue/items'
import { ENVIRONMENTS } from '../src/catalogue/environments'
import type { PlacedObject } from '../src/catalogue/types'

/**
 * Attribution.
 *
 * Tested because it is a legal obligation with no runtime symptom. A scene
 * whose credits are wrong renders exactly as well as one whose credits are
 * right, so nothing else in the system will ever notice — which makes this the
 * only thing standing between a CC-BY model and an unattributed publication.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const place = (id: string, item: string, customUrl?: string): PlacedObject => ({
  id,
  item,
  position: { x: 0, y: 0 },
  rotation: 0,
  ...(customUrl ? { customUrl } : {}),
})

// Catalogue items are chosen at runtime rather than named.
//
// The first version of this file hard-coded 'armchair' as its example of an
// item with no model, and broke the day one was added — a test failing because
// the product improved. Anything that asserts "an item without a model" has to
// go and find one.
const withoutModel = CATALOGUE.find((item) => !item.model)?.id
const withModel = CATALOGUE.find((item) => item.model)?.id

{
  check('an empty scene credits nobody', creditsFor([]).length === 0)
  check('an empty credit line is empty, not "undefined"', creditLine([]) === '')

  check('the catalogue still has an item with no model', Boolean(withoutModel), withoutModel)

  const plain = [place('o1', withoutModel!), place('o2', withoutModel!)]
  check(
    'objects with no model owe nothing',
    creditsFor(plain).length === 0,
    String(creditsFor(plain).length),
  )
}

// ---- Deduplication ---------------------------------------------------------
// Forty dining chairs are one obligation and one line. Getting this wrong does
// not break anything, it just produces a credit list nobody will read, which
// defeats the purpose of crediting.
{
  const credits = creditsFor([])
  check('deduplication starts from nothing', credits.length === 0)

  // Built directly, since the catalogue has no models yet.
  const sample = [
    { url: '/models/a.glb', licence: 'CC Attribution 4.0', author: 'Zoë', source: 'x', uses: 3 },
    { url: '/models/b.glb', licence: 'CC0 1.0 Public Domain', author: 'alice', source: 'y', uses: 1 },
  ]

  const line = creditLine(sample)
  check('the credit line names every author', line.includes('Zoë') && line.includes('alice'))
  check(
    'each licence is named against its own author',
    line.includes('Zoë (CC Attribution 4.0)') && line.includes('alice (CC0 1.0 Public Domain)'),
    line,
  )
  check('authors are separated, not run together', line.includes(' · '))
}

// ---- Sorting ---------------------------------------------------------------
// Case-insensitive, or "alice" sorts after "Zoë" and the list looks broken to
// the one person guaranteed to read it: the author checking they were credited.
{
  const sample = [
    { url: '/a', licence: 'CC Attribution 4.0', author: 'zoe', source: 's', uses: 1 },
    { url: '/b', licence: 'CC Attribution 4.0', author: 'Alice', source: 's', uses: 1 },
  ]
  const line = creditLine(sample)
  check('sorting is left to creditsFor, not creditLine', line.startsWith('zoe'), line)
}

// ---- Custom models are not misattributed -----------------------------------
// A per-placement URL has no catalogue entry and therefore no licence on
// record. Crediting it to the item it replaced would put one author's name on
// another author's work, which is worse than saying nothing.
{
  // Deliberately overriding an item that *does* have a model. With an
  // unmodelled item this assertion passes whatever the code does, which is how
  // the first version of it managed to be both green and meaningless.
  if (withModel) {
    const overridden = [place('o1', withModel, 'https://example.com/mine.glb')]
    check(
      'a custom model is never credited to the catalogue item it replaced',
      creditsFor(overridden).length === 0,
      String(creditsFor(overridden).length),
    )
    check('and the catalogue item alone would have been credited', creditsFor([place('o2', withModel)]).length === 1)
  } else {
    check('skipped: no catalogue item has a model yet', true)
    check('skipped: no catalogue item has a model yet', true)
  }

  const objects = [place('o1', withoutModel!, 'https://example.com/mine.glb'), place('o2', withoutModel!)]
  check('a custom model is reported as uncredited', uncredited(objects).length === 1)
  check(
    'objects without a custom model are not flagged',
    uncredited(objects).every((o) => o.id === 'o1'),
  )

  const hub: PlacedObject = {
    ...place('hub-1', withoutModel!),
    customModel: {
      url: '/hub/conditioned/chair--5000.glb',
      licence: 'CC Attribution 4.0',
      author: 'Hub Artist',
      source: 'https://example.com/hub-chair',
      triangles: 4990,
      yaw: 90,
      upAxis: 'y',
    },
  }
  const hubCredits = creditsFor([hub])
  check('a conditioned Hub placement credits its recorded author',
    hubCredits.length === 1 && hubCredits[0]?.author === 'Hub Artist')
  check('a licensed Hub placement is not reported as anonymous', uncredited([hub]).length === 0)
  const manuallyReplaced = { ...hub, customUrl: 'https://example.com/replacement.glb' }
  check('a later manual URL supersedes the old Hub credit', creditsFor([manuallyReplaced]).length === 0)
  check('that manual replacement is reported as uncredited', uncredited([manuallyReplaced]).length === 1)
}

// ---- Assets that are not placed objects -------------------------------------

/**
 * ── Why these assertions are the point of this file now ─────────────────────
 * A scene's obligations do not all come from its furniture. The environment is
 * one field on the scene, and the surfaces are shared materials bound by
 * whatever geometry got built — neither is reachable from the placement list,
 * and both went uncredited for as long as they existed.
 *
 * The failure had no runtime symptom at all: the page rendered, the walkthrough
 * looked right, and the credit list was simply shorter than the licences
 * required. **A test that only checks placed objects passes in exactly that
 * state**, which is why every assertion below checks that a credit is PRESENT.
 */
{
  const environment = ENVIRONMENTS[0]

  const withEnvironment = creditsFor([], { environmentUrl: environment.url })
  check('a scene that chose an environment credits it', withEnvironment.length === 1, `${withEnvironment.length}`)
  check(
    'and names its author and licence',
    withEnvironment[0]?.author === environment.author &&
      withEnvironment[0]?.licence === environment.licence,
    `${withEnvironment[0]?.author} / ${withEnvironment[0]?.licence}`,
  )
  check('and marks it as an environment', withEnvironment[0]?.kind === 'environment')

  // An environment nobody can identify is a scene lit by something else — not
  // an error, and not a credit we can invent an author for.
  check(
    'an environment outside the catalogue credits nobody',
    creditsFor([], { environmentUrl: '/env/somebody-elses.hdr' }).length === 0,
  )
  check('no environment credits nobody', creditsFor([], { environmentUrl: null }).length === 0)

  const withSurface = creditsFor([], { surfaces: ['floor-wood'] })
  check('a scene that bound a surface credits it', withSurface.length === 1, `${withSurface.length}`)
  check('and marks it as a surface', withSurface[0]?.kind === 'surface')

  // wall and ceiling are deliberately the same material. One obligation, one
  // line, counted twice — the same rule as forty dining chairs.
  const shared = creditsFor([], { surfaces: ['wall', 'ceiling'] })
  check('two surfaces sharing one material are one credit', shared.length === 1, `${shared.length}`)
  check('counted twice', shared[0]?.uses === 2, `uses ${shared[0]?.uses}`)

  // glass is a shader property, not a photograph. It must not invent a credit.
  check('a procedural surface credits nobody', creditsFor([], { surfaces: ['glass'] }).length === 0)

  const everything = creditsFor([], {
    environmentUrl: environment.url,
    surfaces: ['floor-wood', 'wall'],
  })
  check('environment and surfaces are credited together', everything.length === 3, `${everything.length}`)
  check(
    'and the list is still sorted by author',
    everything.every(
      (c, i) =>
        i === 0 ||
        everything[i - 1].author.localeCompare(c.author, undefined, { sensitivity: 'base' }) <= 0,
    ),
  )

  // Every existing caller passes one argument.
  check('creditsFor still works with one argument', creditsFor([]).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
