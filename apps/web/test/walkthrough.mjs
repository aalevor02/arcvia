/**
 * What a client sees at /view/ when the model does not arrive.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * `SceneViewer.loadModel` used to catch its error, call `onError`, and then
 * RESOLVE — so `await loadModel(url)` walked into the success path with nothing
 * in the scene. On this page that produced a serene empty sky-and-ground world
 * with the full chrome over it and no error at all: the page DID write one,
 * through that callback, and its own success path deleted it four hundred lines
 * later by hiding the status panel and revealing the controls.
 *
 * It shipped like that because nothing here could see it. `linkcheck.mjs` asks
 * whether pages resolve, `crawl-policy.mjs` asks what the built files tell
 * crawlers, and the studio's runner says in its own comment that anything
 * touching the DOM or WebGL belongs in a browser test. There was no browser
 * test. This is it.
 *
 * ── Why it is hermetic ──────────────────────────────────────────────────────
 * No API, no database, no published scene. The page derives its API host from
 * its own hostname (`lib/api.ts`), so every request is intercepted in the
 * browser and answered from a fixture. That means this suite cannot be broken
 * by whatever happens to be in the dev database, cannot fight another session
 * for port 8787, and — the point — can serve a model URL that 404s ON PURPOSE,
 * which is the case that was never being exercised.
 *
 * The success case uses a one-triangle glTF built in memory below rather than a
 * file on disk. A suite whose "it works" case depends on an artifact in A:/tmp
 * is a suite that goes green when the artifact rots.
 *
 * ── Playwright ──────────────────────────────────────────────────────────────
 * Resolved from the GLOBAL npm root, not added as a dependency of this repo. If
 * it is not installed this exits 3, which `tools/validate.mjs` already reads as
 * `blocked` rather than passed or failed — see the comment there on why a run
 * that skipped work must not report clean.
 *
 * Run: npm run build --workspace=apps/web && node test/walkthrough.mjs
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(HERE, '..', 'dist')

let passed = 0
let failed = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log(`  ok    ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

// ---- Preconditions, both of which BLOCK rather than fail --------------------

try {
  await stat(join(DIST, 'view', 'index.html'))
} catch {
  console.error(
    `No build at ${DIST}.\n\n  npm run build --workspace=apps/web\n`,
  )
  process.exit(3)
}

let chromium
try {
  // Derived from this process rather than by shelling out to `npm root -g`:
  // no subprocess, no shell, and it works when npm is a .cmd shim. Windows puts
  // the global root beside the node binary; POSIX puts it under `../lib`.
  const nodeDir = dirname(process.execPath)
  const globalRoots = [
    join(nodeDir, 'node_modules'),
    join(dirname(nodeDir), 'lib', 'node_modules'),
  ]
  const require = createRequire(import.meta.url)
  ;({ chromium } = require(
    require.resolve('playwright', {
      paths: globalRoots.flatMap((root) => [
        root,
        join(root, '@playwright', 'cli', 'node_modules'),
      ]),
    }),
  ))
} catch (error) {
  console.error(
    'BLOCKED — Playwright is not available.\n\n' +
      'This suite drives a real browser; it is the only way to observe what this\n' +
      'page shows, and it is deliberately not a dependency of this repo.\n\n' +
      '  npm i -g @playwright/cli    (then: npx playwright install chromium)\n\n' +
      `Resolution error: ${error.message}\n`,
  )
  process.exit(3)
}

// ---- A one-triangle glTF, built here so nothing on disk can rot ------------

function minimalGlb() {
  // 3 vertices, VEC3 float32 — 36 bytes.
  const bin = Buffer.alloc(36)
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  positions.forEach((v, i) => bin.writeFloatLE(v, i * 4))

  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    // min/max are REQUIRED on a POSITION accessor and must match the data;
    // loaders use them for bounds, and this page frames the camera from them.
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }

  // Each chunk is padded to a 4-byte boundary: JSON with spaces, BIN with
  // zeroes. A loader that reads the declared length will reject anything else.
  const pad = (buf, filler) => {
    const over = buf.length % 4
    return over === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - over, filler)])
  }
  const json = pad(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20)
  const binChunk = pad(bin, 0)

  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + json.length + 8 + binChunk.length, 8)

  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(json.length, 0)
  jsonHeader.write('JSON', 4, 'ascii')

  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binChunk.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4) // "BIN\0"

  return Buffer.concat([header, jsonHeader, json, binHeader, binChunk])
}

const GLB = minimalGlb()

// ---- Serve the built site --------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  // `/view/<slug>/` is a host rewrite in production (public/_redirects); the
  // static file lives at /view/index.html. Reproduced here so the suite tests
  // the address a client is actually sent, not only the `?s=` form.
  const file = path.startsWith('/view/')
    ? join(DIST, 'view', 'index.html')
    : join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''), path.endsWith('/') ? 'index.html' : '')

  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
console.log(`Serving ${DIST} at ${ORIGIN}\n`)

// ---- The fixture the page will be given ------------------------------------

const MODEL_PATH = '/uploads/scenes/testing/model.glb'

function scenePayload() {
  return {
    scene: {
      name: 'Fixture Villa',
      modelUrl: MODEL_PATH,
      lightsUrl: null,
      hdriUrl: null,
      bakedUrl: null,
      panoramaUrl: null,
      views: [],
      hotspots: [],
      branding: null,
      credits: [],
      options: null,
    },
  }
}

/**
 * A browser to drive.
 *
 * Two ways to get one, and the fallback is not a nicety: Playwright pins an
 * exact build of its bundled Chromium, so a global `playwright` that has been
 * upgraded without re-running `playwright install` resolves fine and then fails
 * at launch looking for a revision that is not on disk. This box is in that
 * state — it has chromium-1234 and the module wants 1237.
 *
 * `channel: 'chrome'` drives the Chrome the machine already has, which is what
 * the rest of this workstation's Playwright tooling does.
 *
 * If neither works this BLOCKS. It must not throw: an uncaught launch error
 * exits non-zero and validate.mjs would read a missing browser as a FAILING
 * suite — reporting a machine that is not set up as a regression in the site,
 * which is the exact confusion exit 3 exists to prevent.
 */
let browser
try {
  browser = await chromium.launch()
} catch {
  try {
    browser = await chromium.launch({ channel: 'chrome' })
    console.log('  (using the system Chrome — bundled Chromium is not installed)\n')
  } catch (error) {
    console.error(
      'BLOCKED — Playwright is installed but has no browser to drive.\n\n' +
        '  npx playwright install chromium\n\n' +
        'or install Google Chrome, which this suite will use instead.\n\n' +
        `Launch error: ${String(error).split('\n')[0]}\n`,
    )
    server.close()
    process.exit(3)
  }
}

/**
 * Open the walkthrough with the model request answered by `modelResponse`.
 *
 * @param modelResponse 'ok' to serve a real glTF, '404' to fail the fetch.
 */
async function open(modelResponse) {
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))

  // The page derives its API host from its own hostname, so these patterns
  // match whatever port the throwaway server landed on.
  await page.route('**/scenes/public/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(scenePayload()),
    }),
  )
  await page.route(`**${MODEL_PATH}`, (route) =>
    modelResponse === 'ok'
      ? route.fulfill({
          status: 200,
          contentType: 'model/gltf-binary',
          headers: { 'access-control-allow-origin': '*' },
          body: GLB,
        })
      : route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }),
  )

  await page.goto(`${ORIGIN}/view/fixture-villa/`, { waitUntil: 'load' })
  // The page loads three.js and then the model; both are async and neither
  // fires a documented event. Wait on the observable outcome instead: the
  // status panel is hidden on success and carries text on failure.
  await page
    .waitForFunction(
      () => {
        const s = document.getElementById('status')
        const c = document.getElementById('controls')
        return (s && /\S/.test(s.innerText) && !/Fetching|Loading/i.test(s.innerText)) ||
          (c && !c.hasAttribute('hidden'))
      },
      { timeout: 30_000 },
    )
    .catch(() => {})

  return { page, consoleErrors }
}

/** What a visitor can actually see and reach. */
const surface = (page) =>
  page.evaluate(() => {
    const controls = document.getElementById('controls')
    const status = document.getElementById('status')
    const buttons = [...(controls?.querySelectorAll('button') ?? [])]
    const reachable = buttons.filter((b) => {
      b.focus()
      return document.activeElement === b
    })
    return {
      statusText: (status?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      statusVisible: status ? status.checkVisibility({ checkVisibilityCSS: true }) : false,
      controlsHiddenAttr: controls?.hasAttribute('hidden') ?? null,
      controlsVisible: controls
        ? controls.checkVisibility({ checkVisibilityCSS: true })
        : false,
      controlsDisplay: controls ? getComputedStyle(controls).display : null,
      reachableButtons: reachable.map((b) => b.textContent.trim()),
      title: document.title,
    }
  })

try {
  // ---- The model does not arrive -----------------------------------------
  console.log('  — a model that 404s')
  {
    const { page } = await open('404')
    const s = await surface(page)

    ok(
      'the visitor is told something went wrong',
      /\S/.test(s.statusText) && s.statusVisible,
      s.statusText || '(nothing on screen)',
    )

    // The regression itself. Before the fix these were all true: the chrome was
    // revealed over an empty world and the error was overwritten.
    ok(
      'the walkthrough chrome is not presented',
      s.controlsVisible === false,
      `display:${s.controlsDisplay}`,
    )
    ok(
      'and none of its buttons can be reached by keyboard',
      s.reachableButtons.length === 0,
      s.reachableButtons.length ? `focusable: ${s.reachableButtons.join(', ')}` : '0 focusable',
    )

    // `hidden` is only advisory against an id rule — `#controls{display:flex}`
    // outranks the browser's `[hidden]{display:none}`. Assert the OUTCOME, not
    // the attribute, or this passes while the buttons are still on screen.
    ok(
      'the hidden attribute actually hides, rather than merely being set',
      s.controlsHiddenAttr === true && s.controlsDisplay === 'none',
      `hidden=${s.controlsHiddenAttr} display=${s.controlsDisplay}`,
    )

    ok(
      'the message does not leak the storage path to the client',
      !/uploads\/|\.glb|http:\/\/|https:\/\//.test(s.statusText),
      s.statusText,
    )

    await page.close()
  }

  // ---- The model arrives --------------------------------------------------
  //
  // Without this case the suite would pass against a viewer that failed
  // ALWAYS, which is a worse product and a green board.
  console.log('\n  — a model that loads')
  {
    const { page, consoleErrors } = await open('ok')
    const s = await surface(page)

    ok('the walkthrough is presented', s.controlsVisible === true, `display:${s.controlsDisplay}`)
    ok(
      'its controls are reachable by keyboard',
      s.reachableButtons.length > 0,
      s.reachableButtons.join(', ') || '(none)',
    )
    ok('no error is shown', s.statusVisible === false, s.statusText)
    ok(
      'the tab is named after the project, not the page',
      s.title.startsWith('Fixture Villa'),
      s.title,
    )
    ok(
      'the page loads without console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(' | '),
    )

    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
