import { db } from '../store.js'
import { requireAuth } from '../lib/auth.js'
import { spend } from '../lib/credits.js'

/**
 * Scenes — the projects a user builds in the studio.
 *
 * Large binary payloads (the .glb, the .hdr, floor-plan images) never pass
 * through this service. The client asks for a signed upload URL and writes to
 * object storage directly. Proxying a 200 MB model through an app server is how
 * you turn a cheap API into an expensive one.
 */

export async function registerSceneRoutes(app) {
  app.get('/', { preHandler: requireAuth }, async (request) => {
    const scenes = await db.find('scenes', (s) => s.ownerId === request.auth.userId)
    return {
      scenes: scenes.map(listItem).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }
  })

  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const name = String(request.body?.name ?? '').trim()
    if (!name) return reply.status(400).send({ message: 'Give the scene a name.' })

    // Names are unique per user so the studio's "open by name" never guesses.
    const clash = await db.findOne(
      'scenes',
      (s) => s.ownerId === request.auth.userId && s.name.toLowerCase() === name.toLowerCase(),
    )
    if (clash) {
      return reply.status(409).send({ message: 'You already have a scene with that name.' })
    }

    await spend(request.auth.userId, 'sceneCreate', { name })

    const scene = await db.insert('scenes', {
      name,
      ownerId: request.auth.userId,
      organisationId: request.auth.orgId,
      modelUrl: null,
      lightsUrl: null,
      hdriUrl: null,
      floorPlanUrl: null,
      plan: null,
      published: false,
      publishedSlug: null,
      updatedAt: new Date().toISOString(),
    })

    return reply.status(201).send({ scene: summarise(scene) })
  })

  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    return { scene }
  })

  app.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return

    // Allow-list the writable fields. Spreading req.body straight into the
    // record would let a caller rewrite ownerId and steal someone's scene.
    //
    // `plan` is the 2D floor-plan graph (see apps/studio/src/plan/types.ts).
    // It rides in the JSON body rather than going to object storage the way the
    // model and textures do, because it is small — a few hundred vertices, tens
    // of kilobytes — and it changes on every edit, so a presigned round-trip per
    // save would cost two requests to move less data than the request headers.
    // Revisit if plans ever carry raster underlays inline; they must not.
    const allowed = ['name', 'modelUrl', 'lightsUrl', 'hdriUrl', 'floorPlanUrl', 'plan']
    const patch = Object.fromEntries(
      Object.entries(request.body ?? {}).filter(([k]) => allowed.includes(k)),
    )
    patch.updatedAt = new Date().toISOString()

    await spend(request.auth.userId, 'sceneSave', { sceneId: scene.id })
    const updated = await db.update('scenes', scene.id, patch)
    return { scene: summarise(updated) }
  })

  app.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    await db.remove('scenes', scene.id)
    return reply.status(204).send()
  })

  // ---- Publish ------------------------------------------------------------
  app.post('/:id/publish', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    if (!scene.modelUrl) {
      return reply.status(409).send({ message: 'Save the scene before publishing.' })
    }

    const slug = scene.publishedSlug ?? slugify(scene.name)
    const updated = await db.update('scenes', scene.id, {
      published: true,
      publishedSlug: slug,
      publishedAt: new Date().toISOString(),
    })

    return { scene: summarise(updated), url: `/view/${slug}/` }
  })

  app.post('/:id/unpublish', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    const updated = await db.update('scenes', scene.id, { published: false })
    return { scene: summarise(updated) }
  })

  // ---- Public read --------------------------------------------------------
  // No auth: this is what a client following a shared link hits. Only published
  // scenes resolve, and only the fields a viewer needs are returned.
  app.get('/public/:slug', async (request, reply) => {
    const scene = await db.findOne(
      'scenes',
      (s) => s.publishedSlug === request.params.slug && s.published,
    )
    if (!scene) return reply.status(404).send({ message: 'Walkthrough not found.' })

    return {
      scene: {
        name: scene.name,
        modelUrl: scene.modelUrl,
        lightsUrl: scene.lightsUrl,
        hdriUrl: scene.hdriUrl,
      },
    }
  })
}

async function owned(request, reply) {
  const scene = await db.findOne('scenes', (s) => s.id === request.params.id)
  if (!scene) {
    reply.status(404).send({ message: 'Scene not found.' })
    return null
  }
  if (scene.ownerId !== request.auth.userId) {
    // 404 rather than 403: a caller who does not own a scene should not learn
    // that it exists.
    reply.status(404).send({ message: 'Scene not found.' })
    return null
  }
  return scene
}

function summarise(scene) {
  const { ownerId, ...rest } = scene
  return rest
}

/**
 * Row shape for the dashboard list.
 *
 * Drops `plan` specifically. The dashboard renders a name, a date and a
 * published badge — it has no use for the wall graph, and returning it means a
 * user with fifty projects downloads fifty floor plans to draw a table. The
 * editor fetches the full record by id when a project is actually opened.
 *
 * Kept as a separate function from `summarise` so the single-scene responses,
 * which *do* need the plan, cannot be trimmed by accident later.
 */
function listItem(scene) {
  const { plan, ...rest } = summarise(scene)
  return {
    ...rest,
    // Enough for the dashboard to show "3 floors" without shipping the graph.
    floorCount: Array.isArray(plan?.floors) ? plan.floors.length : 0,
    hasPlan: Boolean(plan),
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
