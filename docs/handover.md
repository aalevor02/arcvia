# Arcvia — engineering handover

A real-estate visualisation platform: read an architect's floor plan, build the
model, walk a client through it, render it.

There is a formatted version of this document at the link the team shares; this
is the copy that lives with the code and should be updated alongside it.

## What the machine needs

| Tool | Version | Why |
|---|---|---|
| Node | 20+ (built on 24.18) | API, all four front ends, the build |
| Python | 3.10–3.12 (**not** 3.13+) | Floor-plan reader; wheels lag on newer |
| Blender | 4.2 or 5.x | Render worker and lightmap bakes. Optional until you render |
| Disk | ~4 GB | node_modules, venv, Blender, model catalogue |
| GPU | not required | Detection is CPU-only; Blender falls back to CPU |

No cloud account, no Docker, no database server. Persistence is a JSON file,
uploads go to local disk, OTP codes are logged rather than sent.

## Setup

There is **no git remote configured** — the repository is local only. Push it
somewhere, or zip the working tree excluding `node_modules`, `.venv`, `.data`
and `dist`.

```bash
npm install
cp .env.example .env          # then set BLENDER_PATH for this machine

cd services/floorplan-ai
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

# Optional extras: OCR (room names + scale) and PDF reading.
# --no-deps is NOT optional -- see the trap below.
.venv/Scripts/python -m pip install onnxruntime
.venv/Scripts/python -m pip install --no-deps rapidocr-onnxruntime
```

Check both extras came up:

```bash
.venv/Scripts/python -m uvicorn main:app --port 8090
curl http://127.0.0.1:8090/health     # want reads_text: true, reads_pdf: true
```

## Running it

| What | Command | Port |
|---|---|---|
| API | `npm run dev:api` | 8787 |
| Reader | `uvicorn main:app --port 8090` (in its venv) | 8090 |
| Marketing site | `npm run dev:web` | 4321 |
| **Studio** | `npm run dev:studio` | 5173 |
| Plan viewer | `npm run dev:plan` | 5174 |
| Visualisation | `npm run dev:vis` | 5175 |

Tests:

```bash
cd apps/studio && node test/run.mjs                       # ~270 assertions
cd services/api && npm test                               # ~115, needs API running
cd services/floorplan-ai && .venv/Scripts/python test/test_deck.py
```

## The floor-plan reader works backwards, deliberately

The obvious pipeline — extract every long straight stroke, then decide which are
walls — cannot work on a furnished plan. Nothing local to a stroke settles it: a
double bed is 2 m and a partition is 3 m, both are four pixels wide at brochure
resolution, both are dark. Length, stroke weight, colour and pixel texture were
each measured against real drawings and none separates them.

What separates them is what the line *does*. A wall bounds a room; a bed sits
inside one. So the reader seals doorways, floods the enclosed regions, and keeps
only strokes on a region's edge. Furniture is rejected because nothing is behind
it — as are stair treads, hatching and dimension leaders, with no rule for any.

Three things ride on the same pass:

- **Room names** from OCR of the drawing's own labels. A labelled WARDROBE is
  joinery, not structure — the one signal no pixel measurement provides.
- **Scale** from the sizes printed beside those names. Applied only to a drawing
  nobody has calibrated by hand.
- **Site versus building.** LAWN, GREEN, WATER BODY are ground and produce no
  walls. Balcony, verandah, terrace deliberately are not — they have a slab.

When two binarisations disagree, the one closing more *named* rooms wins.
Scoring by area rewards missing a partition; scoring by room count rewards
shattering the plan. Named rooms cannot be gamed either way.

**Do not revert this to per-stroke classification.** The symptom it fixes is a
plan whose beds and sofas come through as walls, and 92 walls enclosing 0 rooms.

## Failures that do not announce themselves

Each completes successfully and returns something worthless.

**Installing OCR silently breaks OpenCV.** `rapidocr-onnxruntime` depends on the
full `opencv-python` and pip will uninstall `opencv-python-headless` to satisfy
it, pulling in GUI libraries a server cannot load. Use `--no-deps`. On Windows
stop uvicorn first or the uninstall dies with `WinError 5` holding `cv2.pyd`.

**Axis conversion happens in exactly one place.** `toBlenderVec()` in
`services/api/src/routes/render.js`. A render rotated 90° is always a repeat of
it at a call site.

**Lightmap baking has three silent traps.** `uv_layers.new()` does not unwrap
(call `smart_project()`); Blender bakes `active_render`, not `active` (set
both); deselect *inside* the per-object loop or `mode_set('EDIT')` re-unwraps
everything already packed. Diagnostic: a correct atlas for N objects uses
exactly N cells with black gutters; 100% coverage means overlap.

**"Could not reach the server" is CORS, not the network.** `fetch` rejects
identically for both. Symptom: works on `localhost:4321`, fails from
`192.168.x.x:4321`. The API must accept RFC1918 origins outside production, and
clients must derive the API host from `window.location.hostname`.

**Three.js does not free GPU memory.** `SceneViewer.clearModel()` disposes
explicitly. The viewer also renders on demand — do not make the loop
unconditional.

**A React ref can outlive its element.** The 2D canvas was built in a mount-once
effect while its element unmounts with the 3D view; coming back, the renderer
drew into a detached canvas and the screen stayed blank while all the state was
correct. It is a callback ref now.

**Credits are charged before queueing.** Charging on completion lets a
zero-credit user burn GPU time. Cancelling a queued job refunds; cancelling a
rendering one does not.

**The store serialises writes on purpose.** `store.js` chains flushes through a
promise queue because `await` yields. Do not simplify it away.

**Blender progress is parsed from stdout.** `Sample N/M` and
`ARCVIA_OUTPUT:<path>`. Changing those prints breaks the queue silently.

## Where it stands

Works: wall detection, room naming and scale, PDF deck import, the editor,
the 44-item catalogue, lightmap baking, publishing with access codes.

Rough: DXF import has a reader but no studio screen; wide openings still read
two rooms as one (reported rather than silently wrong).

Not built: automatic furniture placement — fittings are *detected* and returned,
nothing places them yet. Photoreal AI pass needs `AI_IMAGE_KEY`. Billing is off
by a flag in `packages/brand/plans.config.mjs`.

Two `TODO(you)` markers are business judgements, not unfinished work: session
expiry in `apps/web/src/lib/auth.ts`, out-of-credits behaviour in
`services/api/src/lib/credits.js`.

## Starting an alternate project

1. Edit `packages/brand/brand.config.mjs` — name, domains, colours, type.
2. Rewrite copy in `apps/web/src/pages/*.astro` and `src/data/faqs.ts`.
3. Point `DB_PATH`, `UPLOAD_DIR` and `ARCVIA_OUT_DIR` at a fresh directory so
   the two installs never share state.
4. Everything else follows.

Keep `RENDER_MODE=local` as the default. The render worker is the only expensive
component; everything else combined is $20–80/month. Cost guards live in
`renderQueue.js`: `RENDER_CONCURRENCY` (1), `RENDER_TIMEOUT_MS` (10 min),
`RENDER_DAILY_CAP` (500, holds rather than fails). Raising concurrency
multiplies worst-case burn linearly.

Read `docs/architecture.md` and `docs/costs.md` next.
