import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { grantMonthly } from '../lib/credits.js'
import plansConfig from '@arcvia/brand/plans'

const { planFor } = plansConfig

/** Free-mail domains. A team invite to one of these is almost always a typo. */
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'live.com', 'msn.com', 'aol.com', 'protonmail.com', 'zoho.com',
  'mail.com', 'yandex.com', 'fastmail.com',
])

export async function registerOrgRoutes(app) {
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const org = await db.findOne('organisations', (o) => o.id === request.auth.orgId)
    if (!org) return reply.status(404).send({ message: 'Organisation not found.' })

    const members = await db.find('users', (u) => u.organisationId === org.id)
    const plan = planFor(members.find((m) => m.id === org.ownerId)?.planId)

    return {
      organisation: {
        id: org.id,
        name: org.name,
        referralCode: org.referralCode,
        seatsUsed: members.length,
        seatLimit: plan.seats === Infinity ? null : plan.seats,
      },
      members: members.map((m) => ({
        uid: m.id,
        name: m.name,
        email: m.email,
        credits: m.credits ?? 0,
        isOwner: m.id === org.ownerId,
      })),
    }
  })

  app.post('/members', { preHandler: requireAuth }, async (request, reply) => {
    const org = await db.findOne('organisations', (o) => o.id === request.auth.orgId)
    if (!org) return reply.status(404).send({ message: 'Organisation not found.' })
    if (org.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'Only the account owner can invite members.' })
    }

    const email = String(request.body?.email ?? '').trim().toLowerCase()
    const name = String(request.body?.name ?? '').trim()

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ message: 'Enter a valid email address.' })
    }

    const members = await db.find('users', (u) => u.organisationId === org.id)
    const plan = planFor(members.find((m) => m.id === org.ownerId)?.planId)

    if (plan.seats !== Infinity && members.length >= plan.seats) {
      return reply.status(409).send({
        message: `Your plan includes ${plan.seats} seats and they are all in use.`,
        code: 'SEAT_LIMIT',
      })
    }

    if (await db.findOne('users', (u) => u.email === email)) {
      return reply.status(409).send({ message: 'That person already has an account.' })
    }

    // A warning, not a rejection — sole practitioners legitimately use Gmail,
    // and blocking them outright would be wrong. The client shows the hint.
    const domain = email.split('@')[1]
    const consumerDomain = CONSUMER_DOMAINS.has(domain)

    const member = await db.insert('users', {
      name: name || email.split('@')[0],
      email,
      phone: null,
      passwordHash: null, // set when they accept the invitation
      organisationId: org.id,
      planId: request.auth.planId,
      credits: 0,
      invited: true,
      invitedBy: request.auth.userId,
      phoneVerified: false,
      emailVerified: false,
    })

    await db.update('organisations', org.id, { seats: [...org.seats, member.id] })
    await grantMonthly(member.id)

    return reply.status(201).send({
      member: { uid: member.id, name: member.name, email: member.email },
      warning: consumerDomain
        ? 'That looks like a personal email address rather than a work one.'
        : null,
    })
  })

  app.delete('/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const org = await db.findOne('organisations', (o) => o.id === request.auth.orgId)
    if (!org) return reply.status(404).send({ message: 'Organisation not found.' })
    if (org.ownerId !== request.auth.userId) {
      return reply.status(403).send({ message: 'Only the account owner can remove members.' })
    }
    if (request.params.userId === org.ownerId) {
      return reply.status(409).send({ message: 'The account owner cannot be removed.' })
    }

    await db.remove('users', request.params.userId)
    await db.update('organisations', org.id, {
      seats: org.seats.filter((id) => id !== request.params.userId),
    })

    return reply.status(204).send()
  })
}
