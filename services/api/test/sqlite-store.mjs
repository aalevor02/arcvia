/**
 * Transactional production persistence.
 *
 * Run: node test/sqlite-store.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDb } from '../src/lib/sqliteStore.js'

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'arcvia-sqlite-'))
const path = join(dir, 'nested', 'arcvia.sqlite')

try {
  let nextId = 1
  let db = createSqliteDb(path, () => `id-${nextId++}`)

  const first = await db.insert('users', { email: 'first@example.com' })
  ok('insert assigns an id', first.id === 'id-1')
  ok('insert assigns a creation timestamp', Boolean(first.createdAt))
  ok(
    'find applies the caller predicate',
    (await db.find('users', (user) => user.email.startsWith('first'))).length === 1,
  )
  ok(
    'findOne returns null when no row matches',
    (await db.findOne('users', (user) => user.email === 'missing@example.com')) === null,
  )

  const updated = await db.update('users', first.id, { email: 'updated@example.com' })
  ok(
    'update preserves identity and records the patch',
    updated?.id === first.id && updated.email === 'updated@example.com' && updated.updatedAt,
  )
  ok('update returns null for a missing id', (await db.update('users', 'absent', {})) === null)
  ok('remove returns false for a missing id', (await db.remove('users', 'absent')) === false)

  await db.insert('leads', { name: 'durable' })
  db.close()

  db = createSqliteDb(path, () => `id-${nextId++}`)
  ok(
    'records survive close and reopen',
    (await db.findOne('leads', (lead) => lead.name === 'durable'))?.name === 'durable',
  )
  ok('remove persists a deletion', await db.remove('users', first.id))
  db.close()

  let shouldThrow = true
  db = createSqliteDb(path, () => {
    if (shouldThrow) {
      shouldThrow = false
      throw new Error('synthetic id failure')
    }
    return 'after-rollback'
  })
  let rejected = false
  try {
    await db.insert('referrals', { code: 'bad' })
  } catch {
    rejected = true
  }
  ok('a failed mutation rejects', rejected)
  await db.insert('referrals', { code: 'good' })
  ok(
    'a failed mutation rolls back and the next transaction succeeds',
    (await db.find('referrals')).length === 1 &&
      (await db.find('referrals'))[0].code === 'good',
  )

  let unknownRejected = false
  try {
    await db.find('notACollection')
  } catch {
    unknownRejected = true
  }
  ok('unknown collections are rejected', unknownRejected)
  db.close()
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
