import brand from '@arcvia/brand'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      // Brand tokens are pulled from the shared config rather than re-typed
      // here, so `packages/brand` stays the only place a colour is defined.
      colors: {
        ink: brand.color.ink,
        'ink-soft': brand.color.inkSoft,
        line: brand.color.line,
        surface: brand.color.surface,
        'surface-alt': brand.color.surfaceAlt,
        accent: {
          DEFAULT: brand.color.accent,
          hover: brand.color.accentHover,
          soft: brand.color.accentSoft,
          // Accent as text rather than as a fill — `accent` itself does not
          // clear WCAG AA on any of the tinted backgrounds this site uses.
          ink: brand.color.accentInk,
          'on-dark': brand.color.accentOnDark,
        },
        signal: brand.color.signal,
        warn: brand.color.warn,
        danger: brand.color.danger,
      },
      fontFamily: {
        sans: [brand.font.sans],
        mono: [brand.font.mono],
      },
      maxWidth: {
        shell: '1200px',
      },
      // A 4px-based rhythm. Every vertical gap on the site is a multiple of
      // these, which is what keeps unrelated sections feeling related.
      spacing: {
        section: '6rem',
        'section-sm': '3.5rem',
      },
      borderRadius: {
        card: '14px',
      },
    },
  },
  plugins: [],
}
