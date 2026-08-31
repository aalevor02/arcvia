/**
 * Types for the brand tokens.
 *
 * The config itself stays plain `.mjs` so that non-TypeScript consumers — the
 * Tailwind config, the Astro site, any build script — can import it without a
 * compile step. This file gives the TypeScript apps the same shape without
 * changing how the source is authored.
 */
export interface Brand {
  name: string
  legalName: string
  tagline: string
  description: string
  domains: {
    marketing: string
    studio: string
    walkthrough: string
    planViewer: string
  }
  color: {
    ink: string
    inkSoft: string
    line: string
    surface: string
    surfaceAlt: string
    accent: string
    accentHover: string
    accentSoft: string
    /** Accent used as TEXT on a light background. See the config for why. */
    accentInk: string
    /** Accent used as TEXT on `ink`. See the config for why. */
    accentOnDark: string
    signal: string
    warn: string
    danger: string
  }
  font: { sans: string; mono: string }
  social: { linkedin: string; instagram: string }
}

export declare const brand: Brand
export default brand
