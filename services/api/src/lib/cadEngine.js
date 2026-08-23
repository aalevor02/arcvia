import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Running the CAD reconstruction engine.
 *
 * ── Why this is a queued job and not a proxy ─────────────────────────────────
 * `detect.js` proxies straight through to floorplan-ai because detection is a
 * sub-second inference call. Reconstruction is not: it converts a DWG, pairs
 * thousands of faces, segments the sheet into its separate drawings, chooses
 * layers by what they enclose, derives the envelope and writes a GLB. Tens of
 * seconds on a small villa, minutes on a big sheet.
 *
 * So it goes through the render queue, which already owns everything a long job
 * needs — the daily cap, the concurrency limit, credit metering, refunds on
 * failure, cancellation, and reconciliation after a restart. A second queue
 * would mean a second copy of all of that, and the copy would drift.
 *
 * ── The engine is a separate process on purpose ─────────────────────────────
 * It is Python, it has its own 3.12 virtualenv, and it deliberately does NOT
 * share floorplan-ai's environment — rapidocr there will uninstall the headless
 * OpenCV build out from under it. Talking to it over a process boundary keeps
 * that quarantine intact and costs one spawn.
 */

const ROOT = resolve(import.meta.dirname, '../../../..')

/** The engine's own interpreter. Not the system one — it has the dependencies. */
const PYTHON =
  process.env.RECONSTRUCT_PYTHON ??
  resolve(ROOT, 'services/reconstruct/.venv/Scripts/python.exe')

const ENGINE_DIR = process.env.RECONSTRUCT_DIR ?? resolve(ROOT, 'services/reconstruct')

/** A big sheet is minutes. Beyond this something is wedged. */
const TIMEOUT_MS = Number(process.env.RECONSTRUCT_TIMEOUT_MS ?? 900_000)

export class EngineError extends Error {}

/**
 * Run one engine command and return its parsed JSON report.
 *
 * `onProgress` is called with a 0-100 estimate. The engine prints its stages to
 * stdout rather than a percentage, so the mapping is coarse and deliberately
 * monotonic — a bar that goes backwards reads as a bug even when the job is fine.
 */
export function runEngine(command, args, { onProgress, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PYTHON, ['-m', 'cli', command, ...args], {
      cwd: ENGINE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })

    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new EngineError(`The engine did not finish within ${TIMEOUT_MS} ms.`))
    }, TIMEOUT_MS)

    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })

    // Stage markers, in the order the engine reaches them. Coarse on purpose:
    // see the note on monotonicity above.
    const STAGES = [
      [/^CONVERT/m, 10],
      [/^UNIT/m, 20],
      [/^FACES/m, 35],
      [/^FRAMES/m, 45],
      [/^WALLS/m, 60],
      [/^ROOMS/m, 75],
      [/^OPENINGS/m, 85],
      [/^MESH/m, 92],
      [/^GLB/m, 98],
    ]
    let reached = 0

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      out += text
      if (!onProgress) return
      for (const [pattern, percent] of STAGES) {
        if (percent > reached && pattern.test(text)) {
          reached = percent
          onProgress(percent)
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new EngineError(`Could not start the engine: ${error.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        // The engine's refusals are deliberate and specific — a converter that
        // dropped model space, a unit that produces an empty building. Passing
        // its own words through is far more useful than "exit code 2".
        const reason = err.trim().split('\n').slice(-4).join(' ').slice(0, 500)
        rejectPromise(new EngineError(reason || `Engine exited with code ${code}.`))
        return
      }

      resolvePromise({ stdout: out, stderr: err })
    })
  })
}

/**
 * Reconstruct a drawing into a building model and a GLB.
 *
 * Returns the model report — including the verify verdict, which the caller
 * must look at. A `blocking` verdict means the engine built something it does
 * not believe, and shipping that to a viewer is worse than failing.
 */
export async function reconstruct({ inputPath, outDir, unit, layers, autoLayers = true,
                                    height, frame, onProgress, signal }) {
  const args = ['--input', inputPath, '--out', outDir]
  if (unit) args.push('--unit', unit)
  if (layers?.length) args.push('--layers', layers.join(','))
  else if (autoLayers) args.push('--auto-layers')
  if (height) args.push('--height', String(height))
  if (frame !== undefined && frame !== null) args.push('--frame', String(frame))

  await runEngine('reconstruct', args, { onProgress, signal })

  const stem = inputPath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '')
  const modelPath = resolve(outDir, `${stem}.building.json`)

  let model
  try {
    model = JSON.parse(await readFile(modelPath, 'utf8'))
  } catch {
    throw new EngineError('The engine reported success but wrote no model.')
  }

  // The plan drawing and the solved cameras cost seconds and need no renderer,
  // so there is no reason to make them a second job. A reviewer wants the plan
  // more than the mesh — it is the artefact they can actually read.
  let plan = null
  let views = null
  try {
    await runEngine('deliverables', ['--model', modelPath, '--out', outDir], { signal })
    plan = resolve(outDir, `${stem}.plan.svg`)
    views = resolve(outDir, `${stem}.views.json`)
  } catch {
    // A model that built but will not draw is still a usable model. Losing the
    // plan is a degraded result, not a failed job.
  }

  return { model, modelPath, glbPath: model.glb?.path ?? null, plan, views }
}

/**
 * What plans a presentation PDF holds, and what the scale evidence is.
 *
 * Phase one of the two-phase deck flow: cheap (extraction plus detection, no
 * engine build), so the user confirms ONE printed dimension before the single
 * paid build — never build-then-rebuild at a second charge for our own
 * uncertainty. Returns the survey JSON verbatim; the route rewrites preview
 * paths into served URLs, because a disk path means nothing to a browser.
 */
export async function deckSurvey({ inputPath, outDir, detector, signal }) {
  const jsonPath = resolve(outDir, 'deck-survey.json')
  const args = ['survey', '--input', inputPath, '--out', outDir, '--json', jsonPath]
  if (detector) args.push('--detector', detector)

  await runEngine('deck', args, { signal })

  try {
    return JSON.parse(await readFile(jsonPath, 'utf8'))
  } catch {
    throw new EngineError('The deck survey reported success but wrote no JSON.')
  }
}

/**
 * Phase two: reconstruct ONE chosen plan sheet at a confirmed scale.
 *
 * Mirrors `reconstruct`'s return shape so the queue's cad branch treats the
 * two identically. The sheet's stem is derived engine-side from its caption,
 * so the model is found as the one building.json in the job's own outDir —
 * which is why every deck job gets a fresh directory.
 */
export async function deckBuild({
  inputPath, outDir, page, index = 0, scale, height, detector, onProgress, signal,
}) {
  const args = [
    'build', '--input', inputPath, '--out', outDir,
    '--page', String(page), '--index', String(index),
  ]
  if (scale) args.push('--scale', String(scale))
  if (height) args.push('--height', String(height))
  if (detector) args.push('--detector', detector)

  await runEngine('deck', args, { onProgress, signal })

  const written = (await readdir(outDir)).filter((f) => f.endsWith('.building.json'))
  if (written.length !== 1) {
    throw new EngineError(
      written.length === 0
        ? 'The deck build reported success but wrote no model.'
        : `The deck build wrote ${written.length} models into one job directory.`,
    )
  }
  const modelPath = resolve(outDir, written[0])
  const model = JSON.parse(await readFile(modelPath, 'utf8'))
  return { model, modelPath, glbPath: model.glb?.path ?? null, plan: null, views: null }
}

/** Read-only, free, and fast enough to answer synchronously. */
export async function survey({ inputPath, workDir, unit, signal }) {
  const jsonPath = resolve(workDir, 'survey.json')
  const args = ['--input', inputPath, '--work', workDir, '--json', jsonPath]
  if (unit) args.push('--unit', unit)

  await runEngine('survey', args, { signal })
  return JSON.parse(await readFile(jsonPath, 'utf8'))
}

/** Which layers hold walls, with the evidence. Also free. */
export async function layers({ inputPath, workDir, unit, signal }) {
  const jsonPath = resolve(workDir, 'layers.json')
  const args = ['--input', inputPath, '--work', workDir, '--json', jsonPath]
  if (unit) args.push('--unit', unit)

  await runEngine('layers', args, { signal })
  return JSON.parse(await readFile(jsonPath, 'utf8'))
}

export const enginePaths = { PYTHON, ENGINE_DIR }
