import { solarPosition, siteLocalToUtc, sunDirection } from '../src/lib/sun'

/**
 * Solar geometry, held against the NOAA calculator.
 *
 * ── Why published values and not derived ones ───────────────────────────────
 * The daylight-factor work recorded the right instinct: a reference the next
 * reader can CHECK beats one they must trust. These cases are readable off the
 * NOAA solar calculator (gml.noaa.gov/grad/solcalc) by anyone with the date and
 * the coordinates, and each states what it pins: noon elevation is the latitude
 * cosine everyone learns, June sunrise in London really does come up in the
 * NORTH-east, and at Pune — south of the Tropic of Cancer — the midsummer noon
 * sun stands NORTH of overhead, which is the case that catches every azimuth
 * formula tested only in Europe.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  condition ? passed++ : failed++
}

const near = (value: number, target: number, tolerance: number) =>
  Math.abs(value - target) <= tolerance

// ---- London, both solstices ---------------------------------------------------
{
  // 2026-06-21 12:00 UTC at 51.5N 0E. NOAA: elevation ~61.9, azimuth ~180.
  const sun = solarPosition(new Date(Date.UTC(2026, 5, 21, 12, 0)), 51.5, 0)
  check('London midsummer noon elevation ~62', near(sun.elevation, 61.9, 1.5), sun.elevation.toFixed(1))
  check('and the sun is due south', near(sun.azimuth, 180, 3), sun.azimuth.toFixed(1))
}
{
  // 2026-12-21 12:00 UTC. NOAA: elevation ~15.1.
  const sun = solarPosition(new Date(Date.UTC(2026, 11, 21, 12, 0)), 51.5, 0)
  check('London midwinter noon elevation ~15', near(sun.elevation, 15.1, 1.5), sun.elevation.toFixed(1))
  check('still due south', near(sun.azimuth, 180, 3), sun.azimuth.toFixed(1))
}
{
  // Midsummer sunrise, ~03:47 UTC: the sun comes up in the NORTH-east (~50°),
  // which surprises everyone who has only seen "the sun rises in the east".
  const sun = solarPosition(new Date(Date.UTC(2026, 5, 21, 3, 47)), 51.5, 0)
  check('midsummer London sunrise sits on the horizon', near(sun.elevation, 0, 2), sun.elevation.toFixed(1))
  check('and rises north-east', near(sun.azimuth, 50, 4), sun.azimuth.toFixed(1))
}

// ---- Pune: the market this product is built for --------------------------------
{
  // Equinox solar noon. Declination ~0, so elevation = 90 - latitude.
  const noon = siteLocalToUtc(2026, 3, 20, 12, 73.8567)
  const sun = solarPosition(noon, 18.5204, 73.8567)
  check('Pune equinox noon elevation = 90 - latitude', near(sun.elevation, 90 - 18.52, 1.5), sun.elevation.toFixed(1))
}
{
  // June solstice: Pune is SOUTH of the Tropic of Cancer, so the noon sun
  // stands north of overhead. Azimuth flips to ~0/360 — the hemisphere case a
  // Europe-tested formula gets wrong while passing everything else.
  const noon = siteLocalToUtc(2026, 6, 21, 12, 73.8567)
  const sun = solarPosition(noon, 18.5204, 73.8567)
  check('Pune midsummer noon is nearly overhead', sun.elevation > 84, sun.elevation.toFixed(1))
  check('and stands to the NORTH', sun.azimuth < 25 || sun.azimuth > 335, sun.azimuth.toFixed(1))
}
{
  const midnight = siteLocalToUtc(2026, 6, 21, 0, 73.8567)
  const sun = solarPosition(midnight, 18.5204, 73.8567)
  check('midnight is below the horizon', sun.elevation < -20, sun.elevation.toFixed(1))
}

// ---- Solar time round-trip ------------------------------------------------------
{
  // 12:00 solar at Pune is ~07:05 UTC: 73.8567° east is 4.924 hours ahead.
  const noon = siteLocalToUtc(2026, 3, 20, 12, 73.8567)
  check(
    'site solar noon converts to the right UTC hour',
    near(noon.getUTCHours() + noon.getUTCMinutes() / 60, 12 - 73.8567 / 15, 0.02),
    `${noon.getUTCHours()}:${String(noon.getUTCMinutes()).padStart(2, '0')} UTC`,
  )
}

// ---- The light vector ------------------------------------------------------------
{
  // Due south at 45°: the sun stands in +z (south), halfway up.
  const direction = sunDirection({ elevation: 45, azimuth: 180 })
  check('south sun points from +z', near(direction.z, Math.SQRT1_2, 0.01) && near(direction.x, 0, 0.01))
  check('at half height', near(direction.y, Math.SQRT1_2, 0.01))

  // Due east on the horizon: +x, flat.
  const east = sunDirection({ elevation: 0, azimuth: 90 })
  check('east sun points from +x on the horizon', near(east.x, 1, 0.01) && near(east.y, 0, 0.01))

  // North: -z, because the top of the plan is north and plan +y is world -z.
  const north = sunDirection({ elevation: 10, azimuth: 0 })
  check('north sun points from -z', north.z < -0.9, north.z.toFixed(2))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
