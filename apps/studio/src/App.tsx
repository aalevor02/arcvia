import { useEffect, useState } from 'react'
import Dashboard from './screens/Dashboard'
import PlanEditor from './screens/PlanEditor'
import Publisher from './screens/Publisher'
import { getToken, getUser, redeemHandoff } from './lib/api'

/**
 * Router.
 *
 * Hand-rolled rather than pulling in a routing library, because the studio has
 * exactly two routes and no nesting, no loaders and no layouts to coordinate.
 * A router dependency would add more API surface than the thing it routes.
 *
 * State lives in the URL (`?scene=<id>`) rather than in component state so that
 * reload, back, and a shared link all land in the same place. An editor whose
 * open project vanishes on refresh is the sort of thing people only forgive
 * once.
 */

type Route =
  | { screen: 'dashboard' }
  | { screen: 'editor'; sceneId: string; start?: string }
  | { screen: 'publisher' }

/**
 * In-flight hand-off redemptions, keyed by ticket.
 *
 * Module scope on purpose: it has to outlive a component remount, which is
 * exactly the case StrictMode creates.
 */
const pending: Record<string, Promise<boolean>> = {}

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search)
  if (params.get('publish') !== null) return { screen: 'publisher' }
  const sceneId = params.get('scene')
  if (!sceneId) return { screen: 'dashboard' }
  return { screen: 'editor', sceneId, start: params.get('start') ?? undefined }
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)

  /**
   * Arriving from the site with a hand-off ticket.
   *
   * `null` while a ticket is being redeemed, so the signed-out screen does not
   * flash up in the half-second before the session exists — which would be the
   * first thing a user sees after clicking "Open the studio", and would look
   * exactly like the sign-in having failed.
   */
  const [redeeming, setRedeeming] = useState(() =>
    new URLSearchParams(window.location.search).has('ticket'),
  )

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ticket = params.get('ticket')
    if (!ticket) return

    // The ticket is single-use, and StrictMode invokes this effect twice in
    // development. Without a guard the second call spends a ticket that is
    // already gone, gets a 400, and — because the two requests race — the
    // failing one can resolve first and render the signed-out screen over a
    // session that was in fact established. Deduplicating by ticket value
    // fixes both the wasted request and the flash.
    const inFlight = (pending[ticket] ??= redeemHandoff(ticket))

    void inFlight.finally(() => {
      // Strip the ticket from the URL either way. It is single-use, so leaving
      // it in the address bar means any refresh or shared link carries a dead
      // credential — and puts it in browser history for no reason.
      params.delete('ticket')
      const query = params.toString()
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (query ? `?${query}` : ''),
      )
      setRedeeming(false)
    })
  }, [])

  // The back button must work. Without this the URL changes and the view does
  // not, which is worse than having no history at all.
  useEffect(() => {
    const onPop = () => setRoute(readRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (next: Route) => {
    let url = window.location.pathname
    if (next.screen === 'editor') {
      const params = new URLSearchParams({ scene: next.sceneId })
      if (next.start) params.set('start', next.start)
      url += `?${params}`
    } else if (next.screen === 'publisher') {
      url += '?publish'
    }
    window.history.pushState(null, '', url)
    setRoute(next)
  }

  // Auth is checked here rather than per screen: every route below needs a
  // session, and the marketing site owns sign-in, so there is nothing to render
  // for a signed-out visitor except a way back to it.
  if (redeeming) {
    return (
      <div className="backdrop" style={{ position: 'static', height: '100%' }}>
        <div className="modal" style={{ textAlign: 'center' }}>
          <p className="muted">Signing you in…</p>
        </div>
      </div>
    )
  }

  if (!getToken() || !getUser()) return <SignedOut />

  if (route.screen === 'editor') {
    return (
      <PlanEditor
        sceneId={route.sceneId}
        start={route.start}
        onBack={() => navigate({ screen: 'dashboard' })}
      />
    )
  }

  return route.screen === 'publisher' ? (
    <div className="dashboard">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          Arcvia Studio
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {getUser()?.email}
        </span>
      </header>
      <Publisher onBack={() => navigate({ screen: 'dashboard' })} />
    </div>
  ) : (
    <div className="dashboard">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          Arcvia Studio
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {getUser()?.email}
        </span>
      </header>
      <Dashboard
        onOpen={(sceneId, start) => navigate({ screen: 'editor', sceneId, start })}
        onPublish={() => navigate({ screen: 'publisher' })}
      />
    </div>
  )
}

function SignedOut() {
  /**
   * The studio has no login form of its own, on purpose: one sign-in flow,
   * owned by the site, is one place for password reset, OTP and rate limiting
   * to live.
   *
   * Nothing needs to be passed back. The site's login already lands on its
   * `/handoff/` page, which mints a one-time ticket and forwards it here — so
   * the round trip ends where it started, signed in.
   */
  const site = `${window.location.protocol}//${window.location.hostname}:4321`

  return (
    <div className="backdrop" style={{ position: 'static', height: '100%' }}>
      <div className="modal" style={{ textAlign: 'center' }}>
        <span className="brand-mark" style={{ margin: '0 auto 14px' }} aria-hidden="true">
          A
        </span>
        <h2>Sign in to start designing</h2>
        <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          The studio uses the same account as the main site.
        </p>
        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <a className="btn btn-primary" href={`${site}/login/`}>
            Sign in
          </a>
          <a className="btn" href={`${site}/register/`}>
            Create an account
          </a>
        </div>
      </div>
    </div>
  )
}
