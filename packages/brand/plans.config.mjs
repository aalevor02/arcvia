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
}

export const plans = {
  free: {
    id: 'free',
    label: 'Free',
    price: 0,
    currency: 'INR',
    interval: null,
    seats: 5,
    creditsPerSeat: 100,
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

export function planFor(id) {
  if (!billingEnabled) return plans[defaultPlanId]
  return plans[id] ?? plans[defaultPlanId]
}

export default { billingEnabled, plans, creditCost, defaultPlanId, planFor }
