import { defineConfig } from 'vite'

export default defineConfig({
  /**
   * Relative base.
   *
   * Published output gets dropped into a subfolder as often as onto a domain
   * root — the reference product serves each project from
   * `/<project-slug>/<build-timestamp>/`. Absolute asset paths break the moment
   * that happens, and the failure looks like a blank page with no error.
   */
  base: './',

  build: {
    rollupOptions: {
      output: {
        /**
         * Three.js gets its own chunk, and it is only fetched when a visitor
         * opens a walkthrough — every other page on this site is images and
         * text. Bundling it into the entry chunk would put half a megabyte of
         * WebGL in front of someone who only wanted the floor plans.
         */
        manualChunks: {
          three: ['three'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
    // Published output is archived per build; a sourcemap costs nothing to
    // ship and turns "the site is broken" into a stack trace with line numbers.
    sourcemap: true,
  },
})
