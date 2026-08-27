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
