import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const node = process.execPath
const mode = process.argv[2] ?? 'all'
const validModes = new Set(['types', 'js', 'python', 'bim', 'build', 'all'])

if (!validModes.has(mode)) {
  console.error(`Unknown validation family: ${mode}`)
  console.error(`Choose one of: ${[...validModes].join(', ')}`)
  process.exit(2)
}

const results = []

function run(label, command, args, cwd = ROOT, options = {}) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    // Windows exposes npm as a .cmd shim rather than an executable. Node's
    // spawnSync needs the shell explicitly for that shim; the command is a
    // fixed npm path chosen above, never caller-provided input.
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  })

  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }

  // Exit 3 means the suite RAN but could not complete a case -- today only
  // "the machine did not have the memory to load the checkpoint". It is
  // deliberately not 'passed': a run that skipped work is not a clean run, and
  // it is deliberately not 'failed' either, because reporting a resource
  // shortage as a regression is what sent two investigations looking for a bug
  // that was never there. 'blocked' already means exactly this and already
  // goes red, so the summary names the reason instead of hiding it.
  const status = result.error
    ? 'blocked'
    : result.status === 0
      ? 'passed'
      : result.status === 3
        ? 'blocked'
        : 'failed'
  const detail =
    result.error?.message ??
    (result.status === 3
      ? 'ran, but skipped cases it could not complete -- see its output above'
      : `exit ${result.status ?? 'unknown'}`)
  results.push({ family: options.family ?? mode, label, status, detail })
  return { ...result, validationStatus: status }
}

function runTypes() {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  for (const [label, config] of [
    ['types:studio', 'apps/studio/tsconfig.json'],
    ['types:visualisation', 'apps/visualisation/tsconfig.json'],
    ['types:planviewer', 'apps/planviewer/tsconfig.json'],
  ]) {
    run(label, node, [tsc, '--project', config, '--noEmit', '--pretty', 'false'], ROOT, {
      family: 'types',
    })
  }

  run('types:web (astro check)', npm, ['run', 'check', '--workspace=apps/web'], ROOT, {
    family: 'types',
  })

  // This tracked contract is not an npm workspace and has no tsconfig yet.
  // Check it explicitly so it cannot disappear from the green workspace build.
  run('types:building-model (standalone contract)', node, [
    tsc,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module', 'ESNext',
    '--moduleResolution', 'bundler',
    '--target', 'ES2022',
    'packages/building-model/src/schema.ts',
    'packages/building-model/src/buildplan.ts',
  ], ROOT, { family: 'types' })
}

// Two of the JS suites drive a running server rather than booting their own.
// With nothing listening they used to report FAILED, which says "the code is
// broken" about a machine that simply has no server started — and
// docs/validation.md never mentioned the requirement, so `npm run validate` on
// a clean checkout produced two red lines that no code change could fix.
//
// That is the same shape as every other defect in this repository's notes: the
// summary could not express "did not run", so it said the nearest thing.
// 'blocked' already means exactly this, already goes red, and already refuses
// to count as a pass. The only thing missing was noticing the condition, and
// saying which command fixes it.
function serverUp(origin) {
  const probe = spawnSync(
    node,
    ['-e', `fetch(${JSON.stringify(origin)}).then(() => process.exit(0)).catch(() => process.exit(1))`],
    { cwd: ROOT, encoding: 'utf8', timeout: 8000 },
  )
  return probe.status === 0
}

function runJavaScript() {
  for (const [label, command, args, cwd, needs] of [
    ['js:brand', npm, ['test', '--workspace=packages/brand'], ROOT],
    ['js:studio', npm, ['test', '--workspace=apps/studio'], ROOT],
    ['js:api', npm, ['test', '--workspace=services/api'], ROOT, {
      origin: 'http://127.0.0.1:8787/health',
      start: 'npm run dev:api',
      what: 'the API',
    }],
    ['js:asset-ingest', node, ['licence.test.mjs'], join(ROOT, 'tools', 'asset-ingest')],
    ['js:render-worker-atlas', node, ['check_atlas.test.mjs'], join(ROOT, 'services', 'render-worker')],
    ['js:web-linkcheck', npm, ['run', 'linkcheck', '--workspace=apps/web'], ROOT, {
      origin: 'http://127.0.0.1:4321/',
      start: 'npm run dev:web',
      what: 'the marketing site',
    }],
  ]) {
    if (needs && !serverUp(needs.origin)) {
      console.log(`\n=== ${label} ===`)
      console.log(`BLOCKED  nothing is listening at ${needs.origin}`)
      console.log(`         This suite drives a running server; it does not boot one.`)
      console.log(`         Start ${needs.what} first:  ${needs.start}`)
      results.push({
        family: 'js',
        label,
        status: 'blocked',
        detail: `needs ${needs.what} at ${needs.origin} — start it with \`${needs.start}\``,
      })
      continue
    }
    run(label, command, args, cwd, { family: 'js' })
  }
}

function pythonCandidates(service, envName) {
  const candidates = []
  const add = (display, command, prefix = []) => {
    if (command && !candidates.some((item) => item.display === display)) {
      candidates.push({ display, command, prefix })
    }
  }

  add(envName, process.env[envName])
  add('ARCVIA_PYTHON', process.env.ARCVIA_PYTHON)
  if (process.platform === 'win32') {
    add(`${service}/.venv`, join(ROOT, service, '.venv', 'Scripts', 'python.exe'))
    add('py -3.12', 'py', ['-3.12'])
    add('py -3.11', 'py', ['-3.11'])
    add('py -3.10', 'py', ['-3.10'])
  } else {
    add(`${service}/.venv`, join(ROOT, service, '.venv', 'bin', 'python'))
  }
  add('python3.12', 'python3.12')
  add('python3.11', 'python3.11')
  add('python3.10', 'python3.10')
  add('python3', 'python3')
  add('python', 'python')
  return candidates
}

function discoverPython({ service, envName, imports }) {
  console.log(`\n=== discover:${service} ===`)
  for (const candidate of pythonCandidates(service, envName)) {
    const probe = spawnSync(candidate.command, [
      ...candidate.prefix,
      '-c',
      `import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')`,
    ], { cwd: ROOT, encoding: 'utf8', env: process.env })

    if (probe.error || probe.status !== 0) {
      const why = probe.error?.message ?? (probe.stderr || `exit ${probe.status}`).trim()
      console.log(`skip ${candidate.display}: ${why.split(/\r?\n/)[0]}`)
      continue
    }

    const version = probe.stdout.trim().split(/\r?\n/).at(-1)
    const [major, minor] = version.split('.').map(Number)
    if (major !== 3 || minor < 10 || minor > 12) {
      console.log(`skip ${candidate.display}: Python ${version} is outside supported 3.10-3.12`)
      continue
    }

    const dependencyProbe = spawnSync(candidate.command, [
      ...candidate.prefix,
      '-c',
      imports.map((name) => `import ${name}`).join(';'),
    ], { cwd: join(ROOT, service), encoding: 'utf8', env: process.env })
    if (dependencyProbe.error || dependencyProbe.status !== 0) {
      const why = dependencyProbe.error?.message ?? dependencyProbe.stderr.trim()
      console.log(`skip ${candidate.display} (${version}): dependencies unavailable: ${why.split(/\r?\n/).at(-1)}`)
      continue
    }

    console.log(`use ${candidate.display}: Python ${version}`)
    return candidate
  }
  return null
}

function pythonFiles(service, exclude = new Set()) {
  return readdirSync(join(ROOT, service, 'test'))
    .filter((name) => /^test_.*\.py$/.test(name) && !exclude.has(name))
    .sort()
}

function runPython() {
  const services = [
    {
      service: 'services/reconstruct',
      envName: 'RECONSTRUCT_PYTHON',
      imports: ['cv2', 'ezdxf', 'fastapi', 'numpy', 'pdfplumber', 'pydantic', 'pypdfium2', 'shapely'],
      files: pythonFiles('services/reconstruct', new Set(['test_plangraph.py'])),
    },
    {
      service: 'services/floorplan-ai',
      envName: 'FLOORPLAN_PYTHON',
      imports: ['cv2', 'fastapi', 'numpy', 'pdfplumber', 'pydantic', 'pypdfium2'],
      files: pythonFiles('services/floorplan-ai'),
    },
  ]

  for (const suite of services) {
    const python = discoverPython(suite)
    if (!python) {
      console.error(`BLOCKED ${suite.service}: no supported interpreter with required dependencies.`)
      results.push({
        family: 'python',
        label: `python:${suite.service}`,
        status: 'blocked',
        detail: `set ${suite.envName} or ARCVIA_PYTHON`,
      })
      continue
    }
    for (const file of suite.files) {
      run(
        `python:${suite.service}:${file}`,
        python.command,
        [...python.prefix, join('test', file)],
        join(ROOT, suite.service),
        { family: 'python' },
      )
    }
  }
}

function runBim() {
  const suite = {
    service: 'services/reconstruct',
    envName: 'RECONSTRUCT_PYTHON',
    imports: ['cv2', 'ezdxf', 'numpy', 'shapely'],
  }
  const python = discoverPython(suite)
  if (!python) {
    console.error('BLOCKED BIM fixtures: no supported reconstruction interpreter.')
    results.push({
      family: 'bim',
      label: 'bim:test_plangraph.py',
      status: 'blocked',
      detail: 'set RECONSTRUCT_PYTHON or ARCVIA_PYTHON',
    })
    return
  }
  run(
    'bim:test_plangraph.py',
    python.command,
    [...python.prefix, join('test', 'test_plangraph.py')],
    join(ROOT, suite.service),
    { family: 'bim' },
  )
}

function runBuild() {
  for (const workspace of ['apps/web', 'apps/studio', 'apps/planviewer', 'apps/visualisation']) {
    run(`build:${workspace}`, npm, ['run', 'build', `--workspace=${workspace}`], ROOT, {
      family: 'build',
    })
  }
}

const families = mode === 'all' ? ['types', 'js', 'python', 'bim', 'build'] : [mode]
for (const family of families) {
  if (family === 'types') runTypes()
  else if (family === 'js') runJavaScript()
  else if (family === 'python') runPython()
  else if (family === 'bim') runBim()
  else if (family === 'build') runBuild()
}

console.log('\n=== validation summary ===')
for (const family of families) {
  const rows = results.filter((result) => result.family === family)
  const count = (status) => rows.filter((result) => result.status === status).length
  console.log(`${family}: ${count('passed')} passed, ${count('failed')} failed, ${count('blocked')} blocked`)
  for (const result of rows.filter((result) => result.status !== 'passed')) {
    console.log(`  ${result.status.toUpperCase()} ${result.label}: ${result.detail}`)
  }
}

process.exit(results.some((result) => result.status !== 'passed') ? 1 : 0)
