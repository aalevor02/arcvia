import { useEffect, useState } from 'react'
import type { SceneViewer } from '@arcvia/viewer'

import { siteLocalToUtc, solarPosition, sunDirection } from '../lib/sun'

export interface Site {
  latitude: number
  longitude: number
}

interface Props {
  viewer: SceneViewer | null
  /** The scene's stored site, if one has been set. */
  site: Site | null
  onSiteChange(site: Site): void
}

/** Pune — the market this product is built for, and an honest default. */
const DEFAULT_SITE: Site = { latitude: 18.5204, longitude: 73.8567 }

/**
 * The sun study: where the shadows fall, at this site, at that time.
 *
 * ── The one assumption, stated where the user can see it ────────────────────
 * Plans drawn in the studio carry no compass, so the study assumes the TOP OF
 * THE PLAN IS NORTH — the convention of nearly every drawing ever issued. The
 * panel says so in its own hint, because a rotated site makes every shadow
 * here confidently wrong, and the user is the only one who knows.
 *
 * ── Solar time, not clock time ──────────────────────────────────────────────
 * The slider is solar time at the site: 12:00 is the sun at its highest. Civil
 * clocks disagree with the sun by whatever politics decided — about 21 minutes
 * at Pune — and a slider that says 12:00 while the sun leans visibly off
 * vertical files itself as a bug.
 */
export default function SunPanel({ viewer, site, onSiteChange }: Props) {
  const [enabled, setEnabled] = useState(false)
  const [latitude, setLatitude] = useState(site?.latitude ?? DEFAULT_SITE.latitude)
  const [longitude, setLongitude] = useState(site?.longitude ?? DEFAULT_SITE.longitude)
  // Month and day only — a shadow study cares about the season, and a year
  // selector implies the answer changes year to year, which it does not.
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [day, setDay] = useState(new Date().getDate())
  const [hours, setHours] = useState(12)

  // The stored site arrives after mount, with the scene.
  useEffect(() => {
    if (site) {
      setLatitude(site.latitude)
      setLongitude(site.longitude)
    }
  }, [site])

  const position = solarPosition(
    siteLocalToUtc(new Date().getFullYear(), month, day, hours, longitude),
    latitude,
    longitude,
  )

  useEffect(() => {
    if (!viewer) return
    if (!enabled) {
      // Back to the default rig's sun, expressed through the same call so
      // there is one code path. Direction ~(6,9,4) normalised — what
      // addDefaultRig sets, near enough that nobody can tell the study ran.
      viewer.setSunDirection({ x: 0.51, y: 0.77, z: 0.34 })
      return
    }
    viewer.setSunDirection(sunDirection(position))
  }, [viewer, enabled, position.elevation, position.azimuth])

  const commitSite = () => onSiteChange({ latitude, longitude })

  return (
    <section>
      <span className="eyebrow">Sun study</span>
      <p className="note">
        Real shadows for a date and time. Assumes the top of your plan faces
        north; times are solar time at the site.
      </p>

      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          style={{ width: 'auto' }}
        />
        <span style={{ fontSize: 12.5 }}>Drive the sun from the site</span>
      </label>

      {enabled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
            <label style={{ fontSize: 11.5 }}>
              Latitude
              <input
                type="number"
                step="0.0001"
                value={latitude}
                onChange={(e) => setLatitude(Number(e.target.value))}
                onBlur={commitSite}
              />
            </label>
            <label style={{ fontSize: 11.5 }}>
              Longitude
              <input
                type="number"
                step="0.0001"
                value={longitude}
                onChange={(e) => setLongitude(Number(e.target.value))}
                onBlur={commitSite}
              />
            </label>
            <label style={{ fontSize: 11.5 }}>
              Month
              <input
                type="number"
                min={1}
                max={12}
                value={month}
                onChange={(e) => setMonth(Math.min(12, Math.max(1, Number(e.target.value))))}
              />
            </label>
            <label style={{ fontSize: 11.5 }}>
              Day
              <input
                type="number"
                min={1}
                max={31}
                value={day}
                onChange={(e) => setDay(Math.min(31, Math.max(1, Number(e.target.value))))}
              />
            </label>
          </div>

          <label style={{ display: 'block', fontSize: 11.5, marginTop: 8 }}>
            Time <span className="mono">{String(Math.floor(hours)).padStart(2, '0')}:{String(Math.round((hours % 1) * 60)).padStart(2, '0')}</span>
            <input
              type="range"
              min={5}
              max={21}
              step={0.25}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>

          <p className="note" style={{ marginTop: 4 }}>
            {position.elevation > 0
              ? `Sun ${position.elevation.toFixed(0)}° up, bearing ${position.azimuth.toFixed(0)}°.`
              : 'The sun is below the horizon — night.'}
          </p>
        </>
      )}
    </section>
  )
}
