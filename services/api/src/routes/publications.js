import { db, nanoid } from '../store.js'
import { requireAuth } from '../lib/auth.js'

/**
 * Publications — the site a client opens.
 *
 * ── What this is, and why it is not a scene ─────────────────────────────────
 * A scene is one building: a plan, a model, a walkthrough. What an architect
 * actually hands over is a *project* — a master plan with units on it, several
 * unit types each with their own floors and room schedules, a gallery, and the
 * copy that surrounds all of it. `apps/visualisation` is exactly that shape,
 * hand-authored for one client, and its own type file says why it is worth
 * generating:
 *
 *   "A second project is a second data file, not a second codebase — which is
 *    the whole reason the reference system could stand up a new client site in
 *    a day."
 *
 * This is the store for that data file.
 *
 * ── Why the whole payload is stored rather than assembled per request ───────
 * Two reasons, and the second is the one that matters.
 *
 * Assembling would mean re-deriving rooms, areas and schedules from each
 * scene's wall graph on every page view. That geometry lives in the studio
 * (`plan/rooms.ts`), in TypeScript, and re-implementing it here would put two
 * copies of the one calculation that must never disagree on either side of a
 * network boundary.
 *
 * And it would not be *frozen*. A published site is a document a client was
 * shown on a date. Re-deriving it later means the page changes when the
 * catalogue changes, the room-naming rules change, or someone edits the scene —
 * silently, after the fact, in a document somebody may have signed against. The
 * same argument the scenes route already makes about credits: the obligation
 * travels with the page, not with the editor.
 *
 * So the studio composes a complete `Project` and PATCHes it here. This route
 * owns ownership, slugs and publication state, and nothing else.
 */

/** Everything a client-facing page needs, and nothing about who owns it. */
function publicPayload(publication) {
  return publication.project ?? null
}

/**
 * Row shape for the dashboard list.
 *
 * Drops `project` specifically — it is the entire site, several hundred
 * kilobytes of copy, room schedules and unit polygons, and a list of ten
 * publications would download ten of them to draw a table of names.
 */
function listItem(publication) {
  const { ownerId, project, ...rest } = publication
  return {
    ...rest,
    /** Enough for a dashboard row to say how much is in there. */
    unitTypes: project?.villaTypes?.length ?? 0,
    hasProject: Boolean(project),
  }
}

function summarise(publication) {
  const { ownerId, ...rest } = publication
  return rest
}

async function owned(request, reply) {
  const publication = await db.findOne('publications', (p) => p.id === request.params.id)
  if (!publication || publication.ownerId !== request.auth.userId) {
    // 404 rather than 403, as elsewhere: a caller who does not own it should
    // not learn that it exists.
    reply.status(404).send({ message: 'Publication not found.' })
    return null
  }
  return publication
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * A slug nobody else is using.
 *
 * Published URLs are the one thing here that outlives the record — they go in
 * emails and on printed material — so two projects called "Villas" must not
 * race for `/p/villas` and win by whoever published second.
 */
async function uniqueSlug(base, selfId) {
  const taken = new Set(
    (await db.find('publications', (p) => p.id !== selfId)).map((p) => p.slug).filter(Boolean),
  )
  const root = slugify(base) || 'project'
  if (!taken.has(root)) return root

  for (let n = 2; n < 500; n++) {
    const candidate = `${root}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${root}-${nanoid(6).toLowerCase()}`
}

export async function registerPublicationRoutes(app) {
  // ---- Public: the page a client opens ------------------------------------
  //
  // Declared before the authenticated `/:id` route. Fastify matches static
  // segments before parameters, so the order is not load-bearing — but reading
  // it first makes the one unauthenticated route in this file impossible to
  // miss when reviewing what is exposed.
  app.get('/public/:slug', async (request, reply) => {
    const publication = await db.findOne(
      'publications',
      (p) => p.slug === request.params.slug && p.published,
    )
    if (!publication) {
      return reply.status(404).send({ message: 'No published project at this address.' })
    }
    if (!publication.project) {
      // Published but empty is a real state — someone published before
      // composing. Saying so beats a page that renders nothing and looks broken.
      return reply.status(409).send({ message: 'This project has not been composed yet.' })
    }
    return { project: publicPayload(publication) }
  })

  // ---- Authenticated -------------------------------------------------------

  app.get('/', { preHandler: requireAuth }, async (request) => {
    const mine = await db.find('publications', (p) => p.ownerId === request.auth.userId)
    return {
      publications: mine
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(listItem),
    }
  })

  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const name = String(request.body?.name ?? '').trim()
    if (!name) return reply.status(400).send({ message: 'A project needs a name.' })

    const now = new Date().toISOString()
    const publication = await db.insert('publications', {
      id: nanoid(),
      ownerId: request.auth.userId,
      name,
      slug: await uniqueSlug(name, null),
      published: false,
      publishedAt: null,
      project: null,
      createdAt: now,
      updatedAt: now,
    })

    return reply.status(201).send({ publication: listItem(publication) })
  })

  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const publication = await owned(request, reply)
    if (!publication) return
    return { publication: summarise(publication) }
  })

  app.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const publication = await owned(request, reply)
    if (!publication) return

    // ── Rejects unknown fields rather than filtering them ──────────────────
    // Same decision as the scenes route, for the same reason: a caller sending
    // a field this does not know about has a bug, and silently dropping it
    // means the studio believes it saved something it did not. That failure
    // shows up as "my copy keeps reverting" days later.
    const allowed = ['name', 'project']
    const patch = {}
    for (const [key, value] of Object.entries(request.body ?? {})) {
      if (!allowed.includes(key)) {
        return reply.status(400).send({
          message: `"${key}" is not a field of a publication. Allowed: ${allowed.join(', ')}.`,
        })
      }
      patch[key] = value
    }

    if ('name' in patch) {
      const name = String(patch.name ?? '').trim()
      if (!name) return reply.status(400).send({ message: 'A project needs a name.' })
      patch.name = name
    }

    const updated = await db.update('publications', publication.id, patch)
    return { publication: summarise(updated) }
  })

  app.post('/:id/publish', { preHandler: requireAuth }, async (request, reply) => {
    const publication = await owned(request, reply)
    if (!publication) return

    // Refused rather than allowed-and-empty. Publishing is the one action here
    // with consequences outside the account, and a live URL showing nothing is
    // worse than a button that explains itself.
    if (!publication.project) {
      return reply.status(409).send({
        message: 'Compose the project in the studio before publishing it.',
      })
    }

    const slug = publication.slug ?? (await uniqueSlug(publication.name, publication.id))
    const updated = await db.update('publications', publication.id, {
      published: true,
      publishedAt: new Date().toISOString(),
      slug,
    })

    return { publication: summarise(updated), url: `/p/${slug}/` }
  })

  app.post('/:id/unpublish', { preHandler: requireAuth }, async (request, reply) => {
    const publication = await owned(request, reply)
    if (!publication) return

    // The slug is kept. Unpublishing is usually temporary, and a link that
    // comes back at a different address is a link somebody has already sent.
    const updated = await db.update('publications', publication.id, {
      published: false,
    })
    return { publication: summarise(updated) }
  })

  app.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const publication = await owned(request, reply)
    if (!publication) return
    await db.remove('publications', publication.id)
    return reply.status(204).send()
  })
}
