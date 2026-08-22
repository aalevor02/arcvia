import { nanoid } from 'nanoid'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * Persistence.
 *
 * Deliberately a thin, swappable layer. Right now it is a JSON file on disk,
 * which is enough to run the whole product locally with zero infrastructure —
 * no Mongo, no Docker, no cloud account. Every function below is async and
 * collection-shaped, so replacing the body with a real MongoDB driver is a
 * mechanical change that touches this file only.
 *
 * The point: you should be able to `npm run dev` and have a working backend on
 * a laptop with no network. Infrastructure is a deployment concern, not a
 * prerequisite for writing code.
 */

const DB_PATH = resolve(process.env.DB_PATH ?? './.data/db.json')

const EMPTY = {
  users: [],
  organisations: [],
  scenes: [],
  publications: [],
  renderJobs: [],
  leads: [],
  creditLedger: [],
  referrals: [],
  passwordResets: [],
  handoffTickets: [],
}

let cache = null
let writeQueue = Promise.resolve()

async function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(DB_PATH, 'utf8'))
    // Tolerate a db.json written by an older version that lacks a collection.
    for (const key of Object.keys(EMPTY)) cache[key] ??= []
  } catch {
    cache = structuredClone(EMPTY)
  }
  return cache
}

/**
 * Serialise writes through a promise chain.
 *
 * Node is single-threaded but `await` yields, so two concurrent requests can
 * interleave between read and write and silently lose one of the two updates.
 * Chaining guarantees each flush completes before the next begins.
 */
function flush() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(DB_PATH), { recursive: true })
    await writeFile(DB_PATH, JSON.stringify(cache, null, 2), 'utf8')
  })
  return writeQueue
}

export const db = {
  async find(collection, predicate = () => true) {
    const data = await load()
    return data[collection].filter(predicate)
  },

  async findOne(collection, predicate) {
    const data = await load()
    return data[collection].find(predicate) ?? null
  },

  async insert(collection, doc) {
    const data = await load()
    const record = {
      id: doc.id ?? nanoid(12),
      createdAt: new Date().toISOString(),
      ...doc,
    }
    data[collection].push(record)
    await flush()
    return record
  },

  async update(collection, id, patch) {
    const data = await load()
    const index = data[collection].findIndex((d) => d.id === id)
    if (index === -1) return null
    data[collection][index] = {
      ...data[collection][index],
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await flush()
    return data[collection][index]
  },

  async remove(collection, id) {
    const data = await load()
    const before = data[collection].length
    data[collection] = data[collection].filter((d) => d.id !== id)
    if (data[collection].length !== before) await flush()
    return before !== data[collection].length
  },
}

export { nanoid }
