/**
 * Display formatting for lengths and areas.
 *
 * The model is metric everywhere (see `plan/types.ts`). This module is the only
 * place metres become something a person reads, which is the whole point: one
 * conversion, at the edge, so no other module ever has to know which unit it is
 * holding.
 */

export type UnitSystem = 'metric' | 'imperial'

/**
 * What the editor opens in.
 *
 * ── Why metric, when the code said imperial ─────────────────────────────────
 * The editor hard-coded `'imperial'` in three places and remembered nothing, so
 * every project on every reload opened in feet and inches. Everything around it
 * disagrees:
 *
 *   - the plan model is metres (`plan/types.ts`, and the note at the top here)
 *   - the reconstruction engine is metres throughout, down to matching wall
 *     thicknesses against 229 mm brick
 *   - the product is sold into a metric market — RERA, SBUA, rupees, and the
 *     drawings this reads are dimensioned in millimetres
 *
 * So the default was costing every user a toggle on every project, and the
 * toggle did not stick. Worse than the extra click: `CalibrateDialog` takes a
 * typed real-world length, and its own comment records that a metric number
 * entered into an imperial field scales the drawing by a thousand. A default
 * nobody expects is the setup for exactly that.
 *
 * Anyone who wants imperial still gets it — once, rather than every time.
 */
export const DEFAULT_UNITS: UnitSystem = 'metric'

const UNITS_KEY = 'arcvia.units'

/**
 * The remembered choice, or the default.
 *
 * Wrapped because `localStorage` throws rather than returning null in a private
 * window and under some enterprise policies — and a preference is never worth
 * failing to open the editor over.
 */
export function readUnitPreference(): UnitSystem {
  try {
    const stored = localStorage.getItem(UNITS_KEY)
    return stored === 'imperial' || stored === 'metric' ? stored : DEFAULT_UNITS
  } catch {
    return DEFAULT_UNITS
  }
}

export function writeUnitPreference(units: UnitSystem): void {
  try {
    localStorage.setItem(UNITS_KEY, units)
  } catch {
    // Not being able to remember it is not a reason to refuse the change.
  }
}

const FEET_PER_METRE = 3.280839895013123
const SQ_FEET_PER_SQ_METRE = 10.763910416709722

/**
 * Metres to feet-and-inches, e.g. `9.6` -> `31' 6"`.
 *
 * Inches are rounded to the nearest whole inch, not to a decimal, because that
 * is how the dimension would be written on a drawing. The carry matters: 11.6
 * inches must round to `1' 0"`, never to `0' 12"`, and a naive
 * `Math.round(inches)` produces exactly that on a surprising number of ordinary
 * measurements.
 */
export function metresToFeetInches(metres: number): string {
  const totalInches = Math.round(metres * FEET_PER_METRE * 12)
  const feet = Math.floor(totalInches / 12)
  const inches = totalInches % 12
  return `${feet}' ${inches}"`
}

/** A length, in whichever system the editor is set to. */
export function formatLength(metres: number, units: UnitSystem): string {
  if (units === 'imperial') return metresToFeetInches(metres)

  // Millimetres below a metre: "0.84 m" is how nobody writes a door width.
  if (Math.abs(metres) < 1) return `${Math.round(metres * 1000)} mm`
  return `${metres.toFixed(2)} m`
}

/** An area. Square metres in, m² or ft² out. */
export function formatArea(squareMetres: number, units: UnitSystem): string {
  if (units === 'imperial') {
    return `${Math.round(squareMetres * SQ_FEET_PER_SQ_METRE).toLocaleString()} ft²`
  }
  return `${squareMetres.toFixed(2)} m²`
}

/**
 * Parse a typed dimension back to metres.
 *
 * Accepts what people actually type into a dimension field rather than a single
 * canonical form, because the alternative is rejecting `12'6"` from someone who
 * has typed it that way for thirty years:
 *
 *   `3.5`      in metric mode, metres; in imperial mode, feet
 *   `3.5m`     metres              `350cm`   centimetres      `3500mm`  millimetres
 *   `12'`      feet                `12' 6"`  feet and inches  `12'6`    the same
 *   `30"`      inches              `12ft 6in`                 `12-6`    feet-inches
 *
 * Returns null when it cannot tell, and the caller keeps the old value. Guessing
 * at an ambiguous dimension is worse than refusing it.
 */
export function parseLength(input: string, units: UnitSystem): number | null {
  const text = input.trim().toLowerCase()
  if (!text) return null

  // Explicit metric suffixes win regardless of the current unit system.
  const metric = text.match(/^([\d.]+)\s*(mm|cm|m)$/)
  if (metric) {
    const value = Number(metric[1])
    if (!Number.isFinite(value)) return null
    const factor = metric[2] === 'mm' ? 0.001 : metric[2] === 'cm' ? 0.01 : 1
    return value * factor
  }

  // Feet and inches, in their several spellings.
  const feetInches = text.match(
    /^(?:([\d.]+)\s*(?:'|ft|feet))?\s*(?:[-\s])?\s*(?:([\d.]+)\s*(?:"|in|inch|inches)?)?$/,
  )
  if (feetInches && (feetInches[1] || feetInches[2])) {
    const hasFootMark = /'|ft|feet/.test(text)
    const hasInchMark = /"|in\b|inch/.test(text)

    if (hasFootMark || hasInchMark) {
      const feet = Number(feetInches[1] ?? 0)
      const inches = Number(feetInches[2] ?? 0)
      if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null
      // A bare number after a foot mark is inches: `12' 6` means 12 feet 6.
      return (feet + inches / 12) / FEET_PER_METRE
    }
  }

  // A bare number means whatever the editor is currently showing. This is the
  // one place the unit setting changes an interpretation, which is why the
  // suffixed forms above are checked first.
  const bare = Number(text)
  if (!Number.isFinite(bare)) return null
  return units === 'imperial' ? bare / FEET_PER_METRE : bare
}

/** `1.4` -> `1.4 m` / `4' 7"`, for a wall-thickness style readout. */
export function formatThickness(metres: number, units: UnitSystem): string {
  if (units === 'imperial') {
    const inches = metres * FEET_PER_METRE * 12
    return `${inches.toFixed(1).replace(/\.0$/, '')}"`
  }
  return `${Math.round(metres * 1000)} mm`
}
