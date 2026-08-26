# Arcvia — one upload, every deliverable

What it would take for Arcvia to be the only tool an architect opens between a
drawing set and a client walkthrough.

Written 2026-08-22. Companion to `HANDOFF-POCHE.md` (engine state) and
`roadmap-parity.md` (feature parity with the reference product, now partly stale
— see §7).

---

## 1. Who this is for, and why nobody serves them

The wedge is not "architects". It is **practices who draw in AutoCAD and never
adopted BIM** — which is most small and mid-size practices in India and much of
the world. They have a 2D drawing set, no 3D model, and no intention of
rebuilding their workflow in Revit.

Today that practice pays a visualisation studio per view, waits days, and cannot
iterate. Every tool aimed at them assumes the model already exists:

| Product | Needs | Gives | Cannot |
|---|---|---|---|
| Shapespark | a modelled 3D scene | a good walkthrough | build the model |
| Enscape / Lumion | a live Revit/SketchUp model | renders | help a CAD-only practice |
| Matterport | an existing building | a scan | anything at design stage |
| mnml.ai | any image | a different image | geometry, scale, export, consistency |
| **Arcvia** | **the DWG they already have** | **model + drawings + quantities + walkthrough** | — |

**Poché is the only thing in this market that meets a CAD-only practice where it
already is.** That is the claim worth building everything else around, and it is
currently one wiring job away from being unreachable in the product.

---

## 2. The journey, stage by stage

Status is honest: **✓ built** · **◐ partial** · **✗ absent**.
Effort is rough working days.

### Stage 1 — Intake: whatever they actually have

| | Item | Effort | Note |
|---|---|---|---|
| ✓ | DWG (LibreDWG gate) | — | done, verified |
| ✓ | DXF | — | done |
| ✗ | **Vector PDF** | 4–6 | A print-to-PDF is *exact* vector geometry. Extremely common, and `deck.py` currently returns an empty sheet list that reads as a successful import of nothing. |
| ✗ | **Scanned / photographed plan** | 6–10 | `floorplan-ai` is running on :8090 and already returns walls, rooms **and a scale read from printed dimensions**. Needs `ingest/raster.py` only. See `HANDOFF-POCHE.md` §4. |
| ✗ | IFC | 8–12 | The interchange standard. Opens the door to practices that *did* adopt BIM. |
| ✗ | ~~SketchUp `.skp`~~ **→ accept its exports instead** | 3–4 | **Not an effort item — a licence one.** Reading `.skp` needs Trimble's licensed C++ SDK; there is no pip wheel and no open reader for modern `.skp`. The fix is not to read it: SketchUp Pro exports DWG, DXF, DAE, OBJ, FBX and IFC natively. Accept those and the problem disappears — and the same reader serves Rhino, 3ds Max and Blender users. |
| ◐ | Multi-sheet sets | — | `solve/frames.py` splits them; picking the right frame is still manual. |

### Stage 2 — Reconstruct: make it a building, not a floor

**This is where the biggest structural gaps are.**

| | Item | Effort | Note |
|---|---|---|---|
| ✓ | Walls with measured thickness | — | 0.23 m off a real drawing, unprompted |
| ✓ | Rooms at the finished face | — | |
| ✓ | Openings cut arithmetically | — | |
| ✓ | Fixtures placed from blocks | — | |
| ✓ | Building envelope (`add_perimeter`) | — | the single highest-value piece |
| ✗ | **Multi-storey** | 10–14 | `storey0` is hardcoded. **A house has floors.** Storey registration is M6 in the blueprint and unbuilt. Nothing below matters as much as this. |
| ✗ | **Stairs** | 6–8 | You cannot walk a client between floors without them. Needed the moment storeys exist. |
| ✗ | **Roof** | 6–10 | Every exterior view currently shows an open-topped box. Also the cause of the unlit interior pockets. |
| ✗ | Ceilings / false ceilings | 3–4 | The layer is already in the drawings — `A5 FALSE CEILING` is one of the two the selector picks. |
| ✗ | Site / terrain | 5–8 | Casa Altinho has garden levels; a villa on a slope is not optional. |
| ◐ | Curved walls | 3–5 | Arcs are read but chorded. |

### Stage 3 — Review: make it trustworthy

| | Item | Effort | Note |
|---|---|---|---|
| ✓ | The verify gate | — | refuses to ship a model it does not believe |
| ✗ | **Residual queue (M5)** | 12–15 | The ranked list of what the solver is unsure about, with one-click choices. **This is what turns "usually right" into "safe to sell".** Needs the 12-drawing corpus first. |
| ◐ | `CadImport.tsx` review screen | 5–7 | First slice built: successful jobs with verifier warnings now pause before import, show ranked findings and model facts, and require explicit acceptance. Solver residual choices and persistent `ModelPatch` replay remain. |
| ✗ | Fix-and-re-solve | 4–6 | Correct one wall, re-run, keep the correction |

### Stage 4 — Design: the part they enjoy

| | Item | Effort | Note |
|---|---|---|---|
| ✓ | Furniture catalogue | — | **38 of 46 items already carry real licensed GLBs** |
| ✗ | **Wire `A:\Assets\Hub`** | 3–5 | **301 HDRIs, 856 materials, 307 models, 671 textures already harvested with credits and a manifest.** Almost none of it is reachable from the studio. Highest value-per-day item on this entire document. |
| ✗ | Material editor / per-face materials | 8–10 | roadmap todo |
| ✗ | Lighting controls (sun colour, intensity, gizmo) | 4–5 | roadmap todo |
| ✗ | Modelling tools (box, extrude, cuts) | 12–15 | for the things a plan cannot express |

### Stage 5 — Validate: what a drawing cannot tell you

Nothing in this stage exists, and it is where a visualisation tool becomes a
design tool.

| | Item | Effort | Note |
|---|---|---|---|
| ✗ | **Clearance checking** | 4–6 | Does the door swing hit the bed? Is there a metre past the sofa? The catalogue is *correctly dimensioned* precisely so this is answerable — that is stated as its whole purpose and nothing uses it. |
| ✗ | Area schedule export | 1–2 | Rooms already carry finished-face areas |
| ✗ | **Sun path / shadow study** | 4–6 | Architects need this for approvals. Blender does it natively; the cameras are already solved. |
| ✗ | Code checks (min room, corridor width, egress) | 8–12 | Regional rulesets. High value, high maintenance. |
| ✗ | Daylight factor | 6–8 | Needs the bake path, which exists |

### Stage 6 — Quantify: the money argument

**All of this is a report over data already in `building.json`.** No new
extraction, no new modelling.

| | Item | Effort | Note |
|---|---|---|---|
| ✗ | **Door / window schedule** | 1–2 | Openings already carry kind, width, height, sill and host wall. This is a table. |
| ✗ | **Room area schedule** | 1 | Already computed |
| ✗ | **BOQ / BOM (.xlsx)** | 4–6 | Wall lengths × thickness × height, floor areas, fixture counts by catalogue id. On the roadmap as todo. |
| ✗ | Paint / finish areas | 2–3 | Wall face area minus openings — arithmetic |
| ✗ | Cost estimate | 5–8 | Needs a rate library; regional |

A practice currently does the schedule and the BOQ **by hand, from the same
drawing**. Handing it back automatically is hours saved per project, and no
visualisation competitor offers it at all.

### Stage 7 — Visualise

| | Item | Effort | Note |
|---|---|---|---|
| ✓ | Solved cameras (interior / orbit / iso / plan) | — | 47 on the villa |
| ✓ | Vector plan drawing | — | poché filled, named rooms, scale bar |
| ✓ | Cycles stills, 6 styles | — | |
| ◐ | Lightmap bake | 3–4 | API + worker exist, **no UI** |
| ✓ | **360° panoramas** | — | Built: 4096×2048 equirectangular Cycles preset, persistent scene panorama, shared drag/zoom viewer in Studio and published walkthrough, access-code gating, and removal. Real 512×256 Blender output is verified; full browser-flow and production-size render checks remain. |
| ✗ | AI finish (`finish_ai.py`) | 5–8 | AOV passes are built and now Blender-5-correct |
| ✗ | Film / orbit encode | 3–4 | `encode_film.py` exists in `tools/cad-to-3d` |
| ✗ | VR | 6–10 | |

### Stage 8 — Deliver: what the client actually sees

**The largest missing surface.** The reference product runs an entire sixth
application for this.

| | Item | Effort | Note |
|---|---|---|---|
| ◐ | Published walkthrough | — | Public viewer now includes persistent, access-code-gated 360 panoramas with removal parity; a broader authoring console is still absent. |
| ✓ | Hotspots | — | `apps/planviewer`, master plans only |
| ✗ | **Publisher app** | 15–20 | bake console, named views, checkpoints, autoplay |
| ✗ | **Configurator (object + material switching)** | 8–12 | "Show me the oak floor instead." **This is the feature that closes the sale**, and the catalogue + material library make it reachable. |
| ✗ | Per-scene branding | 2–3 | The practice's logo, not yours |
| ✗ | Login-gated scenes | 2 | already partly present via access codes |
| ✗ | **Client comments / feedback capture** | 5–7 | Nobody in this market does it well. Turns a deliverable into a conversation. |
| ✗ | PDF summary of selected options | 3–4 | |

### Stage 9 — Iterate

| | Item | Effort | Note |
|---|---|---|---|
| ✗ | Re-import a revised DWG | 10–12 | **Deliberately deferred** — see the one-shot decision. Revisit only when customers ask. |
| ✗ | Variants / options (kitchen A vs B) | 6–8 | Pairs with the configurator |
| ✗ | Version compare | 4–6 | |

### Stage 10 — Operations

Small, unglamorous, and they are what stop a product being trusted.

| | Item | Effort | Note |
|---|---|---|---|
| ✗ | **Queue persistence** | 2–3 | `pending`/`running` are plain in-memory objects. A deploy destroys a 45-minute job **after** the CPU is spent. |
| ✗ | **Idempotency on submit** | 1 | Zero handling in `render.js` or `cad.js`. A double-click charges twice. |
| ✗ | Per-preset queue lanes | 1–2 | One bake currently blocks every 240 px preview |
| ✗ | Generate `pricing.astro` from `creditCost` | 1 | Hand-maintained, silently goes stale |
| — | **Render capacity** | — | ~1 min/frame CPU-only is the ceiling on everything in Stage 7. A decision, not a task. |

---

## 3. What I would actually do, in order

Ranked by *value per day*, not by size.

**Tier 1 — days, not weeks. Do these first.**
1. **Wire `A:\Assets\Hub`** (3–5 d) — 2,100 assets already on disk and unreachable.
2. **Poché as the studio's front door** (2–3 d) — the differentiator is unreachable from the product.
3. **Schedules + BOQ** (5–8 d) — a report over data you already have; nobody else offers it.
4. **Queue persistence + idempotency** (3–4 d) — stops silently losing work and double-charging.
5. ~~**360° panoramas**~~ — built, including persistence, public viewing,
   access-code gating, and removal; browser-flow and production-size render
   verification remain.

**Tier 2 — the structural gap.**
6. **Multi-storey + stairs + roof** (22–32 d) — a house has floors. Nothing in Stage 7 or 8 is really sellable until this is true.

**Tier 3 — what makes it trustworthy and what closes sales.**
7. **Residual review queue (M5)** (17–22 d) — turns "usually right" into "safe to sell".
8. **Configurator** (8–12 d) — the feature clients decide on.
9. **Publisher app** (15–20 d) — the surface the client actually touches.

**Tier 4 — reach.**
10. Vector PDF, then raster, then IFC/SKP intake.
11. Clearance checking and sun path — the move from visualisation to design.

---

## 4. The sentence this is all for

> Upload the drawing you already have. Get the model, the plan, the schedules,
> the quantities and a walkthrough you can send to your client.

Every item above either makes that sentence true, or makes it trustworthy. Items
that do neither are not on this list.

---

## 5. Deliberately not doing

- **Competing with Revit.** This serves practices that chose not to adopt BIM.
- **Generative imagery as the product.** Diffusion stays a finish over real
  geometry, conditioned on real depth and normals. `reference-mnml.md` §9 records
  what happens to a product built the other way round.
- **Payments.** `billingEnabled: false` is a decision. The credit model meters.

---

## 6. Open questions worth deciding before building

1. **Render capacity.** CPU-only caps Stage 7 permanently. GPU in the box, a
   rented lane, or commit publicly to stills and short orbits?
2. **Who is the buyer** — the practice, or the developer selling flats? The
   configurator and client-comments features serve the second; schedules and
   clearance checking serve the first. Both is fine; the *first* one is not.
3. **Regional scope for code checks and cost rates.** Very high value, very
   high maintenance. Worth doing only for one market at a time.

---

## 7. Corrections to `roadmap-parity.md`

That document is largely accurate and two entries are now wrong:

- **"Real 3D models in the catalogue — todo."** 38 of 46 catalogue items carry
  licensed GLBs, and `A:\Assets\Hub` holds 307 more models, 856 materials, 671
  textures and 301 HDRIs with a credits file.
- **"The gap that remains is assets, not code."** The sourcing is done. The gap
  is now wiring, multi-storey geometry, and delivery.

---

## 8. The same list, cut by ADD vs UPGRADE

§2 is organised by the architect's journey. This is the same content organised by
what kind of work it is — useful when planning a sprint rather than a product.

### ADD — does not exist at all

**Intake**
- Vector PDF reader (`ingest/pdf_vector.py`) — 4–6 d
- Raster / scan / photo (`ingest/raster.py`) — 6–10 d — detector already returns scale
- IFC reader — 8–12 d
- SketchUp `.skp` reader — 5–8 d

**Geometry — the structural gap**
- Multi-storey (storey detection + registration) — 10–14 d
- Stairs — 6–8 d
- Roof — 6–10 d
- Ceilings / false ceilings — 3–4 d
- Site / terrain — 5–8 d

**Trust**
- Residual review queue (M5) — 12–15 d
- `CadImport.tsx` review screen — 5–7 d
- Fix-one-wall-and-re-solve — 4–6 d

**Validate — nothing in this stage exists**
- Clearance checking — 4–6 d — catalogue is dimensioned FOR this and nothing uses it
- Sun path / shadow study — 4–6 d
- Code checks (min room, corridor, egress) — 8–12 d
- Daylight factor — 6–8 d

**Quantify — nothing exists; all of it is a report over `building.json`**
- Door / window schedule — 1–2 d
- Room area schedule — 1 d
- BOQ / BOM `.xlsx` — 4–6 d
- Paint / finish areas — 2–3 d
- Cost estimate (needs a rate library) — 5–8 d

**Visualise**
- ~~360° panoramas — 2–3 d~~ — built; browser-flow and production-size render
  verification remain
- AI finish (`finish_ai.py`) — 5–8 d
- Film / orbit encode — 3–4 d
- VR — 6–10 d

**Deliver**
- Publisher app — 15–20 d
- Configurator (object + material switching) — 8–12 d
- Client comments / feedback — 5–7 d
- Per-scene branding — 2–3 d
- PDF summary of chosen options — 3–4 d

**Iterate**
- Variants / options — 6–8 d
- Version compare — 4–6 d
- Re-import a revised DWG — 10–12 d — deliberately deferred

**Operations**
- Queue persistence — 2–3 d
- Idempotency on submit — 1 d
- Per-preset queue lanes — 1–2 d

### UPGRADE — exists, but not finished or not reachable

- **`A:\Assets\Hub` is unwired** — 301 HDRIs, 856 materials, 307 models, 671
  textures, with credits and a manifest, and almost none of it reachable from the
  studio. 3–5 d. **Highest value per day in this document.**
- **Poché is not the studio's front door** — the differentiator cannot be reached
  from the product. The studio's GLB-import project start was never finished and
  Poché emits GLBs. 2–3 d for both ends.
- **Lightmap bake has no UI** — API and worker both exist. 3–4 d.
- **`pricing.astro` is hand-maintained** — generate it from `creditCost`. 1 d.
- **`scenes.js` writable allow-list silently drops unknown fields** — should
  reject, not ignore. 1 d.
- **Curved walls are chorded** — arcs are read and then flattened. 3–5 d.
- **Frame selection is manual** — `solve/frames.py` splits the sheet correctly;
  choosing the right frame still needs a human, and gets it wrong on
  `LATEST DRAWINGS`. 3–5 d.
- **Render capacity** — ~1 min/frame CPU-only caps everything visual. A decision,
  not a task.

### FIX — known defects

- Black pockets in lit renders — six hypotheses eliminated, see `HANDOFF-POCHE.md` §3
- ~~6 of 18 doors unhosted on the villa~~ — current auto-layer, multi-storey
  run reports zero unassigned openings; exact targets are retained if it regresses
- ~~`LATEST DRAWINGS` yields only small rooms (a frame problem)~~ — fixed; it was
  a unit problem, not a frame problem
- Villa wall fidelity: 202/298 paired (67.8%), but wall run remains 3.48 m per
  m² of indoor floor, indicating duplicate walls or rooms that are not closing

---

## 9. Licence constraints — not effort, and not negotiable by working harder

Added 2026-08-22 after an item was priced as engineering when it was a licence
problem. Audited the rest of the dependency surface for the same mistake.

| Component | Licence | What it means |
|---|---|---|
| `ezdxf` | MIT | free |
| `shapely` | BSD-3 | free |
| `opencv-python-headless` | Apache 2.0 | free |
| `fastapi` · `pydantic` | MIT | free |
| ~~`pymupdf`~~ | ~~AGPL-3.0~~ | ✅ **OUT OF THE PRODUCT 2026-08-22.** Replaced by `pypdfium2` (BSD-3/Apache-2.0) + `pdfplumber` (MIT) behind `services/floorplan-ai/pdfbackend.py`; fixtures moved to `reportlab` (BSD-3). Later restored as an **opt-in diagnostic backend** — `requirements-dev.txt` only, never `requirements.txt`, selected by `ARCVIA_PDF_BACKEND=pymupdf`, no automatic fallback. A shipped artifact still contains no AGPL. Not in the `reconstruct` venv at all. 27/27 deck tests, 4 of them cross-backend. |
| **LibreDWG** | **GPL-3.0** | Invoked as a **subprocess** (`dwg2dxf.exe`), which is aggregation rather than linking — the standard mitigation. Never link it, never bundle it into the same distributable, and keep the invocation at arm's length as it is today. |
| SketchUp `.skp` | Trimble SDK, licensed C++ | No open reader exists. Do not plan around building one. |

### PyMuPDF — done

Removed 2026-08-22. `services/floorplan-ai/pdfbackend.py` is a small adapter
presenting the same shapes `deck.py` already expected, backed by:

- **pypdfium2** (BSD-3 / Apache-2.0) — embedded images at NATIVE resolution and
  their placed rectangle. This is the trick `deck.py` depends on: a plan buried
  in a slide is a 4096 px original, not a screenshot of a slide.
- **pdfplumber** (MIT, over `pdfminer.six`) — text with positions *and font
  size*, which is what separates a caption from a footer.
- **reportlab** (BSD-3) — test fixtures only. PyMuPDF was also the fixture
  generator; leaving it as a dev dependency keeps the obligation one careless
  import away from the service, so it went too.

**The trap this absorbed:** PyMuPDF and pdfplumber measure y *downward from the
top*; pypdfium2 returns PDF-native coordinates, which measure *upward from the
bottom*. `nearest_caption()` compares text positions against image rectangles,
so mixing them does not raise — it silently captions the wrong picture, and the
symptom looks like bad captioning rather than bad arithmetic. The conversion
happens once, at the boundary, and `deck.py` needed no coordinate changes.

**Write the vector-PDF reader against `pdfplumber`** — its `.lines` / `.rects` /
`.curves` are the permissive equivalent of `page.get_drawings()`.

#### It came back as an opt-in second reader — 2026-08-22, later the same day

Removed from the product, restored as a *selectable* backend. Two independent
readers of the same PDF disagree in useful ways: when a deck extracts as an
empty sheet list, re-reading it with the other engine turns "the importer is
broken" into "these two disagree about page 4".

What keeps it off the licence sheet:

| | |
|---|---|
| `requirements.txt` | unchanged — `pypdfium2` + `pdfplumber` only |
| `requirements-dev.txt` | **new**, `pymupdf`, opt-in, nothing refers to it |
| `ARCVIA_PDF_BACKEND` unset | permissive — the only value a release sees |
| `ARCVIA_PDF_BACKEND=pymupdf` | PyMuPDF, if this machine has it |

**There is deliberately no automatic fallback.** The obligation attaches to
distribution and network use, not to call frequency — a reader that silently
reached for PyMuPDF when the permissive path struggled would carry the full AGPL
obligation on every hosted request. Selecting it is an explicit act, and asking
for it on a machine without it raises rather than quietly using the other one.
A mistyped backend name is refused for the same reason, and there is a test for
it: silent substitution would also make the two impossible to compare, which is
the entire point of having both.

`/health` reports `pdf_backend`, so which reader produced a result is never a
guess. `test_deck.py` is 27 assertions now, four of them cross-backend: the two
must agree on sheet count, on which caption pairs with which page, on what each
sheet is, and on native bitmap size. The caption assertion is the one that
matters — it is what catches the coordinate flip being applied on the wrong
path, which does not raise and looks like bad captioning rather than bad
arithmetic.

⚠ The running `floorplan-ai` service must be **restarted** to pick this up.

### The general rule this exposes

Before estimating any intake format, ask whether a *free, redistributable* reader
exists. If it does not, the item is not "N days" — it is a purchase, a licence
negotiation, or a request to the customer to export something else. Those are
different kinds of decision and they do not belong in a day count.
