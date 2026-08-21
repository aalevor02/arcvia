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

  const rendered =
    PROVIDER === 'gemini'
      ? await gemini(bytes.toString('base64'), mimeType, prompt)
      : (() => {
          throw new Error(`Unknown AI_IMAGE_PROVIDER "${PROVIDER}".`)
        })()

  const stored = await put(rendered, 'image/png', { prefix: `renders/${ownerId}` })
  return stored.url
}
