import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { db } from '../store.js'
import { renderWithAi } from './aiRender.js'
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
const SCRIPT = resolve(
  process.env.BLENDER_SCRIPT ?? '../../services/render-worker/render.py',
)

/**
 * How many jobs may render at once.
 *
 * This is the single most important number for cost control in remote mode:
 * concurrency multiplied by GPU hourly rate is your worst-case burn. Default 1.
 */
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 1)

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

const timeoutFor = (job) => (job.preset === 'bake' ? BAKE_TIMEOUT_MS : JOB_TIMEOUT_MS)

/**
 * Daily cap on completed jobs across the whole install. Once hit, submissions
 * still queue but nothing starts until the counter rolls over. A crude but very
 * effective circuit breaker against a bug that submits in a loop.
 */
const DAILY_JOB_CAP = Number(process.env.RENDER_DAILY_CAP ?? 500)

const pending = []
const running = new Map() // jobId -> { child, startedAt, timer }
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
  return pending.length + running.size
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
  if (pending.some((j) => j.id === jobId)) {
    return { status: 'queued', progress: 0, elapsedMs: 0, markers: {} }
  }
  return null
}

export async function enqueue(job) {
  pending.push(job)
  drain()
}

export async function cancelJob(jobId) {
  const index = pending.findIndex((j) => j.id === jobId)
  if (index !== -1) {
    pending.splice(index, 1)
    return true
  }

  const active = running.get(jobId)
  if (active) {
    clearTimeout(active.timer)
    active.child?.kill('SIGTERM')
    running.delete(jobId)
    drain()
    return true
  }
  return false
}

function drain() {
  rollDayIfNeeded()

  while (running.size < CONCURRENCY && pending.length > 0) {
    if (completedToday >= DAILY_JOB_CAP) {
      // Deliberately leaves jobs queued rather than failing them — the cap is a
      // spend guard, not a rejection. They run when the day rolls over.
      console.warn(
        `[renderQueue] daily cap of ${DAILY_JOB_CAP} reached; holding ${pending.length} job(s)`,
      )
      return
    }

    const job = pending.shift()
    void start(job)
  }
}

async function start(job) {
  await db.update('renderJobs', job.id, { status: 'rendering' })

  const finish = async (status, patch = {}) => {
    const active = running.get(job.id)
    if (active) clearTimeout(active.timer)
    running.delete(job.id)

    if (status === 'done') completedToday += 1
    await db.update('renderJobs', job.id, { status, ...patch })
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
  const contentType = extname(outputPath) === '.glb' ? 'model/gltf-binary' : 'image/png'

  const stored = await put(bytes, contentType, {
    prefix: `renders/${job.ownerId}`,
  })

  return stored.url
}
