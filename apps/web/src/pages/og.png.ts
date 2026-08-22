import type { APIRoute } from 'astro'
import sharp from 'sharp'
import brand from '@arcvia/brand'

/**
 * The share card — what a link to this site looks like in WhatsApp or Slack.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `Base.astro` declared `twitter:card = summary_large_image` on every page and
 * the site had no `og:image` at all. That combination is not "no card", it is a
 * card that promises a large image and supplies none — so the preview renders
 * as a bare strip, or the platform silently downgrades it, depending on who is
 * reading. Declaring a format we could not fill was the actual bug; this fills
 * it.
 *
 * ── Why generated rather than a file in `public/` ────────────────────────────
 * Same reasoning as `favicon.svg.ts` and `apple-touch-icon.png.ts`, which this
 * deliberately mirrors: a committed PNG is a second place the brand colour and
 * the tagline live, and it is the place nobody remembers to update.
 * `brand.config.mjs` stays the only source of truth, and a rebrand still costs
 * one edit rather than one edit plus an image nobody can find the source of.
 *
 * 1200 x 630 is the size every platform crops from. Text is kept well inside
 * the edges because Twitter and WhatsApp crop to different aspect ratios and
 * anything near the boundary is the first thing lost.
 */

const WIDTH = 1200
const HEIGHT = 630

/** Escape for XML text nodes — the tagline comes from config, not from here. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cardSvg(): string {
  const initial = brand.name.charAt(0).toUpperCase()

  // The tagline is one sentence in config and too long for one line at this
  // size. Wrapped on words rather than characters, and capped at two lines —
  // a third would collide with the safe area the platforms crop into.
  const words = brand.description.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    // ~26 characters per line at 40px in this face. Measured by eye against the
    // rendered card rather than computed, because the font is the system stack
    // and its metrics differ per machine — so this is deliberately generous.
    if (candidate.length > 46 && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
    if (lines.length === 2) break
  }
  if (lines.length < 2 && line) lines.push(line)

  const tagline = lines
    .map(
      (text, n) =>
        `<text x="96" y="${400 + n * 54}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="40" fill="${brand.color.inkSoft}">${esc(text)}</text>`,
    )
    .join('\n  ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${brand.color.surface}"/>
  <rect width="${WIDTH}" height="12" fill="${brand.color.accent}"/>

  <rect x="96" y="150" width="96" height="96" rx="21" fill="${brand.color.accent}"/>
  <text x="144" y="198" text-anchor="middle" dominant-baseline="central"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="56" font-weight="700" fill="#ffffff">${esc(initial)}</text>

  <text x="216" y="198" dominant-baseline="central"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="56" font-weight="700" fill="${brand.color.ink}">${esc(brand.name)}</text>

  <text x="96" y="320" dominant-baseline="central"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="64" font-weight="700" fill="${brand.color.ink}">Drawings to 3D walkthroughs</text>

  ${tagline}
</svg>`
}

export const GET: APIRoute = async () => {
  const png = await sharp(Buffer.from(cardSvg())).png().toBuffer()

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
    },
  })
}
