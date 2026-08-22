import {
  DEFAULT_UNITS,
  formatArea,
  formatLength,
  metresToFeetInches,
  parseLength,
  readUnitPreference,
  writeUnitPreference,
} from '../src/lib/format'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

const near = (a: number | null, b: number, tol = 1e-4) =>
  a !== null && Math.abs(a - b) < tol

// ---- Feet and inches --------------------------------------------------------
check('9.6 m reads as 31\' 6"', metresToFeetInches(9.6) === `31' 6"`, metresToFeetInches(9.6))
check('exactly 1 foot', metresToFeetInches(0.3048) === `1' 0"`, metresToFeetInches(0.3048))

// The carry case: 0.3047 m is 11.996 inches, which must become 1' 0", not 0' 12".
check(
  'inches carry into feet rather than showing 12"',
  !metresToFeetInches(0.3047).includes('12"'),
  metresToFeetInches(0.3047),
)
check('zero', metresToFeetInches(0) === `0' 0"`, metresToFeetInches(0))

// ---- Length display ---------------------------------------------------------
check('sub-metre metric shows mm', formatLength(0.84, 'metric') === '840 mm', formatLength(0.84, 'metric'))
check('over a metre shows m', formatLength(3.5, 'metric') === '3.50 m', formatLength(3.5, 'metric'))
check('imperial length', formatLength(9.6, 'imperial') === `31' 6"`)

// ---- Area -------------------------------------------------------------------
check('metric area', formatArea(12, 'metric') === '12.00 m²', formatArea(12, 'metric'))
check('imperial area', formatArea(12, 'imperial') === '129 ft²', formatArea(12, 'imperial'))

// ---- Parsing ----------------------------------------------------------------
check('bare number in metric mode is metres', near(parseLength('3.5', 'metric'), 3.5))
check('bare number in imperial mode is feet', near(parseLength('10', 'imperial'), 3.048))

check('explicit mm', near(parseLength('3500mm', 'metric'), 3.5))
check('explicit cm', near(parseLength('350cm', 'metric'), 3.5))
check('explicit m', near(parseLength('3.5m', 'metric'), 3.5))

// Suffixes must win over the current mode, or someone in imperial mode typing
// "3.5m" gets 1.07 m and never works out why.
check('metric suffix wins in imperial mode', near(parseLength('3.5m', 'imperial'), 3.5))

check("feet only", near(parseLength("12'", 'metric'), 3.6576))
check("feet and inches", near(parseLength(`12' 6"`, 'metric'), 3.8100))
check("feet and bare inches", near(parseLength("12' 6", 'metric'), 3.8100))
check('inches only', near(parseLength('30"', 'metric'), 0.762))
check('ft/in words', near(parseLength('12ft 6in', 'metric'), 3.8100))

check('rubbish returns null', parseLength('banana', 'metric') === null)
check('empty returns null', parseLength('   ', 'metric') === null)

// Round trip: whatever we display must parse back to what we displayed.
{
  const metres = 9.6
  const shown = formatLength(metres, 'imperial')
  const back = parseLength(shown, 'imperial')
  check(
    'imperial display round-trips to within an inch',
    near(back, metres, 0.0254),
    `${shown} -> ${back}`,
  )
}

// ---------------------------------------------------------------------------
// The unit the editor opens in
//
// It hard-coded 'imperial' in three places and remembered nothing, so every
// project on every reload opened in feet — in a product sold into a metric
// market, on a model that is metres everywhere, reading drawings dimensioned
// in millimetres.
// ---------------------------------------------------------------------------

check('the editor opens metric', DEFAULT_UNITS === 'metric', DEFAULT_UNITS)

// No `localStorage` in Node — which is also a private window and a locked-down
// browser. A preference is never worth failing to open the editor over.
check('no storage falls back to the default', readUnitPreference() === DEFAULT_UNITS)
check(
  'writing without storage does not throw',
  (() => {
    try {
      writeUnitPreference('imperial')
      return true
    } catch {
      return false
    }
  })(),
)

{
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }

  check('a fresh browser gets the default', readUnitPreference() === 'metric')

  writeUnitPreference('imperial')
  check('a choice is remembered', readUnitPreference() === 'imperial')

  writeUnitPreference('metric')
  check('and can be changed back', readUnitPreference() === 'metric')

  store.set('arcvia.units', 'furlongs')
  check('a junk stored value is ignored, not trusted', readUnitPreference() === DEFAULT_UNITS)

  delete (globalThis as { localStorage?: unknown }).localStorage
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
