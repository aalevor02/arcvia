/**
 * Where to crawl.
 *
 * This defaulted to `http://192.168.1.36:4321` — the LAN address of whichever
 * machine last ran it. Everywhere else `npm run linkcheck` failed with
 * `FETCH fetch failed /`, which reads like a broken site rather than a checker
 * pointed at a host that is not there, so the natural response is to go looking
 * for a bug in the pages.
 *
 * Loopback is the only address that means the same thing on every machine. Pass
 * an origin as the first argument to crawl a deployed site or a LAN address.
 */
const ORIGIN = (process.argv[2] ?? process.env.LINKCHECK_ORIGIN ?? 'http://127.0.0.1:4321')
  .replace(/\/$/, '')

// Say it before the first fetch, so a wrong target is obvious from the output
// rather than inferred from the failures.
console.log(`Crawling ${ORIGIN}\n`)

try {
  await fetch(ORIGIN + '/')
} catch (error) {
  console.error(
    `Cannot reach ${ORIGIN} — ${error.message}\n\n` +
      `Start the site first (npm run dev -w apps/web), or pass the origin:\n` +
      `  node test/linkcheck.mjs https://arcvia.com`,
  )
  process.exit(2)
}

const seen = new Set()
const queue = ['/']
const broken = []
const external = new Set()
const checked = []

function norm(href, base) {
  try {
    const u = new URL(href, base)
    if (u.origin !== ORIGIN) {
      external.add(u.href.split('#')[0])
      return null
    }
    u.hash = ''
    return u.pathname + u.search
  } catch {
    return null
  }
}

while (queue.length) {
  const p = queue.shift()
  if (seen.has(p)) continue
  seen.add(p)

  let res, body = ''
  try {
    res = await fetch(ORIGIN + p)
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('html')) body = await res.text()
  } catch (e) {
    broken.push([p, 'FETCH ' + e.message])
    continue
  }

  checked.push([res.status, p])
  if (!res.ok) broken.push([p, res.status])
  if (!body) continue

  for (const m of body.matchAll(/href="([^"]+)"/g)) {
    const n = norm(m[1], ORIGIN + p)
    if (n && !seen.has(n)) queue.push(n)
  }
}

console.log(`Checked ${checked.length} same-origin URLs on ${ORIGIN}\n`)
for (const [status, p] of checked.sort((a, b) => a[1].localeCompare(b[1]))) {
  console.log(`  ${status}  ${p}`)
}

console.log(`\nExternal links (${external.size}):`)
for (const e of [...external].sort()) console.log('  ' + e)

console.log(`\n${broken.length ? 'BROKEN:' : 'No broken internal links.'}`)
for (const [p, s] of broken) console.log(`  ${s}  ${p}`)
process.exit(broken.length ? 1 : 0)
