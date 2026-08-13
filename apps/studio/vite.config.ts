import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /**
         * Split three and react into their own chunks.
         *
         * The reference product shipped a single 3.3 MB entry bundle, which
         * means every deploy — even a one-line UI tweak — invalidates the whole
         * thing for every returning user. Three.js changes maybe twice a year;
         * giving it a stable chunk means it stays in cache across releases.
         */
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
})
