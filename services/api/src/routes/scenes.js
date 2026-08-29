import { db, nanoid } from '../store.js'
import { requireAuth, hashPassword, verifyPassword } from '../lib/auth.js'
import { spend } from '../lib/credits.js'
import { isEnvAsset, keyOfOwnUpload, open } from '../lib/storage.js'
import {
  PUBLIC_ASSET_FIELDS,
  protectedAssetUrl,
  verifyProtectedAsset,
} from '../lib/publicAssetAccess.js'

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
      panoramaUrl: null,
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
    // Through `summarise`, like every other scene response. Returning the raw
    // record leaked `ownerId` and, once access codes existed, the scrypt hash
    // as well — to the owner, which sounds harmless until you consider that it
    // lands in devtools, in any log that captures a response, and in whatever
    // the client persists.
    return { scene: summarise(scene) }
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
    // `bakedUrl` is the lightmap atlas produced by a bake. It belongs on the
    // scene rather than only on the render job: a published walkthrough has no
    // access to job records, and the atlas *is* the lighting — without it the
    // client sees the same flat, sourceless room the bake exists to fix.
    const allowed = [
      'name',
      'modelUrl',
      // The CAD reconstruction behind a furnished import, preserved
      // separately because the bake flow OVERWRITES modelUrl with the
      // combined export — without this field, baking a furnished
      // reconstruction would destroy the only reference to the building.
      'cadModelUrl',
      // The measured rooms and classified fixtures behind the reconstruction.
      // Render-derived furniture needs these polygons after reload; the GLB
      // alone carries shapes and names, not the source room record.
      'cadModelJsonUrl',
      'lightsUrl',
      'hdriUrl',
      'floorPlanUrl',
      // Designs read out of the deck's renders (DesignSpecs: floor, walls,
      // ceiling, furniture, style, measured colours). The studio re-applies
      // them on every
      // rebuild; the published page never reads it — the look reaches clients
      // inside the exported model. Null is meaningful: "the user cleared the
      // dressing", which stops the studio's read-on-open resurrecting it.
      // Absent from this list, the whole feature was unreachable — the studio
      // dressed the model on screen and this route refused the save.
      'design',
      // Room-design keys the user already accepted or discarded for furniture.
      // Without this, declining an inferred arrangement would make it return
      // on every reload until the user gave in.
      'designFurnitureReviewed',
      'bakedUrl',
      // The latest completed equirectangular render. Unlike an ordinary render
      // result, this is part of the presentation: Studio restores it after a
      // reload and published viewers can offer the same 360 experience.
      'panoramaUrl',
      'plan',
      // What turns a model into a presentation. All three are authored in the
      // studio and consumed by the published page, and none of them is worth a
      // separate endpoint — they are scene content, edited the same way the
      // plan is.
      'views',
      'hotspots',
      'branding',
      // Attribution for everything on the page, derived in the studio at
      // publish time.
      //
      // ── Why this is stored rather than computed here ────────────────────
      // The obligation is a property of what the *client* will see, and only
      // the studio knows that: which models were placed, which environment was
      // chosen, which surfaces the geometry actually bound. The API has a GLB
      // and a plan, neither of which names an author.
      //
      // Storing it also freezes it. A credit list recomputed later would drift
      // as the catalogue changed, and the page a client was shown in March is
      // the page whose credits have to be right.
      'credits',
      // Client options for the published page — which finishes a visitor may
      // switch between. Composed in the studio, which uploads every texture a
      // choice needs into this API's storage first, so the published page
      // never has to reach back into the studio's origin for a file.
      'options',
      // Where the building is, for the sun study. Latitude and longitude only
      // — no address, nothing a geocoder touched, just what solar geometry
      // needs.
      'site',
      // The declared super built-up area in square metres, entered by the
      // architect in the Presentation panel. Stored as given.
      'sbua',
    ]
    // ── Why this rejects instead of filtering ───────────────────────────────
    // This used to be `.filter(([k]) => allowed.includes(k))`. A caller sending
    // an unknown field — a typo, a renamed property, a field added to the client
    // before the server — got 200 OK and a response that looked like a
    // successful save, with that field silently gone. The next read returns the
    // old value, so the symptom is "my change did not stick", arbitrarily far
    // from the cause.
    //
    // It is the same failure this codebase has now hit in five other places in
    // one day, and the cheapest one to close: a write that is not performed must
    // not answer 200.
    //
    // Separating unknown from read-only is most of the value. "hdriUrl2 is not a
    // field" and "protected is real but is set elsewhere" send a developer to
    // completely different places, and a single "invalid field" message sends
    // them to the wrong one half the time.
    const readOnly = {
      id: 'assigned when the scene is created',
      ownerId: 'assigned from your session',
      organisationId: 'assigned from your session',
      createdAt: 'assigned when the scene is created',
      updatedAt: 'set by the server on every save',
      published: 'use POST /scenes/:id/publish or /unpublish',
      publishedSlug: 'set by publishing',
      protected: 'use the access-code endpoint; the code never leaves the server',
      comments: 'written by visitors through the public comment endpoint',
      accessCodeHash: 'never accepted from a client',
      floorCount: 'derived from the plan',
      hasPlan: 'derived from the plan',
    }

    const sent = Object.keys(request.body ?? {})
    const unknown = sent.filter((k) => !allowed.includes(k) && !(k in readOnly))
    const blocked = sent.filter((k) => k in readOnly)

    if (unknown.length || blocked.length) {
      const problems = [
        ...unknown.map((k) => `"${k}" is not a scene field`),
        ...blocked.map((k) => `"${k}" cannot be set here — ${readOnly[k]}`),
      ]
      return reply.status(400).send({
        message: `That save was refused so nothing is silently dropped: ${problems.join('; ')}.`,
        unknown,
        readOnly: blocked,
        writable: allowed,
      })
    }

    const patch = Object.fromEntries(
      Object.entries(request.body ?? {}).filter(([k]) => allowed.includes(k)),
    )

    // ── Defence in depth on the one field that reaches a client verbatim ─────
    // `credits` is published unchanged to unauthenticated visitors and rendered
    // on the walkthrough page. The page now builds it with textContent so a
    // hostile value is inert there — but a value that cannot be stored cannot
    // be served to a page that later regresses, so the fields are coerced to
    // plain strings and length-capped here too. Not a schema, just a floor:
    // anything that is not an object with string-ish fields is dropped rather
    // than trusted.
    if ('credits' in patch) {
      patch.credits = normaliseCredits(patch.credits)
    }

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

    // A slug nobody ELSE holds — same rule, and same reasoning, as
    // publications.js. This used to be `slugify(scene.name)` with no check at
    // all, and `/public/:slug` resolves by first match in the collection: two
    // users who both named a scene "Living Room" shared `/view/living-room/`,
    // and whichever published FIRST owned it. The second user was handed that
    // URL as their own, printed it, and their client opened somebody else's
    // project. A republish keeps the slug it already has, because the link may
    // already be on paper.
    const slug = scene.publishedSlug ?? (await uniqueSceneSlug(scene.name, scene.id))
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
  // ---- Access code --------------------------------------------------------
  // Set or clear the code that gates a published link. A pre-launch unit is
  // commercially sensitive, and "the URL is unguessable" is not an answer a
  // developer accepts for something they have not announced yet.
  app.post('/:id/access-code', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return

    const code = request.body?.code

    // An empty code removes the gate. Explicit, because "publish it open" is a
    // decision worth being able to make deliberately.
    if (!code) {
      await db.update('scenes', scene.id, { accessCodeHash: null })
      return { protected: false }
    }

    if (String(code).length < 4) {
      return reply.status(400).send({ message: 'Use at least four characters.' })
    }

    // Hashed with the same scrypt used for account passwords. A scene code is
    // lower-stakes than a password, but people reuse them, and storing one in
    // plain text makes a database leak worse than it needs to be.
    await db.update('scenes', scene.id, { accessCodeHash: await hashPassword(String(code)) })
    return { protected: true }
  })

  // No auth: this is what a client following a shared link hits. Only published
  // scenes resolve, and only the fields a viewer needs are returned.
  app.get('/public/:slug', async (request, reply) => {
    const scene = await db.findOne(
      'scenes',
      (s) => s.publishedSlug === request.params.slug && s.published,
    )
    if (!scene) return reply.status(404).send({ message: 'Walkthrough not found.' })

    // A protected scene gives up its name and nothing else.
    //
    // The name is deliberate: a visitor needs to know they are at the right
    // place before being asked for a code. Everything that would let them
    // render it — the model, the atlas, the views — is withheld, because
    // returning the URLs and hiding the page would be theatre.
    if (scene.accessCodeHash) {
      return { scene: { name: scene.name, protected: true } }
    }

    return { scene: publicPayload(scene) }
  })

  /**
   * Exchange a code for the scene.
   *
   * ── What this does and does not protect ─────────────────────────────────
   * It gates the *manifest*. The model and atlas behind it are content-
   * addressed and served without auth, exactly like a presigned CDN URL, so
   * anyone who has already been given those URLs keeps them.
   *
   * That is the same model the reference product uses and it is worth being
   * plain about: this makes a link shareable-but-gated, not encrypted. It stops
   * a forwarded link being opened by whoever received it, which is the actual
   * request. It would not stop someone who had already loaded the scene.
   */
  /**
   * A visitor leaves a note on a published walkthrough.
   *
   * ── Feedback to the author, not a message board ─────────────────────────
   * Comments are never served back to visitors: the published page is a sales
   * document, and one buyer's "can this wall move?" is not another buyer's
   * business. They surface in the studio, to the owner, and nowhere else —
   * which is also what keeps this endpoint safe to leave unauthenticated:
   * nothing a visitor writes is ever rendered to anyone but the owner, whose
   * studio escapes it as text.
   *
   * ── Refused, not truncated ──────────────────────────────────────────────
   * The leads route silently trims long messages, which is fine for a contact
   * form. A truncated COMPLAINT is worse than none — the author reads half a
   * concern and answers the wrong thing — so an over-long comment is refused
   * with the limit stated.
   */
  app.post('/public/:slug/comments', async (request, reply) => {
    const slug = request.params.slug
    const scene = await db.findOne('scenes', (s) => s.publishedSlug === slug && s.published)
    if (!scene) {
      return reply.status(404).send({ message: 'No published walkthrough at this address.' })
    }

    if (commentThrottled(slug, request.ip)) {
      return reply.status(429).send({
        message: 'That is enough notes for now — give the architect a moment to read them.',
      })
    }

    const message = String(request.body?.message ?? '').trim()
    if (!message) return reply.status(400).send({ message: 'Write the note first.' })
    if (message.length > COMMENT_MAX_LENGTH) {
      return reply.status(400).send({
        message: `That note is ${message.length} characters. The limit is ${COMMENT_MAX_LENGTH} — a truncated note would say the wrong thing, so it is refused whole.`,
      })
    }

    const comments = scene.comments ?? []
    if (comments.length >= COMMENTS_PER_SCENE) {
      // A cap because comments live inside the scene record: an unbounded
      // array in db.json is a slow-motion outage. Said honestly to the
      // visitor rather than dropped.
      return reply.status(409).send({
        message: 'This walkthrough has reached its comment limit. Contact the developer directly.',
      })
    }

    const comment = {
      id: nanoid(10),
      name: String(request.body?.name ?? '').trim().slice(0, 80) || null,
      message,
      /** Which named view the visitor was looking at, if any. Display text only. */
      view: String(request.body?.view ?? '').trim().slice(0, 120) || null,
      at: new Date().toISOString(),
    }

    recordComment(slug, request.ip)
    await db.update('scenes', scene.id, { comments: [...comments, comment] })
    return reply.status(201).send({ received: true })
  })

  /** The owner reads what visitors left. Newest first — the new note is why they came. */
  app.get('/:id/comments', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    return { comments: [...(scene.comments ?? [])].reverse() }
  })

  app.delete('/:id/comments/:commentId', { preHandler: requireAuth }, async (request, reply) => {
    const scene = await owned(request, reply)
    if (!scene) return
    const comments = scene.comments ?? []
    const remaining = comments.filter((c) => c.id !== request.params.commentId)
    if (remaining.length === comments.length) {
      return reply.status(404).send({ message: 'No such comment.' })
    }
    await db.update('scenes', scene.id, { comments: remaining })
    return reply.status(204).send()
  })

  app.post('/public/:slug/unlock', async (request, reply) => {
    const slug = request.params.slug

    if (throttled(slug)) {
      return reply
        .status(429)
        .send({ message: 'Too many attempts. Try again in a few minutes.' })
    }

    const scene = await db.findOne(
      'scenes',
      (s) => s.publishedSlug === slug && s.published,
    )
    if (!scene) return reply.status(404).send({ message: 'Walkthrough not found.' })

    // No code set: nothing to unlock, and answering "wrong code" would be a
    // lie that sends someone hunting for a code that does not exist.
    if (!scene.accessCodeHash) return { scene: publicPayload(scene) }

    const ok = await verifyPassword(String(request.body?.code ?? ''), scene.accessCodeHash)
    if (!ok) {
      recordFailure(slug)
      return reply.status(401).send({ message: 'That code did not work.' })
    }

    attempts.delete(slug)
    return { scene: publicPayload(scene, { protectAssets: true }) }
  })

  app.get('/public/:slug/assets/:field', async (request, reply) => {
    const scene = await db.findOne(
      'scenes',
      (item) => item.publishedSlug === request.params.slug && item.published,
    )
    const field = request.params.field
    if (
      !scene
      || !verifyProtectedAsset(
        scene,
        field,
        request.query?.expires,
        request.query?.sig,
      )
    ) {
      return reply.status(404).send({ message: 'Protected asset not found.' })
    }
    const key = keyOfOwnUpload(scene[field])
    if (!key) return reply.status(404).send({ message: 'Protected asset not found.' })
    const object = await open(key)
    if (!object) return reply.status(404).send({ message: 'Protected asset not found.' })

    reply.header('Content-Type', object.contentType)
    if (object.size) reply.header('Content-Length', String(object.size))
    reply.header('Cache-Control', 'private, no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    return reply.send(object.stream)
  })

}

/**
 * Failed unlock attempts, per slug.
 *
 * A four-digit access code is guessable in ten thousand tries, which is nothing
 * over HTTP. Throttling is what makes a short, sayable-over-the-phone code
 * viable at all — without it the code length would have to grow to the point
 * where nobody would use the feature.
 *
 * In memory, so it resets on deploy and is per-process. That is a real
 * limitation and the right trade at this size: the alternative is a shared
 * store for something that only has to make bulk guessing tedious.
 */
const attempts = new Map()

const ATTEMPT_LIMIT = 8
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000

const COMMENT_MAX_LENGTH = 2000
const COMMENTS_PER_SCENE = 500
const COMMENT_LIMIT = 5
const COMMENT_WINDOW_MS = 10 * 60 * 1000

/**
 * Per visitor per walkthrough, same shape as the gate's attempt throttle.
 * Five notes in ten minutes is a person; fifty is a script.
 */
const commentRates = new Map()

function commentThrottled(slug, ip) {
  const key = `${slug}|${ip}`
  const record = commentRates.get(key)
  if (!record) return false
  if (Date.now() > record.until) {
    commentRates.delete(key)
    return false
  }
  return record.count >= COMMENT_LIMIT
}

function recordComment(slug, ip) {
  const key = `${slug}|${ip}`
  const record = commentRates.get(key) ?? { count: 0, until: Date.now() + COMMENT_WINDOW_MS }
  record.count += 1
  commentRates.set(key, record)
}

function throttled(slug) {
  const record = attempts.get(slug)
  if (!record) return false
  if (Date.now() > record.until) {
    attempts.delete(slug)
    return false
  }
  return record.count >= ATTEMPT_LIMIT
}

function recordFailure(slug) {
  const record = attempts.get(slug) ?? { count: 0, until: Date.now() + ATTEMPT_WINDOW_MS }
  record.count += 1
  attempts.set(slug, record)
}

/**
 * What a client is given for a published scene.
 *
 * Everything needed to render, and nothing else — no owner, no plan, no
 * internal ids.
 */
function publicPayload(scene, { protectAssets = false } = {}) {
  const result = {
    name: scene.name,
    modelUrl: scene.modelUrl,
    lightsUrl: scene.lightsUrl,
    hdriUrl: scene.hdriUrl,
    // The whole point of publishing. A scene with a bake renders with real
    // light; one without falls back to the real-time rig, which is worse but
    // still a walkthrough — so this is optional rather than required.
    bakedUrl: scene.bakedUrl ?? null,
    panoramaUrl: scene.panoramaUrl ?? null,
    // Empty arrays rather than null: the page iterates these, and a null would
    // make every consumer write the same guard.
    views: scene.views ?? [],
    hotspots: scene.hotspots ?? [],
    branding: scene.branding ?? null,
    // Credits travel with the scene because the obligation does. A CC-BY
    // model's licence is met by the page the client opens, not by anything in
    // the editor.
    credits: scene.credits ?? [],
    // Null rather than absent, matching hdriUrl: the page checks one field.
    options: scene.options ?? null,
  }
  if (!protectAssets) return result

  for (const field of PUBLIC_ASSET_FIELDS) {
    const source = result[field]
    if (!source) continue
    if (keyOfOwnUpload(source)) result[field] = protectedAssetUrl(scene, field)
    else if (!isEnvAsset(source)) result[field] = null
  }
  return result
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

/**
 * A scene as its owner may see it.
 *
 * `accessCodeHash` is replaced by a boolean rather than passed through. A hash
 * is not a secret the way a password is, but it has no business leaving the
 * server: it appears in browser devtools, in any log that captures a response,
 * and in whatever a client persists — and offline cracking of a four-character
 * code is trivial. The editor only needs to know whether a code is set, which
 * is exactly what it gets.
 *
 * Written as a deny-list of two fields on purpose. An allow-list would be safer
 * still, but scenes gain fields often, and one that silently stops being
 * returned is a bug that looks like data loss.
 */
function summarise(scene) {
  const { ownerId, accessCodeHash, ...rest } = scene
  return { ...rest, protected: Boolean(accessCodeHash) }
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

/**
 * Coerce a credits list to plain, bounded strings.
 *
 * Attribution is three text fields per model — author, source, licence. This
 * keeps exactly those, as strings, capped at a length no real credit reaches.
 * Nothing here makes the value safe to put in innerHTML — the page must still
 * treat it as text — but it stops a script string being stored at all, which
 * is the whole point of a second line.
 */
function normaliseCredits(value) {
  if (!Array.isArray(value)) return []
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, 300)
  return value
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ author: str(c.author), source: str(c.source), licence: str(c.licence) }))
    .slice(0, 200)
}

/**
 * A published slug no OTHER scene holds. Mirrors publications.js exactly,
 * because it is the same promise: a published URL outlives the record — it
 * goes in emails and on printed material — so two scenes with the same name
 * must not race for the same address and resolve by whoever published first.
 *
 * `|| 'scene'` matters on its own: a name that is all punctuation slugifies
 * to the empty string, and an empty publishedSlug is the URL `/view//` — a
 * link that never worked, handed out as if it did.
 */
async function uniqueSceneSlug(name, selfId) {
  const taken = new Set(
    (await db.find('scenes', (s) => s.id !== selfId)).map((s) => s.publishedSlug).filter(Boolean),
  )
  const root = slugify(name) || 'scene'
  if (!taken.has(root)) return root

  for (let n = 2; n < 500; n++) {
    const candidate = `${root}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${root}-${nanoid(6).toLowerCase()}`
}
