import { db } from '../store.js'

/**
 * Inbound leads from the contact and demo forms.
 *
 * Stored locally first, then optionally forwarded to a CRM. That order matters:
 * if the CRM is down or the token has expired, the enquiry is still captured
 * rather than lost. The reference implementation fired at the CRM directly from
 * the browser and swallowed the error — every failure was a lost customer that
 * nobody ever knew about.
 */

export async function registerLeadRoutes(app) {
  app.post('/leads', async (request, reply) => {
    const { name, email, organisation, message, source } = request.body ?? {}

    if (!String(name ?? '').trim()) {
      return reply.status(400).send({ message: 'Enter your name.' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? ''))) {
      return reply.status(400).send({ message: 'Enter a valid email address.' })
    }

    const lead = await db.insert('leads', {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      organisation: String(organisation ?? '').trim() || null,
      message: String(message ?? '').trim().slice(0, 4000) || null,
      source: String(source ?? 'website'),
      forwarded: false,
    })

    if (process.env.CRM_WEBHOOK_URL) {
      // Fire-and-forget: the visitor should not wait on a third party, and a
      // CRM outage must not turn into a form error.
      void forwardToCrm(lead).catch((err) =>
        request.log.error({ err, leadId: lead.id }, 'CRM forward failed'),
      )
    }

    return reply.status(201).send({ received: true })
  })
}

async function forwardToCrm(lead) {
  const response = await fetch(process.env.CRM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.CRM_TOKEN
        ? { Authorization: `Bearer ${process.env.CRM_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      Last_Name: lead.name,
      Email: lead.email,
      Company: lead.organisation,
      Description: lead.message,
      Lead_Source: lead.source,
    }),
  })

  if (!response.ok) throw new Error(`CRM returned ${response.status}`)
  await db.update('leads', lead.id, { forwarded: true })
}
