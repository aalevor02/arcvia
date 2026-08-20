import type { APIRoute } from 'astro'
import { markSvg } from '../lib/mark'

/** Emitted at build time to /favicon.svg. See lib/mark.ts for why. */
export const GET: APIRoute = () =>
  new Response(markSvg(64), {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=604800',
    },
  })
