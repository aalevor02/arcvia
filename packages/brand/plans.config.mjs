/**
 * Plan + credit model.
 *
 * BILLING IS OFF. `billingEnabled: false` means every account is provisioned
 * on the `free` plan with the limits below, no payment gate anywhere in the
 * product, and the pricing page renders as a "free while in beta" notice.
 *
 * The paid tiers are still defined because the *data model* has to be right
 * from day one — accounts carry a planId, credits are metered and decremented,
 * and usage is recorded. Switching to paid later is:
 *
 *   1. billingEnabled = true
 *   2. drop in the payment-provider keys
 *   3. deploy
 *
 * ...rather than retrofitting metering into a product that never had it, which
 * is the expensive way to do this.
 */

export const billingEnabled = false

/** Credit cost per metered action. The render costs dominate; see docs/costs.md. */
export const creditCost = {
  // Cheap: happens entirely in the browser, no server compute.
  sceneCreate: 0,
  sceneSave: 0,
  floorplanDetect: 1, // one GPU-less inference call

  // Expensive: each of these queues a Blender Cycles job on a GPU worker.
  previewRender: 1, // 240x240 thumbnail, samples: 4
  isometricRender: 3, // 1920x1080, samples: 32
  fullRender: 5, // full-res still, samples: 128
  lightmapBake: 25, // whole-scene bake — the single most expensive action

  // CAD reconstruction. Reading a drawing is free on purpose: a survey answers
  // the questions a human must settle before a solve is worth running (which
  // unit? which layers? which of the five plans on this sheet?), and charging
  // for those makes people guess instead of check.
  cadSurvey: 0,
  cadReconstruct: 3, // CPU-only, tens of seconds — priced like an isometric
}

/**
 * What each metered action is called on the published price list.
 *
 * ── Why this lives beside the prices ────────────────────────────────────────
 * `pricing.astro` used to name its own six rows. It read the COSTS from
 * `creditCost`, so no number could drift — but it chose which actions to show,
 * and that list fell behind. Measured: nine priced actions, six on the page.
 *
 * The one missing that matters is `cadReconstruct`, at 3 credits. A user was
 * charged for CAD reconstruction and could not find it on the price list at any
 * point before or after paying. That is not a drift of a number, it is a charge
 * with no published price, and it is exactly the conversation nobody wants to
 * have with a customer.
 *
 * So the page now enumerates THIS object rather than a hand-written list, and
 * `labelFor` falls back to a humanised key. An action added to `creditCost`
 * without a label here still appears on the price list, spelled awkwardly —
 * which is a far better failure than being charged for invisibly.
 */
export const creditLabel = {
  sceneCreate: 'Create a scene',
  sceneSave: 'Save a scene',
  floorplanDetect: 'Detect a floor plan',
  previewRender: 'Preview render (thumbnail)',
  isometricRender: 'Isometric render (1920×1080)',
  fullRender: 'Full-resolution still',
  lightmapBake: 'Full scene lightmap bake',
  cadSurvey: 'Read a CAD drawing (survey and layers)',
  cadReconstruct: 'Reconstruct a CAD drawing into 3D',
}

/** The label for an action, or a readable fallback so nothing is ever hidden. */
export function labelFor(action) {
  return (
    creditLabel[action] ??
    action.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
  )
}

/**
 * Every metered action, cheapest first, for the published price list.
 *
 * Free actions are kept rather than filtered. "Reading a drawing is free" is a
 * deliberate product decision — `creditCost` says so in its own comment, that
 * charging for a survey makes people guess instead of check — and a price list
 * that silently omits the free things makes the paid ones look like the whole
 * product.
 */
export const meteredActions = () =>
  Object.entries(creditCost)
    .map(([action, cost]) => ({ action, cost, label: labelFor(action) }))
    .sort((a, b) => a.cost - b.cost || a.label.localeCompare(b.label))

export const plans = {
  free: {
    id: 'free',
    label: 'Free',
    price: 0,
    currency: 'INR',
    interval: null,
    seats: 5,
    // Effectively unlimited while the product is free. At this level the credit
    // ledger is still recording every render — which is the point, because that
    // usage data is what tells you where to set real limits later — but nobody
    // will ever hit the ceiling in normal use.
    //
    // NOTE: this is no longer the thing protecting your GPU bill. The real
    // guard is now RENDER_DAILY_CAP in services/api/src/lib/renderQueue.js
    // (default 500 jobs/day across the whole install). Raise credits freely;
    // raise that one deliberately.
    creditsPerSeat: 100000,
    features: {
      walkthroughs: true,
      configurator: true,
      unlimitedProjects: true,
      creditsCarryForward: true,
      modellingTool: true,
      floorplanDetect: true,
      boq: true,
      downloadableModel: true,
      support: 'email',
    },
  },

  // ---- Defined but dormant while billingEnabled === false ------------------
  studio: {
    id: 'studio',
    label: 'Studio',
    price: 3499,
    currency: 'INR',
    interval: 'month',
    seats: 1,
    creditsPerSeat: 50,
    features: {
      walkthroughs: true,
      configurator: true,
      unlimitedProjects: true,
      creditsCarryForward: true,
      modellingTool: true,
      floorplanDetect: true,
      boq: false,
      downloadableModel: false,
      support: 'email',
    },
  },

  practice: {
    id: 'practice',
    label: 'Practice',
    price: 4999,
    currency: 'INR',
    interval: 'month',
    seats: Infinity,
    creditsPerSeat: 75,
    features: {
      walkthroughs: true,
      configurator: true,
      unlimitedProjects: true,
      creditsCarryForward: true,
      modellingTool: true,
      floorplanDetect: true,
      boq: true,
      downloadableModel: false,
      support: 'chat+email',
    },
  },

  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    price: null, // "talk to us"
    currency: 'INR',
    interval: 'month',
    seats: Infinity,
    creditsPerSeat: 150,
    features: {
      walkthroughs: true,
      configurator: true,
      unlimitedProjects: true,
      creditsCarryForward: true,
      modellingTool: true,
      floorplanDetect: true,
      boq: true,
      downloadableModel: true,
      support: 'chat+email+call',
    },
  },
}

/** The plan every new account lands on while billing is disabled. */
export const defaultPlanId = 'free'

/**
 * Above this, an allowance is not a number anyone is tracking — it is "no
 * practical limit", and printing the digits actively misleads.
 */
const UNMETERED_THRESHOLD = 100000

/**
 * How a plan's credit allowance is written on the site.
 *
 * Exists because the pricing page printed "1,00,000 render credits" in the plan
 * card while the comparison table three sections below said "Unmetered" for the
 * same plan. Both were reading the same field and formatting it differently,
 * and the page contradicted itself in public.
 *
 * One formatter, used by every surface that shows an allowance.
 */
export function formatCredits(plan) {
  return plan.creditsPerSeat >= UNMETERED_THRESHOLD
    ? 'Unmetered'
    : plan.creditsPerSeat.toLocaleString('en-IN')
}

export function planFor(id) {
  if (!billingEnabled) return plans[defaultPlanId]
  return plans[id] ?? plans[defaultPlanId]
}

export default { billingEnabled, plans, creditCost, defaultPlanId, planFor, formatCredits }
