import type { SceneView } from '@arcvia/viewer'

/**
 * What turns a model into a presentation.
 *
 * ── Why these three and not more ────────────────────────────────────────────
 * A client opening a walkthrough does not explore. They look at the two or
 * three things they care about, and they want to be told what they are looking
 * at. Free roam alone reads as a tech demo; the same model with named views and
 * a few labelled points reads as a presentation someone prepared for them.
 *
 * So: somewhere to go, something to read when you get there, and whose name is
 * on it. Everything else is decoration.
 */

/** A named camera position a visitor can jump to. */
export type { SceneView }

/**
 * A labelled point in the model.
 *
 * Position is in world metres, not screen space, because the marker has to stay
 * on the thing it labels as the camera moves — screen coordinates would pin it
 * to the glass. Projection to the screen happens per frame in the viewer.
 */
export interface Hotspot {
  id: string
  title: string
  /** Optional detail, shown when the marker is opened. */
  body?: string
  /** World position, metres: [x, y, z] in Three.js axes. */
  position: [number, number, number]
  /** Optional outbound link — a spec sheet, a product page. */
  link?: string
}

/**
 * Per-scene presentation identity.
 *
 * Per *scene* rather than per organisation on purpose: an agency delivering to
 * three developers needs three different logos, and the unit of delivery is the
 * walkthrough, not the account.
 */
export interface Branding {
  /** Shown top-left instead of the scene name. Stored image URL. */
  logoUrl?: string
  /** Hex, used for the controls and hotspot markers. */
  accent?: string
  /**
   * Remove the "Made with Arcvia" credit.
   *
   * A paid white-label affordance rather than a free one — the flag lives here
   * so the viewer has a single thing to read, but whether an account may set it
   * is a billing decision, enforced server-side when that exists.
   */
  hideCredit?: boolean
}

export interface Presentation {
  views: SceneView[]
  hotspots: Hotspot[]
  branding: Branding | null
}

/** A stable id from a label, so hand-edited scene files stay readable. */
export function slugId(label: string, fallback: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}

/**
 * Add a view, replacing any with the same id.
 *
 * Replacing rather than rejecting: capturing "Kitchen" twice means the author
 * has re-framed it and wants the new one. Refusing the second would make them
 * delete the first, which is two steps to do the obvious thing.
 */
export function upsertView(views: SceneView[], view: SceneView): SceneView[] {
  const index = views.findIndex((v) => v.id === view.id)
  if (index === -1) return [...views, view]

  const next = [...views]
  next[index] = view
  return next
}

export function removeView(views: SceneView[], id: string): SceneView[] {
  return views.filter((view) => view.id !== id)
}

/**
 * Move a view up or down the list.
 *
 * The order is the order the buttons appear to a client, which is the order
 * they will look at the property in. That makes it a presentation decision
 * worth controlling, not an implementation detail of insertion order.
 */
export function reorderView(views: SceneView[], id: string, delta: number): SceneView[] {
  const from = views.findIndex((view) => view.id === id)
  if (from === -1) return views

  const to = from + delta
  if (to < 0 || to >= views.length) return views

  const next = [...views]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function upsertHotspot(hotspots: Hotspot[], hotspot: Hotspot): Hotspot[] {
  const index = hotspots.findIndex((h) => h.id === hotspot.id)
  if (index === -1) return [...hotspots, hotspot]

  const next = [...hotspots]
  next[index] = hotspot
  return next
}

export function removeHotspot(hotspots: Hotspot[], id: string): Hotspot[] {
  return hotspots.filter((hotspot) => hotspot.id !== id)
}
