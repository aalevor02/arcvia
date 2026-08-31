import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import tailwind from '@astrojs/tailwind'
import sitemap from '@astrojs/sitemap'
import brand from '@arcvia/brand'
import { isIndexable } from './src/lib/routes.mjs'

// https://astro.build/config
export default defineConfig({
  // ── Where this site will actually live ────────────────────────────────────
  //
  // Everything a crawler is told derives from `site`: every <link rel=
  // "canonical">, og:url, og:image, all 12 URLs in the sitemap, and the
  // `Sitemap:` line in robots.txt.
  //
  // `brand.domains.marketing` is still the placeholder `https://arcvia.example`
  // while the real domain is undecided, and it was read here directly — so the
  // site could not be deployed to a real domain without editing source. Worse,
  // it would fail HALF-configured and quietly: the API already honours
  // PUBLIC_SITE_URL (services/api/src/lib/origins.js, and auth.js for reset
  // links), so setting that one variable made password-reset and shared links
  // point at the real domain while every canonical tag and the whole sitemap
  // still named `arcvia.example`. Canonicals pointing at a domain you do not
  // own tell search engines the real site is a duplicate of a site that does
  // not exist, and robots.txt would advertise a sitemap that resolves nowhere.
  //
  // Same variable, same precedence as the API, so one value configures both.
  // The brand placeholder remains the fallback, which is what keeps local
  // development working with no .env at all.
  site: (process.env.PUBLIC_SITE_URL || brand.domains.marketing).replace(/\/$/, ''),

  // `static` is the whole point: the build emits plain HTML/CSS/JS that any
  // static host serves for pennies. There is no Node process in production.
  output: 'static',

  // The reference site redirects /pricing -> /pricing/ at the edge. Emitting
  // directory-style URLs up front means the host never has to issue that 301.
  trailingSlash: 'always',
  build: { format: 'directory' },

  integrations: [
    // React only hydrates the handful of components that genuinely need it
    // (accordion, carousel, booking widget). Everything else ships as zero JS.
    react(),
    tailwind({ applyBaseStyles: false }),

    // The filter reads the same list `Base.astro` uses to emit its robots meta
    // tag, so the sitemap cannot submit a page that then refuses indexing.
    // It could, and did: the 2026-08-30 build submitted 18 URLs of which 7
    // carried `noindex`, including `/view/` — the route that serves client
    // deliverables. See src/lib/routes.mjs.
    sitemap({ filter: isIndexable }),
  ],

  vite: {
    build: {
      // Keep the shipped CSS honest — warn early if a page starts dragging in
      // more than it should.
      chunkSizeWarningLimit: 600,
    },
  },
})
