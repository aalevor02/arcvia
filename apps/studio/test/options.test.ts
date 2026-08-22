import { composeFlooringOptions, offerableFinishes } from '../src/publish/options'
import { PROCEDURAL_SURFACES } from '../src/catalogue/surfaces'

/**
 * Client options for the published page.
 *
 * ── What the tests protect ──────────────────────────────────────────────────
 * The published page is another origin with no session, so an option is only
 * real once its textures live in the API's storage. The compose step is where
 * that guarantee is made, and the failure modes are all silent: a procedural
 * finish offered as a choice is a button that does nothing; a missing upload is
 * a floor with a hole in it, on the client's machine, after publishing.
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

// ---- What may be offered -----------------------------------------------------

const offerable = offerableFinishes()
check('there are finishes to offer', offerable.length >= 2, `${offerable.length}`)
check(
  'no procedural finish is offerable',
  offerable.every((finish) => !(finish.id in PROCEDURAL_SURFACES)),
  offerable.map((f) => f.id).join(', '),
)
// Grass is the concrete case: its maps are drawn on a canvas inside the studio,
// and the published page cannot run that generator.
check('grass specifically is not offerable', !offerable.some((f) => f.id === 'grass'))

// ---- Composing ----------------------------------------------------------------

{
  const uploaded: string[] = []
  const upload = async (url: string) => {
    uploaded.push(url)
    return `/uploads/floorplans/u1/${url.split('/').pop()}`
  }

  const flooring = await composeFlooringOptions(['floor-wood', 'floor-tile'], upload)
  check('two finishes compose', flooring?.choices.length === 2)
  check('three maps uploaded per finish', uploaded.length === 6, `${uploaded.length}`)
  check(
    'the stored URLs are what the choice carries',
    flooring?.choices.every((c) =>
      [c.maps.color, c.maps.roughness, c.maps.normal].every((u) => u.startsWith('/uploads/')),
    ),
  )
  check(
    'attribution rides on every choice',
    flooring?.choices.every((c) => Boolean(c.licence && c.author && c.source)),
  )
  check(
    'tile scale rides on every choice',
    flooring?.choices.every((c) => c.tileMetres > 0),
  )
}

{
  // One choice is not a choice: a panel with a single button reads as broken.
  const none = await composeFlooringOptions(['floor-wood'], async (u) => u)
  check('a single finish composes to nothing', none === undefined)

  const empty = await composeFlooringOptions([], async (u) => u)
  check('no finishes compose to nothing', empty === undefined)

  // A procedural finish in the request is dropped rather than uploaded — it has
  // no files to upload, and failing the whole compose over it would punish a
  // valid selection for containing one invalid member.
  const mixed = await composeFlooringOptions(
    ['floor-wood', 'floor-tile', 'grass' as never],
    async (u) => u,
  )
  check('a procedural finish in the selection is dropped', mixed?.choices.length === 2)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
