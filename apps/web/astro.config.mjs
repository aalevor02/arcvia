import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import tailwind from '@astrojs/tailwind'
import sitemap from '@astrojs/sitemap'
import brand from '@arcvia/brand'
import { isIndexable } from './src/lib/routes.mjs'

// https://astro.build/config
export default defineConfig({
  site: brand.domains.marketing,

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
