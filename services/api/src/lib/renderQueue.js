import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../store.js'
import { renderWithAi } from './aiRender.js'
import { settleRefund } from './refunds.js'
import { put } from './storage.js'

/**
 * Render queue.
 *
 * Two modes, chosen by env:
 *
 *   RENDER_MODE=local  — spawns Blender on this machine. Costs nothing beyond
 *                        your own electricity, and is how you should develop.
 *   RENDER_MODE=remote — POSTs the job to a worker pool endpoint. This is the
 *                        one that bills you per GPU-second.
 *
 * `local` is the default on purpose. The expensive path should be something you
 * opt into deliberately, not the thing that happens because you forgot to set a
 * variable.
 */

const MODE = process.env.RENDER_MODE ?? 'local'
const BLENDER = process.env.BLENDER_PATH ?? 'blender'
const WORKER_URL = process.env.RENDER_WORKER_URL ?? ''
// ── Resolve the render script relative to THIS file, not the cwd ────────────
// `resolve('../../services/render-worker/render.py')` with no base is anchored
// on process.cwd(), and the API is started from at least three directories:
// the repo root (docs/deploy.md), services/api (npm scripts), and the test
// harness. From the repo root it resolved to `A:\services\render-worker\...`,
// which does not exist, and — because Blender exits 0 on a Python traceback —
// every render on a fresh deploy failed with "Python file could not be opened".
// storage.js and cadEngine.js already anchor on import.meta; this was the
// outlier. `.env.example` shipped a cwd-relative override that was wrong from
// services/api, so it is removed there and the file-relative default applies.
const SCRIPT = process.env.BLENDER_SCRIPT
  ? resolve(process.env.BLENDER_SCRIPT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../../render-worker/render.py')

// Say so at boot, loudly, if it is not there. A missing render script is a
// deployment fault that otherwise only surfaces as a failed job per render,
// with an error (OSError from Blender) that names Python rather than the deploy.
if (MODE === 'local' && !existsSync(SCRIPT)) {
  console.warn(
    `[renderQueue] BLENDER_SCRIPT not found at ${SCRIPT}. ` +
      `Local renders will fail until this path is correct.`,
  )
}

/**
 * Two lanes, so a bake cannot starve a preview.
 *
 * With one global slot, a 45-minute CPU bake at the head of the queue held a
 * 20-second preview hostage behind it — the user watching the viewport paid
 * the waiting cost of someone else's overnight job. Splitting by the SHAPE of
 * the work fixes that: quick, someone-is-watching jobs flow through `fast`
 * while long deliverables take turns in `heavy`. Within a lane it is still
 * strict FIFO; lanes only stop unlike work from queueing behind unlike work.
 *
 * ── Cost control now reads as a SUM ─────────────────────────────────────────
 * Concurrency multiplied by GPU hourly rate is the worst-case burn, and that
 * number is now RENDER_CONCURRENCY + RENDER_HEAVY_CONCURRENCY — at the
 * defaults, two jobs at once where the old single queue ran one. That is not
 * an accident to be minimised; it is the feature. An operator pricing
 * worst-case burn budgets the sum, and either limit can be set to zero to
 * close its lane entirely.
 *
 * `full` sits in heavy deliberately: 128 CPU samples is minutes of work
 * (measured in this repo at 4–5 minutes a frame), and minutes is what the
 * fast lane exists to never wait for.
 */
const LANES = {
  fast: { limit: Number(process.env.RENDER_CONCURRENCY ?? 1) },
  heavy: { limit: Number(process.env.RENDER_HEAVY_CONCURRENCY ?? 1) },
}

const LANE_OF_PRESET = { full: 'heavy', cad: 'heavy', bake: 'heavy' }

/** Which lane a job queues in. Unknown presets ride fast — they always did. */
export const laneOf = (job) => LANE_OF_PRESET[job.preset] ?? 'fast'

/**
 * Hard ceiling on a single job. A runaway scene cannot bill for hours.
 *
 * Two of them, because a bake and a still are not the same kind of work. A
 * still renders one camera; a bake path-traces every surface in the building
 * into an atlas, and on a machine without a CUDA or HIP device Cycles falls
 * back to the CPU, where a furnished room is comfortably tens of minutes. One
 * ceiling for both means either the bake is killed just before it finishes —
 * having already spent all of that CPU — or stills get a limit far looser than
 * they need.
 */
const JOB_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 10 * 60 * 1000)
const BAKE_TIMEOUT_MS = Number(process.env.BAKE_TIMEOUT_MS ?? 45 * 60 * 1000)

export const timeoutFor = (job) => (job.preset === 'bake' ? BAKE_TIMEOUT_MS : JOB_TIMEOUT_MS)

/**
 * Whether a restart of THIS process leaves the job's work still running
 * somewhere else.
 *
 * In remote mode a Blender job is owned by the worker pool: our process dying
 * does not stop the GPU, and the worker will still call back with the result.
 * AI and CAD jobs are in-process regardless of mode — the fetch or the Python
 * child dies with us. Reconciliation branches on this: remote-owned work is
 * waited for, in-process work is gone and can only be re-run.
 */
export const isRemoteOwned = (job) =>
  MODE === 'remote' && job.preset !== 'ai' && job.preset !== 'cad'

/**
 * Daily cap on completed jobs across the whole install. Once hit, submissions
 * still queue but nothing starts until the counter rolls over. A crude but very
 * effective circuit breaker against a bug that submits in a loop.
 */
const DAILY_JOB_CAP = Number(process.env.RENDER_DAILY_CAP ?? 500)

const pending = { fast: [], heavy: [] }
const running = new Map() // jobId -> { child, startedAt, timer }
// jobId -> lane, kept beside `running` rather than inside its entries because
// the per-branch `running.set` calls in start() overwrite entries wholesale —
// a lane recorded there would be lost at exactly the moment it must be stable.
const laneTag = new Map()
const laneBusy = { fast: 0, heavy: 0 }

/**
 * The one exit for a running job. Every path that removes a job from
 * `running` must come through here, or its lane's slot leaks and the lane
 * quietly narrows until nothing in it ever starts again.
 */
function release(jobId) {
  const lane = laneTag.get(jobId)
  if (lane !== undefined) {
    laneTag.delete(jobId)
    laneBusy[lane] = Math.max(0, laneBusy[lane] - 1)
  }
  running.delete(jobId)
}

let completedToday = 0
let dayStamp = new Date().toISOString().slice(0, 10)

function rollDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== dayStamp) {
    dayStamp = today
    completedToday = 0
  }
}

export async function queueDepth() {
  return pending.fast.length + pending.heavy.length + running.size
}

export async function jobStatus(jobId) {
  if (running.has(jobId)) {
    const entry = running.get(jobId)
    return {
      status: 'rendering',
      progress: entry.progress ?? 0,
      // Both are here for the same reason: a bake reports no progress at all,
      // so "how long has this been going" and "is it on the CPU" are the only
      // honest things left to tell the user while they wait.
      elapsedMs: Date.now() - entry.startedAt,
      markers: entry.markers ?? {},
    }
  }
  if (pending.fast.some((j) => j.id === jobId) || pending.heavy.some((j) => j.id === jobId)) {
    return { status: 'queued', progress: 0, elapsedMs: 0, markers: {} }
  }
  return null
}

export async function enqueue(job) {
  pending[laneOf(job)].push(job)
  drain()
}

export async function cancelJob(jobId) {
  for (const lane of Object.keys(pending)) {
    const index = pending[lane].findIndex((j) => j.id === jobId)
    if (index !== -1) {
      pending[lane].splice(index, 1)
      return true
    }
  }

  const active = running.get(jobId)
  if (active) {
    clearTimeout(active.timer)
    // A Blender render has a child to signal; an AI or CAD job has an
    // AbortController instead (its "child" is an HTTP call or the Python engine
    // reached through cadEngine). Both stop the work in progress; without the
    // abort, a cancelled CAD reconstruction kept running to completion and its
    // finish('done') raced the cancel.
    active.child?.kill('SIGTERM')
    active.controller?.abort()
    release(jobId)
    drain()
    return true
  }
  return false
}

function drain() {
  rollDayIfNeeded()

  for (const lane of Object.keys(LANES)) {
    while (laneBusy[lane] < LANES[lane].limit && pending[lane].length > 0) {
      if (completedToday >= DAILY_JOB_CAP) {
        // Deliberately leaves jobs queued rather than failing them — the cap
        // is a spend guard, not a rejection. They run when the day rolls
        // over. It is also global across lanes on purpose: it exists to bound
        // a runaway submission loop's spend, and a per-lane cap would just
        // mean the loop burns two budgets.
        const held = pending.fast.length + pending.heavy.length
        console.warn(
          `[renderQueue] daily cap of ${DAILY_JOB_CAP} reached; holding ${held} job(s)`,
        )
        return
      }

      const job = pending[lane].shift()
      // ── Reserve the slot BEFORE yielding ───────────────────────────────────
      // `start()` does not register the job in `running` until after its first
      // `await` (db.update below), so without this line the lane's tally is
      // unchanged when the loop re-tests its condition — and the whole lane
      // is shifted and started in one tick. At limit 1 that launched five
      // queued jobs at once: five simultaneous Blender processes locally, or
      // five times the operator's configured worst-case GPU burn in remote
      // mode. Reserving here makes the counter honest across the await; the
      // per-branch `running.set` calls in start() overwrite this placeholder
      // with the real entry (same key, so size is unchanged), and release()
      // gives the slot back on every exit path.
      running.set(job.id, { child: null, startedAt: Date.now(), progress: 0, markers: {} })
      laneTag.set(job.id, lane)
      laneBusy[lane] += 1
      void start(job)
    }
  }
}

async function start(job) {
  // A throw before any branch registers its real entry would strand the slot
  // reserved in drain(), wedging the queue one job at a time. Anything
  // unexpected here fails the job, which frees the slot and refunds.
  try {
    await runJob(job)
  } catch (error) {
    const active = running.get(job.id)
    if (active?.timer) clearTimeout(active.timer)
    release(job.id)
    await db.update('renderJobs', job.id, { status: 'failed', error: error.message })
    await settleRefund(job.id, 'render-failed')
    drain()
  }
}

async function runJob(job) {
  // ── A job that resolved while it waited must not be re-run ───────────────
  // Reconciliation re-queues jobs a restart orphaned, and in remote mode the
  // old worker may still finish one and call back while its requeued copy
  // sits in `pending`. Without this read, starting the copy would flip a
  // 'done' row back to 'rendering' and run the work twice. The same read
  // makes a cancel that landed between shift() and here stick.
  const current = await db.findOne('renderJobs', (j) => j.id === job.id)
  if (current && ['cancelled', 'failed', 'done'].includes(current.status)) {
    const active = running.get(job.id)
    if (active?.timer) clearTimeout(active.timer)
    release(job.id)
    drain()
    return
  }

  // `startedAt` is persisted, not just held in `running`, because it is what
  // lets a restart compute how much of the job's time budget remains — the
  // in-memory copy dies with the process, which is exactly the moment the
  // number is needed.
  await db.update('renderJobs', job.id, { status: 'rendering', startedAt: Date.now() })

  const finish = async (status, patch = {}) => {
    const active = running.get(job.id)
    if (active) clearTimeout(active.timer)
    release(job.id)

    // ── A cancelled job stays cancelled ──────────────────────────────────────
    // The worker (or the CAD engine) may complete a fraction of a second after
    // a cancel writes 'cancelled', and this closure would then overwrite it
    // with 'done' at 100% — the user cancels, is refunded, and the job reappears
    // as a finished import moments later. Re-read the row and refuse to move a
    // job that has already reached a terminal state someone else set. This is
    // the guard that makes cancel real for every job kind rather than only the
    // ones whose child can be killed.
    const current = await db.findOne('renderJobs', (j) => j.id === job.id)
    if (current && ['cancelled', 'failed', 'done'].includes(current.status)) {
      drain()
      return
    }

    if (status === 'done') completedToday += 1
    await db.update('renderJobs', job.id, { status, ...patch })

    // A job that failed for our reasons must not cost the user anything.
    // The remote path has always done this from the worker callback; this,
    // the local path, never did — which is why the database reached 29 failed
    // jobs against 6 refunds. settleRefund is idempotent, so if a cancel
    // killed this process the decision is already closed and this is a no-op.
    if (status === 'failed') {
      await settleRefund(job.id, 'render-failed')
    }

    drain()
  }

  // An AI render is a job in every sense that matters here — it costs money,
  // it takes long enough to need polling, and it must be reconciled after a
  // restart — so it runs through the same queue rather than beside it. It just
  // makes an HTTP call instead of spawning Blender.
  if (job.preset === 'ai') {
    // Tracked in `running` like any other job so the daily cap, the concurrency
    // limit and boot reconciliation all apply without special cases.
    running.set(job.id, { child: null, startedAt: Date.now(), progress: 0, markers: {} })

    try {
      const outputUrl = await renderWithAi({
        sourcePath: job.spec.inputUrl,
        styleId: job.spec.style,
        note: job.spec.note,
        ownerId: job.ownerId,
      })
      await finish('done', { progress: 100, outputUrl, markers: { device: 'cloud' } })
    } catch (error) {
      await finish('failed', { error: error.message })
    }
    return
  }

  // CAD reconstruction. Spawns the Python engine rather than Blender, and is
  // tracked in `running` like any other job so the daily cap, the concurrency
  // limit and boot reconciliation all apply without special cases.
  if (job.preset === 'cad') {
    // An AbortController rather than a child process: the Python engine is
    // reached through cadEngine, which kills it on abort. cancelJob() aborts
    // this to actually stop a running reconstruction — without it, a cancelled
    // CAD job kept running to completion.
    const controller = new AbortController()
    running.set(job.id, { child: null, controller, startedAt: Date.now(), progress: 0, markers: {} })

    try {
      const engine = await import('./cadEngine.js')
      const onProgress = (percent) => {
        const active = running.get(job.id)
        if (active) active.progress = percent
      }
      // A deck sheet is a CAD-class job for every purpose this queue has —
      // lane, tariff, refunds, restart handling — so it shares the preset and
      // only the engine entry point differs. spec.kind is that dispatch.
      const { model, glbPath, plan } =
        job.spec.kind === 'deck'
          ? await engine.deckBuild({
              inputPath: job.spec.inputPath,
              outDir: job.spec.outDir,
              page: job.spec.page,
              index: job.spec.index,
              scale: job.spec.scale,
              height: job.spec.height,
              signal: controller.signal,
              onProgress,
            })
          : await engine.reconstruct({
              inputPath: job.spec.inputPath,
              outDir: job.spec.outDir,
              unit: job.spec.unit,
              layers: job.spec.layers,
              autoLayers: job.spec.autoLayers !== false,
              height: job.spec.height,
              frame: job.spec.frame,
              signal: controller.signal,
              onProgress,
            })

      // A blocking verdict means the engine built something it does not
      // believe. Publishing that is worse than failing: a villa 4 cm across
      // renders beautifully, and nobody downstream can tell.
      const verify = model.verify ?? { ok: true, checks: [] }
      if (!verify.ok) {
        const why = (verify.checks ?? [])
          .filter((c) => c.level === 'blocking')
          .map((c) => c.message)
          .join(' ')
        await finish('failed', { error: `The drawing did not reconstruct. ${why}` })
        return
      }

      const outputUrl = glbPath ? await publish(glbPath, job) : null
      const planUrl = plan ? await publish(plan, job).catch(() => null) : null
      await finish('done', {
        progress: 100,
        outputUrl,
        planUrl,
        markers: {
          device: 'cpu',
          rooms: model.rooms?.count ?? 0,
          named: model.rooms?.named ?? 0,
          walls: model.walls?.total ?? 0,
          openings: model.openings?.total ?? 0,
          unit: model.unit,
          layers: model.layersUsed,
          // Deck sheets carry scale evidence instead of a drawing unit; the
          // reviewer's question there is "was the scale confirmed or guessed".
          ...(model.scale
            ? {
                scale: model.scale.metresPerUnit,
                scaleConfirmed: Boolean(model.scale.confirmed),
              }
            : {}),
        },
      })
    } catch (error) {
      await finish('failed', { error: error.message })
    }
    return
  }

  if (MODE === 'remote') {
    try {
      const response = await fetch(`${WORKER_URL}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': process.env.WORKER_SECRET ?? '',
        },
        body: JSON.stringify({ jobId: job.id, spec: job.spec }),
      })
      if (!response.ok) throw new Error(`worker returned ${response.status}`)
      // The worker owns the job now and will call back when it finishes.
      running.set(job.id, { child: null, startedAt: Date.now(), progress: 0 })
    } catch (err) {
      await finish('failed', { error: `Could not reach render worker: ${err.message}` })
    }
    return
  }

  // ---- Local Blender ------------------------------------------------------
  const args = [
    '--background',
    '--factory-startup', // ignore whatever add-ons happen to be installed
    '--python',
    SCRIPT,
    '--',
    '--spec',
    JSON.stringify(job.spec),
    '--job-id',
    job.id,
  ]

  let child
  try {
    child = spawn(BLENDER, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    await finish('failed', { error: `Could not start Blender: ${err.message}` })
    return
  }

  const limit = timeoutFor(job)
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    void finish('failed', {
      error: `${job.preset === 'bake' ? 'Bake' : 'Render'} exceeded ${Math.round(limit / 60000)} minutes and was stopped.`,
    })
  }, limit)

  const entry = { child, startedAt: Date.now(), progress: 0, markers: {}, timer }
  running.set(job.id, entry)

  let stderr = ''
  let outputPath = null

  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    // Blender prints "Fra:1 Mem:… | Sample 12/32" — parse it for real progress
    // instead of showing an indeterminate spinner for minutes.
    //
    // A *bake* prints no such line. `bpy.ops.object.bake()` is a single atomic
    // call that reports nothing until it returns, so progress legitimately sits
    // at zero for the whole of the slowest operation there is. A client must
    // say "running, N minutes in" rather than draw a bar that has not moved —
    // see the elapsed-time fallback in the studio.
    const sample = text.match(/Sample (\d+)\/(\d+)/)
    if (sample) {
      entry.progress = Math.round((Number(sample[1]) / Number(sample[2])) * 100)
    }

    // The worker's own markers: ARCVIA_DEVICE, ARCVIA_BAKE_UV, ARCVIA_BAKE_CELLS.
    // Kept because they answer the questions actually asked about a slow or
    // wrong-looking bake — which device it ran on, whether it used the UVs it
    // was sent, how many atlas cells it packed — and none of them survives the
    // process exiting.
    for (const [, key, value] of text.matchAll(/ARCVIA_([A-Z_]+):(.*)/g)) {
      if (key === 'OUTPUT') outputPath = value.trim()
      else if (key !== 'ERROR') entry.markers[key.toLowerCase()] = value.trim()
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })

  child.on('error', (err) => {
    void finish('failed', { error: `Blender failed to run: ${err.message}` })
  })

  child.on('close', (code) => {
    if (!running.has(job.id)) return // already cancelled or timed out

    // A multi-view run that rendered SOME of its views is not done.
    //
    // ── The partial success this closes ─────────────────────────────────────
    // `render_views.py` prints `ARCVIA_DONE:<n>/<total>` and the marker loop
    // above already captures it, so a 22-view run that lost two views recorded
    // `markers.done = "20/22"` on the job. Nothing ever compared the two
    // numbers. The run exited 0, printed ARCVIA_OUTPUT for the views that did
    // work, published, and finished as `done` at 100% — with the evidence of its
    // own incompleteness sitting in the job record, unread.
    //
    // It is worse than a clean failure because of how resuming works: a view is
    // skipped when its PNG already exists, so a retry of a job marked `done`
    // never asks for the missing frames again. The customer has a complete-
    // looking job that is permanently two frames short.
    //
    // Not hypothetical — three of the six styles do not currently render, and
    // Blender EXITS 0 ON A PYTHON TRACEBACK, so the exit code cannot be the
    // check. The existing `code === 0 && outputPath` guard is what stops a
    // total failure from publishing; this is the same guard for a partial one.
    //
    // Absence of the marker is NOT a failure: `render.py`, the single-image
    // path, never prints it. Only a marker that is present and short counts.
    const short = viewsMissing(entry.markers)
    if (short) {
      void finish('failed', {
        markers: entry.markers,
        error:
          `Rendered ${short.done} of ${short.total} views. The run exited ` +
          `cleanly but did not finish — Blender returns 0 even on a Python ` +
          `error, so the exit code cannot be trusted here. Retrying re-renders ` +
          `only the missing views.\n` +
          (stderr.trim().split('\n').slice(-3).join('\n') || ''),
      })
      return
    }

    if (code === 0 && outputPath) {
      void publish(outputPath, job)
        .then((url) =>
          finish('done', { progress: 100, outputUrl: url, markers: entry.markers }),
        )
        .catch((err) =>
          finish('failed', { error: `Render finished but could not be stored: ${err.message}` }),
        )
    } else {
      void finish('failed', {
        error: stderr.trim().split('\n').slice(-3).join('\n') || `Blender exited ${code}`,
      })
    }
  })
}

/**
 * Whether a multi-view run finished short of the views it was asked for.
 *
 * Returns `{ done, total }` when the worker reported progress AND that progress
 * is incomplete, otherwise null. Exported so the rule can be tested without a
 * Blender process — it is a decision about a string, and burying it in a `close`
 * callback made it untestable and therefore untested, which is how it came to be
 * recorded on every job and read by nothing.
 *
 * A missing marker returns null on purpose. `render.py`, the single-image path,
 * never prints ARCVIA_DONE, and treating silence as failure would fail every
 * ordinary render.
 */
export function viewsMissing(markers) {
  const progressed = /^(\d+)\/(\d+)$/.exec((markers && markers.done) || '')
  if (!progressed) return null
  const done = Number(progressed[1])
  const total = Number(progressed[2])
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return done < total ? { done, total } : null
}

/**
 * Move a finished render into storage and return a URL the browser can fetch.
 *
 * Blender writes to a temporary directory and prints the path. That path was
 * previously stored as `outputUrl` verbatim — which is a filesystem path on
 * the server, not a URL, so a completed render was unreachable from the client
 * that asked for it. The job reported "done" and there was nothing to show.
 *
 * Storing it content-addressed also means an identical re-render costs no extra
 * disk, and the URL is immutable enough to cache forever.
 */
async function publish(outputPath, job) {
  const bytes = await readFile(outputPath)
  const BY_EXTENSION = {
    '.glb': 'model/gltf-binary',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }
  const contentType = BY_EXTENSION[extname(outputPath)] ?? 'image/png'

  const stored = await put(bytes, contentType, {
    prefix: `renders/${job.ownerId}`,
  })

  // ── Delete the temp render once it is safely in content-addressed storage ─
  // `put()` copied the bytes into their durable, hashed key; this `outputPath`
  // is the worker's scratch output and nothing reads it again. Left behind, it
  // was a full-size byte-identical orphan per render, forever — measured on
  // this repo at .data/renders full of duplicates of the uploads. Removed only
  // AFTER put() returns, so a failed copy still leaves the evidence, and
  // best-effort because a missing temp is the desired end state anyway.
  //
  // NOTE: the multi-view path's per-view PNGs live under job.spec.outDir and
  // are the resume cache render_views.py checks (a view whose file exists is
  // skipped on retry). Those are deliberately NOT swept here — sweeping the
  // outDir needs to preserve resume semantics and is a separate change.
  await unlink(outputPath).catch(() => {})

  return stored.url
}
