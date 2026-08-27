import { createHash } from 'node:crypto'
import { createReadStream, readdirSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

const [canonicalArg, staleArg] = process.argv.slice(2)
if (!canonicalArg || !staleArg) {
  console.error('Usage: node tools/compare-trees.mjs <canonical-root> <stale-root>')
  process.exit(2)
}

const canonicalRoot = resolve(canonicalArg)
const staleRoot = resolve(staleArg)
const skippedDirectories = new Set([
  '.git', 'node_modules', '.venv', 'venv', '.data', 'dist', 'build', 'out',
  'coverage', '.cache', '.vite', '.astro', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache',
])
const skippedFile = /\.(?:pyc|pyo|log|tmp|cache|pem|key|pfx|p12)$/i

function filesUnder(root) {
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        entry.isFile()
        && entry.name !== '.env'
        && !(entry.name.startsWith('.env.') && !entry.name.startsWith('.env.example'))
        && !skippedFile.test(entry.name)
      ) found.push(path)
    }
  }
  visit(root)
  return found
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function inventory(root) {
  const rows = new Map()
  for (const path of filesUnder(root)) {
    const key = relative(root, path).split(sep).join('/').toLowerCase()
    rows.set(key, { path, relative: relative(root, path).split(sep).join('/'), hash: await sha256(path) })
  }
  return rows
}

const [canonical, stale] = await Promise.all([inventory(canonicalRoot), inventory(staleRoot)])
const only = []
const changed = []
let same = 0

for (const [key, staleFile] of stale) {
  const canonicalFile = canonical.get(key)
  if (!canonicalFile) only.push(staleFile)
  else if (canonicalFile.hash === staleFile.hash) same += 1
  else changed.push({ ...staleFile, canonicalHash: canonicalFile.hash })
}

only.sort((a, b) => a.relative.localeCompare(b.relative))
changed.sort((a, b) => a.relative.localeCompare(b.relative))

console.log(`canonical included: ${canonical.size}`)
console.log(`stale included: ${stale.size}`)
console.log(`same relative path + hash: ${same}`)
console.log(`same relative path, different hash: ${changed.length}`)
console.log(`stale-only relative path: ${only.length}`)
console.log('\nSTALE_ONLY\tSHA256[:12]\tRELATIVE_PATH')
for (const file of only) console.log(`ONLY\t${file.hash.slice(0, 12)}\t${file.relative}`)
console.log('\nDIFFERENT\tSTALE_SHA[:12]\tCANONICAL_SHA[:12]\tRELATIVE_PATH')
for (const file of changed) {
  console.log(`DIFF\t${file.hash.slice(0, 12)}\t${file.canonicalHash.slice(0, 12)}\t${file.relative}`)
}
