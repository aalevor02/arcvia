/**
 * Where the sun is, for a place and a moment.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The sun study: drag a time slider and watch the model's shadows move. The
 * question a buyer actually asks — "does the west bedroom cook at 4pm in May,
 * does the courtyard get morning light" — is a question about solar geometry,
 * and solar geometry is computable to a fraction of a degree from nothing but
 * latitude, longitude and time.
 *
 * ── The algorithm, and its honest accuracy ──────────────────────────────────
 * Spencer's Fourier fits for declination and the equation of time (1971), the
 * standard spherical-triangle formulas for elevation and azimuth. Accurate to
 * roughly a quarter of a degree against the NOAA calculator — the tests hold
 * it to that against published values. A shadow study needs nothing finer: a
 * quarter degree moves a 3 m shadow about 13 mm.
 *
 * Deliberately NOT the full NREL SPA (pressure, temperature, refraction,
 * ΔT): those matter for solar plant yield, not for whether the veranda is in
 * shade at teatime. Refraction lifts the apparent sun ~0.6° AT THE HORIZON
 * and nothing at useful elevations, so sunrise shadows here are a minute or
 * two "late" — stated rather than corrected, because correcting it implies an
 * accuracy the rest of a plan-derived model does not have.
 */

export interface SunPosition {
  /** Degrees above the horizon. Negative means night. */
  elevation: number
  /** Compass degrees: 0 north, 90 east, 180 south, 270 west. */
  azimuth: number
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/**
 * Solar position for a UTC moment at a latitude/longitude.
 *
 * UTC in, deliberately: time zones are a political database and longitude is
 * not. Callers that want "3pm at the site" convert with `siteLocalToUtc`,
 * which uses SOLAR time — the sun neither knows nor cares what the clocks in
 * that country decided.
 */
export function solarPosition(atUtc: Date, latitudeDeg: number, longitudeDeg: number): SunPosition {
  const start = Date.UTC(atUtc.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((atUtc.getTime() - start) / 86_400_000)
  const hoursUtc =
    atUtc.getUTCHours() + atUtc.getUTCMinutes() / 60 + atUtc.getUTCSeconds() / 3600

  // Fractional year, in radians, including the time of day.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear + (hoursUtc - 12) / 24)

  // Spencer 1971. Declination in radians, equation of time in minutes.
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)

  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma))

  // True solar time: clock time corrected for where the sun actually is.
  const solarMinutes = hoursUtc * 60 + equationOfTime + 4 * longitudeDeg
  // Hour angle: degrees the sun is past solar noon. -180..180.
  let hourAngle = solarMinutes / 4 - 180
  if (hourAngle < -180) hourAngle += 360
  if (hourAngle > 180) hourAngle -= 360

  const lat = latitudeDeg * RAD
  const ha = hourAngle * RAD

  const sinElevation =
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(ha)
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinElevation)))

  // Azimuth from north, clockwise. The atan2 form is branch-free — the
  // textbook acos form needs a hemisphere correction that is exactly the kind
  // of branch that passes every test written in one hemisphere.
  const azimuth =
    Math.atan2(
      Math.sin(ha),
      Math.cos(ha) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat),
    ) *
      DEG +
    180

  return { elevation: elevation * DEG, azimuth: ((azimuth % 360) + 360) % 360 }
}

/**
 * "15:00 at the site" as a UTC moment, using solar time.
 *
 * Longitude alone: 15 degrees per hour. This is what a sun study wants — the
 * slider says 12:00, the sun is at its highest — and it sidesteps the tz
 * database entirely. It is NOT civil clock time; in India the difference is
 * about 21 minutes at Pune, and the panel says "solar time" so nobody checks
 * it against their watch and files a bug.
 */
export function siteLocalToUtc(
  year: number,
  month: number,
  day: number,
  localHours: number,
  longitudeDeg: number,
): Date {
  const utcHours = localHours - longitudeDeg / 15
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) + utcHours * 3_600_000)
}

/**
 * The sun's direction as a world-space unit vector, for a light.
 *
 * Assumes the TOP OF THE PLAN IS NORTH: the studio's plans carry no compass,
 * so up-the-page maps to north the way it does on almost every drawing ever
 * issued. The panel states the assumption; a per-scene north angle is the
 * follow-up if a site is rotated.
 *
 * Plan +y is world -z, so north is -z and east is +x.
 */
export function sunDirection(position: SunPosition): { x: number; y: number; z: number } {
  const elevation = position.elevation * RAD
  const azimuth = position.azimuth * RAD
  return {
    x: Math.sin(azimuth) * Math.cos(elevation),
    y: Math.sin(elevation),
    z: -Math.cos(azimuth) * Math.cos(elevation),
  }
}
