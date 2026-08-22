/**
 * Types for the plan and credit model.
 *
 * Same arrangement as `brand.config.d.mts`, for the same reason: the config
 * stays plain `.mjs` so the Tailwind config, the Astro site and any build
 * script can import it with no compile step, and this file gives the
 * TypeScript consumers the shape without changing how the source is authored.
 *
 * ── Why `plans` is a record and not the literal ─────────────────────────────
 * Without this file the type was inferred from the object literal, so it had
 * exactly four known keys and nothing typed `string` could index it. Every
 * lookup by a plan id — which is what a plan id is FOR — was a type error:
 * `plans[user.planId]`, and even `plans[defaultPlanId]`, because
 * `defaultPlanId` is a string too.
 *
 * The value is `Plan | undefined` deliberately. An id arriving from the API is
 * an arbitrary string and may name a plan that no longer exists, so a lookup
 * genuinely can miss — and `planFor` is the function that already handles
 * that, falling back to the default. Typing the miss away would have hidden
 * the reason `planFor` exists.
 */

export interface PlanFeatures {
  walkthroughs: boolean
  configurator: boolean
  unlimitedProjects: boolean
  creditsCarryForward: boolean
  modellingTool: boolean
  floorplanDetect: boolean
  boq: boolean
  downloadableModel: boolean
  /** 'email', 'priority', and so on — a level, not a boolean. */
  support: string
}

export interface Plan {
  id: string
  label: string
  price: number
  currency: string
  /** `null` on a plan that is not billed on a cycle. */
  interval: string | null
  seats: number
  creditsPerSeat: number
  features: PlanFeatures
}

export declare const billingEnabled: boolean

/**
 * Keyed by plan id.
 *
 * The four tiers the config defines are named, so `plans.free` is a `Plan` and
 * the pricing page can read `.label` off it without a guard. Any OTHER key —
 * an id arriving from the API — is `Plan | undefined`, because that is the
 * truth: an account can carry an id for a plan that no longer exists, and
 * `planFor` is the function that already handles it.
 */
export interface Plans extends Record<string, Plan | undefined> {
  free: Plan
  studio: Plan
  practice: Plan
  enterprise: Plan
}

export declare const plans: Plans

export declare const defaultPlanId: string

/** Credits charged per metered action, keyed by action name. */
export declare const creditCost: Record<string, number>

/** What each metered action is called on the published price list. */
export declare const creditLabel: Record<string, string>

/** A label for an action, falling back to a humanised key. */
export declare function labelFor(action: string): string

export interface MeteredAction {
  action: string
  cost: number
  label: string
}

/**
 * Every priced action, cheapest first, for the published price list.
 *
 * Free actions are included, not filtered — see the note on the function
 * itself: a list that omits the free things makes the paid ones look like the
 * whole product.
 */
export declare const meteredActions: () => MeteredAction[]

/** 'Unmetered' above the threshold, otherwise a grouped number. */
export declare function formatCredits(plan: Plan): string

/**
 * The plan for an id, and always a plan.
 *
 * Returns the default when billing is off, when the id is unknown, and when it
 * is absent — which is why callers should reach for this rather than indexing
 * `plans` and writing their own fallback.
 */
export declare function planFor(id: string | null | undefined): Plan

declare const _default: {
  billingEnabled: typeof billingEnabled
  plans: typeof plans
  creditCost: typeof creditCost
  defaultPlanId: typeof defaultPlanId
  planFor: typeof planFor
  formatCredits: typeof formatCredits
}
export default _default
