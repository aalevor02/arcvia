import { readFile } from 'node:fs/promises'
import { put } from './storage.js'

/**
 * Photoreal stills, by running a viewport capture through an image model.
 *
 * ── Why this belongs here and not in a separate product ─────────────────────
 * AI architectural renderers take a sketch or a viewport grab and return a
 * photograph. They are fast, cheap and genuinely good, and they have one
 * structural weakness: nothing underneath. Render the kitchen twice and you get
 * two different kitchens, because there is no model — only a picture each time.
 *
 * Arcvia has the thing they lack. Every view comes from one dimensionally
 * correct scene, so the geometry handed to the model is *the same geometry*
 * from every angle. Feeding viewport captures through an image model gives
 * photorealism with consistency, which neither a diffusion model nor a
 * real-time renderer manages alone.
 *
 * ── Why the capture is the input, not the plan ──────────────────────────────
 * The image already encodes the camera, the layout, the openings and the
 * furniture. Describing all that in a prompt would be lossy and would let the
 * model invent — which is the failure mode that makes AI renders unusable for
 * property work, because a flat with an invented window is not that flat.
 *
 * So this is strictly image-to-image, and the prompt's job is to say *keep
 * everything, change only the realism*.
 */

/**
 * What a style may change, and what it may never change.
 *
 * The invariant half is repeated into every prompt rather than left to each
 * style's author. A style that forgets to say "do not move the walls" produces
 * a beautiful render of a different property, and that is not a style bug, it
 * is a lawsuit.
 */
const PRESERVE =
  'Keep the exact same camera angle, room geometry, wall and window positions, ' +
  'and furniture layout. Do not add, remove, move or resize anything. ' +
  'Do not invent windows, doors, rooms or objects that are not present.'

/**
 * The styles a user can pick.
 *
 * Deliberately a short list of *lighting and finish* treatments rather than the
 * dozens of period styles these tools usually advertise. Changing a room's
 * period means changing its furniture, and this pipeline is explicitly
 * forbidden from changing furniture — offering "Victorian" would either be
 * ignored or would break the invariant above.
 */
export const AI_STYLES = {
  daylight: {
    name: 'Natural daylight',
    prompt:
      'Photorealistic architectural interior photograph. Natural daylight through ' +
      'the windows, soft global illumination, realistic material textures, subtle ' +
      'contact shadows, neutral colour grading, sharp focus, high dynamic range.',
  },
  evening: {
    name: 'Evening, lamps lit',
    prompt:
      'Photorealistic architectural interior photograph at dusk. Warm interior ' +
      'lighting from lamps, deep blue daylight through the windows, soft pools of ' +
      'warm light, realistic materials, cinematic but natural.',
  },
  bright: {
    name: 'Bright and airy',
    prompt:
      'Photorealistic estate-agency interior photograph. Bright, airy, evenly lit, ' +
      'clean white walls, light neutral tones, high key, crisp and inviting, the ' +
      'way a property is photographed for a listing.',
  },
  dusk: {
    name: 'Exterior at dusk',
    prompt:
      'Photorealistic architectural exterior photograph at dusk. Warm light glowing ' +
      'from the windows, deep blue sky, realistic materials and landscaping, ' +
      'professional property photography.',
  },
}

export const isStyle = (id) => Object.prototype.hasOwnProperty.call(AI_STYLES, id)

/**
 * Providers, behind one shape.
 *
 * Which model this runs against is a commercial decision that will change, so
 * it is one env var and one function rather than a choice baked through the
 * codebase. Every provider takes image bytes plus a prompt and returns image
 * bytes.
 */
const PROVIDER = process.env.AI_IMAGE_PROVIDER ?? 'gemini'
const API_KEY = process.env.AI_IMAGE_KEY ?? ''

/**
 * Google's image model, which is the same family as the tools this competes
 * with and is unusually good at leaving a structure alone when told to.
 */
async function gemini(imageBase64, mimeType, prompt) {
  const model = process.env.AI_IMAGE_MODEL ?? 'gemini-2.5-flash-image'
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')

    // 429 from this API is nearly always a project spend cap rather than rate
    // limiting, and the two need completely different responses from a user.
    if (response.status === 429 && detail.includes('spend')) {
      throw new Error(
        'The image provider has hit its spending cap. Raise it in the provider console.',
      )
    }
    throw new Error(`Image provider returned ${response.status}: ${detail.slice(0, 200)}`)
  }

  const body = await response.json()
  const parts = body.candidates?.[0]?.content?.parts ?? []
  const image = parts.find((part) => part.inline_data?.data ?? part.inlineData?.data)

  if (!image) {
    // A refusal comes back as text where the image should be, and saying so is
    // far more useful than "no image returned".
    const text = parts.find((part) => part.text)?.text
    throw new Error(text ? `The model declined: ${text.slice(0, 160)}` : 'No image was returned.')
  }

  return Buffer.from(image.inline_data?.data ?? image.inlineData.data, 'base64')
}

/**
 * BytePlus Ark (Seedream). The same OpenAI-ish `/images/generations` shape,
 * with two differences that matter.
 *
 * First, the source image goes in as a data URL rather than inline parts.
 * Measured 2026-08-27: a 2.53 MB data URL is accepted, which covers a normal
 * viewport capture, so nothing has to be downscaled on the way out.
 *
 * Second, Ark answers with a URL rather than bytes, and that URL is temporary.
 * Fetching it here rather than storing it is deliberate: a link that expires
 * would turn a client's published walkthrough into broken images weeks later,
 * long after anyone connects the two.
 */
async function byteplus(imageBase64, mimeType, prompt) {
  const base = process.env.AI_IMAGE_BASE_URL ?? 'https://ark.ap-southeast.bytepluses.com/api/v3'
  const model = process.env.AI_IMAGE_MODEL ?? 'seedream-4-0-250828'

  const response = await fetch(`${base.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      prompt,
      image: `data:${mimeType};base64,${imageBase64}`,
      size: process.env.AI_IMAGE_SIZE ?? '2K',
      response_format: 'url',
      // A watermark on a client's presentation render is not acceptable, and
      // the default is on.
      watermark: false,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')

    // Ark reports an un-activated model as 404 rather than 403, which reads as
    // "wrong URL" and sends people to check the endpoint. It nearly always
    // means the model was never switched on for this account.
    if (response.status === 404 && detail.includes('InvalidEndpointOrModel')) {
      throw new Error(
        `The image model "${model}" is not activated on this Ark account. ` +
        'Enable it in the BytePlus console, or set AI_IMAGE_MODEL to one that is.',
      )
    }
    if (response.status === 429) {
      throw new Error('The image provider is rate limiting or out of quota.')
    }
    throw new Error(`Image provider returned ${response.status}: ${detail.slice(0, 200)}`)
  }

  const body = await response.json()
  const url = body.data?.[0]?.url
  if (!url) {
    // A refusal arrives as a 200 with no image, exactly like the vision path.
    // Say which, rather than "no image was returned".
    const reason = body.data?.[0]?.revised_prompt ?? body.error?.message
    throw new Error(reason ? `The model declined: ${String(reason).slice(0, 160)}` : 'No image was returned.')
  }

  const fetched = await fetch(url)
  if (!fetched.ok) {
    throw new Error(`The provider's image URL returned ${fetched.status} when fetched back.`)
  }
  return Buffer.from(await fetched.arrayBuffer())
}

/**
 * One name to one function. The choice is an env var precisely so that moving
 * providers is a config change and not a patch, so the dispatch stays a table.
 */
const PROVIDERS = { gemini, byteplus }

/** The image type actually present in the bytes, from its magic number. */
function sniffImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  // Storage needs some answer, and PNG was the long-standing assumption, so an
  // unrecognised payload behaves exactly as it did before rather than throwing.
  return 'image/png'
}

/**
 * Render a captured viewport into a photograph, and store it.
 *
 * Returns a stored URL, the same shape as a Blender render, so everything
 * downstream — polling, the gallery, the published page — treats the two
 * identically.
 */
export async function renderWithAi({ sourcePath, styleId, note, ownerId }) {
  if (!API_KEY) {
    throw new Error(
      'No AI_IMAGE_KEY is configured, so photoreal rendering is unavailable.',
    )
  }

  const style = AI_STYLES[styleId] ?? AI_STYLES.daylight
  const bytes = await readFile(sourcePath)
  const mimeType = sourcePath.endsWith('.png') ? 'image/png' : 'image/jpeg'

  // The invariant first, then the style, then anything the user added. Order
  // matters: instructions later in a prompt carry more weight with most models,
  // so the user's note can nudge the finish without being able to override
  // "do not move the walls".
  const prompt = [PRESERVE, style.prompt, note?.slice(0, 300)].filter(Boolean).join(' ')

  const provider = PROVIDERS[PROVIDER]
  if (!provider) {
    throw new Error(
      `Unknown AI_IMAGE_PROVIDER "${PROVIDER}". Known: ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }
  const rendered = await provider(bytes.toString('base64'), mimeType, prompt)

  // Sniff the bytes rather than trusting a constant. Gemini returns PNG and
  // Ark returns JPEG, and the old hardcoded 'image/png' meant an Ark render was
  // stored as .png while actually being a JPEG. Browsers sniff and render it
  // anyway, so this stays invisible until something downstream believes the
  // extension -- a thumbnailer, a PDF export, a Content-Type header.
  const stored = await put(rendered, sniffImageType(rendered), { prefix: `renders/${ownerId}` })
  return stored.url
}
