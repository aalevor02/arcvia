# Session handoff — floor-plan reading, assets, quantities

Written 2026-08-22. Paste the prompt at the bottom into a new session.

This covers the **plan-reading / assets / quantities** track. The CAD engine has
its own handoff at `docs/HANDOFF-POCHE.md` — read that too, they overlap.

---

## 0. Read first

1. `docs/HANDOFF-POCHE.md` — the CAD→3D engine, its traps, and §3/§4 which this
   session updated with measured answers.
2. `docs/handover.md` — setup, ports, the eight silent-failure traps.
3. This file.

**Nothing in `services/reconstruct/` is committed.** The working tree is the
record for that engine. Everything in this file's own track *is* committed —
7 commits, see §5.

---

## 1. What was built this session

### The floor-plan reader was rewritten (committed)

`services/floorplan-ai/` now finds **rooms first, then the walls that bound
them**. Do not revert this to per-stroke classification. Nothing local to a
stroke separates a 2 m bed from a 3 m partition — length, stroke weight, colour
and pixel texture were each measured on real drawings and all four overlap. The
symptom of the old code was 92 walls enclosing 0 rooms with the beds extruded.

Riding on the same pass:
- **OCR names the rooms** (`labels.py`), so a labelled WARDROBE is known to be
  joinery rather than structure.
- **Scale is read, not asked for** — from the dimensions printed inside rooms.
  Applied only when `underlay.calibrated` is falsy. Never override a human.
- **Site is separated from building** — LAWN, GREEN, WATER BODY produce no
  walls. Balcony and verandah deliberately do, they have a slab.
- **PDF decks** (`deck.py`) — plans extract at placed resolution; captions pair
  renders with rooms.

Selection between two binarisations scores **named rooms closed**. Area rewards
missing a partition; room count rewards shattering the plan. Names cannot be
gamed either way.

### Furniture identification and placement (committed)

`apps/studio/src/catalogue/recognise.ts` + `plan/furnish.ts`. A plan says what
is in it three ways, in descending reliability: it writes the name down, it
draws to scale, it names the room. Each is tried only where the previous had
nothing to say, and the review panel groups by which answered.

Verified against three real drawings, which found two faults now fixed: a
walk-in outside every room outline had no room to narrow by, and a rectangle
measured against every floor item always finds something within 30% — that is
how a 1.31 × 1.17 m block became a two-seat sofa.

### The asset hub (committed, plus a user-scope skill)

Skill at `~/.claude/skills/asset-hub`, invoked with `/asset-hub`.
**2,132 CC0 assets at `A:\Assets\Hub`** — 304 models, 856 materials, 671
textures, 301 HDRIs. All CC0, 0 requiring attribution, none missing provenance.

`tools/asset-ingest/from-hub.mjs` matches catalogue slots by name, tags, real
dimensions and triangle budget. **38 of 46 catalogue slots now carry a model.**
The remaining 8 are doors and windows, parametric on purpose.

### The raster path for Poché (NOT committed)

`services/reconstruct/ingest/raster.py` + `raster_build.py` + a `raster` CLI
command. A photograph → a verified building:

```
DETECT   13 single lines, 25 already paired, 8 rooms (6 named)
SCALE    14.32 m across the image, 5 rooms, 16% spread
WALLS    65, median thickness 0.241 m
VERIFY   PASS  (0 blocking, 0 warnings)
```

PNG/JPG/WebP added to `READABLE` in `routes/cad.js`.

### Quantities and costing (NOT committed)

`services/reconstruct/quantify/` — `rates.py`, `boq.py`, `refresh.py`.
Rate library at `data/rates/hyderabad-2026.csv`, 235 rates, all dated.

Villa BOQ from its DXF: **₹3,253,201**, every line carrying the rule that
produced its quantity.

---

## 2. Answers established by measurement — do not re-derive

**Detector output is mixed, and the thickness says which is which.**
`merge_parallel` pairs what it can; the rest stay single ink lines.

| drawing | segments | single line | already paired |
|---|---|---|---|
| villa | 38 | 15 | 22 |
| Avarana ground | 19 | 14 | 4 |
| Avarana basement | 22 | **22** | 0 |

There is no constant answer. `PAIRED_MIN_THICKNESS = 0.075 m` — thinner than
any wall anyone builds.

**Black pockets: six hypotheses eliminated.** See HANDOFF-POCHE §3. Winding,
normals, materials, tone mapping, light direction, light intensity, and the
`A5 FALSE CEILING` layer are all ruled out with evidence. What remains: those
surfaces see light from nowhere, so the camera is inside sealed geometry.
Diagnostic at `services/reconstruct/_normals.py`.

**Counting up-vs-down normals cannot detect an inside-out box.** Flipping a
closed solid swaps the counts and preserves the ratio. Compare winding to the
stored normal per triangle instead.

**Rooms for a raster come from the detector, not the wall graph.** On the villa
the graph closed 3 rooms totalling 18.5 m²; the detector had 8 covering 84 m².
Verify still judges the graph, or it would pass walls that enclose nothing.

---

## 3. Traps hit this session

- **Installing OCR replaces headless OpenCV.** `pip install --no-deps
  rapidocr-onnxruntime`, and stop uvicorn first on Windows or it dies with
  WinError 5 holding `cv2.pyd`.
- **Blender 5 broke the AOV path in four places** — `scene.node_tree` →
  `compositing_node_group`, `base_path` → `directory`, `file_slots` gone,
  `CompositorNodeMixRGB` → use `ShaderNodeMixRGB`. Fixed; it no longer crashes,
  but the passes still do not write files.
- **Poly Haven is Z-up.** `dimensions` is `[width, depth, height]`. Reading the
  second as height made the only bookshelf in the library score 27 against a
  threshold of 40, and the slot came back empty with nothing erroring.
- **A flat model collapses when fitted to a target box.** Fitting a 12 mm
  thickness against a near-zero extent gave scale 0.006. Axes with no extent now
  take no part in the fit.
- **Python heredocs eat escapes.** `\b` becomes a literal backspace (0x08) with
  no warning, because backspace is a valid Python escape. `\d` warns; `\b` does
  not. Use the Write/Edit tools for anything with regexes.
- **PyMuPDF is AGPL.** The other session removed it from a test fixture for this
  reason, but `services/floorplan-ai/deck.py` still imports it **in production**.
  Unresolved licensing risk for a commercial product.

---

## 4. Known limits, stated plainly

- **Photographic plans yield no furniture.** Villa A-1's furniture is pasted
  photographs — no closed shapes to measure. Walls, rooms, names and scale all
  work; furniture falls back to room-type assumptions.
- **Merged rooms.** Wide openings read two spaces as one. Reported, not silently
  wrong.
- **The BOQ is not a structural take-off.** No beams, columns or designed slabs
  exist in the model, so there is no reinforcement schedule. Stated in the
  output's own caveats.
- **Masonry volume looks ~2× high** — 901 m of wall for a 505 m² villa. Either
  `add_perimeter` double-counts against existing walls, or the sheet's other
  drawings leak into frame 0. **Not yet investigated.**

---

## 5. Commits

```
678a521  Fit a flat model without collapsing it, and give the rug a texture
0a8c3e0  Write down what a second engineer needs
0e755ba  Fill four catalogue slots from the shared asset library
81cf363  Read the furniture the drawing already shows
ea50776  Rebind the 2D canvas when its element is replaced
9e40c0f  Take the scale off the drawing instead of asking for it
75a9c64  Accept the PDF a client actually has
```

Branch `villa-model-view-and-film`. The Poché engine and the quantify work are
**uncommitted on purpose** — another session owns that tree.

---

## 6. Test commands

```bash
cd apps/studio && node test/run.mjs                    # 319
cd services/api && npm test                            # 149, needs dev:api
cd services/floorplan-ai && .venv/Scripts/python test/test_deck.py   # 22
cd services/reconstruct && ./.venv/Scripts/python.exe test/test_classify.py  # 53
cd services/reconstruct && ./.venv/Scripts/python.exe test/test_build.py     # 45
cd services/reconstruct && ./.venv/Scripts/python.exe test/test_render.py    # 44
```

All green as of writing. **`quantify/` has no tests yet** — that is the first
thing the next session should fix.

---

## 7. Outstanding from the user's last instruction

Asked for, not yet done:

1. **VR requirements** — gather and document, build later.
2. **Daylight factor** — was blocked on validation data; the user has asked for
   it anyway. Needs reference values or it is a liability.
3. **Re-import a revised DWG** — the user has explicitly reopened the
   "one-shot importer, no merge engine" decision.
4. **Schedule the weekly rate refresh** — `quantify/refresh.py` works and is
   verified against the live source; nothing calls it on a timer yet.
5. **BOQ tests, and the masonry ~2× question in §4.**

Left deliberately: the two `TODO(you)` business judgements. The user has said
they will decide those last.

---

## Prompt for a new session

> Read `A:\Web\Arcvia\docs\HANDOFF-SESSION.md` and `docs\HANDOFF-POCHE.md` in
> full before doing anything. Both record what was tried and failed, not just
> what works — several of those look like the obvious right answer until you
> measure.
>
> Then, in this order:
>
> 1. Write tests for `services/reconstruct/quantify/` — rates, BOQ, refresh.
>    The refresh path especially: it must never stamp a date it cannot justify,
>    and it must refuse a price that moved more than 40% in one run.
> 2. Investigate §4's masonry question — 901 m of wall for a 505 m² villa is
>    about twice what it should be. Suspect `add_perimeter` double-counting or
>    another drawing on the sheet leaking into frame 0.
> 3. Schedule the weekly rate refresh and surface `oldestRateDays` wherever a
>    costing is shown.
> 4. Gather VR requirements as a written spec; do not build it — it cannot be
>    tested on this machine.
> 5. Re-import of a revised DWG: the user has reopened this decision. Design it
>    before building it — the existing note says "one-shot importer, no merge
>    engine", and that was a considered choice.
>
> Do not re-derive anything in §2. Do not revert the reader to per-stroke wall
> classification. Use the Write/Edit tools for code containing regexes — bash
> heredocs silently corrupt escape sequences in this environment.
