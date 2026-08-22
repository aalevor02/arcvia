import { SURFACE_KINDS } from '../src/plan/materials'
import { WALL_TYPES, wallTypeById, type WallTypeId } from '../src/plan/types'

/**
 * Named wall build-ups.
 *
 * ── Why a table of constants is worth testing ───────────────────────────────
 * Because every number in it ends up in a quantity. A wall's thickness is what
 * the masonry is priced on, and the engine's bill of quantities multiplies it by
 * a run of hundreds of metres — a build-up entered at 0.023 instead of 0.23
 * would price a villa's brickwork at a tenth and nothing downstream would
 * question it, because a tenth of a plausible number is also plausible.
 *
 * And because a `surface` naming a kind that does not exist falls back to the
 * default silently: the wall renders, in plaster, and the only symptom is that
 * the exposed brick someone specified is not exposed.
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

check('there are build-ups to choose from', WALL_TYPES.length > 0, `${WALL_TYPES.length}`)

const ids = WALL_TYPES.map((type) => type.id)
check('build-up ids are unique', new Set(ids).size === ids.length)

for (const type of WALL_TYPES) {
  // A one-tenth slip is the failure that matters, and it stays plausible: the
  // range is what a wall can physically be, not a rounding tolerance.
  check(
    `${type.id} is between 40 mm and 500 mm thick`,
    type.thickness >= 0.04 && type.thickness <= 0.5,
    `${(type.thickness * 1000).toFixed(0)} mm`,
  )

  // A surface that does not exist renders as the default with no error, so the
  // exposed brick someone asked for is quietly plaster.
  check(
    `${type.id} names a surface that exists`,
    (SURFACE_KINDS as readonly string[]).includes(type.surface),
    type.surface,
  )

  check(`${type.id} has a name and a note`, Boolean(type.name && type.note))

  // The name states the thickness and a reader will trust it over the field.
  const stated = /(\d+)\s*mm/.exec(type.name)
  if (stated) {
    check(
      `${type.id}'s name and thickness agree`,
      Number(stated[1]) === Math.round(type.thickness * 1000),
      `name says ${stated[1]} mm, field says ${Math.round(type.thickness * 1000)} mm`,
    )
  }
}

// The two thicknesses almost every plan this tool sees is drawn to. Their being
// present is a claim the product makes about the market it is built for.
check(
  'a nine-inch and a four-and-a-half inch brick wall are both offered',
  WALL_TYPES.some((t) => t.thickness === 0.23) && WALL_TYPES.some((t) => t.thickness === 0.115),
)

check('wallTypeById finds a known id', wallTypeById(ids[0])?.id === ids[0])
// Undefined is a real state: a wall with no build-up is unspecified masonry,
// which is what every wall was before build-ups existed.
check('wallTypeById tolerates undefined', wallTypeById(undefined) === undefined)
check(
  'wallTypeById returns undefined for an unknown id',
  wallTypeById('no-such-wall' as WallTypeId) === undefined,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
