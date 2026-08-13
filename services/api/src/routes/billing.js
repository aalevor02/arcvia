import { requireAuth } from '../lib/auth.js'
import { db } from '../store.js'
import plansConfig from '@arcvia/brand/plans'

const { billingEnabled, plans, planFor } = plansConfig

/**
 * Billing.
 *
 * BILLING IS CURRENTLY OFF (`billingEnabled === false` in packages/brand).
 * Every route here returns a clear 501 rather than a 404, so the frontend can
 * distinguish "this feature does not exist yet" from "you typed the URL wrong".
 *
 * The endpoints are stubbed rather than absent because the *shape* of the
 * integration is the part worth getting right early: create an order server
 * side, never trust an amount sent by the browser, and verify the provider's
 * signature before granting anything. Those rules are written down below so
 * that switching billing on later is filling in three functions, not designing
 * a payment flow under time pressure.
 */

export async function registerBillingRoutes(app) {
  // Always available — the UI needs to know what to render.
  app.get('/status', async () => ({
    billingEnabled,
    currentlyFree: !billingEnabled,
    message: billingEnabled
      ? null
      : 'All features are free while the product is in beta.',
  }))

  app.get('/plans', async () => ({
    billingEnabled,
    plans: Object.values(plans).map((p) => ({
      id: p.id,
      label: p.label,
      price: p.price,
      currency: p.currency,
      interval: p.interval,
      seats: p.seats === Infinity ? null : p.seats,
      creditsPerSeat: p.creditsPerSeat,
      features: p.features,
      // While billing is off, exactly one plan is real.
      available: billingEnabled ? true : p.id === 'free',
    })),
  }))

  app.get('/subscription', { preHandler: requireAuth }, async (request) => {
    const user = await db.findOne('users', (u) => u.id === request.auth.userId)
    const plan = planFor(user?.planId)
    return {
      planId: plan.id,
      planLabel: plan.label,
      credits: user?.credits ?? 0,
      creditsPerCycle: plan.creditsPerSeat,
      renewsAt: null, // no billing cycle while free
      billingEnabled,
    }
  })

  // ---- Dormant until billingEnabled ---------------------------------------

  app.post('/orders', { preHandler: requireAuth }, async (request, reply) => {
    if (!billingEnabled) {
      return reply.status(501).send({
        message: 'Payments are not enabled — the product is free right now.',
        code: 'BILLING_DISABLED',
      })
    }

    // When you switch this on:
    //
    //   1. Look the price up from `plans` on the server. Never read an amount
    //      from the request body — that is the single most common way payment
    //      integrations get exploited.
    //   2. Create the order with your provider and return only the order id and
    //      public key to the browser.
    //   3. Record the pending order locally so a webhook can reconcile it even
    //      if the user closes the tab mid-payment.
    return reply.status(501).send({ message: 'Not implemented.' })
  })

  app.post('/verify', { preHandler: requireAuth }, async (request, reply) => {
    if (!billingEnabled) {
      return reply.status(501).send({
        message: 'Payments are not enabled — the product is free right now.',
        code: 'BILLING_DISABLED',
      })
    }

    // When you switch this on:
    //
    //   1. Verify the provider's HMAC signature over (order_id, payment_id)
    //      using your *secret* key, server side. A client claiming "payment
    //      succeeded" means nothing on its own.
    //   2. Only after the signature checks out, upgrade the plan and grant
    //      credits.
    //   3. Make it idempotent — a retried webhook must not grant twice.
    return reply.status(501).send({ message: 'Not implemented.' })
  })
}
