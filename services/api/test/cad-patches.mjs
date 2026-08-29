import {
  CadPatchError,
  applyCadPatch,
  choicesForCadChecks,
  cadPatchWasOffered,
  frameChoiceCheck,
  normaliseCadPatch,
} from '../src/lib/cadPatches.js'

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) { passed++; console.log(`PASS  ${label}`) }
  else { failed++; console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`) }
}
const rejects = (raw) => {
  try { normaliseCadPatch(raw, '2026-08-29T00:00:00.000Z'); return false }
  catch (error) { return error instanceof CadPatchError }
}

const unit = applyCadPatch(
  { inputPath: 'villa.dxf', unit: null, patches: [] },
  { op: 'setUnit', target: 'unit', value: 'cm', by: 'solver', at: 'old' },
  '2026-08-29T01:02:03.000Z',
)
ok('a unit choice changes the engine argument', unit.unit === 'cm')
ok('accepted solver advice is persisted as a user decision',
  unit.patches[0].by === 'user' && unit.patches[0].at === '2026-08-29T01:02:03.000Z')

const layer = applyCadPatch(
  { layers: ['A-WALL'], autoLayers: true, patches: unit.patches },
  { op: 'setLayerRole', target: 'A-PART', value: 'wall' },
  '2026-08-29T01:03:00.000Z',
)
ok('a layer choice joins the explicit wall layers',
  layer.layers.join(',') === 'A-PART,A-WALL', layer.layers.join(','))
ok('an explicit layer choice disables auto-layer guessing', layer.autoLayers === false)
ok('earlier decisions survive later re-solves', layer.patches.length === 2)

const building = applyCadPatch(
  { patches: layer.patches },
  { op: 'acceptAlternative', target: 'building', value: 2 },
)
ok('a building choice reaches the existing CLI argument', building.building === 2)
ok('unsupported geometry edits refuse instead of pretending to replay',
  rejects({ op: 'moveVertex', target: 'v1', value: [1, 2] }))
ok('invalid unit choices refuse', rejects({ op: 'setUnit', target: 'unit', value: 'yards' }))
ok('negative alternative indices refuse',
  rejects({ op: 'acceptAlternative', target: 'frame', value: -1 }))

const checks = choicesForCadChecks({
  unit: 'm',
  unitMeasured: { candidates: [
    { label: 'centimetres', extent: 18.4, paired: 42 },
    { label: 'metres', extent: 1840, paired: 4 },
  ] },
  site: { buildings: [
    { index: 0, rooms: 8, named: 6, area: 120 },
    { index: 1, rooms: 4, named: 3, area: 65 },
    { index: 2, rooms: 1, named: 0, area: 2 },
  ] },
}, [
  { name: 'plan-span', level: 'blocking', message: 'wrong span', value: 1840 },
  { name: 'site-scope', level: 'blocking', message: 'two buildings', value: 2 },
  { name: 'enclosure', level: 'warning', message: 'open', value: 0 },
], '2026-08-29T02:00:00.000Z')
ok('unit findings carry measured unit candidates',
  checks[0].choices?.[0]?.patch.value === 'cm')
ok('site findings carry one choice per named building only', checks[1].choices?.length === 2)

const markers = { verifyChecks: checks }
const offeredPatch = checks[0].choices?.[0]?.patch
ok('the exact solver-offered patch is authorized',
  cadPatchWasOffered(markers, offeredPatch))
ok('changing an offered patch value is not authorized',
  !cadPatchWasOffered(markers, { ...offeredPatch, value: 'ft' }))
ok('a job with no choices authorizes no free re-solve',
  !cadPatchWasOffered({ verifyChecks: [] }, offeredPatch))
const deckChecks = choicesForCadChecks(
  { scale: { metresPerUnit: 12 }, unitMeasured: { candidates: [{ label: 'metres', paired: 2 }] } },
  [{ name: 'plan-span', level: 'blocking', message: 'wrong span', value: 400 }],
)
ok('deck findings invent no patches its build command cannot replay',
  !('choices' in deckChecks[0]))

ok('non-replayable findings do not invent choices', !('choices' in checks[2]))

const frame = frameChoiceCheck({
  frames: [{ title: 'Ground floor' }, { title: 'First floor' }],
}, [{ reason: 'registration uncertain' }], '2026-08-29T03:00:00.000Z')
ok('unregistered storeys become a blocking choice-bearing finding',
  frame.level === 'blocking' && frame.choices.length === 2)
ok('frame choice targets the existing frame CLI argument',
  frame.choices[1].patch.target === 'frame' && frame.choices[1].patch.value === 1)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

