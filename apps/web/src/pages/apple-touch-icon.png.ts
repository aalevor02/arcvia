import type { APIRoute } from 'astro'
import sharp from 'sharp'
import { markSvg } from '../lib/mark'

/**
 * iOS home-screen icon.
 *
 * A separate route from the SVG because Safari will not accept SVG here, and a
 * <link> pointing at a file that does not exist is worse than no <link> at all
 * — it costs every iOS visitor a 404 on first load.
 *
 * 180x180 is the largest size iOS asks for; smaller devices downscale it.
 */
export const GET: APIRoute = async () => {
  const png = await sharp(Buffer.from(markSvg(180))).png().toBuffer()

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
    },
  })
}
