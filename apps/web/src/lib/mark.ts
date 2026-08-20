import brand from '@arcvia/brand'

/**
 * The brand mark, as SVG source.
 *
 * Generated rather than committed as a file in `public/`, because a committed
 * favicon is a second place the brand colour lives — and it is the place
 * nobody remembers to update. `brand.config.mjs` stays the only source of
 * truth, exactly as the repo requires, and rebranding still costs one edit.
 *
 * Consumed by `favicon.svg.ts` and `apple-touch-icon.png.ts`.
 */
export function markSvg(size = 64): string {
  const initial = brand.name.charAt(0).toUpperCase()
  const radius = Math.round(size * 0.22)

  // Font size is a ratio of the box rather than a constant so the same source
  // renders correctly at 32px and at 180px.
  const fontSize = Math.round(size * 0.58)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${brand.color.accent}"/>
  <text
    x="50%" y="50%"
    dy="0.02em"
    text-anchor="middle"
    dominant-baseline="central"
    font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    font-size="${fontSize}"
    font-weight="700"
    fill="#ffffff">${initial}</text>
</svg>`
}
