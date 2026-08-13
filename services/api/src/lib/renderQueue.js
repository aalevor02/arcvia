import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { db } from '../store.js'

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

/** Hard ceiling on a single job. A runaway scene cannot bill for hours. */
const JOB_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 10 * 60 * 1000)

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
    return { status: 'rendering', progress: running.get(jobId).progress ?? 0 }
  }
  if (pending.some((j) => j.id === jobId)) {
    return { status: 'queued', progress: 0 }
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

  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    void finish('failed', { error: `Render exceeded ${JOB_TIMEOUT_MS / 1000}s and was stopped.` })
  }, JOB_TIMEOUT_MS)

  const entry = { child, startedAt: Date.now(), progress: 0, timer }
  running.set(job.id, entry)

  let stderr = ''
  let outputPath = null

  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    // Blender prints "Fra:1 Mem:… | Sample 12/32" — parse it for real progress
    // instead of showing an indeterminate spinner for minutes.
    const sample = text.match(/Sample (\d+)\/(\d+)/)
    if (sample) {
      entry.progress = Math.round((Number(sample[1]) / Number(sample[2])) * 100)
    }
    const written = text.match(/ARCVIA_OUTPUT:(\S+)/)
    if (written) outputPath = written[1]
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
      void finish('done', { progress: 100, outputUrl: outputPath })
    } else {
      void finish('failed', {
        error: stderr.trim().split('\n').slice(-3).join('\n') || `Blender exited ${code}`,
      })
    }
  })
}
