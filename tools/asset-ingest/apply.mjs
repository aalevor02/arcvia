#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Merge ingested models into the catalogue.
 *
 *   node tools/asset-ingest/apply.mjs            # apply .data/catalogue-additions.json
 *   node tools/asset-ingest/apply.mjs --check    # report what would change
 *
 * ── Why this is a separate step ─────────────────────────────────────────────
 * The batch runner deliberately writes to a file instead of editing
 * `items.ts`, because every entry it produces carries a licence somebody is
 * accepting on the product's behalf, and a script that silently rewrites the
 * catalogue makes that invisible.
 *
 * This is the other half of that: applying is one command, and what it did is a
 * git diff. Automating the tedium without automating the decision.
 *
 * ── On editing source by string surgery ─────────────────────────────────────
 * Parsing TypeScript properly to insert a field would need the compiler API for
 * something whose whole shape is known: each entry is a flat object literal,
 * ending at a line that is exactly two spaces and a brace. The insert is
 * anchored on the item's own id and refuses anything it cannot place exactly,
 * which is the property that matters — a partial edit to a catalogue is worse
 * than no edit.
 */

const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '../..',
)

const check = process.argv.includes('--check')
// Replace an existing model rather than skipping it. Needed whenever the
// picker improves and an item deserves a better asset than the one it has.
const replace = process.argv.includes('--replace')
const itemsPath = join(root, 'apps/studio/src/catalogue/items.ts')
const additionsPath = join(root, '.data/catalogue-additions.json')

const additions = JSON.parse(await readFile(additionsPath, 'utf8'))
let source = await readFile(itemsPath, 'utf8')

const applied = []
const skipped = []

for (const [id, entry] of Object.entries(additions)) {
  const at = source.indexOf(`    id: '${id}',`)
  if (at === -1) {
    skipped.push({ id, why: 'no catalogue entry with that id' })
    continue
  }

  // The end of this object literal. Entries are formatted one per line at two
  // levels of indent, so the first `\n  },` after the id closes it.
  let end = source.indexOf('\n  },', at)
  if (end === -1) {
    skipped.push({ id, why: 'could not find the end of the entry' })
    continue
  }

  let body = source.slice(at, end)
  if (body.includes('model: {')) {
    if (!replace) {
      skipped.push({ id, why: 'already has a model (use --replace)' })
      continue
    }

    // Cut the old block out before inserting the new one. Anchored on the
    // exact indentation the writer below emits, so it can only ever match a
    // block this tool produced.
    const OPEN = '\n    model: {'
    const CLOSE = '\n    },'

    const from = body.indexOf(OPEN)
    const to = body.indexOf(CLOSE, from)
    if (from === -1 || to === -1) {
      skipped.push({ id, why: 'has a model block this tool cannot safely replace' })
      continue
    }

    const cleaned = body.slice(0, from) + body.slice(to + CLOSE.length)
    source = source.slice(0, at) + cleaned + source.slice(end)
    body = cleaned
    end = at + cleaned.length
  }

  const model = entry.model
  const lines = [
    '',
    '    model: {',
    `      url: '${model.url}',`,
    `      licence: '${model.licence.replace(/'/g, "\\'")}',`,
    `      author: '${model.author.replace(/'/g, "\\'")}',`,
    `      source:`,
    `        '${model.source}',`,
    ...(model.triangles ? [`      triangles: ${model.triangles},`] : []),
    ...(model.yaw ? [`      yaw: ${model.yaw},`] : []),
    '    },',
  ]

  source = source.slice(0, end) + lines.join('\n') + source.slice(end)
  applied.push({ id, author: model.author, triangles: model.triangles, yaw: model.yaw ?? 0 })
}

for (const entry of applied) {
  console.log(
    `${entry.id.padEnd(16)} ${String(entry.author).slice(0, 22).padEnd(24)} ` +
      `${String(entry.triangles).padStart(6)}t` +
      (entry.yaw ? `  yaw ${entry.yaw}°` : ''),
  )
}
for (const entry of skipped) console.log(`skip ${entry.id.padEnd(16)} ${entry.why}`)

if (check) {
  console.log(`\n${applied.length} would be applied, ${skipped.length} skipped (--check)`)
  process.exit(0)
}

await writeFile(itemsPath, source)
console.log(`\n${applied.length} applied, ${skipped.length} skipped`)
console.log('Review with: git diff apps/studio/src/catalogue/items.ts')

// Attribution is the reason this file exists. Counting it out loud is the
// cheapest way to make the obligation visible to whoever runs this.
const owed = applied.filter((entry) => entry.author && entry.author !== 'Unknown')
console.log(`\n${owed.length} model(s) require author credit in every published walkthrough.`)
console.log('That is handled automatically by catalogue/credits.ts — nothing further to do.')
