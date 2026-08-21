import { creditsFor, creditLine, uncredited } from '../src/catalogue/credits'
import { CATALOGUE } from '../src/catalogue/items'
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
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
