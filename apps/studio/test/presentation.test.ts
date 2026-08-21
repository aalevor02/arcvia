import {
  slugId,
  upsertView,
  removeView,
  reorderView,
  upsertHotspot,
  removeHotspot,
  type Hotspot,
} from '../src/plan/presentation'
import type { SceneView } from '@arcvia/viewer'

/**
 * Presentation state.
 *
 * Pure list operations, which is exactly why they are worth testing: they are
 * the sort of thing that looks obviously correct and is quietly off by one at
 * the ends. The order of this list is the order a client looks at the property
 * in, so "move up" doing nothing at the top is a feature and "move up"
 * wrapping to the bottom is a bug.
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

const view = (name: string): SceneView => ({
  id: slugId(name, 'view'),
  name,
  position: [0, 1.6, 0],
  rotation: [0, 0],
  mode: 'fps',
})

// ---- Ids -------------------------------------------------------------------
{
  check('a label becomes a slug', slugId('Master Bedroom', 'x') === 'master-bedroom')
  check('punctuation collapses', slugId('Kitchen / Diner', 'x') === 'kitchen-diner')
  check('edges are trimmed', slugId('  Hall  ', 'x') === 'hall')
  check('a label with nothing usable falls back', slugId('!!!', 'view-2') === 'view-2')
  check('an empty label falls back', slugId('', 'view-3') === 'view-3')
}

// ---- Views -----------------------------------------------------------------
{
  let views: SceneView[] = []
  views = upsertView(views, view('Kitchen'))
  views = upsertView(views, view('Lounge'))
  check('views append in order', views.map((v) => v.name).join(',') === 'Kitchen,Lounge')

  // Re-capturing means "I reframed it", not "make a duplicate".
  const reframed = { ...view('Kitchen'), position: [3, 1.6, -2] as [number, number, number] }
  views = upsertView(views, reframed)
  check('re-capturing replaces rather than duplicates', views.length === 2, String(views.length))
  check('and keeps its place in the order', views[0].name === 'Kitchen')
  check('with the new camera', views[0].position[0] === 3)

  views = removeView(views, 'kitchen')
  check('removing takes only the named one', views.map((v) => v.name).join(',') === 'Lounge')
  check('removing something absent is a no-op', removeView(views, 'nope').length === 1)
}

// ---- Order -----------------------------------------------------------------
// The client-facing order, so the ends matter.
{
  const views = [view('A'), view('B'), view('C')]
  const names = (list: SceneView[]) => list.map((v) => v.name).join('')

  check('moving down swaps with the next', names(reorderView(views, 'a', 1)) === 'BAC')
  check('moving up swaps with the previous', names(reorderView(views, 'c', -1)) === 'ACB')
  check('the first cannot move up', names(reorderView(views, 'a', -1)) === 'ABC')
  check('the last cannot move down', names(reorderView(views, 'c', 1)) === 'ABC')
  check('an unknown id changes nothing', names(reorderView(views, 'zz', 1)) === 'ABC')
  check('the original list is not mutated', names(views) === 'ABC')
}

// ---- Hotspots --------------------------------------------------------------
{
  const spot = (id: string, title: string): Hotspot => ({
    id,
    title,
    position: [1, 1, 1],
  })

  let spots: Hotspot[] = []
  spots = upsertHotspot(spots, spot('h1', 'Oak flooring'))
  spots = upsertHotspot(spots, spot('h2', 'Quartz worktop'))
  check('hotspots append', spots.length === 2)

  spots = upsertHotspot(spots, { ...spot('h1', 'Engineered oak'), body: '180mm board' })
  check('editing replaces in place', spots.length === 2 && spots[0].title === 'Engineered oak')
  check('and keeps the added detail', spots[0].body === '180mm board')

  spots = removeHotspot(spots, 'h2')
  check('removing works', spots.length === 1 && spots[0].id === 'h1')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
