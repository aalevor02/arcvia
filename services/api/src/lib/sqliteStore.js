import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const COLLECTIONS = [
  'users',
  'organisations',
  'scenes',
  'publications',
  'renderJobs',
  'leads',
  'creditLedger',
  'referrals',
  'passwordResets',
  'handoffTickets',
]

function assertCollection(collection) {
  if (!COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown database collection: ${collection}`)
  }
}

/**
 * Transactional single-process persistence for Arcvia's production API.
 *
 * The public methods intentionally match the JSON driver's collection-shaped
 * async contract. Callers keep their predicates and do not know which durable
 * driver is active.
 */
export function createSqliteDb(path, makeId) {
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec(
    'CREATE TABLE IF NOT EXISTS arcvia_collections (' +
      'name TEXT PRIMARY KEY, docs TEXT NOT NULL, updated_at TEXT NOT NULL)',
  )

  const insertCollection = database.prepare(
    'INSERT OR IGNORE INTO arcvia_collections (name, docs, updated_at) VALUES (?, ?, ?)',
  )
  const now = new Date().toISOString()
  for (const collection of COLLECTIONS) {
    insertCollection.run(collection, '[]', now)
  }

  const readCollection = database.prepare(
    'SELECT docs FROM arcvia_collections WHERE name = ?',
  )
  const writeCollection = database.prepare(
    'UPDATE arcvia_collections SET docs = ?, updated_at = ? WHERE name = ?',
  )

  function read(collection) {
    assertCollection(collection)
    const row = readCollection.get(collection)
    if (!row) throw new Error(`SQLite collection is missing: ${collection}`)
    let docs
    try {
      docs = JSON.parse(row.docs)
    } catch {
      throw new Error(`SQLite collection is not valid JSON: ${collection}`)
    }
    if (!Array.isArray(docs)) {
      throw new Error(`SQLite collection is not an array: ${collection}`)
    }
    return docs
  }

  function mutate(collection, callback) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const docs = read(collection)
      const result = callback(docs)
      writeCollection.run(JSON.stringify(docs), new Date().toISOString(), collection)
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  return {
    async find(collection, predicate = () => true) {
      return read(collection).filter(predicate)
    },

    async findOne(collection, predicate) {
      return read(collection).find(predicate) ?? null
    },

    async insert(collection, doc) {
      return mutate(collection, (docs) => {
        const record = {
          id: doc.id ?? makeId(),
          createdAt: new Date().toISOString(),
          ...doc,
        }
        docs.push(record)
        return record
      })
    },

    async update(collection, id, patch) {
      return mutate(collection, (docs) => {
        const index = docs.findIndex((doc) => doc.id === id)
        if (index === -1) return null
        docs[index] = {
          ...docs[index],
          ...patch,
          updatedAt: new Date().toISOString(),
        }
        return docs[index]
      })
    },

    async remove(collection, id) {
      return mutate(collection, (docs) => {
        const index = docs.findIndex((doc) => doc.id === id)
        if (index === -1) return false
        docs.splice(index, 1)
        return true
      })
    },

    close() {
      database.close()
    },
  }
}
