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
| `vendor/cad_kernel.py` | `services/floorplan-ai/cad.py` vendored byte-for-byte. DXF reading, unit inference, layer classification, block→furniture guessing. **Do not edit — it is vendored for a parity test.** ⚠ **This claim is STALE as of 2026-08-26 and the DIRECTION matters.** Measured: 32 diff lines, 4 hunks, and the vendored copy is **AHEAD**, not behind — it has `read(path, doc=None, auditor=None)` and `furniture(..., doc=None)` where `services/floorplan-ai/cad.py` still has the single-arg forms, plus the matching `"audit": len(auditor.errors) if auditor is not None else 0` guard. That reads as a deliberate additive change so a caller can pass an already-open document instead of re-reading the file, and it is backward compatible at every call site. One hunk is comment-only (a Spanish PUERTA/PUERTA-VENTANA note that exists in floorplan-ai and not here). So today's divergence is not the hazard. **The hazard is the REVERSE direction**: a fix landing in `floorplan-ai/cad.py` that the vendored copy never receives, with nothing to notice — because **no automated parity test exists**. Nothing under `test/` compares the two files, so "vendored for a parity test" is documentation, not a guarantee. The change was not made by the session recording this and is reported rather than reverted. Either restore parity, add a real check, or reword this line to what is actually true. |
| `ingest/dwg.py` | The LibreDWG gate. Version assert, converts twice, keeps the larger, counts **model-space** entities specifically. Refuses rather than falling back. |
| `ingest/blocks.py` | Block footprints from block definitions, room labels from TEXT/MTEXT, wall proximity. |
| `classify/elements.py` | Four-signal wall/furniture classifier. Block name → layer → footprint → room context. Reports `score` **and `margin`**. |
| `classify/catalogue_dims.py` | GENERATED. `node tools/cad-engine/gen-catalogue-dims.mjs`. |
| `hypothesise/pair.py` | Face pairing + collinear merge + corner joining. Faithful port of `apps/studio/src/plan/detections.ts` with STRtree indexing. Same constants. **2026-08-26 — two changes.** (a) `Wall.offset`: where the SOLID sits relative to the axis (IFC's OffsetFromReferenceLine). Defaults 0 = symmetric, so nothing existing moves; only `build/solidify` and the plan's poché read it, never the topology. It exists because merging composite leaves by moving the centreline was refuted — see `assemble.py`. Tested in `test/test_offset.py`. (b) `join_corners` now picks a crossing that lands ON the other wall (`ON_SEGMENT_TOLERANCE`, 20 mm) over a nearer near-miss: `polygonize` nodes exact touches, not near misses, so a 3 cm miss winning on reach alone was leaking room cycles. **The real villa gained 4 rooms and 3 names (21/14 → 25/17), gate still clean, median thickness unchanged.** |
| `hypothesise/openings.py` | `D750`/`W1200` blocks → openings hosted on a wall as `(wall, along, width)`. Label bridging closes drawn door gaps: collinear gaps between two walls in one run, and (2026-08-26) **corner doors** — `_end_gap_candidate` extends a wall END to a crossing perpendicular wall when a DOOR label sits beside the gap. That second form was the dominant room leak on the ground-truth fixtures (a door flush against a partition leaves no collinear partner to bridge); villa A/B is byte-identical because its doors resolve from blocks first. |
| `quantify/areas.py` | The area statement (2026-08-26): RERA §2(k) carpet vs IS 3861 carpet, **every figure tagged with its definition + conventions** — the two differ by construction (villa: 242.71 vs 80.68 m2) and an unlabelled figure is a legal liability under RERA. Partition term from `boundedBy` gated by a both-faces probe (reference-counting alone laundered 12.8 m2 of envelope into carpet). Refuses built-up/super-built-up (marketing numbers, not geometry). Recipes from `A:\Research\BIM\knowledge\10-indian-codes-and-area-measurement.md` §2. |
| `quantify/refresh.py` + `tools/refresh-rates.cmd` | **2026-08-26 — weekly rate refresh executed through Windows Task Scheduler.** The first task claimed `Last Result: 0` while running nothing: UTF-8 batch comments were misparsed, its relative log path pointed below `services/reconstruct`, and the missing redirections still yielded a green wrapper result. The batch file is now ASCII-safe, resolves the repo from `%~dp0`, writes `data/rates/refresh.log`, and propagates Python's exit status. The first real write then revealed that `TRUST_BAND` alone allowed a 6 Aug timber page to replace three newer 12 Aug rows. Freshness is now monotonic: a page older than `Rate.rate_date` is untrusted and cannot change value, range, or date. The affected rows were restored. Guarded scheduled run: 28 confirmed, 0 unreachable, 171 refused, Last Result 0; next run Monday 2026-08-31 09:00. Rate/BOQ tests 96/96; full reconstruction 874/874 across 24 scripts. |
| `hypothesise/assemble.py` | **Still unwired, now ONE room out** (was six). Rewritten on `Wall.offset` so the axis never moves: kit 16/18 and nibs 48/60 unchanged, revit22 21/28 against a 22/28 baseline, and composite thickness outliers 0.365 → **0.000**. Four-round record in its docstring, including two defects where this module broke its own rules (reclaim moving an axis; a stray line read as a leaf spanning a CAVITY). Wire when the fixture suite shows one-to-one parity on all three. |
| `hypothesise/perimeter.py` | `add_perimeter` — morphological closing on the wall network. **The single highest-value piece.** |
| `hypothesise/priors.py` | Measured priors from 2,360 BIM walls / 654 doors / 500 windows (corpus at `A:\Research\BIM`). Data only — its docstring records TWO refuted uses (an on-standard-thickness unit gate, and a thickness scoring weight) with the measurements that killed them. Read it before building either. |
| `quantify/dwellings.py` | Unit assignment (2026-08-26): rooms connected by doors form a flat; stairs/lifts common by name; shared corridors found by the ARTICULATION test (cut the candidate, require two dwelling-shaped sides — two-plus rooms, one non-circulation — else an in-unit hall shatters its own flat). `unit_model()` filters a storey to one unit so `areas.area_statement` computes per-flat RERA with zero changes — walls to other units automatically read as external. Quality is bounded by the room graph upstream; exact on clean input (test_dwellings, 12 asserts). |
| `solve/frames.py` | Splits a sheet into its separate drawings. **Mandatory.** |
| `solve/spaces.py` | `polygonize` → rooms, inset to the finished face. 2026-08-26: the envelope filter is now island-aware (`MAX_ISLANDS`) — a room surrounding a free-standing stair core used to be deleted as "contains another face"; islands are subtracted instead, and only a face containing more than two is the outline. Measured on the Revit-22 ground truth; villa A/B byte-identical. |
| `solve/layerscan.py` | Per-frame layer selection scored on **named rooms**, not room count. **2026-08-26 — `encloses()`**: rooms each layer closes ON ITS OWN, now a column in the free `layers` table, plus a hint when a layer the verdict DISMISSED out-encloses every layer it endorsed. Found on a real client upload (a Norwegian DWG in `services/api/.data/uploads/cad/`): its wall faces are split across two layers, so `A-WALL` verdicted WALLS and closed **0 rooms** while `inne_gulv` ("inner floor") was dismissed as "not at wall thicknesses" and closed **11**. Auto-layers → 3 rooms, verify BLOCKED; `--layers "A-WALL,A-SECTMBM,inne_gulv"` → 33 rooms, 10 named, clean PASS. Refuted alternative recorded in the docstring: a pair-count "gain" from combining layers does not work — pairing is exclusive, so combining gives FEWER pairs (61 vs 62) but far better ones. |
| `solve/verify.py` | The gate. Blocks a model that contradicts its own input. |
| `build/glb.py` | Hand-rolled glTF 2.0 writer. No Blender, no three.js. **2026-08-26 — TEXCOORD_0**: every GLB previously carried POSITION and NORMAL only, so no reconstructed model could take a textured material at all (only glass/water/flat paint could bind). UVs are box-projected per face — drop the dominant axis of the face normal — and measured in **METRES**, so `u = 1.0` is one metre of building and a material tiles from its own physical size (a 0.6 m tile repeats every 0.6 of u). Computed at WRITE time from final positions/normals, so `translate_plan` cannot desync them. **Also emits `extras.surfaceClass`** per mesh in the shared 39-class vocabulary (`A:\Research\BIM\tools\material_bridge.json`) — `floor_bath`, `ceiling`, `internal_wall`, `water_body`, `driveway`… — so a material library can bind without parsing mesh-name conventions. The writer tags what the geometry KNOWS and stays silent otherwise. **The poché face split landed the same day**: `build/solidify.py::side_classes` probes half a thickness past each long face at the wall's midpoint (the same test `quantify/areas.py` uses for internal partitions, applied per FACE), and `add_box_from_segment` routes the two long faces to `wallface_internal` / `wallface_external` meshes while ends, tops and bottoms stay in `walls` — an end cap is a reveal and claims neither class. End caps go to a third mesh, `wallface_reveal`, tagged as itself rather than folded into either side: beside an opening that face is the reveal and its finish follows the FRAME, which is a materials decision the geometry cannot make (a library aliases `wallface_reveal → internal_wall` in one line if it does not care). Villa: 71 of 73 meshes tagged, and the split **reconciles exactly** — triangles 2591 → 2591, the original 1320-triangle poché becoming 82 external + 358 internal + 440 reveal + 440 left in `walls`, which is precisely the top and bottom of each of the 110 wall pieces (both buried). Passing no `spaces` is byte-identical to the old build. **Every tag also carries `extras.surfaceClassSource` — `measured` or `assumed`** — because a class the engine determined and a class a default filled in are different claims and a render cannot tell them apart by looking. Villa: 56 measured, 15 assumed, 2 untagged. Three defects found in review and fixed, each a shipped bug: (a) every outdoor floor resolved to `driveway` because the mesh KIND was read before the room's name, so balconies rendered as tarmac; (b) several `floor_*` classes had no producer at all and were unreachable; (c) an unknown room resolved silently to `floor_living`, which in the library is the PREMIUM vitrified floor — the fallback stays but now marks itself `assumed`. The fix for (b) walked straight into a substring trap the file already warns about — **`storey0` contains `store`** — so word tests match the room slug only, never the whole mesh name. `test/test_uv.py`, 53 asserts.

**Skew walls (2026-08-26).** `_box_uv` measured a wall along a WORLD axis, so a
wall at 45° was compressed to cos45 of its run — a brick course 41.4% too long
— and every plangraph fixture is orthogonal by construction, so nothing caught
it. A vertical face's horizontal run is recoverable from its own normal, so `u`
is now measured along the wall itself: exact at every angle, identical to before
for axis-aligned walls, and `v` stays world height so courses remain horizontal
by construction. Consequence worth knowing: the two faces of a wall now measure
`u` in OPPOSITE directions (each reads correctly from the side you stand on), so
a box's total u span is 2× its length — and consecutive pieces of one wall share
a normal and take `u` from absolute world position, so a texture runs
continuously across the pieces a doorway splits a wall into.

**Plinth band (2026-08-26).** The bottom `PLINTH_HEIGHT` (0.45 m) of an
EXTERNAL face routes to `wallface_plinth` → class `plinth` → flamed granite.
Slicing is safe here for a measured reason recorded in `RING_INSET`'s own study:
two boxes stacked at a butt joint present OPPOSED faces (zero black pixels); it
is COINCIDENT boxes that z-fight. The room-facing half of the same slice stays
internal — a plinth is a facade feature and must not appear indoors — and a wall
shorter than the band is left whole rather than sliced into a sliver. Still untagged by design: `storey0_walls` (tops/bottoms) and `storey0_fixtures` (furniture is not a building surface). |
| `build/solidify.py` | Walls split **arithmetically** around openings. n holes → n+1 solids, n lintels, 1 apron per sill. **`build_roof` (2026-08-26) — OFF unless `--with-roof`.** A plan never draws the roof, so everything above the wall head is inference: this emits a flat RCC slab over the indoor footprint (oversailing 50 mm to throw water clear of the face) plus a 1.0 m parapet, both tagged `surfaceClassSource: assumed`. Most Indian residential IS flat RCC with a parapet, so it is the honest fallback AND the common case — but a pitched-roof building will be wrong until form recovery exists, and being wrong LOUDLY beats a model with no roof, which is silently wrong in a way no reviewer can see. **Opt-in for a hard reason**: `render/cameras.py::isometric_view` is a CUTAWAY that works because there has never been a roof to look through, so building one unconditionally would lid every existing isometric. Verified: without the flag the villa GLB is byte-identical. A renderer wanting an interior view hides the `roof*` meshes rather than never having them. |
| `build/solidify.py` (stairs) | **2026-08-26 — straight plus dog-leg/U recovery, including measured riser evidence.** The named-room path still requires registered overlapping stair-room footprints and refuses ambiguous or undersized cores. The new fallback is deliberately narrower: two parallel regular riser runs on the lower plan, 0.20-0.35 m measured going, an explicit landing edge, nearby `UP`, matching registered upper risers, and nearby upper `DOWN`; exactly one core may satisfy all evidence. It then cuts the measured opening out of intersecting room slabs rather than deleting a whole room cap. Casa Altinho `DOWN VILLA -WD 22-1-24.dxf` now produces a 9+9 dog-leg with 0.300 m going, 1.169/1.153 m measured flight widths, 0.079 m gap, 1.200 m landing depth, and a 3.900 x 2.400 m core. The mesh is 456 vertices / 228 triangles and spans the exact -3.0 m to 0.0 m elevations; the complete GLB is 6,255 triangles / 13,855 vertices. Blender 5.1 imported 143 meshes and completed the 1280x720 isometric validation render with no frame warning (OIDN was disabled after host-memory exhaustion). Direction and tread solids are still marked assumed; riser spacing, widths, landing edge, and core are measured. No winders, spiral/L/three-flight stairs, irregular wells, railings, guards, strings, soffits, headroom, or structural slab design. Synthetic geometry is 93/93 and the full reconstruction suite is 874/874 across 24 scripts. Direct human visual approval is still pending because the in-app browser is blocked by Windows sandbox error 1344. |
| `render/cameras.py` | The camera solver. Pole of inaccessibility, orbit, true isometric, ortho plan. |
| `render/styles.py` | Engine/Expert/Style/Camera/Seed as real config. |
| `render/plan_svg.py` | The plan as vector, poché filled solid. |
| `cli.py` | `survey` · `layers` · `reconstruct` · `deliverables` |

### The renderer — `services/render-worker/`

`render_views.py` (main) · `arcvia_style.py` (6 styles) · `arcvia_aov.py` (depth/normal/AO/Cryptomatte)

**The material hook (2026-08-26) — `--materials <bridge.json>`.** Dresses each
mesh from its `extras.surfaceClass`, consuming the material library's own file
rather than a bespoke format. Verified end-to-end in Blender 5.1 on the villa:
`surfaceClass` arrives as a custom property on `obj.data` and the coordinates
as a `UVMap` layer — **both confirmed by measurement, not assumed**. **Classes name a TIER, not always a single material**: walls carry `default`,
floors carry economy/standard/premium — reading only `default` dropped all
SIXTEEN floor classes, the largest surface in any interior, and the render came
back with dressed walls on undressed floors. `standard` is the default tier on
purpose; `premium` would make every unnamed room the most expensive floor in
the catalogue. Applied on the villa: **38 of 39 classes resolve and only TWO
meshes go untouched** — `storey0_fixtures` (furniture) and `storey0_walls`
(buried tops/bottoms) — i.e. every visible surface is dressed: 21 ceilings,
23 internal walls, 1 external, 1 plinth (flamed granite, tile 1.6 m), 15 living
/ 2 corridor / 2 bath / 1 kitchen / 1 bedroom / 2 balcony / 1 courtyard floors,
water and planting. **Real texture maps are loaded, not just colours** (2026-08-26): the library's
`asset_library.map_suffixes` says how each source names its files (ambientCG
`_2K-JPG_Color.jpg`, Poly Haven `_diff_2k.jpg`), so the paths are READ rather
than guessed — a guessed path finds nothing and falls back to flat colour,
which looks like a lighting fault rather than a missing file. 32 of 38 classes
have maps on disk; base colour, roughness (loaded Non-Color — a roughness map
is data, and reading it as sRGB makes every surface glossier than the material
says) and normal are wired through a Mapping node scaled by `1 / tile_metres`.
That single division is the whole payoff of emitting UVs in metres.
**Measured end-to-end on the villa isometric**: flat-colour render had 13,612
black pixels (1.48%) and 0.0% coloured; textured render has **0 black pixels**
and visible plaster on the external band. Note for anyone debugging that:
**black pixels in a material-less render are a MATERIAL symptom, not a
geometry one** — this codebase has real z-fighting history and that 1.48% was
one step from being chased through `build/`.

**`audit_materials` — the corpus's traps, machine-checked.** The material
library ALREADY documented that a roughness map must load Non-Color, with the
exact symptom; this hook shipped the bug anyway and rediscovered it from a
render, because prose does not defend code written before the prose is read.
So the checkable rules are now checked at render time and reported as
`ARCVIA_MATERIAL_WARNING:` — data maps loaded as sRGB, textured materials with
no `tile_metres`, textured materials with no Mapping node. Verified in both
directions: clean on the shipped path, and it catches 7 of 7 real roughness
maps when they are deliberately corrupted. **It audits the map's ROLE, stamped
on the image at load time, never its filename** — `white_rough_plaster_diff_2K.jpg`
is a DIFFUSE map whose name contains "rough", and matching on the name produced
a false positive, i.e. this audit's own instance of the substring-matcher
species it exists to catch. `wallface_reveal` aliases to `internal_wall` by default. Runs only
under a style that KEEPS materials — `clay`/`flat`/`paper` are deliberate
requests for one uniform surface and must win, so the hook is skipped and says
so. UVs being in metres is what makes tiling one division by `tile_metres`.

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

```bash
# Ground truth — 25 assertions, ~1 minute. The engine against real BIM models.
./.venv/Scripts/python.exe test/test_plangraph.py
# Area statement — 24 assertions. RERA vs IS 3861 carpet with definitions.
./.venv/Scripts/python.exe test/test_areas.py
# Dwellings — 12. Door-connectivity flats, corridor articulation, per-flat RERA.
./.venv/Scripts/python.exe test/test_dwellings.py
# Wall.offset — 12. Axis stays, body moves; rooms/joins never see it.
./.venv/Scripts/python.exe test/test_offset.py
# Layer enclosure — 9. A dismissed layer can be the one that closes the
# building; plus the blocked-build re-seed's ranking and its refusal to guess.
./.venv/Scripts/python.exe test/test_layerscan_enclosure.py
# UVs — 13. Box projection per face, in metres, computed at write time.
./.venv/Scripts/python.exe test/test_uv.py
# Raster adapter offline — 9. Fake DetectionResult from KIT ground truth through
# the real read(): aspect/y-flip round trip, 75mm band/hairline split, pairing.
./.venv/Scripts/python.exe test/test_raster_plangraph.py
```

`cli deliverables` now also writes `<stem>.areas.json` and prints the area
statement (RERA vs IS 3861, definition-tagged) after SURFACE.

**The ground-truth suite (added 2026-08-25).** `test/fixtures/plangraph/`
carries three real buildings' storeys extracted from production IFC models
(KIT institute / Revit-22 apartment / NIBS office — provenance in the
fixtures README), each with the architect's own wall axes, measured
thicknesses, hosted doors and named rooms. `test/test_plangraph.py` renders
each back into the double-line drawing a sheet would carry, runs the real
pipeline (`pair_faces → from_text_labels → add_perimeter → join_corners →
detect_spaces`), and scores the output against the truth. Baselines, asserted
a step below the measurement (both generations kept in the test's own
comments):

```
                 2026-08-25 first baseline      2026-08-26 current (corner-door
                                                bridge + leaf-width doorways)
kit-institute    recall 0.961  rooms 14/18   →  recall 1.000  matched 16/18  area x1.028
revit22          recall 0.615  rooms 13/28   →  recall 0.712  matched 22/28  area x1.001
nibs-office      recall 0.832  rooms 22/60   →  recall 0.922  matched 47/60  area x0.885
```

("matched" = ground-truth rooms matched ONE-TO-ONE at >=50% overlap — the
metric raw counts cannot fake; the suite asserts it per fixture. A doorway's
two GT records — structural opening incl. sidelight, and the leaf — are one
gap of LEAF width on a sheet; cutting structural widths had been destroying
partitions no bridge could span, which was masking real engine capability.)

Findings the suite encodes: **windows must not cut the synthetic wall faces**
(a drawn window keeps its sill/frame linework — cutting them erased KIT's
ribbon-glazed facades and scored the engine on a drawing nobody draws);
**a 2.1 m door gap exceeds MERGE_GAP and leaks every room** (KIT: recall 0.87,
zero rooms) until `from_text_labels` bridges it — the no-bridge canary pins
that; and **corner doors were the dominant remaining leak** until the
end-extension bridge (see the openings.py row above). Room counts now sit a
little above truth — corridors split at extended walls — so the assertions
are count BANDS, not floors. Ratchet as the engine improves.

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
- **A CAD-imported balcony has NO railing geometry.** Not wrong — absent.
  `extrude_walls` skips unpaired lines on purpose ("a single unpaired line is
  usually a railing, and extruding one to ceiling height turns a balcony into a
  sealed box that blacks out the rooms behind it"), and `test_build.py` asserts
  it: `pieces == 0 and skippedUnpaired == 4`. So the engine correctly refuses to
  build a railing as a wall, and then builds nothing, and a balcony edge is open
  in the model. **Correcting a claim made in `2d17eda`'s commit message**, which
  says solidify.py "still builds a parapet full height" — it does not, and that
  sentence should not be trusted. The engine's only parapet today is
  `build_roof`'s, at `PARAPET_HEIGHT = 1.0`.

  The designed answer already exists and has not been built:
  `engine-blueprint.md` §736 — an unpaired run > 0.8 m becomes a two-alternative
  hypothesis `{masonry@storey-height, railing@1.0 m}`, never a wall by default —
  plus §756, where an OUTDOOR region pushes its bounding walls towards
  railing/kerb. Implementing it is a piece of the classifier rework, not a patch,
  which is why this session recorded it rather than improvising against a design
  it had just read.

  Related and DONE on the other path: the raster/studio pipeline now carries the
  adjudicator's verdict on `WallSegment.kind` and builds a `railing` wall type at
  **1.0 m, pinned to this file's `PARAPET_HEIGHT`** rather than to a code
  minimum — two builders that can draw the same building must agree on that
  number, or a parapet changes height depending on which path drew it.
- ~~**Black pockets in lit renders.**~~ **SOLVED — `6f0d685`. It is Z-FIGHTING,
  not darkness, and the account below is REFUTED. Read this before the table.**

  The conclusion this section reached — *"those surfaces receive light from no
  direction at all, so the camera is seeing the interior of sealed geometry"* —
  is wrong, and one control killed it:

  | control | black px |
  |---|---|
  | two exactly coincident boxes | **14,275** |
  | box strictly INSIDE another box | **0** |
  | 50 mm air slit | 0 |
  | flush butt joint, opposed faces | 0 |
  | 0.3 mm clearance, no shared plane | 0 |

  **A sealed lightless volume is invisible, not black.** So the sealed-geometry
  account, the missing-roof account, and the sealed-sandwich account all fall
  together. Inverted normals are excluded too: zero of 124 boxes have negative
  signed volume.

  The cause is coincident faces from `add_perimeter`'s derived ring lying exactly
  on the walls it retraces. The fix is 2 mm of clearance on ring segments, **not
  deletion**:

  | | black px |
  |---|---|
  | as built | 12,119 |
  | ring 2 mm thinner and shorter | **513** |
  | ring not built at all | 505 |

  Below the no-ring baseline while keeping all 57 ring segments, 23 rooms and
  1,848 triangles — so the envelope survives, which is the whole reason
  `add_perimeter` is not optional.

  **And it was at least three bugs, not one.** On the fixed model: `interior-6`
  measures 0.00% (was 3.774%, cured here); `interior-16` 1.03% (survives);
  `interior-17` is *lighting*, swinging 20.15% photoreal → 0.10% cgi. That is why
  six hypotheses died against it — they were each tested against a mixture.

  The table below is **kept, not deleted**, because every row in it is still a
  true measurement and re-running any of them would still be wasted time. What
  changed is the conclusion drawn from them. Six correct eliminations pointed at
  a wrong answer because the thing being eliminated was three different things.

  Historical, and still true as measurements:

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
- ~~**6 of 18 doors unhosted**~~ — no longer reproduces on the current
  auto-layer, multi-storey path. The 2026-08-25 real villa run hosted every
  detected opening (`unassigned: 0`). Exact unhosted block targets are now
  retained if this regresses.
- **`LATEST DRAWINGS` yields only small rooms.** Its bootstrap frame captures
  elevations (auto-layers picks `A1 ELEV`). A **frame** problem, not a layer or
  perimeter problem.
- ~~**A sparse seed layer makes the bootstrap frame lie.**~~ **FIXED 2026-08-26
  by a failure-triggered retry** (`cli.py`, the `reconstruct` dispatch +
  `_enclosure_seed`). The account below is still the correct diagnosis; what
  changed is that a BLOCKED build now re-seeds from the layers that actually
  enclose rooms and tries once more, keeping the retry only if it verifies.
  On the Norwegian client DWG: BLOCKED with 3 rooms → automatically re-seeded
  to `inne_gulv, A-WALL, A-SECTMBM` → 1 frame of 28.66 m, 141 walls, **33
  rooms, 10 named, PASS**. Gating on failure is the whole safety argument —
  a drawing that verifies is never re-run, so nothing that works can change;
  the villa is byte-identical and fires no retry. Do NOT convert this into a
  preemptive "widen when the seed is a minority" gate: the villa's seed is
  also a minority of its linework, and it works.
  On the Norwegian client DWG (above), bootstrapping from the name-heuristic
  set (`A-WALL`, a third of the building's linework) produced **2 frames of
  ~9.2 m**; seeding from the layers that actually close the building produces
  **1 frame of 28.66 m**, the real extent. Layer selection then runs inside a
  frame that is both too small and falsely split, and cannot recover — the
  chicken-and-egg the "frames first, layers second" order creates when the
  seed is a minority of the plan. The `layers` table now SAYS so (see
  `encloses`), and `--layers` provably fixes that file, but auto-layers still
  gets it wrong. A safe fix shape: on a BLOCKED verify, re-bootstrap the frame
  from the enclosure-ranked layers and keep whichever result verifies —
  triggered only on failure, so no currently-working drawing changes.
- **Wall fidelity still needs review, but the old ~44% figure is stale.** The
  2026-08-25 current-path villa run paired 202 of 298 walls (67.8%). Its live
  warning is 3.48 m of indoor wall per m² of indoor floor, outside the 0.6–1.6
  band: walls are still duplicated or rooms are not all closing.

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

**Determinism**
- **A `set` of layer-name STRINGS made the same drawing quote differently on every
  run.** Two consecutive `reconstruct --storeys` of one file, same code, nothing
  changed between them: `148 walls / 260.3 m²` then `147 / 259.4`. Python
  randomises string hashing per process, `pool = [f for name in selected ...]`
  iterated a `set[str]`, and pairing and corner-joining are order-sensitive.
  Fixed by `sorted(selected)` (`cli.py`, commit `d82c34e`).
  - **`PYTHONHASHSEED=0` is the diagnostic, never the fix** — three runs agree
    under it whether or not the bug is still there, so pinning it hides the
    dependency. Use it to *confirm* hash-order sensitivity, then go and remove it.
  - An earlier session concluded the engine was deterministic after testing five
    hash seeds. That test used the **single-frame** path; this is in the
    multi-storey one. "Deterministic" is a claim about a code path, not an engine.
  - The line below the bug already called `sorted(selected)` for the *report*.
    When you find ordering made deterministic for display, check the data it
    describes.

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
- **The frame gutter reaches TWICE its own value, and a sheet can put two plans
  closer than that.** `segment_frames` inflates *both* wall boxes by `gutter`, so
  `DEFAULT_GUTTER = 3.0` merges anything within **6.0 m**. The villa draws its two
  storeys **2.477 m apart** and they merged into one flat 505 m² building with
  901 m of wall — a bill of quantities for a building that does not exist, and it
  passed VERIFY. No gutter value fixes it: separating them needs < 1.238 m and the
  upper storey has a 7.73 m internal gap. `solve/frames.py` now applies a second
  criterion — an axis-projection channel that no wall crosses — with `min_walls`
  on both sides and a minimum side share. Read its docstring before touching it;
  the guards each exist for a measured reason.
- **A projection gap, not an empty rectangle.** An empty rectangle is everywhere in
  a floor plan; a courtyard, corridor or open-plan void produces no gap in the
  projection because walls elsewhere at the same coordinate fill the band. This is
  why the split is a projection test. The one shape that can produce a genuine
  projection gap inside a single drawing is a **partitions-only plan with no
  perimeter** — the same shape `add_perimeter` exists for. Known limit, recorded
  in the tests rather than hidden: every frame is still returned, so `--frame`
  recovers the other half, and `Frame.origin` says whether a cut happened.
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
