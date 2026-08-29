import { nanoid } from 'nanoid'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createSqliteDb } from './lib/sqliteStore.js'

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

const DB_PROVIDER = String(
  process.env.DB_PROVIDER ??
    (process.env.NODE_ENV === 'production' ? 'sqlite' : 'json'),
).toLowerCase()
if (!['json', 'sqlite'].includes(DB_PROVIDER)) {
  throw new Error(`DB_PROVIDER=${DB_PROVIDER} is unsupported; use json or sqlite`)
}
const DB_PATH = resolve(
  process.env.DB_PATH ??
    (DB_PROVIDER === 'sqlite' ? './.data/arcvia.sqlite' : './.data/db.json'),
)

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

  let raw = null
  try {
    raw = await readFile(DB_PATH, 'utf8')
  } catch (error) {
    // A missing file is the one absence that MEANS something: a fresh install.
    // Anything else — permissions, an unreadable disk — must surface, because
    // starting empty over a database that exists is data loss with extra steps.
    if (error.code !== 'ENOENT') throw error
  }

  if (raw === null) {
    cache = structuredClone(EMPTY)
    return cache
  }

  try {
    cache = JSON.parse(raw)
  } catch {
    // ── A corrupt database is a stop, never a shrug ─────────────────────────
    // This used to be `catch { cache = EMPTY }`, which read as tolerance and
    // acted as deletion: a half-written or damaged db.json booted the product
    // with zero users, zero scenes and a zero credit ledger, and the first
    // flush then OVERWROTE the evidence with the empty state. Nobody sees an
    // error; they see a product that has forgotten them.
    //
    // The file is quarantined first, so what remains of the data survives the
    // crash-loop that follows a throw in load(), and the error says where it
    // is. Recovery is a human decision — restore the quarantine, or delete
    // db.json to genuinely start over — not something to guess at in a catch.
    const quarantine = `${DB_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(DB_PATH, quarantine)
    throw new Error(
      `${DB_PATH} is not valid JSON — refusing to start over it. ` +
        `The damaged file is preserved at ${quarantine}. ` +
        `Restore a good copy, or delete db.json to start empty on purpose.`,
    )
  }

  // Tolerate a db.json written by an older version that lacks a collection.
  for (const key of Object.keys(EMPTY)) cache[key] ??= []
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
  // The `.catch` keeps the CHAIN alive, not the failure quiet. Without it one
  // failed write — a full disk, a locked file — left `writeQueue` permanently
  // rejected, and every write for the rest of the process's life failed with
  // the first one's error. The caller of the failing flush still gets its
  // rejection through the promise returned below; only the next writer starts
  // from a clean chain. Nothing is lost in between: the cache still holds the
  // un-flushed records, and the next successful flush writes all of them.
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(DB_PATH), { recursive: true })

    // ── Write aside, then rename — never in place ───────────────────────────
    // `writeFile(DB_PATH, ...)` truncates the real database to zero bytes and
    // then fills it. A crash, a power cut or a full disk in that window leaves
    // db.json torn — and a torn db.json used to boot as an EMPTY one (see
    // load), which turned a bad moment into total loss. A rename on the same
    // volume is atomic: at every instant the path holds either the old
    // complete state or the new complete state, and never a prefix of one.
    const tmp = `${DB_PATH}.tmp`
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    await rename(tmp, DB_PATH)
  })
  return writeQueue
}

const jsonDb = {
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

export const db =
  DB_PROVIDER === 'sqlite' ? createSqliteDb(DB_PATH, () => nanoid(12)) : jsonDb

export { nanoid }
