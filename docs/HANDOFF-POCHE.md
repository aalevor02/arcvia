# Poché — handoff

The CAD/plan → 3D reconstruction engine. Written 2026-08-21 to hand this work to
another session without losing anything.

**Read these first, in order:**
1. This file.
2. `docs/engine-blueprint.md` §7 build sequence, §8 open decisions, §9 known traps.
3. `docs/reference-mnml.md` §9 — the competitor teardown, settled, do not re-litigate.

---

## 0. State right now — read before touching anything

**A fix was applied that has not propagated.** `services/reconstruct/build/glb.py`
had its wall winding reversed (all six faces of every wall box were inside-out).
The tests pass, but **every GLB on disk was built before the fix and is stale.**

Regenerate before judging any render:

```bash
cd A:/Web/Arcvia/services/reconstruct
./.venv/Scripts/python.exe -m cli reconstruct \
  --input "A:/Projects/CasaAltinho/_work/cad/dxf/DOWN VILLA -WD 22-1-24.dxf" \
  --out A:/tmp/m9 --auto-layers
./.venv/Scripts/python.exe -m cli deliverables \
  --model "A:/tmp/m9/DOWN VILLA -WD 22-1-24.building.json" --out A:/tmp/m9
```

Everything else is on disk and tested. This is a git repo but nothing was committed
during the session — the working tree is the record.

---

## 1. What exists

### The engine — `services/reconstruct/` (Python 3.12, own venv, port 8091 unused so far)

| Path | What it does |
|---|---|
| `vendor/cad_kernel.py` | `services/floorplan-ai/cad.py` vendored byte-for-byte. DXF reading, unit inference, layer classification, block→furniture guessing. **Do not edit — it is vendored for a parity test.** |
| `ingest/dwg.py` | The LibreDWG gate. Version assert, converts twice, keeps the larger, counts **model-space** entities specifically. Refuses rather than falling back. |
| `ingest/blocks.py` | Block footprints from block definitions, room labels from TEXT/MTEXT, wall proximity. |
| `classify/elements.py` | Four-signal wall/furniture classifier. Block name → layer → footprint → room context. Reports `score` **and `margin`**. |
| `classify/catalogue_dims.py` | GENERATED. `node tools/cad-engine/gen-catalogue-dims.mjs`. |
| `hypothesise/pair.py` | Face pairing + collinear merge + corner joining. Faithful port of `apps/studio/src/plan/detections.ts` with STRtree indexing. Same constants. |
| `hypothesise/openings.py` | `D750`/`W1200` blocks → openings hosted on a wall as `(wall, along, width)`. |
| `hypothesise/perimeter.py` | `add_perimeter` — morphological closing on the wall network. **The single highest-value piece.** |
| `solve/frames.py` | Splits a sheet into its separate drawings. **Mandatory.** |
| `solve/spaces.py` | `polygonize` → rooms, inset to the finished face. |
| `solve/layerscan.py` | Per-frame layer selection scored on **named rooms**, not room count. |
| `solve/verify.py` | The gate. Blocks a model that contradicts its own input. |
| `build/glb.py` | Hand-rolled glTF 2.0 writer. No Blender, no three.js. |
| `build/solidify.py` | Walls split **arithmetically** around openings. n holes → n+1 solids, n lintels, 1 apron per sill. |
| `render/cameras.py` | The camera solver. Pole of inaccessibility, orbit, true isometric, ortho plan. |
| `render/styles.py` | Engine/Expert/Style/Camera/Seed as real config. |
| `render/plan_svg.py` | The plan as vector, poché filled solid. |
| `cli.py` | `survey` · `layers` · `reconstruct` · `deliverables` |

### The renderer — `services/render-worker/`

`render_views.py` (main) · `arcvia_style.py` (6 styles) · `arcvia_aov.py` (depth/normal/AO/Cryptomatte)

```bash
"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" -b --factory-startup \
  --python render_views.py -- --glb X.glb --views X.views.json --out DIR \
  --style cgi --engine fast --kind isometric
```

### The integration — `services/api/`

| Route | Cost | Notes |
|---|---|---|
| `GET /cad/health` | — | Is the Python engine installed |
| `POST /cad/survey` | **0** | Free and synchronous. Deliberate — see below. |
| `POST /cad/layers` | **0** | Layer evidence table |
| `POST /cad/jobs` | **3** | Queued. Returns `outputUrl` (GLB) + `planUrl` (SVG) |
| `GET/DELETE /cad/jobs/:id` | — | Status, summary, cancel |

Supporting changes: `lib/cadEngine.js`, `lib/refunds.js`, `storage.pathOf()`,
DWG/DXF/SVG in `ALLOWED`, magic-byte sniffing, `bodyLimit`+`fileSize` 32→64 MB,
`cad` entry in `PRESETS`, a `preset === 'cad'` branch in `renderQueue.start()`.

---

## 2. Verified, with the commands

```bash
# Engine — 142 assertions
cd A:/Web/Arcvia/services/reconstruct
./.venv/Scripts/python.exe test/test_classify.py   # 53
./.venv/Scripts/python.exe test/test_build.py      # 45
./.venv/Scripts/python.exe test/test_render.py     # 44

# API — 149 assertions. Needs `npm run dev:api` running.
cd A:/Web/Arcvia && npm test -w services/api
```

Measured on `DOWN VILLA -WD 22-1-24.dxf`:

```
frames         6 drawings on the sheet, villa is frame 0 (34.9 m span)
layers chosen  A1 WALLS HIDDEN + A5 FALSE CEILING  (auto, per-frame)
walls          303, median thickness 0.23 m  (nine-inch brick, MEASURED)
rooms          41, 20 named — FOYER 104.5, LAWN 58, BED ROOM 48.6, Drawing 32.3
openings       12 hosted, 6 not
glb            4,148 triangles, loads in three.js 11/11
plan           228 poché polygons, 41 rooms, 35 fixtures
cameras        47 solved, 34 usable, best clearance 3.54 m
render         isometric cutaway, ~1 min, 720p/32 samples, CPU
```

---

## 3. Open bugs and unfinished work

### FIXED but not propagated
- **Wall winding.** Every wall box was inside-out (top normal `(0,-1,0)`, sides
  facing inward). Fixed in `build/glb.py`; `test_build.py` now asserts facing.
  **All GLBs on disk predate this.** Regenerate — see §0.

### OPEN
- **Black pockets in lit renders.** Re-tested after the winding fix on 2026-08-22.
  **The winding fix did not clear them, and six hypotheses are now eliminated with
  evidence.** Do not re-test these:

  | Ruled out | How |
  |---|---|
  | Wall winding | Every triangle's winding agrees with its stored normal. 0% flipped across all three meshes. |
  | Normals generally | `services/reconstruct/_normals.py` compares winding to stored normal per triangle. Note the *count* of up-vs-down normals cannot detect this — flipping a closed box swaps the two and preserves the 1:1 ratio. |
  | Materials | One material in the GLB, beige `(0.82, 0.80, 0.77)`, no textures. Nothing is black by assignment. |
  | Tone mapping | Identical under `cgi` (Standard) and `clay` (AgX). |
  | Light *direction* | The fill was at 40 deg from vertical and could not reach a well floor. Moved to 8 deg — near-vertical, straight down into anything open-topped. **No change.** |
  | Light *intensity* | World strength 1.2 -> 8.0 blows the entire model to white. **The black patches stay pure black.** Anything that could see the sky at all would be white. |
  | The `A5 FALSE CEILING` layer | Reconstructing with `--layers "A1 WALLS HIDDEN"` alone gives 80 walls instead of 303, VERIFY BLOCKED, and one 278 m2 room. The layer is load-bearing, not spurious. |

  **What that leaves:** those surfaces receive light from no direction at all, so
  the camera is seeing the *interior* of sealed geometry. There is no clipping
  plane — `isometric_view` has no roof by construction, it does not cut one off —
  so something in `build/solidify.py` is producing closed pockets that are
  visible from outside. Next step is to identify which solids, not to re-test
  the lighting.

  Diagnostic kept at `services/reconstruct/_normals.py`.
- **6 of 18 doors unhosted** on the villa. Not a tolerance problem — the gap
  distribution is bimodal (hosted at 0.02 m, lost at 7–13 m). Their walls do not
  exist in the model.
- **`LATEST DRAWINGS` yields only small rooms.** Its bootstrap frame captures
  elevations (auto-layers picks `A1 ELEV`). A **frame** problem, not a layer or
  perimeter problem.
- **~44% pairing** on the villa. Some genuinely single lines (railings, jali,
  compound walls), not all.

### NOT BUILT
- **Raster / photo / scanned plan → 3D.** `ingest/raster.py` does not exist.
  `/cad/jobs` accepts only DWG and DXF (`READABLE` in `routes/cad.js`) and 415s
  everything else. **This was the next task when the session was handed over.**
- **Vector PDF.** `ingest/pdf_vector.py` does not exist.
- **M5 solver + review queue** — commit/label/relax, `Residual[]`, `CadImport.tsx`.
- **`finish_ai.py`** — the optional diffusion finish over real AOV passes.

---

## 4. The raster path — everything already learned about it

`services/floorplan-ai` is **already running on port 8090** and already does most of
the hard part. Verified live: `{"ok":true,"backend":"heuristic","reads_text":true,"reads_pdf":true}`.

`POST /detect` returns `DetectionResult`:

```python
walls:   list[WallSegment]   # start/end Points NORMALISED 0..1, thickness
                             #   normalised against IMAGE WIDTH, confidence
objects: list[Detection]     # label, bbox [x,y,w,h] normalised, attaches_to
rooms:   list[Room]          # polygon, area as a FRACTION of footprint, name, kind
scale:   PlanScale | None    # metres_per_unit, samples, spread
low_confidence: bool
```

**`PlanScale.metres_per_unit` is the answer to the hardest raster problem** — a
picture has no scale. It is read off the room sizes the architect printed, via OCR,
with `samples` and `spread` so you can tell whether to trust it. `spread` past a few
percent means the sheet disagrees with itself and the caller should say so.

**RESOLVED 2026-08-22 — measured, not reasoned.** The output is **mixed, and the
thickness itself says which is which.** Both documents were right about different
segments:

`merge_parallel()` in `main.py` collapses parallel runs within 1.5% of the sheet
that overlap along their length. Where it finds a partner, the result is a
**centreline whose thickness is the distance between the two faces** — already
paired, exactly as `WallSegment.thickness` suggests. Where it finds none, the
segment stays a **single ink line** with a stroke thickness.

Measured on three real drawings, converting `thickness x metres_per_unit`:

| drawing | segments | <0.08 m (single line) | 0.08-0.45 m (paired wall) |
|---|---|---|---|
| villa (photographic) | 38 | 15 | 22 |
| Avarana ground | 19 | 14 | 4 |
| Avarana basement | 22 | **22** | 0 |

The basement is *entirely* unpaired. So an adapter that trusts `thickness`
blindly builds 22 walls at 3-5 cm; one that pairs everything again doubles the
22 already-paired villa walls. **Neither constant is right — the rule is
per-segment**, and the discriminator is the thickness. `apps/studio/src/plan/
detections.ts` already does exactly this: pair what pairs, default the rest.

Original question, kept for context: whether `walls` are *face lines* or
*centrelines*. `WallSegment` carries a `thickness`, which suggests they are already
paired. But `docs/roadmap-parity.md` states plainly: *"Detector output is ink, not
walls. A drawn wall is two parallel lines, so 47 detected segments are ~24 walls."*
Those cannot both be true. **Read how `main.py` builds `WallSegment` around line 856
before writing the adapter** — building on the wrong assumption either doubles every
wall or throws away the detector's measured thickness.

---

## 5. Traps — every one of these cost real time

**CAD**
- LibreDWG **0.13.3 silently drops model space**: valid file, ~2,993 block entities,
  empty drawing, no error. 0.14 gives 26,194. Assert model space *specifically*.
- **`$INSUNITS` lies.** The villa header says mm → a 3.79 m building; cm → 37.9 m.
  Trust order: **measured > header > extent.** Always ask.
- **A wrong unit yields ZERO walls and a valid empty GLB, silently.** Two real
  drawings with 4,778 wall segments each did exactly this and reported success.
  That is what `solve/verify.py` exists for.
- **Do NOT exclude `*HIDDEN` layers by name.** `A1 WALLS HIDDEN` carries 838 m of the
  main wall run; excluding it cut 126 walls to 26. The name heuristic **pre-selects
  and never decides.**
- **Wall faces arrive fragmented.** 32% fall below the length minimum. Merge
  collinear runs *before* filtering, or the long face loses its partner.
- `guess_item()` cannot return `tv`, `wc` or `wb` — `_MEANINGLESS` eats 2–3 letter
  names, so those `_BLOCK_HINTS` rules are unreachable. Handled by `_SHORT_ALIASES`
  in the classifier, **not** by editing the vendored kernel.

**Geometry**
- **`polygonize` returns interior-DISJOINT faces.** There is no enclosing "envelope"
  face to filter. A huge room means missing partitions.
- **A partitions-only plan encloses almost nothing** — the biggest space in a modern
  house is open-plan. `add_perimeter` is not optional.
- **Zero-length normals render black and no test catches them** unless you assert
  normal *length*; a box can have six unit normals and still be inside-out unless you
  assert *facing*. Both assertions are in `test_build.py` now.
- **three.js sanitises node names.** `storey0/walls` loads as `storey0walls`. Use `_`.

**Rendering**
- **EEVEE renders BLACK under `--background`.** Hard-set `CYCLES` every time.
- **Flat emission is NOT a valid diagnostic for normals** — emission ignores facing.
  A wrong conclusion was drawn from exactly this once.
- No usable GPU: ~1 min/frame at 720p/32 samples. Renders must be resumable and
  cameras placed absolutely from the view spec, never relatively.

**Platform**
- **Never round-trip UTF-8 through PowerShell defaults.** Also: bash heredocs +
  Python string escaping repeatedly collapsed `\n` inside f-strings during this
  session. Use the Write/Edit tools for code containing regexes or escapes.
- Python **3.10–3.12 only** for these services.
- `services/reconstruct` has its **own venv with no rapidocr** — deliberate. rapidocr
  uninstalls headless OpenCV. Keep the quarantine.

---

## 6. Decisions already taken — do not reopen

- **One-shot importer.** Provenance fields stay in the schema; no merge engine.
  A revised DWG means re-import.
- **We own DWG→DXF conversion** server-side via LibreDWG 0.14.
- **Survey and layers are free.** Charging makes people guess instead of check.
- **Named rooms, not room count**, is the layer-selection objective. Room count
  picks the elevation layers and produces 16 rooms with 0 named and 0 doors.
- **Margin, not score**, is the ask-a-human signal.
- **SVG is served `Content-Disposition: attachment`, never inline** — it can carry
  script and these URLs are unauthenticated and same-origin.

---

## 7. Artifact

https://claude.ai/code/artifact/67fa4099-e5f0-4d59-889c-dc385a781856

Teardown + build plan + the render, in the Poché identity. Republish with the same
file path to update it; the source is in this session's scratchpad.
