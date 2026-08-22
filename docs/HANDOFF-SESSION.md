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
- ~~**Masonry volume looks ~2× high**~~ — **INVESTIGATED 2026-08-22. Both
  suspects were right, and they are two independent defects that compound.**

  **1. The sheet's other drawing did leak into frame 0 — it is the other
  STOREY.** `DOWN VILLA -WD 22-1-24.dxf` draws two floors of the same villa
  2.477 m apart, and `segment_frames` merged them into one flat building. Union-
  find over wall endpoints gives two components of identical 20.8 m width and
  identical 15.1 m height with a clean gap and **zero walls straddling**; one
  holds FOYER / Drawing / KITCHEN, the other PASSAGE / BED ROOM / Enclosed
  Balcony and an `OFFICE PATIO (BELOW)` cross-reference.

  The gutter cannot separate them and no value of it can. It is added to *both*
  bounding boxes, so `DEFAULT_GUTTER = 3.0` merges anything within **6.0 m**;
  splitting these needs < 1.238 m, and the upper storey has a 7.73 m internal
  gap. **Fixed** — `solve/frames.py` now cuts a frame on an axis-projection
  channel no wall crosses. See its docstring and the traps list in HANDOFF-POCHE.

  Villa now: **129 walls, 474.19 m built / 316.64 m billable, 22 rooms,
  263.78 m²** (was 303 walls, 901.06 m, 41 rooms, 505.4 m²). `frames[0]` is
  unchanged on all six other real DXFs.

  ⚠ **Any villa figure predating `6ea3fea` is stale**, including the 146 walls /
  459.09 m / 305.15 m billable / 23 rooms / 252.76 m² that this paragraph used
  to quote. The sheet border was consuming real wall faces — see §4a.

  **2. `add_perimeter` does double-count, and it is the larger defect.**
  **FIXED in `ec39fc1`.** `add_perimeter` derives the envelope by closing on
  wall centrelines and emitting the boundary, and most of that ring lands on
  top of walls that already exist — 341.4 m derived on the villa, 310.8 m of it
  within a wall thickness of a real wall. Coincident walls render on top of each
  other, so nothing about the model ever looked wrong, and half the masonry in
  the bill was for wall that gets built once.

  The fix marks the overlap rather than removing it: walls carry a `duplicate`
  length, the summary carries `totalLength` / `billableLength` /
  `duplicateLength`, and `boq.py` charges on billable. Villa (post-`6ea3fea`):
  **474.19 m built, 316.64 m billable**.

  **DO NOT "fix" this by tuning `CLOSE_RADIUS`.** It looks like the obvious
  lever and it destroys the model. On a drawing whose exterior is unpaired
  single lines, **that ring IS the outer boundary, not a gap-filler** — at
  R=0.50 the duplication does collapse (12.8 m) and the building collapses with
  it: 23 rooms become 9, with not one room over 15 m². Any sweep of this
  constant needs a *closure* column beside the duplication column, or it reads
  as a clean win.

  The measurement that settled it: across the radius sweep, **billable length
  holds at 290–305 m (2.5% spread) while total swings 58%**. That is the
  signature of a real quantity being recovered rather than a constant being
  tuned, and it is now an assertion in `test_build.py`.

  **Note why the ratio hid this.** The storey merge doubled the wall run *and*
  the floor area, so it never moved m-of-wall-per-m². After fixing it the ratio
  is still 1.82 m/m² against a normal band of 0.8–1.2 — the perimeter
  over-count is the whole of the remaining excess.

  **Two suspects measured and eliminated — do not re-test:**
  * A5 FALSE CEILING does **not** duplicate A1 WALLS HIDDEN. They are 96%
    disjoint: 10.5 m of shared run at 0.10 m tolerance out of A5's 290.16 m,
    confirmed by two independent implementations. A5 is genuine linework.
  * The 73 unpaired walls are **not** unpaired face pairs. No unpaired wall in
    this model has an unpaired partner at a plausible thickness.

- **A rate lookup matches on a substring and silently misprices.**
  `library.find("m sand")` returns HYD26-0032 *Coarse Aggregate | 20 mm*,
  because the concatenated haystack `"coarse aggregate 20 mm sand, aggregate &
  earth"` contains `"m sand"` inside `"20 mM SAND,"`. Mortar sand is priced as
  coarse aggregate. The matching strategy will do this again on other terms.

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
cd services/reconstruct && ./.venv/Scripts/python.exe test/test_quantify.py # 57
```

Also run the deck suite against **both** PDF backends — the permissive one is
what ships, and the cross-backend assertions only fire when PyMuPDF is present:

```bash
cd services/floorplan-ai && .venv/Scripts/python.exe test/test_deck.py                        # 27
cd services/floorplan-ai && ARCVIA_PDF_BACKEND=pymupdf .venv/Scripts/python.exe test/test_deck.py  # 27
```

All green as of writing. `test_build.py` is 52 (was 45 — the frame-channel
split). **`quantify/` now has tests**: `test_quantify.py`, 57 assertions over
rates, BOQ and refresh, with no network — `refresh.fetch` is stubbed, because a
suite that reaches three public price pages fails on a train and those are small
sites run by people.

The three assertions that matter most there, each guarding a mistake already
made once: that a refresh **never stamps a date the page did not give it**, that
a move past `TRUST_BAND` is refused as a parse failure rather than written, and
that `"m sand"` does not match inside `"20 mm sand"`.

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

## 8. Working alongside other sessions — READ BEFORE EDITING ANYTHING

**Three Claude sessions worked this repository simultaneously on 2026-08-22, and
all three misattributed each other's work at least once.** One file was destroyed
by it. Before touching `services/reconstruct/` or `services/floorplan-ai/`:

1. Run `ListAgents`.
2. `SendMessage` whoever is live and say which files you are about to edit.
3. Ask who owns what. Do not infer it.

Ownership as it stood at the end of this session:

| Session | Owns |
|---|---|
| this one | `services/floorplan-ai`, `apps/studio`, `services/api` routes, `services/reconstruct/quantify/`, `tools/asset-ingest` |
| `aalev-f3` | `services/reconstruct` engine — pairing, perimeter, spaces, verify, GLB, cameras; `services/render-worker` |
| `aalev-35` | `solve/frames.py` (frame splitting), the floorplan-ai PDF backends, `test/test_quantify.py` |

Note that `aalev-35` was reachable by neither of the others — it appeared in no
peer list and its pipe address was rejected — so all traffic to it went through
the user. If you cannot reach someone, say so early rather than assuming silence
means absence.

### How the misattributions actually happened, because the pattern repeats

- I overwrote a file believing it did not exist, on the strength of one
  directory listing taken minutes earlier.
- I then identified a peer by matching session start times, with four sessions
  running, and sent a long technical message to a session working on an
  unrelated game repository.
- `aalev-f3` and I held an entire exchange about `pdfbackend.py` in which each of
  us believed the other had written it. Neither had. **It took two of us
  agreeing to make the wrong answer look settled.**
- `aalev-35` credited me with `billableLength`, which was `aalev-f3`'s.

Every one is the same failure: **treating a consistent observation as a
sufficient one.** And in every case the correction came from measuring something
the original observation did not depend on — never from looking harder at the
original evidence. "Check more carefully" is not the lesson. "Check with an
independent quantity" is.

---

## 9. Tried and rejected — do not spend time re-deriving these

- **Tuning `CLOSE_RADIUS` to fix the perimeter double-count.** The measurement
  that suggests it is correct: R=0.50 collapses duplication from 341 m to 31 m.
  The inference is wrong. `aalev-f3` swept it and measured closure at the same
  time: at R=0.50 the building collapses too — 9 rooms, 36.6 m², zero rooms over
  15 m². The derived ring **is** the outer boundary, not a gap filler, because
  that drawing's exterior is unpaired single lines that never close alone. The
  fix is to emit the ring whole and account for the duplication, which is what
  `billableLength` does.
- **Refusing to build when the scale is untrustworthy.** Rejected for a better
  reason than convenience: most drawings print few dimensions OCR can read, so a
  hard block teaches users to pass a hand-typed `--scale`, which has no
  provenance at all. A marked estimate beats an unmarked assertion. Stamp the
  claims, pass the geometry.
- **A rug mesh from Sketchfab.** Ranked by popularity the candidates are
  photogrammetry scans at 600,000 triangles for an object that is geometrically a
  rectangle; ranked by triangle count the winner is a bare 12-triangle quad with
  no texture at all, which is worse than the parametric slab. For a rug the
  geometry is trivial and the *texture* is the object — filter on `textureCount`,
  which exists only on Sketchfab's model detail endpoint, not on search results.
- **`--no-rotate` when conditioning a flat asset.** A rug plane arrives vertical;
  disabling the up-axis correction leaves it standing on edge.
- **Blender 5.x for AOV passes.** Not fixable, measured exhaustively — see
  `arcvia_aov.compositor_works()`. Run AOV renders under Blender 4.2.
- **Counting up-vs-down normals to find an inside-out mesh.** Flipping a closed
  box swaps the counts and preserves the ratio. Compare winding against the
  stored normal per triangle.

---

## 10. Uncommitted at the time of writing

Everything of this session's own is committed. At the last check the working
tree also held, belonging to other sessions:

```
 M services/reconstruct/hypothesise/pair.py         aalev-f3
 M services/reconstruct/hypothesise/perimeter.py    aalev-f3
 M services/reconstruct/solve/frames.py             aalev-35
 M services/reconstruct/solve/verify.py             aalev-f3
 M services/reconstruct/test/test_build.py          aalev-f3
 M services/render-worker/arcvia_aov.py             aalev-f3
 M services/render-worker/render_views.py           aalev-f3
```

**Commit work mid-flight rather than leaving it untracked.** A half-written file
in history beats a finished one that exists only on somebody's disk — that is
not a general principle, it is the specific lesson of losing `ingest/raster.py`
today, which had existed for hours and was never one `git add` away from being
recoverable.

---

## Prompt for a new session

> Read `A:\Web\Arcvia\docs\HANDOFF-SESSION.md` and `docs\HANDOFF-POCHE.md` in
> full before doing anything. Both record what was tried and failed, not just
> what works — several of those look like the obvious right answer until you
> measure.
>
> **Before editing anything, read §8 and do what it says: run `ListAgents` and
> introduce yourself.** Other Claude sessions work this repository in parallel.
> One file was destroyed today because a session wrote to a path without
> checking who owned it, and it was untracked so nothing could restore it.
>
> **Then read `docs/PENDING-ARCVIA.md`, and take your work from there, not from
> this list.** That file is the whole product with the ownership map; this one
> is one subsystem in depth. Three sessions spent a day inside this document
> while most of Arcvia sat untouched, and the user was right to call it.
>
> **All five items that used to be listed here are done.** Recorded so nobody
> redoes them:
>
> 1. ~~Tests for `quantify/`~~ — `test/test_quantify.py`, since extended to 92
>    assertions. No network; `refresh.fetch` is stubbed.
> 2. ~~The masonry question~~ — two independent defects compounding. See §4, and
>    §9 for the fix that looks right and is not.
> 3. ~~Surface `oldestRateDays`~~ — the `costing` CLI command prints it with an
>    escalating warning past 7 and past 90 days. **The one half still open:
>    nothing runs `rates --refresh` on a timer.** `--refresh` alone is a dry run
>    that reaches the network and reports what it *would* change; nothing is
>    written without `--write`; it exits 1 if a refresh updated nothing but hit
>    unreachable or untrusted sources, so a scheduler can tell a dead run from a
>    quiet one. It needs a cron entry and a decision about who it emails.
> 4. ~~VR requirements~~ — `docs/SPEC-VR.md`. Deliberately builds nothing, and
>    names three prerequisites that are each independently worth having.
> 5. ~~Re-import of a revised DWG~~ — `docs/DESIGN-REIMPORT.md`. Short version:
>    the schema was **already** built for it (`locked`/`suppressed`, IDs shaped
>    `w:dxf:LATEST#2F3A`), and DXF entity handles are readable but the engine
>    discards every one. One field at ingest, ~8 days, and it avoids the lossy
>    projection that correctly killed round-tripping.
>
> Do not re-derive anything in §2. Do not revert the reader to per-stroke wall
> classification. Use the Write/Edit tools for code containing regexes — bash
> heredocs silently corrupt escape sequences in this environment.
>
> And the rule that has produced more of today's real findings than any other:
> **when you sweep a constant or change a default, measure whether the RESULT is
> still valid, not just whether the metric moved.** Three changes were reverted
> today on that basis, each with a better finding attached than the change it
> replaced.
