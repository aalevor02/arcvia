# Validation harness

The repository keeps validation families separate so an unavailable Python
environment cannot hide a TypeScript error, and a failed test cannot prevent the
remaining suites from reporting their own results.

Run these from the repository root:

```powershell
npm run check:types       # no-emit TypeScript/Astro checks
npm run test:js           # JavaScript and bundled TypeScript logic tests
npm run test:python       # Python service tests, one script at a time
npm run test:bim          # real-IFC PlanGraph fixture gate only
npm run build:production  # each production web workspace, independently
npm run compare:trees     # read-only canonical/stale relative-path SHA-256 audit
npm run validate          # all families; continues after individual failures
```

## CI/bootstrap order

Use a clean checkout and run each family as its own CI step so the first failure
cannot mask later diagnostics:

```powershell
npm ci
npm run check:types
npm run test:js
npm run test:python
npm run test:bim
npm run build:production
```

Set `RECONSTRUCT_PYTHON` and `FLOORPLAN_PYTHON` (or `ARCVIA_PYTHON`) in CI to
supported, dependency-complete Python 3.10–3.12 interpreters. The repository had
no provider-specific workflow before this lane; these commands are the portable
bootstrap contract for one.

Every family prints a summary of passed, failed, and blocked suites and exits
non-zero unless every requested suite passed. A blocked suite is never counted as
a pass.

## Two suites need a server, and one needs the detector

`npm run validate` on a clean checkout **cannot be green on its own**, and for a
while that looked like two code defects rather than a missing precondition. Two
JS suites drive a running server instead of booting their own:

| suite | needs | start it with |
|---|---|---|
| `js:api` | the API on `127.0.0.1:8787` | `npm run dev:api` |
| `js:web-linkcheck` | the marketing site on `127.0.0.1:4321` | `npm run dev:web` |

With nothing listening these now report **BLOCKED**, naming the origin and the
command, rather than FAILED. The distinction is the whole point: `failed` sends
a reader looking for a bug, and there was never one to find.

⚠ **`js:api` is worth more with the detector up as well.** `test/detect.mjs`
runs 32 assertions against a live detector and 19 without it — it skips the rest
honestly, so the run is not wrong, just smaller. Start it with
`npm run dev:detect`. Full green with all three services up is **507 assertions
across 29 files**.

⚠ **Check that exactly one process owns each port before trusting a result.**
Windows lets a second process bind a port already in use — no error, the last
binder just quietly starts answering. A second API appeared on `:8787` mid-run
once and two suites reported 13 failures that did not exist; the same files were
clean against a verified listener. The A: tree answers `/cad/health` with
`{"ok":true,...}`; the un-versioned C: copy 404s on that route.

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
curl :8787/cad/health     # 200 + an A:\ python path = the tree you meant
```

## `npm run dev:detect` starts the launcher, not uvicorn

The script used to invoke uvicorn directly, which reads only `os.environ` and so
started the detector with **no `FLOORPLAN_MODEL` and no `NVIDIA_API_KEY`** — the
trained classifier off and the vision adjudicator degraded, both silently, from
the command everyone types. It now runs `tools/dev-detect.ps1`, which loads
`.env`, falls back to the shared NVIDIA key file, and warns by name when either
value is missing or points at a path that is not a file.

Confirm it took: `curl :8090/health` must report `classifier.state` as `ready`,
not `not configured`. Note that `/health` describes the service **now** — to
check what was live when an earlier run happened, read that run's saved response
for its `detector:` notes instead.

## Python discovery

The checked-in virtual environments are conveniences, not portable configuration:
their launchers can retain an absolute path to the Python installation that created
them. The harness probes candidates in this order:

1. the service-specific variable (`RECONSTRUCT_PYTHON` or `FLOORPLAN_PYTHON`);
2. `ARCVIA_PYTHON`, when one interpreter serves both services;
3. the service's local `.venv`;
4. supported Python launchers/commands for Python 3.10 through 3.12.

Each candidate must start, report a supported version, and import the service's
declared runtime dependencies. Otherwise it is skipped with the concrete reason.
Python 3.13+ is rejected because the reconstruction service explicitly supports
3.10–3.12 only.

Example explicit configuration on Windows:

```powershell
$env:RECONSTRUCT_PYTHON = 'C:\Python312\python.exe'
$env:FLOORPLAN_PYTHON = 'C:\Python312\python.exe'
npm run test:python
npm run test:bim
```

If dependencies are missing, create fresh environments rather than repairing or
copying an old launcher:

```powershell
py -3.12 -m venv services/reconstruct/.venv
services/reconstruct/.venv/Scripts/python.exe -m pip install -r services/reconstruct/requirements.txt

py -3.12 -m venv services/floorplan-ai/.venv
services/floorplan-ai/.venv/Scripts/python.exe -m pip install -r services/floorplan-ai/requirements.txt
```

The two environments stay separate because their OpenCV/OCR dependency sets are
intentionally incompatible.

## Reproducible stale-tree comparison

The read-only comparison used during consolidation is:

```powershell
node tools/compare-trees.mjs A:\Web\Arcvia C:\Users\aalev\Arcvia
```

It compares relative paths and SHA-256 hashes while excluding `.git`, dependency
trees, virtual environments, runtime data, caches, build outputs, logs, compiled
Python files, and common secret-file extensions. It never copies or deletes files.
