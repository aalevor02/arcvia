# Arcvia — what is not done, and who is not doing it

Written 2026-08-22 by session `aalev-35`, for a new session joining a repo that
already has three working in it.

**Read this before `HANDOFF-SESSION.md` or `HANDOFF-POCHE.md`.** Those two are
deep on one subsystem — the CAD engine — because that is where three sessions
spent today. This file is the whole product, and it exists because that focus
was itself a problem: a lot of effort went into one villa's masonry number while
most of Arcvia stayed untouched.

---

## 0. First thing you do

Run `ListAgents`, then `SendMessage` to introduce yourself **before editing
anything**. Say which files you intend to touch and ask who owns them. Sessions
here have collided all day and the only thing that has reliably prevented lost
work is talking first.

```
ListAgents
SendMessage → aalev-35   (frame splitting, PDF backends, this document)
```

If `aalev-35` is gone, message whoever is live. The ownership map in §1 is
accurate as of writing and will drift.

⚠ **Reply by `ListAgents` NAME, never by the `from` address.** An incoming
message carries `from="uds:\\.\pipe\LOCAL\cc-msg-…"`, and the tooling tells you
to copy it — **that is the trap.** Sending to that value returns
`ENOINBOX: no-key`; sending to the plain `ListAgents` name (`aalev-35`, or
`aalev-35 [ca1b85]`) arrives every time.

This cost a whole session today. `aalev-35` sent eleven messages that all landed
and received almost nothing back, because peers were replying to the `from`
value. **Reachability is one-directional and peer names are per-session views** —
two sessions can each be absent from the other's `ListAgents` while one can still
send to the other. So: a silent peer is not a refusing peer. If something is
blocking, route it through the user rather than reading silence as a decision.

Two conventions that have already paid for themselves today:

- **Commit mid-flight.** `3fc71bb` is titled *"Track the reconstruction engine,
  so a collision is a merge not a deletion"*. That is the right instinct. An
  uncommitted tree plus three sessions is how work disappears.

- ⚠ **But "commit often" is not enough, and the missing half bit us.**
  **Five sessions share one git index.** `git add` followed by *any* other work
  opens a window in which another session's bare `git commit` sweeps up your
  staged files. It happened: `12c9a02` is titled about two Python constants and
  contains 456 lines of another session's studio work, because `git add <mine>
  && git commit` commits **the whole index**, not the paths you named.

  The victim had done the careful thing — staged only their own paths, checked
  `git status --short` for other sessions' files first, and used an explicit
  pathspec. **None of it helped**, because the staging happened before the
  window, not after it.

  > **Never let `git add` and `git commit` be separated by other work.**
  >
  > modified files only — skip the index entirely:
  > `git commit -F <msg> -- <paths>`
  >
  > anything NEW — one invocation, milliseconds not minutes:
  > `git add <new paths> && git commit -F <msg> -- <all paths>`

  **The second form is not optional for new files and the first will not work
  for them.** git only knows a path once it is tracked, so
  `git commit -F - -- new-file.ts` fails with *"pathspec did not match any file
  known to git"*. The window cannot be closed for a new file, only narrowed —
  and someone following "skip the index" literally will hit that error and may
  fall back to a bare `git commit`, which is the exact thing this prevents.

  Mind the argument order too: `--` ends option parsing, so
  `git commit -- <path> -F -` reads `-F` as a pathspec and dies. `-F` goes
  before the `--`.

  And **do not rebase to tidy an attribution mistake** — putting real work at
  risk to fix whose name is on a commit is a bad trade. Record it and move on.
- **Report what you refuted, not just what you found.** Two of today's
  hypotheses were killed by measurement and telling the other sessions saved
  them the same dead ends. A well-measured negative is a real result.

---

## 1. Who owns what, as of 2026-08-22

**ALL FIVE SESSIONS HAVE CLOSED. Nothing below is owned. The table is history —
it tells you who wrote what, and therefore whose reasoning is in which commit
message, and nothing more.**

| Area | Written by |
|---|---|
| `solve/frames.py`, `solve/storeys.py`, `classify/units.py`, `cli.py` | aalev-35 |
| `hypothesise/`, `solve/{verify,spaces,clearance}.py`, `build/`, `render/`, `render-worker/` | aalev-f3 |
| `quantify/`, API routes, `daylight/` | aalev-51 |
| `tools/asset-ingest/`, the asset curation, `apps/studio` surfaces + environments | aalev-1b |
| render bench, film, bake measurement (nothing written in-repo) | aalev-66 |

### ⚠ Corrections that supersede what follows

Landed after most of this document was written. Where they conflict, these win.

#### 2026-08-27 evening — the AI paths, and four ways a green summary lied

6. **The trained detector is LIVE, as a pass rather than a backend.**
   `services/floorplan-ai/segment.py` runs whenever `FLOORPLAN_MODEL` points at
   stamped weights. There is deliberately no `FLOORPLAN_BACKEND=segment` value —
   a third exclusive mode would force a choice between the classifier and the
   adjudicator when they do different jobs. **WHERE** stays with the heuristic,
   **WHAT** (railings) is the model's and is deterministic, **WINDOWS** stay with
   the adjudicator, which reads 3-5 against the model's one weak blob.

   The weights must carry their own class map; the loader **refuses** an
   unstamped model rather than guessing 44 channels. Note the named indices are
   RELATIVE to their head — `railing_class_index: 8` is absolute channel 29, and
   channel 8 is a junction.

   **The furniture-drop half is deliberately NOT built.** The wall-share
   distribution is a continuum, not two populations; three samplers were swept
   and the ambiguous middle never collapses (13-18 of 55). A threshold there is a
   policy decision about ~15 walls, and a dropped wall costs windows. Do not add
   one without new evidence.

0. **Nothing about the AI worked, and nothing said so.** The adjudicator's model
   had been retired by NVIDIA the previous day (HTTP 410); `adjudicate.py` fails
   open, so every call was swallowed as "went unanswered" while `/health`
   reported the model by NAME. Naming a model is not reaching it. `/health` now
   carries `adjudicator_liveness`, inferred from answered-vs-started counts —
   `null` answering, `"unverified"` = no call since start and **NOT healthy**,
   plus dead / degraded / sustained-rate / dead-window states. **Check this
   first before believing any AI output.**

   Also fixed on the way: `_encode` descended JPEG quality but never size, so a
   full deck page could not be encoded at all and `/design` blamed the model for
   an image it had never been shown — if `calls_started` does not move, the
   model was never asked and the fault is upstream of the provider. And a burst
   of concurrent calls made Windows' `getaddrinfo` fail on 35 of 79 calls, which
   is now retried (resolver/connection only — never HTTP statuses, never
   timeouts).

1. **`/detect` output is NOT reproducible, and it matters for anything scored
   against it.** Measured at n=5 with
   `services/floorplan-ai/test/variance.py --runs N`:

   ```
   rooms 12 every run · named 6 every run     IDENTICAL
   walls 50x1 51x4 · railing 0x1 1x3 2x1      VARIES
   windows 4x3 5x1 7x1 · corrections 8x4 9x1  VARIES
   ```

   Only room detection is reproducible. `walls` is post-adjudication, so it
   inherits verdict variance. **Sample geometry once, sample anything a verdict
   touches many times, and never quote a verdict-derived figure without its
   range.** Verdicts land on three separate segments (41%,64% · 38%,16% ·
   73%,28%), two bimodal — a region containing none of them is verdict-free.

2. **A balcony parapet is no longer built as a full-height wall — but the fix is
   not complete and must not be described as stable.** `WallSegment.kind` now
   carries the verdict, a `railing` wall type is built at 1.0 m (matching
   `solidify.py`'s `PARAPET_HEIGHT`, so the two builders agree), and import
   honours it. The verdict is asked twice and must agree with itself, because it
   CHANGES GEOMETRY. That reduced the flicker and did not remove it: 3 of 5 runs
   give 1 railing. **OPEN DECISION** — either cache the verdict per drawing
   (true determinism, adds state, a wrong verdict becomes sticky) or surface it
   for confirmation like the render→room flow (no new state, one click per
   ambiguous segment). Nobody has chosen.

   Note `solidify.py` does **not** have this defect — it SKIPS unpaired lines by
   design. The CAD path's gap is the opposite: a balcony gets *no* railing at
   all. `engine-blueprint.md` §736 designs the fix. **Load the `poche` skill
   before touching `services/reconstruct`** — it is what surfaced this.

3. **"0 failed" is not "everything ran", and it cost hours tonight in four
   different disguises.** A BLOCKED suite (Poché's entire test suite had never
   run — two missing pip packages, now 3 passed → 29 passed); two concurrent
   runs reporting 426 of 485; a crashed file reporting 190 with exit 1; and a
   skip fix that reported a half-run as clean. A summary with only pass/fail
   cannot express "did not run", so it says the nearest thing, and the nearest
   thing is green. **Check the blocked count, the exit code and the total — not
   the word *failed*.** `services/api/test/detect.mjs` now counts and names
   skips; `validate.mjs` already exits 1 on blocked, so trust its exit code
   rather than reading its text.

4. **Verify on the right input.** `/design` was demonstrated "working" on
   `uploads/decks/*.png` — those are **floor plans, not renders**, and a weaker
   model returned a confident, correctly-shaped DesignSpec hallucinated from
   furniture symbols and the printed word BEDROOM. Verifying the *shape* of an
   answer is not verifying it. Fixtures: real render =
   `apps/web/public/hero/interior.webp`; real plan =
   `A:\Tools\FloorplanModel\realdecks\49b4f5f96a40c7bddf27e09915de195e.png`.

5. **Asset licensing — BIMobject is not usable.** Its EULA permits personal,
   educational, or "inclusion in construction or building project documents"
   use only, with no redistribution, so it cannot go in a shipped library
   however free the downloads are. The hub took 201 CC-BY models from Sketchfab
   instead, then pruned 76 of them (39%) as off-target, whole-room scenes, or
   too heavy to condition — a furniture query returns a Xenomorph Queen Rig.
   **The remaining catalogue slots are deliberately model-free**: pool, deck,
   paving and lawn are floor SURFACES whose upgrade path is `materials.mjs`
   (already generated and committed), a hedge is a 3 m run rather than one bush,
   and both tree slots are pinned empty after photogrammetry foliage refused to
   decimate. Read `from-hub.mjs --report` BEFORE fetching anything.

#### Earlier — the CAD engine, from the sessions before this one

1. **The sheet border was eating real wall faces — `6ea3fea`, the largest defect
   anyone found.** `pair_faces` processed longest-first, and on an architect's
   sheet the longest linework is the **drawing border**. It consumed real wall
   faces and produced two phantom walls among the villa's thickest (13.40 m at
   t=0.291, 10.49 m at t=0.443) while the genuine 0.230 m west wall was **absent
   from the model entirely**. Now ordered by gap — two faces of a wall are
   separated by a wall thickness, which is the definition.
   **Any villa figure predating it is stale.** Current: **129 walls, 474.19 m
   built / 316.64 m billable, 22 rooms, 263.78 m²**, envelope coverage 46% → 86%,
   bill ₹997,755 → ₹957,376.

2. **Black pockets are SOLVED — `6f0d685`. It is z-fighting, not darkness**, and
   it was three bugs, not one. One control killed the whole "sealed geometry"
   account: a box strictly *inside* another box renders **0 black pixels** —
   a sealed lightless volume is invisible, not black. See `HANDOFF-POCHE.md` §3,
   which is now corrected.

3. **The lightmap's 25% atlas waste should NOT be "fixed" by a 3×1 strip.** The
   UV transform scales u and v by the same factor, which is what keeps texel
   density isotropic; a non-square cell needs a per-axis scale, so effective
   resolution per object falls from (1/2)² to (1/3)². **Coverage rises to 100%
   and usable resolution drops by more than the 25% recovered.** The cure is
   area-weighted packing. Also: the 40.5/21.7/11.3% coverage figures are not
   comparable across sizes — a fixed 8-texel margin dilates each island by a
   constant band. True coverage is ~11%.

4. **Never read the villa's `wall-run-per-area` of 1.20 as a clean pass.** That
   check divided by the sum of *all* spaces, and **51% of the villa's denominator
   is lawn, pool, patio and balcony**. The indoor figure is 2.43. Fixed in
   `a5bea89`, which now reports both bases and states the outdoor share.

5. **Do NOT remove the layer from `merge_collinear`'s bucket key.** It looks like
   an obvious win — 10.7–21.0 m of duplicate linework — and on the real pipeline
   it takes run 458.84 → 221.06 m and rooms 23 → 10. **It deletes 52% of the
   model.** Faces sharing a line across two layers frequently have different
   extents along it, so merging yields over-long faces that pair against the
   wrong partners.

6. **`raw` is now the one unguarded render style**, deliberately — flat world
   plus emission returns each surface's own colour regardless of facing, so a
   uniform near-white frame is its correct output. It matters if AOV work
   resumes.

7. **`Space.boundedBy` is present on every space and populated on none.** It is
   the missing link under three separate checks: why wall run cannot be attributed
   to the rooms it bounds, why `wall-run-per-area` must report two bases instead
   of one, and why indoor/outdoor cannot be resolved geometrically.
   **The biggest single unlock left in the engine.**

8. **Indoor/outdoor needs name AND kind — neither alone works, and they disagree
   in both directions.** `OFFICE PATIO` has kind `study` (indoor) and is outdoor
   by name; `Enclosed Balcony` has kind `outdoor`. Use
   `quantify/schedules.py::_is_outdoor`. More than half the villa site is
   outdoor: 125.11 m² indoor against 127.64 m² outdoor.

⚠ **This table is what sessions told me, not what the repo says, and it has
already been wrong once.** `packages/` is absent from it entirely — and
`packages/viewer/src/SceneViewer.ts` is modified in the working tree, so
somebody owns it. **Check `git status <path>` before believing this table**, and
ask rather than inferring vacancy from a session being idle.

---

## 2. The one piece of context that matters most

`storey0` is hardcoded. **A house has floors, and Arcvia cannot represent one.**

The roadmap's own words, and it is right: *"Storey registration is M6 in the
blueprint and unbuilt. Nothing below matters as much as this."*

Today made this urgent rather than theoretical. `DOWN VILLA -WD 22-1-24.dxf`
turned out to draw **two storeys of one villa side by side on one sheet**, and
the engine had been silently merging them into a single flat building — 901 m of
wall, 505 m² of floor, and a ₹3.25 M bill of quantities for a building that does
not exist. `solve/frames.py` now separates them, so the sheet correctly reports
two plans.

**But separating them is only half the job.** The engine still builds one of
them and discards the other. The prerequisite is done; the feature is not:

- `Frame.origin` records that a cut happened and why (`"cut at y=316.28 across a
  2.48 m channel"`), so the information a storey-registration step needs is
  already on the frame.
- What is missing is deciding that two frames are two *storeys of one building*
  rather than two *separate buildings*, stacking them at the right Z, and
  carrying that through `build/solidify.py`, `build/glb.py` and the BOQ.
- Signals available for free: near-identical footprint width, aligned bounding
  boxes, room names that cross-reference (`OFFICE PATIO (BELOW)` is literally an
  upper floor pointing at a lower one), and the sheet's own title text.

~~Estimated 10–14 days. It is the largest single unlock in the product and it
is now unblocked.~~ ✅ **MOSTLY BUILT ALREADY, NOW REACHABLE — go-and-look
strikes the flagship entry itself.** `solve/storeys.py` (geometry proposes,
only TEXT confirms, refusals are a product), the stacked `--storeys` build
with plan registration, and per-storey GLB meshes all existed. Two real gaps
closed on 2026-08-24:

1. **`_solve_frame` accepted `base_z` and forwarded it to no builder** — a
   two-storey build put both floors at z=0. The report said "storey0 z −3.0",
   verify PASSED, and only measuring the GLB's actual mesh heights caught the
   interpenetration. Fixed; the villa now stacks at y [−3, −0.3] / [0, 2.7],
   plan-registered, measured.
2. **Nothing in the product passed `--storeys`** (the finished-producer defect,
   on the flagship). The API cad path now defaults it ON — safe because an
   unconfirmed group builds exactly as before — and the import summary says
   "2 storeys (Lower Ground Floor Plan, Ground Floor Plan): 45 rooms, 302
   walls in all", proven through the real API on the villa DWG.

~~**What genuinely remains of this entry:** `elements.walls/spaces/openings`
are still primary-storey-only by design, so the BOQ, clearance and code
checks cover one floor of a multi-storey building.~~ ✅ **DONE** — the model
now carries `elements.storeys` (one block per floor, frame coordinates, shift
on the tag; the flat `elements.*` stays the primary storey so every existing
consumer keeps its shape), read through ONE iterator
(`solve/storeys.py::element_blocks`) by all four consumers. Clearance and the
code checks run per floor with findings tagged (two beds at the same (x, y)
on different floors are NOT an overlap; egress crosses floors only through
explicitly named, registered-overlapping stair rooms and the real door graph,
with unproven upper routes skipped in coverage rather than passed silently).
Openings re-host by index offset in the concatenated view, or
every upstairs door lands on a ground-floor wall. **On the villa the bill
went from ₹957,376 to ₹1,985,270 — the old bill priced half the building.**
`test/test_multistorey.py`, 17 assertions; the full engine suite is 531
green.

**2026-08-26 — physical stair geometry now covers straight and dog-leg/U
layouts, with a conservative measured-riser fallback.** The named-room path is
unchanged: registered footprints, ambiguity refusal, straight-first and a
code-sized U fallback. When labels do not name a stair room, the second path
requires paired regular lower riser runs, explicit `UP`, a measured landing
edge, matching registered upper risers, upper `DOWN`, and exactly one evidence
core. It triangulates partial floor/ceiling caps around the measured opening,
records both the label refusal and the successful evidence source, and emits
`floor_stair / assumed`. Focused geometry is 93/93 and all 23 reconstruction
scripts are 874/874.

The real `DOWN VILLA -WD 22-1-24.dxf` now emits a 9+9 dog-leg: 0.300 m going,
1.169/1.153 m flight widths, 0.079 m gap, 1.200 m landing depth, and a measured
3.900 x 2.400 m opening. Its mesh has 456 vertices / 228 triangles and joins
-3.0 m to 0.0 m exactly. Blender 5.1 imported the full 143-mesh GLB and rendered
the 1280x720 isometric without a frame warning after disabling OIDN to stay
within host memory. This is still not full stair-detail recovery: opposing
direction and tread solids are inferred, while riser spacing, widths, landing
edge, and core position are measured. Winders, spirals, L/three-flight stairs,
irregular wells, railings/guards, strings/soffits, headroom and structural
design remain unbuilt. Human visual approval of the render remains pending
until the in-app browser is usable; its current Windows sandbox fails with
error 1344.

**2026-08-26 — weekly construction-rate refresh is now genuinely scheduled and
live-validated.** The Windows task existed but its first apparent success was
false: `cmd.exe` misparsed UTF-8 comments, the relative log directory did not
exist after `cd services/reconstruct`, Python never ran, and the wrapper still
returned zero. `tools/refresh-rates.cmd` is now ASCII-safe, resolves the repo
from its own path, logs beside the repository rate library, and returns Python's
exit code. The first actual write found a separate freshness regression: three
12 Aug timber rows were replaced from a 6 Aug page because their price movement
was within `TRUST_BAND`. `quantify/refresh.py` now refuses a page date older than
the row already stored, and the three rows were restored. The guarded scheduled
rerun completed with Last Result 0: 28 confirmed, zero unreachable, 171 refused;
the next run is Monday 31 Aug at 09:00. Rate/BOQ coverage is 96/96 and the full
reconstruction suite is 874/874 across 24 scripts.

---

## 3. Untouched by any current session — start here

Ordered by value per day, which is not the same as by size.

### Quick wins, genuinely quick

~~All five below.~~ ✅ **DONE**, aalev-51, 2026-08-22. Left in place with what
each turned out to be, because three of the five were not what the entry said
and the difference is the useful part.

| Task | Done | What it actually was |
|---|---|---|
| `pricing.astro` is hand-maintained | `53ee3fe` | **Half wrong.** The page already read every COST from `creditCost`, so no number could drift. What it hand-maintained was WHICH ACTIONS APPEAR: nine priced actions, six listed. `cadReconstruct` charges 3 credits and was on **no published price list at all** — not a drifted number, a charge with no published price. Now enumerates the tariff; an action added without a label appears spelled awkwardly rather than invisibly. |
| `scenes.js` silently drops unknown fields | `48e9f21` | As described. Refuses the whole patch, and refuses it WHOLE — a body mixing valid and invalid fields applies neither, since a partial write behind an error status is worse than the silent drop. Unknown and read-only are reported separately: *"hdriUrl2 is not a field"* and *"published is set by POST /publish"* send a developer to different places. |
| Idempotency on submit | `b744501`, `c183d7c` | **Bigger than one route.** `/render/jobs` was fixed first; `/cad/jobs` charges **3 credits** and had no guard at all — and it is the slower job, so it is the one users double-click. The rule is shared, not copied. The first version also had a flaw: it deduplicated against FAILED and CANCELLED jobs, so a user retrying after a failure was handed the dead job and could not retry. Worse than the bug — a duplicate charge costs a credit, an unretryable failure costs the work. |
| Room area schedule | `fedc763` | Indoor and outdoor are reported separately and **never summed**. The villa is 125.11 m² indoor against 127.64 m² outdoor — more than half the site is garden, so any single "total area" is wrong by over 100% as a statement about the building. The classifier reads NAME as well as kind: `OFFICE PATIO` is classified `study`, an indoor kind, and only its name says otherwise. |
| Door / window schedule | `fedc763` | Its most valuable output is a caveat: **all 8 villa openings are doors.** An empty window section reads as "this schedule has no window section"; a reader about to order joinery needs "this building has no windows, and the schedule cannot tell whether the drawing places none or the reader missed them." |

### Highest value per day in the whole product

~~**`A:\Assets\Hub` is unwired.**~~ ✅ **DONE.** Not "a catalogue exists" — a
user can now pick a sky and a floor in the editor and **both reach the
renderer**, which is what the roadmap actually asked for.

| | |
|---|---|
| models | 38 interior slots done before this session; **+6 outdoor slots 2026-08-24** (shrub, planter, lounger, fence, outdoor table/chair — all CC0, Poly Haven + The Base Mesh via `from-hub.mjs --ingest`) |
| surfaces | 8 keys, live in the editor (`e501c20`) |
| environments | 12, live in the editor, render path proven end to end (`0da396e`, `0cc62a1`) |

**2026-08-24 (evening) — the first furnished render, and what it cost to
get.** Scene `Furnished Villa (hybrid)`: villa DXF → CAD job → furnishFromCad
→ hybrid compose → Cycles isometric via the API, with real catalogue models
in the frame (potted plants visible on the terrace) and the validity gate
stamping frame stats on the job (blown 0.24 / black 0.56 vs the default-sky
background / 231 tones — no false suspect). `A:\tmp\furnished-villa-render.png`.
Two operational lessons, both paid for: (1) NEVER run two API processes over
one `.data/db.json` — the store serialises writes per-process only, and a
second server (an 8791 verification instance, and separately a crash-looping
leftover dev:api tree) caused tmp-rename races and double-spawned Blender for
the same job against the same output file; one server, one db, kill strays by
checking which PID owns the port. (2) In dev, `--watch` restarts on ANY
services/api/src save ORPHAN the running Blender and requeue the job — the
restart-reconciliation then double-works every bake a save interrupts. Batch
api saves while a bake runs; prod has no watch and no such hazard.

**2026-08-24 (later) — the fix-all pass.** Four more closed: the queue's
single-image renders now carry a validity verdict (`ARCVIA_FRAME` +
`ARCVIA_SUSPECT` on the job markers — the customer-charged path had no
check of any colour; `205c820`); the lightmap atlas is area-weighted
squares (walls 52% of the atlas where the grid gave 11%, layout emitted
and verified by check_atlas's new layout mode incl. the UV-v/PNG-row flip;
`99fc5bb`); multi-storey CAD furnishing reviews one storey per batch
(`c38d830`); and the LATEST DRAWINGS frame bug was closed by frame
ranking (`141fe0f`, aalev-c3). Still open and honestly research-grade,
each worth its own session: the then-observed 6/18 unhosted villa doors and
~44% pairing, plus the M5 review queue (`CadImport.tsx`). Current 2026-08-25
evidence below supersedes those two villa figures; this paragraph is retained
as history, not an open-defect claim. The
two `TODO(you)` business decisions were put to the owner directly.

**2026-08-24 (evening) — the deck's design now REACHES the walkthrough**
(aalev-88, after the owner said the walkthrough "looks really plain — no
materials from the actual renders are being used", and was right). The design
reader and the dressing both existed and were session-local: `applyDesignToModel`
had one caller (the panel), nothing persisted the spec, the next wall-drag
rebuild wiped it, and the published page — which loads `scene.modelUrl` and
nothing else — could never see it. Trap-6 shape, sixth instance. Now:
`design` on the scene (PATCH allow-listed, null = "user cleared it");
SceneView re-dresses on every rebuild in all three branches; a scene with a
deck and no design auto-reads ONE render on open (free, ~15 s, the panel
refines); and **publish captures the editor's model** — export + upload +
modelUrl — unless a bake exists (the atlas describes the bake-time export's
UVs; replacing that model would light new geometry with the old atlas).
Publish-capture also closes a second gap: an unbaked plan scene used to
publish with NO model at all. Verified in Chrome end to end on the villa GLB +
Avarana deck: auto-read → dressed both storeys → publish → the public page
serves the dressed 1.96 MB export. Two traps for the next reader: (1) do NOT
gate the dressing on `await upgradeSurfaces()` — eight fetches, and one cold
stall leaves the model undressed forever; apply immediately, re-apply in
`.then` (dressing is idempotent). (2) `Color.getHexString()` returns sRGB —
comparing it against linear-space arithmetic "proves" the tint never applied
when it is exactly right (#d0d6d3 IS white→#6f7f75 @0.65, in sRGB). Cost an
hour of chasing a working feature. The engine-side part of the visible-quality
ceiling is now closed: new CAD and raster reconstructions emit one named floor
mesh per room (with lawn, paving and pool water separate), so a finish has an
exact doorway boundary. The corresponding studio seam is now closed too: `design` accepts
the legacy single object and stores new choices as a room-keyed array; adding
a render replaces only that normalised room, survives reload/duplication, and
the same resolver dresses live rebuilds and fresh publish exports. The first
render remains the fallback for old/aggregate meshes; later renders override
matching `floor_roomN_<slug>` meshes without touching lawn, paving or water.
Still open: walls are aggregate storey meshes, so room-specific wall colours
cannot stop at a doorway until reconstruction emits addressable room-wall
meshes; hub materials are ranked queries for a human, not auto-picked; and a
bake made
BEFORE a dressing publishes the undressed look — re-bake after dressing.

**2026-08-24 — furniture seen in deck renders now reaches the model.** A PDF
reconstruction now retains both the original deck (`floorPlanUrl`, so renders
remain readable) and its `building.json` (`cadModelJsonUrl`, so measured room
polygons survive reload). `designFurnish.ts` maps the render's observed
furniture words to real catalogue assets, matches the render room to the
engine's named room, and arranges the items inside that exact polygon with the
recorded storey shift. The result enters the existing FurnitureReview as a new
honest evidence class: **seen in render** means the inventory was observed but
the proposed position was arranged. Accepting creates missing source storeys,
persists normal editable plan objects, and therefore reaches reload, bake and
publish through the existing hybrid composition. A usable CAD fixture or an
already accepted object suppresses the whole room fallback, so it cannot add a
second sofa over an architect's sofa. Accept/discard decisions are versioned by
room + render + inventory and persist; replacing the render reopens review,
reloading does not nag. 17 focused assertions plus the full studio suite. Still
open by design: a perspective render cannot prove plan positions, and only
recognised floor-standing catalogue items are placed. Generic lamps, wall art,
ceiling fittings and unknown bespoke pieces remain review/search work until the
reader can state an attachment surface and the engine exposes addressable room
walls/ceilings.

**2026-08-24 — a CAD import furnishes itself.** The engine always knew where
the furniture was (`kernel.furniture`: exact block positions, rotations, the
four-signal classifier resolving to catalogue item ids); nothing carried it
to the editor. Now: the queue publishes `building.json` beside the GLB
(`modelJsonUrl` on `/cad/jobs/:id`, `fixtures` count in the summary), and
`plan/cadFurnish.ts` converts `elements.fixtures` into the SAME `Proposal[]`
/ FurnitureReview flow the raster path uses — one review surface, one accept
path, one credit trail. Coordinates are the identity by contract (sheet
frame, already origin-shifted; verified walls 90.6–119.2 vs fixtures
91.5–119.8 on the villa — do NOT re-transform). In-wall items (doors,
windows) are filtered: the villa proposed eight door leaves standing in
rooms before that filter existed. Live E2E: villa DXF → job →
modelJsonUrl → 55 fixtures, 42 classified; studio proposes 18 floor pieces
in 4 rooms. 25 assertions in `test/cadFurnish.test.ts`. Proposals now carry
their source storey, and the shared accept path creates/targets that floor and
restores the floor the user was editing afterwards.

**2026-08-24 — every outdoor slot that can be filled, is; the tree verdict
is a measured negative worth keeping.** Hub photogrammetry trees are
unconditionable as a class: fir 7.8M tris → stalled at 349k (53 MB), pine
17.4M → 24.5 GB RAM, killed; jacaranda (manifest said 312k) imported at
3.86M → stalled at 193k (24.5 MB). Scanned foliage shreds, it does not
decimate. The slots filled instead from Sketchfab hand-modelled stock
(batch.mjs gained the terms): parasol, pergola, and a 19.9k-face tree —
all CC-BY, credits automatic. `tree-small` stays parametric: the search's
best candidate was literally a sea monster, and the threshold held.

**2026-08-24 — the whole hub is browsable from inside the editor.**
`GET /assets/hub` (search/stats, authed) + `/hub/preview/*` and
`/hub/conditioned/*` (files, unauthenticated like `/uploads`) in
`services/api/src/{lib/assetHub.js, routes/assets.js}`, and a collapsed
**Asset hub** panel under the catalogue in the plan editor
(`HubBrowserPanel.tsx`). Per model, "Get GLB" runs `condition_asset.py`
server-side — queued one-Blender-at-a-time, cached in
`.data/hub-conditioned/`, ≤600k-triangle ceiling refused up front with the
reason (the 53 MB fir made that number a measurement, not a guess).
`condition_asset.py`'s `--width/--depth/--height` became optional-as-a-trio
for this: no slot, no resize, floor-sit kept. Deliberately NOT placement:
raw hub models never enter scenes; the catalogue stays the only placeable
source. Verified live: search → condition (8 s, 640 tris, 25 KB flower pot)
→ served GLB; 15 new assertions in `test/asset-hub.mjs`.

**2026-08-24 — the hub path got the automation the Sketchfab path had.**
`from-hub.mjs --ingest` now conditions its picks and writes
`.data/catalogue-additions.json` for `apply.mjs`, instead of stopping at a
paste file — which is why the interior filled and the outdoor never did. Four
matcher defects fixed on the way, all of the same species (substring matching
over name+tags): the catalogue parser skipped every entry that carries a
comment (`tree` and `pool`, the two annotated ones); avoid-word `plant`
disqualified every *planter*; avoid-word `trunk` disqualified every LIVING
tree (Poly Haven tags botany, not damage); and "tree" matched "s**tree**t".
Plus cross-slot dedupe — one model no longer fills two slots. Still empty and
honestly so: parasol, pergola (the hub holds none — a Sketchfab
`batch.mjs --only parasol,pergola` run is the route if wanted), hedge
(stretching one bush 5:1 loses to the parametric block), pools/deck/paving/
lawn (surfaces — materials.mjs territory). `tree`/`tree-small` are
photogrammetry scans conditioning in a long-running job — check
`.data/from-hub-trees.log`; if absent from items.ts, that job died and
`from-hub.mjs --ingest --only tree,tree-small` resumes it.

Verified in Chrome rather than inferred, which mattered: the surface upgrade
mutates the **same cached material instance** every mesh holds, so one call
upgrades the whole scene with no traversal — a property no typecheck can express
and no unit test with a fake cache can show. Had it been false the symptom would
have been "some walls upgraded", which reads as a loading race rather than a
design error.

✅ **FIXED — `5a4ff42`. And it was never the small latent gap described here.**

This paragraph used to say *"everything shipped is CC0 so nobody is owed today —
one CC-BY asset away from an unmet obligation"*. **That was true of the twenty
curated assets and false about the product.** From `catalogue/items.ts`:

| licence | models |
|---|---|
| CC Attribution 4.0 | **34** |
| CC Attribution-ShareAlike 4.0 | 1 |
| CC0 1.0 Public Domain | 3 |

**35 of the 38 catalogue models require attribution, and every walkthrough this
product has ever published showed none.** Not one asset away — already there,
already published.

**Every link in the chain existed and was written with care. Nothing joined
them.** `view/index.astro:467` renders the credit list, with a comment reading
*"Attribution. Present when it is owed, absent when it is not."*
`scenes.js publicPayload` serves `credits`, commented *"Credits travel with the
scene because the obligation does."* `catalogue/credits.ts` computes them, with
13 assertions green throughout. Producers: **none** — and `credits` was absent
from the PATCH allow-list, which *rejects* unknown fields, so the field was
unreachable even if something had tried to write it.

The original entry follows, kept because its measurements are still the reason
the work was scoped the way it was. There is a `/asset-hub` skill for it.

⚠ **Corrected 2026-08-22, measured.** What this paragraph used to say — "the
library exists and does nothing" — was repeating the roadmap rather than the
repo. **The furniture half is finished**: 38 GLBs are tracked in
`apps/studio/public/models` (11 MB), `items.ts` carries 46 items with 38 `model:`
blocks, and `models.ts` is a complete loader with caching, in-flight tracking,
fit-to-catalogue-size and a stand-in fallback. Landed in `0e755ba` / `678a521`.
The 8 empty slots are doors and windows, parametric on purpose — do not chase.

The real gap is the other three kinds, all at **zero used**: 301 HDRIs, 856
materials, 671 textures.

The sharpest instance, and the highest value-per-line in the whole slice: **a
complete consumer with no producer.** `hdriUrl` is plumbed the entire length of
the product — persisted on the scene (`scenes.js:43,86,279`), read and resolved
by the API (`render.js:135,216`), fetched by the worker
(`render-worker/render.py:689`), loaded into a real Blender world
(`apply_environment()`), and typed through the studio client
(`api.ts:154,220`) — and **nothing anywhere writes it**. There is no picker, so
`apply_environment()` has taken its `else` branch on every render this product
has ever run, with 301 CC0 HDRIs sitting next to it. `SceneViewer.loadEnvironment`
has zero callers for the same reason. No new API route, no schema change.

**And "wire up the hub" cannot mean exposing the hub.** `A:\Assets\Hub` is
**23.5 GB** on disk — hdris 1.9 GB, materials 5.4 GB, models 4.2 GB, textures
12 GB. The committed precedent is 11 MB for 38 assets. So this is a *curator*:
select an architectural subset, condition it to a web budget, commit that, and
**state the budget and the drop count** rather than letting a top-N truncate
silently.

Grep note: `apps/studio/dist` is checked in and contains the whole three.js
bundle, so a repo-wide grep for anything viewer-related returns ~150 KB of
noise. Search `src` only.

~~**Poché is not the studio's front door — 2–3 d. NOW UNBLOCKED.**~~ ✅ **DONE**
— a fourth project start, "Reconstruct from CAD": DWG/DXF uploads, `/cad/jobs`
runs, and on completion the GLB lands on the scene and the editor jumps to 3D
with the ENGINE'S OWN ACCOUNT shown ("22 rooms (15 named), 129 walls, 8
openings — unit: …") — a reviewer accepts an import on facts, not a spinner.
Verified in Chrome end to end on the villa DWG through the real UI: upload →
3 credits → ~75 s → the building standing in the 3D view. ⚠ The correction
above claiming "the studio's GLB project-start existed" was itself stale —
PlanEditor's own notice said "not wired up yet". Both import starts now work
(the GLB start proven in-browser too); the SceneView branch is on the PLAN
being empty, not on modelUrl existing, because plan-drawn scenes also carry a
modelUrl (the bake writes one) and for them the drawing stays the truth. The
envelope-coverage caveat still applies per drawing: check the build report
before trusting an import.

**And the same door now takes presentation PDFs** (with aalev-35's deck
engine, `c27748d`): upload a rendered deck → a cheap survey finds the plan
sheets and the printed dimensions → the user confirms ONE dimension (anchor
defaults to an engine-flagged well-enclosed room) → a single 3-credit build at
the settled scale. Two-phase BY DESIGN — build-then-rebuild would charge twice
for our own scale uncertainty. Deck jobs ride preset `cad` with
`spec.kind='deck'`, inheriting lane/refunds/reconciliation. Verified in Chrome
on the Avarana deck: survey found both plans, Toilet 4.88 m anchor → 20.09 m
across the sheet, build landed 13 walls / 8 rooms — the engine CLI's own
numbers. ⚠ On heavily-rendered sheets walls under-detect (open-plan has no
partitions to find); the panel promises "a massing model from your plan",
never watertight walls. The failure path was live-tested by a real detector
outage mid-build: the engine's verbatim message reached the panel and the
refund settled.

**This was deliberately held back until `6ea3fea`, and the reason generalises.**
Until the sheet border stopped eating wall faces, the engine emitted models
containing two phantom walls among the thickest in the building — 13.40 m at
t=0.291 and 10.49 m at t=0.443, both the drawing's paper border paired against a
real face — while the genuine 0.230 m west wall was absent entirely. Wiring that
into the product would have surfaced it to real users at the moment it was least
ready. **Making the output honest about itself is not the same as making it
right; a model that describes its own defects accurately is still defective.**

Measured on the villa across that fix:

    envelope coverage   46%  ->  86%     (warns below 90%, so still marginal)
    walls              146   -> 129
    phantom thicknesses 0.291, 0.443  ->  gone
    bill            INR 997,755 -> 957,376

Coverage at 86% is better and not yet good. Check it on the drawing you are
importing before deciding the front door is safe for that drawing.

~~**Lightmap bake has no UI — 3–4 d.**~~ ✅ **It has one. It always did.**
`SceneView.tsx` carries the preset, `handleBake()` exports the GLB with prebaked
UVs, uploads, submits, polls, records `bakedUrl` **on the scene** (not just on
screen — a published walkthrough cannot reach render-job records), applies the
atlas and flips `setBakedLighting`. The waiting state already does the one thing
that is easy to get wrong: **when `progress` is 0 it shows elapsed time
instead**, with a comment saying why — *"a bake reports no progress at all,
Blender's bake is one atomic call… showing 0% for six minutes reads as a hang."*
It also warns when Cycles has fallen back to the CPU, which explains
essentially every "why is this so slow" question.

⚠ **This is the third roadmap entry in one day that described something already
built.** Clearance checking was written, tested and working; the studio's GLB
project-start existed; the bake UI is complete. In each case the entry was
written from an earlier state of the code and never revised, and in each case
someone was about to spend days rebuilding it.

**Before starting any item in this document, go and look.** The engine and the
studio have both moved further than the roadmap records, and the cost of
checking is minutes against days. The corollary is the one already at trap 6:
this codebase's real defect is not missing features, it is finished features
nothing reaches.

### The Validate stage

~~Nothing in it exists at all.~~ **Stale when written.** Clearance checking —
described here as the notable gap, *"the furniture catalogue is dimensioned
specifically for it and nothing uses those dimensions"* — was already built
(`solve/clearance.py`, 25 assertions) and is now run on every reconstruct with
its findings in the model (`3e6a38f`).

⚠ It checks **the primary storey only**. `elements.fixtures` covers every floor
as of `d82c34e`, but `elements.walls` and `spaces` are one floor by design —
they are what the plan drawing draws — so clearance filters to
`storeys.primary`. Furniture on other floors is in the model and unchecked.
Closing that needs per-storey walls in the model, which is a real change, not a
flag.

~~Then sun path / shadow study (4–6 d)~~ ✅ **DONE**, `de93fcd` — studio
SunPanel + `setSunDirection` on the viewer; NOAA-verified solar math; assumes
top-of-plan = north (stated in the panel; per-scene north angle is the
follow-up).

~~and code checks — min room, corridor, egress (8–12 d).~~ ✅ **DONE**,
`solve/codecheck.py` — the sibling `clearance.py`'s docstring reserved:
rulebook-as-data (`data/rulebooks/nbc-2016-residential.json`, a citation per
rule, the architect owns the file), measured facts with no verdict, coverage
lists everything it could NOT check and why. Corridor width is measured by
erosion-connectivity between the corridor's doors — the pinch you walk
through, not the widest pocket an inscribed circle finds. Embedded in every
`building.json` at build time (the clearance lesson: a report behind a
separate CLI command is a finished producer with no consumer). Ventilation
rule sits ready but skips loudly until the importer detects windows. Egress is
reachability on each storey's real door graph, connected vertically only by
explicitly named stair rooms whose registered footprints overlap. A missing or
misaligned stair remains a coverage skip; this route check does not certify the
inferred stair geometry, headroom, or dimensional compliance.

~~**Daylight factor** (6–8 d).~~ ✅ **DONE**, aalev-51, `4a8faec`.

The blocker was a framing problem, and it is worth recording because the same
shape will recur. "Needs reference values before it is built" treated validation
data as something you go and FIND — none was to hand, so the feature stalled
twice. For a CIE standard overcast sky the references are **derivable**: the
luminance distribution is defined, so unobstructed horizontal illuminance falls
out of a two-line integral as 7·π·L_z/9. The numerical integrator is asserted
against that and reproduces it to 4×10⁻⁵, converging as 1/N² so the agreement is
not luck. **A derivation the next reader can check beats a downloaded table they
cannot.**

Two things it found that outlive it:

- `bre_average` is computed alongside every result. Against BS 8206-2 — the
  expression a planning authority actually quotes — this module reads **1.3–1.8×
  HIGH**, systematically. The docstring had claimed every figure was
  "conservative" on the strength of a zero externally-reflected component;
  conservative *against what* was the missing half, and a reader comparing 2.71
  to a 2% threshold would pass a room BRE fails at 1.87. Both numbers ship.
- **Every villa opening is a door.** Counting doors as glazing would have
  produced 23 rooms of plausible percentages, every one an artefact of treating
  a doorway as glass, and it would have looked exactly like the feature working.
  It reports 23 `undetermined` rooms instead, which names window detection as
  the blocker rather than hiding it.

### Deliver — the biggest gap between "works" and "sellable"

~~Publisher app (15–20 d)~~ ✅ **The loop is closed — DWG to a shareable link.**
`c37619d` (publications store + the visualisation app loading by slug),
`e369010` (composer + `@arcvia/publication`), `f4f3894` (the screen). Driven in
a browser against a fresh API and database rather than asserted: compose → a
room schedule read from the wall graph and printed on a client-facing page →
publish → `/p/riverside-villas/`, serving that project with no trace of any
other.

~~**Still to build:** configurator, object and material switching (8–12 d) ·
client comments (5–7 d) · per-scene branding (2–3 d) · PDF summary of chosen
options (3–4 d).~~ ✅ **ALL FOUR BUILT — verified in the tree and green in both
suites 2026-08-24** (studio 667, API 433). Fifth instance of this doc
describing unbuilt work that exists; cite-and-grep before scoping anything
from here:

| feature | producer | consumer | commits |
|---|---|---|---|
| configurator (finish + furniture switching) | `OptionsPanel.tsx`, `publish/options.ts` | `mountConfigurator` in `view/index.astro` | `7975af6`, `d6ffb17` |
| client comments | `POST /public/:slug/comments` (capped, in-record) | studio `CommentsPanel.tsx`; owner-only read/delete | `77d52fc` |
| per-scene branding (accent, logo, hide-credit) | `PresentationPanel.tsx`; `branding` PATCH-allow-listed | `view/index.astro:589-598` | `09d439a` |
| PDF summary of chosen options | configurator's summary (`title`/`capture`/`credits`) | hand-written PDF, no library | `b19f5dc` |

One flake worth knowing about, not fixed because it would not reproduce: on the
day's FIRST full `npm test` chain, `queue-persistence.mjs` branch 2 (the
remote-watchdog) missed its 15 s window — status still `rendering`, credits
unreturned. Solo and on every subsequent chained run it passes 23/23. Cold-start
contention (25 prior test files each booting servers) is the suspect; if it
recurs, widen the `until(…, 15000)` before suspecting the watchdog itself.

⚠ **Two things the publisher surfaced. One is now fixed:**

1. ~~**Every published project shares the same social card.**~~ ✅ **DONE**,
   `services/api/src/routes/share.js` + 26 assertions in
   `test/share-card.mjs`. The API serves `/p/<slug>/` itself and injects the
   title, description, `og:*` and `twitter:card` from the publication the slug
   names, before the HTML is sent. It had to be the API rather than the static
   host, because the answer depends on a database lookup and a bucket cannot do
   one.

   Three things worth knowing if you touch it:
   - **The escaping is the load-bearing part**, not the tags. Names, places and
     taglines are typed by users in the studio and land inside HTML attributes
     on a page served to *that user's clients*. A name containing `"` ends the
     attribute; one containing `<script>` does more. Asserted against both.
   - **An unknown or unpublished slug gets the NEUTRAL card and a 404**, never
     the previous project's — which is why `apps/visualisation/index.html` must
     keep saying nothing about any client. That file is now the 404 card.
   - **`og:image` is emitted only for an already-absolute http(s) URL.** Project
     images may be storage keys, and resolving one against this service's origin
     produces a confident link to nothing; a preview with a broken image renders
     worse than one with none.

   Superseded, for the record:


   `apps/visualisation/index.html` was one client's — hard-coded title,
   description, Open Graph tags, and a `noscript` block carrying a developer's
   phone number. The markup is neutral now and the tags are filled in at run
   time, **but a crawler does not run JavaScript.** WhatsApp and Slack read the
   static file, and that file's own comment records that these pages *"get
   shared by WhatsApp more than by any other route"* — so the commonest path is
   the broken one, and a visitor to client B's link still sees a card
   advertising client A's development. Fixing it needs `/p/<slug>/` served by
   something that injects the tags before the HTML leaves the server.
   Architectural, not an oversight.

2. ~~**`totalSbua` is not a super built-up area, and a buyer will read it as
   one.**~~ ✅ **RESOLVED** — the real SBUA source turned out to be the only
   one there ever was: the architect. The schema now says what each number is:
   `totalMeasuredArea` (the centreline sum, always written, labelled as a
   measurement) and `sbua` (present only when a person typed it into the new
   Presentation → Areas field; stored on the scene, PATCH-allow-listed).
   The compose warning now fires only while no declared figure exists, and
   goes quiet when one does — the noisy state asks for the missing input
   instead of flagging a mislabelled output. Casa Altinho's figures moved to
   `sbua`: its own caption already said "as stated on the architect's type
   sheet", so they were declared figures all along, filed under the wrong
   name.

### Operations

~~Queue persistence (2–3 d)~~ ✅ **DONE** — restart reconciliation now finishes
each orphan's journey instead of killing it: queued jobs re-queue oldest-first
(they lost nothing; no refund), remote-owned renders are left for their worker
with a watchdog on the remains of their time budget (the callback writes to
the row, so it lands fine after a restart), in-process work gets one retry
(`RENDER_RESTART_RETRIES`, default 1) then fails-and-refunds. Late callbacks
on settled jobs are refused (409) — a refunded job must not flip to 'done'.
`test/queue-persistence.mjs` proves all three branches with real SIGKILLs
between boots.

~~Per-preset queue lanes (1–2 d)~~ ✅ **DONE** — two lanes split by the shape
of the work: `fast` (preview, isometric, ai) and `heavy` (full, bake, cad),
each with its own limit (`RENDER_CONCURRENCY` / `RENDER_HEAVY_CONCURRENCY`,
both default 1). A 45-minute bake can no longer starve a 20-second preview.
⚠ Worst-case burn is now the SUM of the two limits — an operator pricing GPU
spend budgets both. Every running-job exit goes through one `release()`
helper, because a leaked lane slot narrows the lane silently forever. The
daily cap stays global across lanes on purpose (a runaway loop must not get
two budgets). `test/queue-lanes.mjs` proves flow-past, per-lane FIFO, and
freed-slot-serves-its-own-lane against a held stub worker.

### Two `TODO(you)` markers that are business decisions, not work

`apps/web/src/lib/auth.ts:183` (session expiry) and
`services/api/src/lib/credits.js:109` (credit enforcement) were previously
waiting on an owner decision. **Decided 2026-08-24:** hybrid sessions (12-hour
idle timeout, 30-day absolute maximum), and queueable work holds credits until
completion while non-queueable work hard-blocks without credits. The code and
tests now implement those choices; this entry is retained as historical context.

### 2026-08-25 — OpenAI-compatible vision provider

The existing render/design reader already had the correct structured contract
and fail-open behavior. `services/floorplan-ai/adjudicate.py` now supports an
OpenAI-compatible vision endpoint as well as NVIDIA: set `FLOORPLAN_AI_PROVIDER=openai`
and `OPENAI_API_KEY` on the server, or leave the provider on `auto` to select
OpenAI when no NVIDIA key is present. The browser never receives the key. The
reader continues to measure palettes and leave exact coordinates, dimensions,
walls, and final geometry to the deterministic CAD engine. The smoke test
verified provider selection and Python compilation without making a network
request. Live activation still requires the deployment secret.

---

## 4. Long-running work — worth a session of its own

These are bounded by wall-clock, not by thinking. They are the ones to hand to a
dedicated session that can sit and grind.

**Render and bake batches.** CPU-only, no usable GPU on this machine. Anything
visual — a film encode, an orbit, a set of 360° panoramas, a lightmap bake —
takes real wall-clock. Renders must be **resumable** and cameras placed
**absolutely** from the view spec, never relatively; this is already recorded as
a trap and the reason is precisely that these runs get interrupted.

⚠ **The "~1 min/frame" figure that used to be here was never measured.** Measured
2026-08-22 on the m11 villa (2,076 tri, Blender 5.1.2, 16 threads, CPU-only),
seconds per frame at `fast` (32 samples, 1280×720):

| kind | photoreal | cgi | clay | cad | sketch |
|---|---|---|---|---|---|
| plan | 32.3 | **3.0** | — | — | — |
| exterior | 14.3 | 10.9 | — | — | — |
| isometric | 19.3 | 15.2 | 15.7 | 20.9 | 22.5 |
| interior | **43.9** | **44.7** | — | — | — |

`standard` is **7.8×** `fast` (122–145 s per isometric). A **full 22-view pass**
(16 interior + 4 exterior + 1 isometric + 1 plan) is **~13 min at `fast`**,
~105 min at `standard`. Note that is neither the ~22 min a flat 1 min/frame
implied nor the ~6 min a flat 16 s/frame would: **interiors dominate**, at
2.3–3× an isometric, and there are sixteen of them.

**Run-to-run precision is ±10–13%**, and knowing that is what makes the table
readable: the photoreal-vs-cgi plan gap (32.3 vs 3.0 s, **10.8×**) is far
outside that band and is real; a 15.2-vs-16.6 difference is not. Two per-kind
oddities, both re-measured clean: **a photoreal plan costs 10.8× a cgi plan**
(the sky world is expensive on a top-down ortho where most of the frame is not
building), and **exteriors are the cheapest real view** — which is what makes an
orbit film affordable.

**Cost is flat between 2k and 4k triangles; untested above that.** The same
building at 2,076 and 4,148 tri renders in 16.6 vs 16.1 s isometric (0.97×) and
9.5 vs 8.6 s exterior (0.91×) — doubling the geometry costs nothing measurable.
So the interior premium is **light transport, not polygon count**, and the
~13 min pass figure is robust to modest geometry changes.

⚠ **Do not generalise that further than it goes.** 2k → 4k is a doubling of a
trivially small number, and both are far below where Cycles becomes
geometry-bound. A furnished scene with the asset hub wired in could be 100k–1M
tri and this result says nothing whatever about it. It establishes that wiring
the asset hub is not *automatically* a render-cost problem — **re-measure when a
furnished scene exists.**

**Film cost model:** frames × exterior cost. 36 frames (1.5 s) ≈ 8 min, 72
frames ≈ 17 min, 120 frames (5 s) ≈ 28 min, at `fast`/`cgi`. Validated end to
end: 36 frames → 143 KB h264, `ARCVIA_DONE:36/36`, 0 invalid, loop-closure delta
0.73 (seamless 360°).

**`ultra` is ~8–13× `fast` for exterior views** — 79–201 s per frame at
2560×1440, mean 133 s, all valid. Treat that as an **upper bound**: the four
frames rose 79 → 119 → 201 s across identical work, which is the box degrading
under memory pressure during the run, not the tier getting more expensive. The
best frame at 79.2 s is ~7.8× `fast`, the same ratio as `standard`, so the true
figure is nearer 80 s.

⚠ **The `ultra` PLAN view is the exception and it is unexplained.** It ran 694 s
and never produced a frame, while ultra exteriors completed in 79–201 s each.
That lines up with something already measured at `fast`: **a photoreal plan
costs 10.8× a cgi plan**, and cgi plan is the *cheapest* view at `fast` (3.0 s)
yet the only kind that failed to finish at `ultra`. Orthographic top-down views,
where most of the frame is not building, are **pathological in a way no other
kind is**. Measure plan views separately; do not assume they scale.

*(This paragraph previously said "ultra is not measurable here, plan as hours per
frame". That was wrong. The process was killed and the conclusion written from
the diagnostics taken while it ran — but the bench kept going and rendered four
valid ultra frames that sat on disk for twenty minutes with timestamps on them.
The memory-pressure figures were all real; "the box was struggling" was true;
"therefore ultra is unmeasurable" did not follow. A real measurement quoted past
what it established, which is the error this document keeps recording.)*

⚠ **Two things inflate render wall-clock ~2× on this box, and only one of them
is another session.**

1. **Concurrent rendering.** Measured against a second Blender: cad 41.7 →
   20.9 s, sketch 36.3 → 22.5 s, photoreal exterior 25.1 → 14.3 s.
2. **Free RAM below ~1 GB — paging alone, with nothing else rendering.** At
   0.51 GB free, an m11 isometric took **34.1 s against its true 16.6 s**. Same
   mechanism that made `ultra` unmeasurable.

So the check before benching anything here is **`blender` processes AND free
RAM**, not just the first. Both of the day's two bad-measurement episodes had
this as the cause and only one of them involved another session. Never run a
render batch alongside asset conditioning.

Two things found while measuring — ~~both open at the time of writing~~ ✅ **both
closed since, verified in the tree 2026-08-24** (a session re-claimed this
cluster from this doc and found every piece already committed — the go-and-look
rule paid again):

- ~~**Three of the six styles do not render.**~~ Fixed in `c742c24` —
  `arcvia_style.py` sets `settings.crease_angle` on the view layer's freestyle
  settings (the Blender 5 location) with the reasoning in a comment. `raw`'s
  near-white output is documented as CORRECT in `STYLE_TABLE`'s docstring — it
  is the emission base layer the `--aov` passes key against, not a picture.
- ~~**Blender exits 0 on a Python traceback… the multi-view path is not
  [guarded]**~~ Fixed across `c742c24`/`146fb49`/`0346a6b`/`28e0992`:
  `render_views.py` wraps main in a catch-all that exits 1, prints
  `ARCVIA_VALID:n/m` and `ARCVIA_DONE:n/total` ALWAYS, and `renderQueue.js`
  compares them via the exported `viewsMissing()` — a short run now fails (and
  refunds) instead of publishing as `done`. Frame validity is two-sided and
  style-aware (`inspect_frame`: blown-fraction with a measured threshold, tone
  count labelled honestly as unmeasured, line-art exempt from brightness, `raw`
  exempt entirely) — the trap-8 "every check looks for BLACK" defect is closed.

**Asset hub conditioning.** Running 2,132 assets through `condition_asset.py`
and wiring the results into the catalogue is batch work with a long tail of
per-asset failures. Ideal for a session that can babysit it. **Do not run it
alongside a render batch** — they contend for the same cores and both sets of
numbers become meaningless.

~~**The lightmap bake.**~~ **Not long-running — measured, and it belongs in §3
with the UI work.** 4.1 s at 512/16, 8.3 s at 1024/32, **24.9 s at 2048/32**,
52.6 s at 2048/128. All valid, `litMean` 0.65–0.69, nowhere near the 0.062 that
`render.py:116` records as a darkened scene. It is a UI job, not a grind job.

(One defect found while measuring, with aalev-f3: **the atlas always wastes
exactly 25% of itself.** `bake_lightmap` packs into `ceil(sqrt(n))` cells and
every Arcvia GLB has exactly n=3 meshes, so it always builds 2×2 and always
leaves one cell empty. The top-right quadrant measures 0.00% lit at every size.
`1 − n/ceil(sqrt(n))²` = 25%, deterministically, on every bake forever.)

**Multi-storey (§2).** Not long-running in the wall-clock sense, but it is the
biggest single piece of design-and-build in the product and deserves an
undivided session.

---

## 5. Known defects still open

- **Black pockets in lit renders.** Six hypotheses eliminated with evidence —
  see `HANDOFF-POCHE.md` §3 and do not re-test any of them. Owned by aalev-f3.
- ~~**6 of 18 doors unhosted**~~ — **NO LONGER REPRODUCES** on the current
  auto-layer, multi-storey pipeline. The 2026-08-25 real villa integration
  reports `unassigned: 0`. Reconstruction now preserves the block, storey,
  registered position, reason, and nearest-wall distance for every future
  unhosted sized opening, so a regression is a repair target rather than a count.
- ~~**`LATEST DRAWINGS` yields only small rooms**~~ — **FIXED `b7fd2da`, and it
  was never a frame problem.** It is recorded elsewhere as one; it is a **unit**
  problem. At the header's centimetres the sheet is 12.3 m across with 56 paired
  walls at 0.065 m median; at metres it is 1,234 m with 675 walls at 0.230 m — a
  nine-inch brick wall to the millimetre. The vendored reader gates unit
  candidates on overall extent (`_PLAUSIBLE = (3.0, 400.0)`), so metres was
  never offered, which inverts its own documented `measured > header > extent`.
  `classify/units.py` now scores candidates by how many walls land on a
  thickness masons actually build. **The reader gets 4 of the 7 real drawings
  wrong.** Sheet now: 37 drawings instead of 1, rooms of 121 m² instead of
  eleven totalling 54.73, unframed linework 19% → 4%.

- ~~**Frame selection is manual / `ALL PLANS` fuses several drawings.**~~
  Fixed on the 2026-08-26 production path. Ranking now rejects a scope whose
  walls segment into several drawings, rejects separated room islands and a
  failed derived-envelope preflight, reserves shortlist capacity for compact
  titled floor plans, and never lets an errored zero grade tie with a coherent
  zero grade. `ALL PLANS` changed from the blocked 498-wall / 106-room fused
  model to one `FIRST FLOOR PLAN`: 77 walls, 6 rooms / 5 named, 46.53 m²,
  all four detected doors hosted, zero verifier warnings or blocks.
  Reconstruction opens the DXF once and shares that document between reading,
  blocks, and furniture. It now uses strict read + audit for a sound DXF and
  falls back to full recovery on structural or remaining audit errors. The
  unprofiled `PLANS_FOR_3D` A/B fell from 15.572 s with forced recovery to
  9.091 s (41.6%), with identical walls, rooms, area, openings, layers, frame,
  and ranking. `ALL PLANS` fell from 273.42 s to 174.90 s (36.0%) with the
  same clean 77-wall / 6-room result. Four-thread candidate fitting helped the
  small sheet by 7.6% but regressed `ALL PLANS` to 279.97 s, so it was
  measured and reverted. Candidate preflight now rejects enclosing/fused
  frames, semantic non-wall layers, and large unknown layers (over 400
  segments) unless their scan verdict is `WALLS` with at least 10% paired-wall
  coverage. Explicit wall layers and small partition supplements remain
  eligible, and `pairedFraction` is exposed in the scan report.

  Measured direct-reconstruction results: `PLANS_FOR_3D` is 8.545 s versus
  15.491 s same-code control with the exact current 106-wall / 28-room /
  105.61 m2 model preserved; `ALL PLANS` is 110.09 s versus the 174.90 s
  fast-loader baseline, with an exact same-code semantic-filter control;
  `LATEST DRAWINGS` now finishes in 240.06 s (75 walls, 12 rooms, 78.58 m2,
  six openings); and `SITE PLAN FOR 3D` now finishes in 646.84 s (1,453 walls,
  179 rooms, 3,355.23 m2) without `ESMajor`. All three dense files previously
  exceeded 15 minutes where noted. `SITE PLAN WITH GARDEN LEVELS` finishes in
  5.67 s filtered (8 walls, no rooms, `A1 WALLS|Wall`) while the same-code
  control with only the large-unknown threshold disabled still exceeded 15
  minutes. That last result is a performance finding only: semantic equivalence
  is not claimed because the control did not complete.

  Visual QA rejects both newly completed site models as corpus truth. The
  `SITE PLAN FOR 3D` raster shows the actual villa cluster occupying a small
  central region while a 577.13 m unpaired `A1 WALLS` diagonal and large
  layer-`0` rectangles dominate the 833.28 m selected scope. Verification is
  correctly blocking (plan span and zero openings), also warning that the
  envelope covers only 5% and rooms split into separate groups. The garden
  result is only two tiny fragments: 8 walls / 0 rooms across 3.72 m at the
  header's 0.01 scale despite 252 room labels, and verification correctly
  blocks `rooms-from-labels`. Do not accept either model's quantities. Next
  treat the full site sheet as a site containing individual buildings rather
  than weakening building gates.

  The garden unit diagnosis is now actionable. Its wall scorer prefers metres
  (13 paired walls) over feet (5), but the 2.6x margin correctly remains below
  the 3x automatic-decision threshold. When labels exist but zero rooms close,
  the blocking finding now names that unresolved metre candidate before asking
  for layer review. An explicit metre control completes in 16.06 s as a 32.76 m
  plan with 142 walls, 20 rooms / 16 named, and 122.98 m2. It is still not an
  accepted model: no openings are hosted, wall run is high, envelope coverage
  is 84%, and rooms split into two groups. Preserve the human unit choice; do
  not lower the global confidence threshold for this one file.

- ~~**CLI enclosure retry can replace a correct measured-unit model.**~~ Fixed
  with an acceptance guard: an enclosure retry may replace a blocked build only
  when its scale is unchanged and its enclosed-room and named-room evidence do
  not regress. The real `PLANS_FOR_3D` CLI path now retains measured metres and
  the 106-wall / 28-room model instead of substituting the header-mm, `tx`-only
  4-wall / 1-room retry. Its original verification findings remain visible.
- ~~**~44% wall pairing / 3.48 m/m² wall run.**~~ Fixed on the real villa.
  Per-layer attribution showed generic layer `0` bought one extra named room
  with 137 walls, while `A6 SANITARY WARE` entered only through the broad
  fallback. Automatic selection now rejects disproportionate wall growth and
  admits fallback layers only when their semantic class is wall/other. Current
  result: 104/148 paired (70.3%), 21 rooms / 14 named, 260.09 m², wall run
  1.263 m/m², all four openings hosted, zero verification warnings.

- ~~**`solve/layerscan.py` picks the wrong layers for the villa's ground
  floor.**~~ Found 2026-08-22 and now fixed in two stages: shared perimeter
  basis, then proportionate evidence growth plus semantic fallback filtering.
  On frame 1 (`Ground Floor Plan`, bbox
  `90.63,299.94 .. 111.44,315.04`):

  | layers | rooms | named | largest |
  |---|---|---|---|
  | `A1 WALLS HIDDEN + A7 COMPOUND WALL` ← chosen | 5 | 4 | **274.84 m²** |
  | `A1 WALLS HIDDEN + A5 FALSE CEILING` | **18** | **7** | 104.5 m² |

  A 274 m² `LIVING / DINING` is a plan whose partitions did not close. The scan
  optimises *named rooms closed*, so it should prefer the second — and `A5
  FALSE CEILING` **is** in its shortlist for that frame (145 faces, verdict
  `WALLS`). It evaluates it and rejects it.

  **Two things ruled out**, so nobody repeats them:
  - *Not* a greedy local optimum. Restarting the hill-climb from every candidate
    seed changes nothing; the search reaches the same answer.
  - *Not* a missing shortlist entry. `recommended()` returns
    `['A1 WALLS HIDDEN', 'A5 FALSE CEILING', 'A5 FURN']` for that frame.

  ✅ **CONFIRMED AND FIXED.** The hypothesis recorded here was right: `fit_of`
  graded a layer set *without* `add_perimeter` while the pipeline builds *with*
  it, so the selector ranked sets by how well they enclose **on their own** and
  handed the winner to a stage that encloses them differently. `fit_of` now
  takes `perimeter=True` by default. `test/_probe_layerscan.py` is the tool that
  settled it — it grades every layer pair on both bases, per frame, and prints
  where the winner flips. Keep it; it answers this question for any drawing.

  Measured on the villa, the same set on the two bases:

  | | rooms | named |
  |---|---|---|
  | `A1 WALLS HIDDEN + A5 FALSE CEILING` | 4 | 2 |
  | ...with the perimeter | **15** | **12** |

  The winner changed outright on 2 of 5 annotated frames — `('0','A1 WALLS')`
  → `('0','A6 PLUMBING')` took one frame from 3 rooms/2 named to 10/8.

  Result on the ground floor: `A7 COMPOUND WALL` is no longer selected
  (`A5 FURN` is), rooms 21 → 23, and **`BED ROOM` 31.35 m² → 24.18 m²** against
  the 24.00 recorded below. Regression-checked against the other drawings:
  `PLANS_FOR_3D` is bit-identical, `ALL PLANS` yields no rooms on either basis
  (it is broken for another reason — see the frame-selection entry).

  ⚠ Still true and still load-bearing: `Fit.score` deliberately excludes raw
  room count, and its docstring records the measurement that settled that. Do
  not "fix" anything here by adding room count back.

---

## 6. Traps that have cost real time — read before debugging anything

The full lists are in `HANDOFF-POCHE.md` §5 and `docs/handover.md`. The four that
generalise beyond the CAD engine:

1. **Every failure here is silent.** A wrong unit yields zero walls and a valid,
   empty GLB that reports success. A wrong layer choice passes the gate. A rate
   lookup matching a substring prices sand as aggregate. Assume the plausible
   result is wrong until measured.
2. **A sweep of a constant needs a second column.** Someone swept
   `CLOSE_RADIUS` today, saw duplication collapse, and nearly shipped it — the
   same setting collapses the building from 23 rooms to 9. Whatever you are
   optimising, measure whether the result is still valid at the same time.
3. **Two checks of one quantity must share a basis, not just a band.** A
   wall-run-per-area check compared a site-*excluding* floor area against a
   site-*including* wall run and flagged a correct model. Each side had a
   locally correct reason, which is why the drift was invisible.
4. **Never round-trip UTF-8 through PowerShell defaults, and never put a regex
   in a bash heredoc.** `\b` becomes a literal backspace with no warning,
   because backspace is a valid Python escape. Use the Write/Edit tools.

5. **The browser and the worker read the same field, and only one of them is
   wrong.** A scene stored `hdriUrl: '/env/midday.hdr'`. That is a perfectly
   valid URL to a browser, so the studio previewed the sky and the picker looked
   finished — while `resolveUrl` matched neither of its branches, returned the
   string untouched, and the render worker resolved it against the drive root:
   `Cannot read 'A:\env\midday.hdr'`. **Anything stored on a scene and consumed
   by both halves can fail this way, and testing in the studio will never show
   it.** Worse than the "declared but never used" family below, because here
   half of it works beautifully. Pinned in `services/api/test/static-urls.mjs`.

6. **A field declared and never written is the defining defect class of this
   codebase — treat it as a class, not as a list of bugs.** Five instances found
   in one day:
   - `Provenance.locked` / `suppressed` — declared in the schema, used nowhere;
   - `ARCVIA_DONE:n/n` — printed, captured into the job record, never compared;
   - DXF entity handles — present in every file, discarded at ingest;
   - `hdriUrl` — plumbed the entire length of the product with nothing writing
     it, so `apply_environment()` took its `else` branch on every render ever
     run;
   - ambientCG's `dimensionX/Y/Z` — declared in its API and **zero in 15 of 15**
     materials sampled, across every family.

   **Before building a feature, check whether it is already built and merely
   unreachable.** And when you consume someone else's declared field, check that
   it is populated before designing around it.

   **A distinct and nastier sub-shape: written and read, but by nobody to each
   other.** `hdriUrl` was a complete consumer with no producer. `credits` was the
   mirror image — a complete *producer* (`catalogue/credits.ts`, 13 assertions
   green) and a complete *consumer* (`view/index.astro:467`, which renders the
   list and explains in a comment why it must), joined by nothing, with the field
   not even in the PATCH allow-list. **Both render a perfectly good page while
   quietly not doing the thing.** Two complete halves are not evidence of a
   working feature; only a test that crosses the seam is.

   And when you write that test, **assert PRESENCE, not correctness.** The
   failure state here is a credit list that is merely *shorter* than the licences
   require — which is exactly how this stayed open with 13 green tests sitting
   on it.

   One more, learned closing it: **the identity of an obligation is the SOURCE,
   not the file generated from it.** Keying surface credits on the colour-map URL
   credited one author twice for one asset, because `wall` and `ceiling` are both
   Plaster001 but the ingest tool writes one file set per surface ID. Models keep
   their own URL — two GLBs are two assets even when one person made both.
   Nothing at runtime would ever have reported the difference.

7. **`A:\Assets\Hub` holds no skies.** All 301 HDRIs are categorised `indoor`
   and none of Poly Haven's 297 `skies` were harvested — `harvest.mjs` says why,
   and is right for a furnishing library: "700 of them is not a furnishing
   library". It is exactly wrong for an architectural renderer, where the most
   valuable environment is the sky outside the window. An interior lit by a
   photograph of somebody's derelict bakery is plausible and wrong.

8. **A third of all rendered frames are invalid, and every check in this
   codebase looks for BLACK.** Measured: **17 of 52 frames bad — 32.7%.**
   photoreal interiors 10/16, cgi interiors 5/16. Every failure is an interior
   and **every one is BLOWN OUT or BLANK, not black** — one TOILET view has four
   distinct grey values in the whole 1280×720 frame. A blank white frame passes
   the near-black test, passes `rc == 0`, passes the `ARCVIA_OUTPUT` sentinel,
   and writes a healthy 900 KB PNG. It has been invisible for exactly that
   reason. **Validity needs a two-sided test and a spread test, not a darkness
   test.** (And the test must be style-aware: a `cad` line drawing is white paper
   with thin lines, has 165 grey levels and more edge content than `cgi`, and a
   brightness threshold flags it at "95.8% blown out" incorrectly.)

   ✅ **Built** — `render_views.py::inspect_frame` + `ARCVIA_SUSPECT` /
   `ARCVIA_VALID` (`146fb49`, `0346a6b`, `28e0992`). Blown threshold measured
   (clean 29→72 band), tone-count threshold kept but labelled unmeasured,
   line-art exempt from brightness, `raw` exempt entirely. Suspect frames are
   reported, never fatal — exposure belongs to the style, aim to the camera
   solver, and the caller decides.

9. **ambientCG ships two normal maps and one of them is silently wrong, and no
   statistic can tell you which.** Every material has `_NormalGL` and
   `_NormalDX` — the same map with the green channel inverted, because DirectX
   and OpenGL disagree about which way +Y points. glTF and three.js are OpenGL.
   Pick DX and every bump becomes a dent lit from the wrong side: geometry
   right, colour right, roughness right, surface just reads oddly and nobody can
   say why. Measured on Asphalt014:

   | channel | mean abs difference |
   |---|---|
   | B | 0.95 |
   | **G** | **58.23** |
   | R | 0.80 |

   …and yet green's **mean is 127.4 against 127.6**. The distribution is
   symmetric about the midpoint, so mean, median, histogram and variance all
   match. **The filename is the only evidence that exists.** Worse than the
   Poly Haven Z-up trap, which at least changes a number. Match the exact
   `_NormalGL` ending and refuse to substitute — matching with `in` picks either,
   which is the substring defect this repo has now recorded three times.

10. **Screen the artefact the renderer consumes, not the vendor's picture of
    it.** Three of eight materials picked off ambientCG's preview spheres were
    wrong, and all three were invisible until a metre rule went on the flat
    albedo: a "clean mid-grey" tile whose albedo is nearly black and whose units
    are 100 mm mosaic; a "Marble" that is speckled granite (the hub's names come
    from its source and describe a *family*, not a look — every `Marble0NN` is
    "marble" whatever it looks like); and a wood strongly orange with grain
    stretched to the width of a wardrobe door. A preview sphere is a lit render
    with its own key light and exposure. It is optimised to sell the asset.

11. **A confident wrong number is worse than no number, because it gets
    believed.** Tile scale was recovered from pixels twice — a column-mean
    luminance profile of a floor gave 3 cycles against ~13 plank rows (running
    bond follows blocks of similar tone, not the seams), and a gradient profile
    gave 32 cycles at spectral strength 0.019, no dominant frequency at all.
    Two plausible millimetre figures four times apart, one of which reported
    400 mm floorboards and looked exactly like a measurement. Both were thrown
    away and replaced by rendering the tile with a one-metre rule across it: a
    board is 100–300 mm and a floor tile 300–600 mm, and the eye settles that
    against a rule in one glance and in the abstract not at all. **That check
    caught all three bad picks above within a minute of existing.**

12. **If a constant's comment says "measured", the measurement belongs in the
    comment.** Three comments in this codebase today claimed a measured constant
    that was not — including one of mine. A threshold defended by a tone
    distribution that turns out to be continuous, with no gap anywhere near the
    value, is a chosen constant wearing a measured one's clothes.

13. **A race that has not yet been lost is not a reason.** An environment was
    applied inside the scene-load handler and worked — but `viewerRef` is a ref,
    so nothing re-runs when the viewer appears, and that effect is declared
    *before* the one that builds the viewer. It only worked because `getScene`
    is a network round trip that resolves long after mount. The symptom would
    have been "the editor sometimes shows the wrong sky on load": intermittent,
    machine-dependent, and blamed on the HDRI or the loader rather than on
    effect declaration order. **Ordering must be a property of the code, not of
    the network.**

14. **A test that resolves paths relative to itself lies to you under any
    bundling runner.** `run.mjs` bundles each test with esbuild into a temp
    directory, so `import.meta.url` points somewhere with no assets beside it —
    twenty-four present files reported as missing, reading as "the assets are
    gone" when the assets were fine. Resolve from cwd, and check the root
    separately and **loudly**: per-file results only mean anything once the root
    check has passed.

15. **A passing test against the wrong build is indistinguishable from a passing
    test.** A stale server held port 8787, so a whole round of "verified against
    the running server" ran against a build from *before* the refactor being
    verified. Cost an hour. If you verify against a live API, check what is
    actually listening: `netstat -ano | grep 8787`, then
    `wmic process where "ProcessId=N" get CommandLine`. And note `--watch`
    restarts the server whenever *any* session edits a repo file, which produced
    two `ECONNRESET` failures that looked exactly like real bugs.

16. **`apps/studio/dist` is an untracked local build** — gitignored, not in
   `git ls-files` — and it still swamps a repo-wide grep with the whole three.js
   bundle. Search `src` only. (Do not go looking for it in git and conclude this
   note is stale; the directory is real, it is just not tracked.)

## 2026-08-25 - room finishes and attachment targets

Reconstruction now emits a separate `wall_roomN_<slug>` finish skin and
`ceiling_roomN_<slug>` underside for every indoor room on every storey. Wall
skins sit 1 mm proud of the measured wall face, face into their room, and split
around the same hosted doors and windows as the masonry; they do not change
quantities. Ceilings are deliberately underside-only: visible to a person
walking inside, back-face culled from above so roofless plan/isometric views
still show furniture instead of a patchwork roof. Later room renders can now
override their matching floor, wall, and ceiling while the first render remains
the fallback. The real two-storey villa rebuilt to 121 GLB meshes: 45 room/site
floors, 35 indoor room-wall meshes, and 35 matching ceilings; verification had
no blocking findings.

The design reader now distinguishes `painting`, `mirror`, `wall-light`,
`ceiling-light`, and `pendant`. Render-derived proposals use `boundedBy` plus
the reconstruction's measured wall thickness to stand wall objects on the room
face, and arrange ceiling objects inside the measured polygon. They remain
**seen in render** review evidence because perspective does not prove plan
position. Stronger CAD or accepted objects suppress only the same attachment
class, so a drawn sofa stops floor guesses without erasing a visible painting
or pendant.

Remaining honest gaps: labels that are genuinely absent from the source drawing,
bespoke assets outside the catalogue, and exact decor positions that appear
only in perspective renders. Unknown-but-plausible room labels now survive the
CAD context filter, so a caption such as `MEDIA ROOM` can target its measured
space. Unsupported render items now carry an Asset Hub search phrase in the
review row, with a copy action; they remain review-only until conditioned and
explicitly placed.

**2026-08-25 — reviewed Hub assets can now become real scene objects.** An
unresolved row's **Find asset** action opens the Hub with the reader's exact
search phrase. The reviewer must choose a real floor-standing catalogue item
as the physical template (dimensions, placement class, 2D symbol and fallback),
then choose a Hub result. The server conditions that result to the web budget,
caches a private metadata sidecar, and returns server-authored licence, author,
source, triangle count and facing. The resolved proposal goes back through the
existing `placeFurniture` path; the conditioned model and its attribution are
persisted on the placed object and flow into publication credits. A later
manual GLB correctly supersedes both the Hub model and its credit. Raw Hub GLBs
still never enter scenes. Wall and ceiling templates remain refused until a
measured attachment target exists; a perspective render proves inventory, not
the exact mounting point. Verified: 12 focused Hub-placement assertions, 30
credit assertions, 17 Hub API assertions, all 784 Studio assertions, full API
suite, Studio production build, and `git diff --check`. The browser smoke test
was attempted but the Windows sandbox could not launch the browser-control
process, so no visual-interaction claim is made.

**2026-08-25 — measured Hub attachments and current-model stills are closed.**
The reviewed Hub flow now offers floor, wall, and ceiling catalogue templates.
Wall and ceiling choices expose the proposal's measured room context and remain
disabled until the reviewer selects a specific room face or ceiling point;
there is no centroid shortcut. In-wall templates remain excluded because a
door/window replacement must bind to an actual opening. The selected target is
resolved through the same measured placement functions as recognised render
decor, then the conditioned model, dimensions, facing, and attribution persist
through the normal plan-object path.

Preview, isometric, and full stills previously submitted only `sceneId`, so the
worker loaded the older saved `scene.modelUrl` unless Publish or Bake happened
first. `SceneView` now shares one current-model capture path between Publish and
those still presets: it waits for models, exports the complete dressed and
furnished editor state, uploads it, updates `modelUrl`, and only then queues the
job. Measured-plan scenes rebuild with ceilings; imported/hybrid scenes export
the composed viewer model; unloaded model-only scenes preserve their stored
building. A scene with a baked atlas deliberately preserves its bake-time
model because replacing its mesh/UV layout would apply the atlas to the wrong
geometry. Verified: 25 design-furnishing assertions, 18 Hub-placement
assertions, 8 capture-policy assertions, all 800 Studio assertions, strict
TypeScript, Studio production build, and `git diff --check`. A real worker
image comparison and the in-app browser interaction smoke remain unclaimed.

**2026-08-25 - OpenAI vision integrated and live-tested under a hard cap.**
`adjudicate.py` now has an optional process-wide provider-call ceiling, clamps
output tokens per call, records returned token usage, and exposes only those
non-secret counters through `/health`. `evaluate_openai.py` refuses keys on its
command line and defaults to three calls: one render DesignSpec, one suspect
plan crop, and one whole-plan window pass. The credential was supplied through
a hidden, process-scoped prompt and removed after the run.

The real two-sheet deck used exactly 3 calls / 2,287 total tokens. Integration
passed: OpenAI image input and the structured response contract worked. Accuracy
did not earn an unattended-production pass. The bedroom inventory and painted
wall palette were useful, but carpet was misclassified as wood/plank. The plan
pass changed 55 walls / 13 rooms to 54 / 12, removed one 90%-confidence fixture
enclosure, and accepted three snapped windows; a one-crop cap cannot cover all
five owner-annotated defect groups. The prompt now distinguishes carpet pile
from plank seams/grain, but no second live call was spent. Full evidence and the
next bounded comparison are in `docs/OPENAI-VISION-EVAL-2026-08-25.md`.

**2026-08-25 — 360 panorama delivery is built; browser smoke remains blocked.**
The API now exposes an 8-credit `panorama` preset at 4096×2048, 64 samples, and
equirectangular projection; the worker maps it to Blender's `PANO` /
`EQUIRECTANGULAR` camera and the heavy queue lane. Studio persists completed
output as `scene.panoramaUrl`, restores it independently of transient still
output, previews it with drag/zoom, and can clear it. The public walkthrough
loads the panorama lazily, withholds it until protected scenes are unlocked,
and loses **View 360** when the panorama is removed. Both clients use the shared
Three.js `PanoramaViewer`, including resize and disposal handling.

Verification passed: pricing 23/23; isolated panorama API render 28/28; queue
lanes 10/10; scene patch 35/35; access-code integration 26/26; Studio strict
TypeScript and production build; web Astro check and production build; and
`git diff --check` apart from line-ending notices. A real colour-coded GLB also
rendered through Blender 5.1 on CPU at 512×256 and one sample, with a 0.58 mean
RGB seam difference and distinct red, green, and blue regions. This does not
claim a production-size 4096×2048 64-sample run. The required browser runtime
was retried after the Codex restart and still exited before launch with
`SetTokenInformation(TokenDefaultDacl) failed: 1344`; no browser interaction
claim is made.

**2026-08-25 — CAD verifier findings now reach an explicit Studio review.**
Successful reconstruction jobs already exposed the gate's structured
`verifyChecks`, but `ImportPanel` discarded them and landed in the editor
immediately. The API contract is now typed and warning-bearing jobs pause on a
review surface that shows the exact finding messages and model facts. The
reviewer must choose **Use reconstruction**, try another file, or close; passed
informational measurements remain available without interrupting clean jobs.
This is deliberately a first M5 slice, not a claim that solver choices,
re-solve, or persistent `ModelPatch` replay exist.

Validation passed: focused review logic 7/7, Studio strict TypeScript, the full
Studio suite, and the Studio production build. A real villa DXF ran end to end
through one isolated non-watch API process: 43/43 assertions passed, including
seven delivered verification checks and a warning count of one. The temporary
API used its own database and upload directory, then stopped and removed them.

A later current-path villa run closed those stale backlog claims. It hosts all
detected openings (`unassigned: 0`) and pairs 104/148 walls (70.3%). Per-layer
attribution and proportionate evidence scoring removed generic layer `0` and
`A6 SANITARY WARE`; wall run is now 1.263 m/m², inside the 0.6–1.6 band, with
zero verifier warnings. Reconstruction retains exact
block/storey/position/nearest-wall evidence for every future unhosted sized
opening, and the API/Studio review surface exposes those targets. Focused
reconstruction tests pass 153/153; frame-ranking tests pass 24/24; the real API
seam passes 49/49.

**2026-08-26 — a site sheet now names its buildings, and a rejected build can
no longer publish itself as a clean pass.**

Two things, and the second was found while trying to get evidence for the first.

*The artefact bug.* `cli.py` re-seeds layers and runs a SECOND reconstruct when
a build blocks, then asks `enclosure_retry_improves()` which to keep. The guard
was correct and refused the bad retry. It was defeated anyway, because
`reconstruct()` writes `<stem>.building.json` and `<stem>.glb` as its final act
and both builds wrote to the same `--out`: the rejected retry overwrote the
accepted model before the guard was ever consulted. Measured on
`PLANS_FOR_3D`: the console printed 106 walls / 28 rooms / BLOCKED while the
file on disk held 4 walls / 1 room / 2.49 m2 and `"ok": true`. A **rejected
build published as a clean pass** — and `services/api/src/lib/cadEngine.js`
reads the model from disk and never sees stdout, so the worse the drawing, the
tidier the model it shipped to a viewer. Its own docstring calls that outcome
worse than failing. A trial build now goes to `work/enclosure-retry` and only a
decision promotes it (`promote_build`); a refused retry now says so instead of
vanishing. The tell, for anyone auditing a similar guard, was a MISSING key:
`layerRetry` was absent from the on-disk model, which proved the file had been
written by the retry itself rather than by the accepted path. When a guard
chooses between two artefacts, check where each one was WRITTEN, not only which
one the code returns.

*The site sheet.* `solve/site.py` separates the buildings on a site, which is
the third scale of separation in this engine and needed its own criterion.
`solve/frames.py` separates the DRAWINGS on a sheet by emptiness, and it is
right to return one frame for a site — roads, plot lines and the compound wall
run continuously between the villas, so there is no channel to find.
`quantify/dwellings.py` separates the DWELLINGS in a building by the door
graph, and it starts from the grouping being asked for here. The new criterion
is topological: **the rooms of one building tile, so they share bounding
walls; two villas on a plot share none.** `Space.bounded_by` already carries
it, so there is no distance in the rule and nothing to tune — which matters,
because `frames.py` records at length how no single gutter value can both keep
a plan whole and separate two plans.

Measured. Four real drawings that verify cleanly today — `PLANS_FOR_3D`,
`DOWN VILLA` and two client uploads — each return exactly **one** building, so
the check cannot fire on a model the engine already accepts. `SITE PLAN FOR 3D`
returns **six**: 82 rooms / 1,615.15 m2, 69 / 954.93, 23 / 598.73, then a
2-room 180.36 m2 group spanning 77.60 m and two fragments of 5.10 and 0.92 m2.
582 walls totalling 3,503.8 m bound no room at all and are reported as site
linework rather than billed to the nearest villa. Room area totals 3,355.2 m2,
matching the figure the previous session measured, so this reads the same model.

The fragments are deliberately NOT filtered out. A "minimum plausible building"
threshold is exactly the kind of constant this criterion exists to avoid, and
the span and area columns let a reviewer see that the 77.60 m two-room group is
an artefact. Before this, the operator's entire report on that sheet was
`plan-span: 833.28 m — not a building`.

`verify.check()` grades it: `site-scope` BLOCKS at two or more buildings,
naming each one and how to escape, and reports INFO on a single building
including the length of linework that bounds nothing — a villa's few stray
metres growing into thousands is the earliest sign a scope has stopped being
one building. `--building N` rebuilds one, and it narrows the WALL list and
re-solves rather than filtering rooms, so the openings, fixtures, perimeter,
meshes and bill all follow; the wall statistics are recomputed after narrowing,
because they were first computed against the whole frame and would otherwise
have priced the site's 106 walls against one building's 102. `--building`
refuses a multi-storey stack outright: the numbering is per frame, so index 2
downstairs need not be index 2 upstairs, and a silent mismatch stacks one
villa's ground floor under another's first floor and renders plausibly.

`model.site` is always the primary storey's answer, carrying the rest under
`storeys` when there is more than one — the shape rule `elements.*` follows.

Verification: `test/test_site.py` 48/48 new; the full reconstruction suite is
841 assertions across 23 scripts, all green, up from 785/22. The multi-storey
refusal and the `--building 0` narrowing were both exercised on real drawings.

Visual QA was then run on the result, and it settles what building #0 is.
Rendered from the model's own geometry, #0 is a ROW OF REPEATED VILLA UNITS,
not one villa: three `TYPE - C` units along the top and four `TYPE - D` along
the bottom, each with its own `STILT` and `U.GR.FL.`. The room-name census says
the same thing without the picture — `STILT` x7, `TYPE - D` x4, `U.GR.FL.` x4,
`TYPE - C` x3 — and "TYPE C/D" are the developer's villa-type designations.

That is the criterion behaving CORRECTLY, not failing. The units are genuinely
wall-connected: dropping every room over 90 m2 from #0 still leaves ONE
component, and dropping everything over 45 m2 leaves two, so the row is not
bridged by a few spurious site-linework enclosures that could be filtered away.
A terrace sharing party walls is one structure, which is exactly what
`solve/site.py` says it will report, and separating the individual dwellings
inside it is `quantify/dwellings.py`'s job, by door graph.

The zero-openings blocker was then chased to its root, and the answer is NOT
the one it looked like. It is not missing opening recovery.

The sheet does carry doors: 15 `D750` block placements plus 45 `WINDOW1` lines,
on layers `door` / `WINDOW1`, and `_width_from_name('D750')` already reads 0.75
correctly. They are read into `placements` too — the block reader returns all
15. What stops them is `_blocks_in`, the frame's position filter: the doors sit
at x 2690-2693, and the SELECTED FRAME spans x 1010-1844. **Zero of the 15 fall
inside it.** The emitter never sees them, which is why the model shows neither
an opening nor a refusal — `openingIssues` is 0, and a hosting failure would
have recorded 15.

The sheet holds **29 frames**. Ranking picked #0, `REVISED SITE PLAN` — 471
walls, 833.28 m, the wall-count leader — and that frame is a SITE LAYOUT. A
site layout has no doors by nature; it depicts villa footprints, stilts and
types. The doors live on the villa DETAIL drawings elsewhere on the same sheet,
and frame **#2** (162 walls, 61.09 m, bbox 2646.6,209.6 .. 2707.7,269.3) is the
one that contains them.

So `openings-present` blocking on frame #0 is CORRECT, not a gap, and the
earlier reading of this as missing opening recovery was wrong. What the sheet
needs is the right FRAME, not a new emitter. That also revises the terrace
finding above: building #0 is the site layout's depiction of a villa row, which
is why it has `TYPE - C` / `TYPE - D` / `STILT` labels and no doors at all.

Worth carrying forward as a rule: on a multi-drawing sheet, "no openings" is
evidence about WHICH FRAME was chosen at least as often as it is evidence about
opening detection. The frame's own bbox against the door blocks' coordinates
settles it in one comparison.

Two documentation defects found on the way, both in `hypothesise/openings.py`:
its docstring advertises **two** emitters, SIZED BLOCKS and OPENING LAYERS, and
says both read what the drawing already says. There is no opening-layer emitter
anywhere in the codebase — no function, no call site, nothing referencing one —
and the second emitter that DOES exist, `from_text_labels`, is not in that list.
A reader following the docstring concludes that a drawing which draws its
openings on a door layer is handled. It is not. `WINDOW1`'s 45 lines on this
sheet are exactly that case.

`--building 0` is nonetheless a large step on the real sheet: 1,453 walls / 179
rooms / 833.28 m span / 2 blocking + 3 warnings becomes 386 walls / 82 rooms /
50.39 m span / 1 blocking + 0 warnings, with 0.0 m of linework bounding no
room. `plan-span`, `envelope-coverage` at 5%, `one-building` and `room-size`
all clear; only `openings-present` remains.

Building frame #2 then proved the diagnosis and caught a false positive in the
new check at the same time. That frame yields **15 hosted doors**, `unassigned:
0`, all `blockSized` — `openings-present` clears, exactly as the coordinate
comparison predicted. But it also segments into 13 components, and 12 of them
are the SAME stamped rectangle: one room, four walls, unnamed, 1.78-2.00 m2,
3.33 m across. The check as first written blocked a real drawing because a
symbol repeats twelve times.

The gate now counts only components carrying at least one NAMED room. The
discriminator is the drawing's own labelling rather than a size floor, for the
reason `frames.py` argues at length and `layerscan.py` states as a rule —
optimise named rooms, not room count. A magnitude threshold could not have done
it anyway: 3.33 m already clears `PLAUSIBLE_SPAN`'s floor of 3.0 m. It fails in
the safe direction, since an unnamed genuine second building becomes a false
negative rather than a wrongly blocked model, and every component is still
listed in `model.site.buildings`. The discounted fragments are named in the
finding itself — a check that silently drops what it chose not to count teaches
its reader that nothing was there.

Current behaviour on the three measured cases: frame 0 BLOCKS with 3 buildings
(the named clusters, 19 / 12 / 4 named rooms); frame 2 passes as one building
and reports 12 discounted fragments; the known-good villa is unchanged.

Not claimed: a per-villa quantity from this sheet. #0's 1,615.15 m2 is a
terrace of roughly seven units and must not be quoted as a villa. Nothing in
Studio or the API surfaces `--building` yet; this slice ends at the engine.

**2026-08-26 (later) — the opening-layer emitter exists now, and the sheet's
remaining windows are a MISSING WALL, not a threshold.**

`hypothesise/openings.py` advertised two emitters, SIZED BLOCKS and OPENING
LAYERS, and said both read what the drawing says. There was no opening-layer
emitter anywhere in the codebase, and the second one that did exist,
`from_text_labels`, was not in the list. `from_opening_layers` now exists and
the docstring describes the three that are really there.

It projects each segment onto the wall it hosts on and merges the overlapping
along-ranges. The wall does the clustering, so there is no "how close is close"
constant — and two windows on opposite faces of one 0.23 m partition stay two,
where any proximity rule loose enough to join a single window's own lines joins
those as well. Hosting is orientation-aware (`host_along`): parallelism filters
the candidate walls rather than grading the winner, because a segment's
direction is evidence about which wall it belongs to and `host()` — correctly,
for a block, which is a point — cannot use it.

Measured, on drawings that already worked:

  * `DOWN VILLA`, the model that verifies clean, is BYTE-IDENTICAL: 149 walls,
    25 rooms, 4 openings, all `blockSized`, zero issues, zero warnings. The new
    emitter adds nothing to it.
  * `PLANS_FOR_3D` goes from BLOCKED with zero openings to PASS with four
    hosted doors at 0.97 / 1.00 / 1.00 / 2.30 m. Its sparseness is not hidden:
    `clearance` reports 14 rooms with no door and a new `openings-hosted`
    warning says 3 of 7 could not be placed.
  * `SITE PLAN FOR 3D` frame 2: 33 openings — 15 doors from blocks, 18 windows
    from `WINDOW1` — and PASS with 4 warnings.

**A correction worth recording, because the reasoning failed in a way that
looked like evidence.** The width split on frame 2 is 13 windows of 0.60 m and
5 of 2.00 m. That was read as a defect against an assumed truth of "15 windows
of 2.00 m", and a cause was proposed — `host()` picking a perpendicular wall,
against which a tick looks like a glazing line. The fix was written and it
changed nothing: the split was identical afterwards.

Instrumenting all 45 segments individually gave the real picture, and it is not
the one that was assumed:

  * all 15 of the 0.60 m lines HOST successfully, running along a wall. They
    are not cross-ticks. The tick story came from reading one sample row of
    2.00 m lines and inferring the rest;
  * 15 of the 30 2.00 m lines host cleanly at 2.00 m;
  * the other 15 are refused, and their NEAREST wall of any orientation is
    0.93-1.01 m away.

So the emitter's orientation handling was never the problem, and the assumed
truth was never measured. The refusals are correct: a window symbol one metre
from the nearest reconstructed wall does not have a wall to sit in. That is the
same finding this project has recorded before about unhosted doors — the wall
does not exist in the model — and it is a wall-detection gap, not a tolerance.

**Do not raise `HOST_RADIUS` to 1.05 to collect them.** It would host five
windows onto a wall a metre away, which is a wrong answer that verifies clean,
and it would be a constant fitted to one drawing.

The orientation-aware hosting was kept. It is defensible on its own terms and
regressed nothing, but it fixed a problem that was never demonstrated to exist,
and it is recorded that way rather than as the fix it was written as.

Verification: `test/test_opening_layers.py` 32 new; `test/test_site.py` 48;
the full suite is 877 assertions across 24 scripts, all green.

**2026-08-26 (later still) — two defects in the new emitter, found by running
it rather than by reading it, and a correction to the entry above.**

*The villa result stated above is superseded.* `PLANS_FOR_3D` was recorded as
going from BLOCKED to PASS with four hosted doors. It now recovers THREE doors
and is still BLOCKED, and that is the better answer. One of the four was a
0.9712 m door hosted on a 0.9602 m wall — an opening 11 mm WIDER than the wall
it was cut into, which is not a thing that can be built. `from_sized_blocks`
has always refused this shape (`wall.length < width + 2 * END_MARGIN`) and the
new emitter did not; it does now, using the sibling's rule rather than a looser
one invented for the occasion. Dropping it moves `openings-hosted` from "3 of
7" to "3 of 6", which crosses into blocking.

So the net for that drawing across the day is: still blocked, but for an honest
reason (half its opening linework has no wall to sit on) instead of a false one
(no openings at all), and with three real doors recovered. `DOWN VILLA` is
unchanged throughout — 149 walls, 25 rooms, 4 blockSized openings, zero
blocking, zero warnings.

*The crash.* Adding that guard ended a villa build with `KeyError: 'position'`.
`cli.py` copies `issue["position"]` into `registeredPosition` for every opening
issue, unguarded, and the two refusals raised against a MERGED run have no
single segment to point at. Both halves are fixed: every refusal this module
raises now carries a position — including the ambiguous-layer one, which is why
the segment midpoint is computed before the kind test rather than after — and
`cli.py` reads it with `.get`. The second half matters more than the first. This
is the review payload for ADVISORY findings, and an advisory that cannot be
displayed must not end a build that had already reconstructed a building. It is
the same rule the clearance and codecheck blocks a few lines below already
follow, and it was the one place that did not.

*Why the frame-2 windows are still refused, precisely.* Instrumenting a single
refused segment against both the raw DXF and the model settles it. The window
runs x=2690.13 from y=237.95 to y=239.95. The raw `Wall` linework has a stub
ENDING at y=237.95 and another STARTING at y=239.95, collinear with it and
touching both endpoints exactly. **The window is the gap in the wall run.**

There is therefore no wall at the opening's midpoint, by construction — and
`host()` and `host_along()` both host by midpoint. It is not a radius problem,
not a missing wall, and not a length filter: the flanking stubs are 0.52 m and
0.75 m, both well over `MIN_LENGTH = 0.35`. The wall is present and
interrupted, which is exactly the shape `_gap_candidate` already bridges for
TEXT labels — that machinery simply is not reachable from linework.

Bridging two collinear walls across a labelled gap is the fix, and it belongs
in wall joining rather than in an emitter. It is not attempted here: it changes
geometry every other stage consumes, and it deserves its own session with the
pairing tests in front of it.

Verification: `test/test_opening_layers.py` 35; the full suite is 880
assertions across 24 scripts, all green.

**2026-08-26 (last) — a wall gap that an opening's own linework sits in is now
bridged, and it closes rooms as well as openings.**

`bridge_opening_runs` closes the shape diagnosed above: an opening drawn AS the
gap in a wall run, with no wall at its own midpoint for any host test to find.
It reuses `_gap_candidate` — the machinery `from_text_labels` already relies on
— by passing the run's own midpoint as a stand-in label. The evidence is at
least as good as a text label's: a `D750` written beside a gap says an opening
is there, and a 2 m window run drawn IN the gap says it with geometry.

It runs BEFORE `detect_spaces`, beside the labelled-gap bridge, and that
placement is the load-bearing decision rather than a detail. Bridging changes
geometry, and the rooms, the wall statistics and the bill all read that
geometry afterwards. Doing it inside the emitter — where it would have been
convenient, since that is where the runs are already gathered — would leave the
rooms solved against a wall run that no longer exists, and every artefact would
look correct on its own.

Measured on `SITE PLAN FOR 3D` frame 2, four bridges made:

  | | before | after |
  |---|---|---|
  | walls | 658 | 651 |
  | rooms | 135 | **139** |
  | unhosted openings | 15 | **3** |
  | window widths | 13 x 0.60, 5 x 2.00 | **9 x 0.60, 9 x 2.00** |
  | verdict | PASS, 4 warnings | PASS, 4 warnings |

The room count is the result worth noticing. Bridging was built to host
openings, and closing those gaps also closed FOUR MORE ROOMS — which is the
whole reason it had to run before room detection rather than after.

Not a complete recovery, and it should not be read as one. The sheet draws 15
window symbols; nine now measure 2.00 m where four did before, and nine 0.60 m
readings remain. Three openings are still unhosted.

Guards, because a bridge merges two walls the drawing drew apart:

  * the gap must match the run's own length within one wall thickness — a run
    is drawn on a FACE and the gap is measured between CENTRELINES, 2.00
    against 2.115 on the real case. Without it a 0.60 m ventilator closes a 2 m
    doorway elsewhere and reports it as its own;
  * a run whose wall is intact never bridges;
  * every bridge is recorded in `model.openingBridges` — always present, so
    "none were made" and "never attempted" stay different states. A reviewer
    looking at a wall that is not in the drawing can find out why it is there.

Cost is not a concern: 15 runs against 658 walls is 0.06 s, because once a gap
closes the remaining runs host on the merged wall and never search.

Regression: `DOWN VILLA` is unchanged — 149 walls, 25 rooms, 4 blockSized
openings, zero blocking, zero warnings, `openingBridges: []`. `PLANS_FOR_3D` is
unchanged at 106 walls / 28 rooms / 3 doors.

Verification: `test/test_opening_layers.py` 48; the full suite is 893
assertions across 24 scripts, all green.

**2026-08-26 (closing) — the 0.60 m windows are REAL, and the guess about them
was wrong three times.**

The frame-2 result was left with an open doubt: nine window readings of 0.60 m
whose provenance nobody could account for. They were described first as
cross-ticks through an opening, then as a symbol artefact, then as unexplained.
All three readings were wrong, and each was an inference from a length
histogram rather than a look at the geometry.

Drawing the raw linework settles it. A 0.60 m reading is TWO horizontal
`WINDOW1` lines 0.115 m apart — y=224.30 and y=224.41, spanning x 2690.76 to
2691.36 — which is one wall thickness, i.e. the two FACES of a wall. That is
the identical construction to a 2.00 m window; the only difference is that it
sits in a horizontal wall rather than a vertical one. The rendered crop shows
the pair, the `W0.60` opening correctly placed on the wall beneath them, and
two `D0.75` doors either side.

So the emitter is reading them correctly and they are small windows or
ventilators. Nothing needs fixing here.

The 2.00 m symbol was also mis-described earlier as "two glazing lines plus a
0.60 m cross tick". It is THREE parallel 2.00 m lines — two faces and a centre
line — and there is no tick anywhere in the symbol.

Expected against measured, from the raw counts: 15 lines of 0.60 pair into
roughly 7 windows and 30 lines of 2.00 triple into 10, so about 17 in total.
The build reports 9 and 9, which is 18. Slightly over on the small ones and one
short on the large ones, and close enough that the remaining difference is
merge behaviour rather than a misread symbol.

The lesson is the one that keeps recurring in this file, in a new costume: a
length histogram is not geometry. Three separate stories were told about these
lines from their LENGTHS alone, all three were plausible, and all three were
wrong. Drawing them took one render and settled it. Nothing was ever filtered
on the strength of those wrong stories, which is the only reason the real data
survived to be looked at.

**2026-08-26 (frame choice) — a fallback frame now says it is a fallback.**

The day's largest time sink was diagnosed backwards twice before the ranking
trace was read, so the trace is worth quoting. On `SITE PLAN FOR 3D`:

    frame 0 REVISED SITE PLAN  error: scope contains 3 independently framed drawings
    frame 1 (untitled)         error: reconstructed rooms split across a 5.83 m gap
    frame 2 (untitled)         error: reconstructed rooms split across a 10.82 m gap
    frame 3 (untitled)         error: preflight envelope-coverage ...
    picked: 0   promoted: false

EVERY candidate errored. `best_eligible_graded_index` then returned the
wall-count incumbent, which is its documented behaviour and the right
conservative move — a broken grade is no basis for promoting anything over
anything else.

The consequence is what nobody could see. The incumbent is the 833 m
`REVISED SITE PLAN`, a SITE LAYOUT, which has no doors by nature and blocks on
two checks. Frame 2 was rejected for the mildest of the four reasons and builds
a model that PASSES with 15 hosted doors, 139 rooms and zero blocking findings.
The fallback picked a blocking model over a passing one, and reported it the
same way it reports a decision.

`fallback_frame_note` now states it: "NO candidate graded cleanly, so this
frame is the wall-count fallback rather than a choice — the others were
considered and rejected: --frame 1 (...): reconstructed rooms split across a
5.83 m gap; --frame 2 (...): ...". It reaches the console through the existing
`framingNote`, naming each rejected frame as a flag the operator can type.

**It deliberately does not re-rank.** Choosing between four broken grades needs
a severity order; that order would be invented here rather than measured, and
the rejected candidate is not reliably the better one — on this sheet it was,
on the next sheet it need not be. The operator settles it in one build with
`--frame N`, and now knows there is something to settle.

The silence case is tested as carefully as the firing case: a single clean
grade must silence it entirely, or every ordinary build grows a warning nobody
reads and the real one is lost in the noise.

Still open, and larger than a note: nothing in frame ranking knows that a SITE
LAYOUT and a CONSTRUCTION PLAN are different kinds of drawing. The title said
"REVISED SITE PLAN" the whole time. Ranking grades on what a scope reconstructs
into — walls, rooms, named rooms — and a site layout scores respectably on all
three while being the wrong artefact to build. That is a real gap and it is not
addressed here.

**2026-08-26 (title) — `openings-present` now explains itself on a site layout.**

The entry above left this open: nothing in the engine knew that a SITE LAYOUT
and a CONSTRUCTION PLAN are different kinds of drawing, while the title read
`REVISED SITE PLAN` throughout the day it cost.

`verify.is_site_layout_title` now reads it. When `openings-present` fires on a
frame whose own title says site/master/layout/key/location plan, the finding
adds: the frame is a site layout, not a construction plan; a site layout
carries no doors by nature; so this is about which frame was built rather than
about opening detection, and the framing note lists the candidates.

Three things it deliberately does NOT do:

  * it does not change the finding's LEVEL. `openings-present` still blocks. A
    gate that explains itself is not a weakened gate;
  * it does not touch frame ranking. Demoting a frame for its title would
    change frame selection across the whole corpus on the strength of one
    sheet, and a title is evidence rather than an answer — the rule walls and
    plan titles already follow here;
  * it does not guess from the word "plan". The qualifier carries the meaning:
    `GROUND FLOOR PLAN` and `SITE PLAN` differ only in what precedes it, and
    `BLOCK - A FINAL CONCEPT PLANS` is a real corpus title that must not match.
    All three are pinned by test.

Verification: `test/test_framerank.py` 37, including the five title cases and
the eight fallback-note cases; the full suite is 901 assertions across 24
scripts, all green.

**2026-08-27 — `--building` now reaches the API, and the browser runtime is
unblocked.**

The engine's building selector ended at the CLI. It now runs the whole way:
`cadEngine.reconstruct` takes `building`, `renderQueue` passes it from the job
spec, and `POST /cad/jobs` accepts it.

Two details that are the actual work rather than the plumbing:

  * **It is in the idempotency fingerprint.** That route's own comment says the
    fingerprint covers every input that changes the output, and `building` is
    the easiest one to leave out, because every other field is identical
    between the two requests — same drawing, same layers, same frame, same
    height. Omitted, asking for building 1 after building 0 would deduplicate
    against it and hand the reviewer the WRONG VILLA together with a cheerful
    "not charged again". Five assertions pin both directions: two different
    buildings are two jobs, the same building twice is one.
  * **A building pick suppresses `--storeys`.** The engine REFUSES the pair,
    because the numbering is per frame and index 2 downstairs need not be index
    2 upstairs; the API sends `--storeys` by default, so passing both would
    fail the job instead of honouring the request. The narrower intent wins and
    the reason travels to the caller through `onProgress`.

Studio deliberately NOT wired. `submitCadJob` sends `{ key }` and nothing else
— no frame, no unit, no layers — so the Studio has never exposed a
reconstruction setting, and adding this one alone would be incoherent. The
surface that lets a reviewer read `site.buildings` and choose is the M5 review
queue, and it belongs there.

Verification: the full API suite is 472 assertions across 32 files, all green,
run against a live server on 8787 with its own data directory, which was then
stopped and removed. `cad.mjs` alone is 54.

**A silent skip worth knowing about.** Run with no server up, `test/cad.mjs`
prints "0 passed, 0 failed" and exits 0. So does `cad-cancel.mjs`. A suite that
reports zero assertions and succeeds is indistinguishable at a glance from one
that ran — this was nearly read as "the CAD tests pass" before the server was
started and the same file reported 49. Not fixed here; recorded, because the
same shape has been found three times in this project already.

**The browser runtime is no longer blocked.** `SetTokenInformation
(TokenDefaultDacl) failed: 1344` no longer reproduces — a tab group opens. The
three items gated on it (the 360 panorama flow end to end, the live post-edit
render comparison, and human visual approval of the stairs) are now runnable.
None of them were run here; only the gate was tested.

**2026-08-27 — the silent skip is fixed, and the browser stack is verified as
far as the sign-in wall.**

*The skip.* `test/cad.mjs` and `test/cad-cancel.mjs` both bailed on one failed
health fetch, and that collapsed two different answers into one. With no server
running they printed "0 passed, 0 failed" and exited 0 — indistinguishable at a
glance from a suite that ran, and nearly read that way here before a server was
started and the same file reported 54.

They are now told apart, because only one of them is a skip:

    no response at all   -> the HARNESS is wrong. Nobody started the server, so
                            nothing was tested. Exit 1, and name the command
                            that starts one.
    a reply saying the
    engine is missing    -> a real skip. The Python engine is a separate
                            install. Exit 0, loudly.

Both directions verified: with no server the two files now exit 1 with
"0 passed, 1 failed (nothing was tested)"; with a server they are 54 and 5.

*The browser.* The runtime that failed with `SetTokenInformation
(TokenDefaultDacl) failed: 1344` throughout the previous sessions now works. A
tab group opens, the built Studio serves from `vite preview` on 5173, loads
against a live API on 8787, renders its project list, and correctly reports
`Session expired. Sign in again.` for a token that predates the fresh data
directory. The console is clean — no errors and no warnings on load.

**That is as far as this can go without the owner.** Everything past that
screen is behind authentication, and entering a password or creating an account
through the browser is not something this assistant does. The three items
gated on the browser — the 360 panorama flow end to end, the live post-edit
render comparison, and human visual approval of the stairs — are now RUNNABLE
but each starts from a signed-in Studio, so they need the owner at the keyboard
for the sign-in step. The gate is open; the door still needs a person.

Both servers started for this were stopped and their data directories removed.

**2026-08-27 — title-aware frame ranking is MEASURED AND REFUSED, not pending.**

The previous entry left "ranking does not read the title" as the next real
piece of work, wanting the corpus in front of it before changing frame
selection. The corpus was surveyed. It argues the other way.

Across every accepted build on disk — 14 models covering the seven unique local
drawings plus their dwg/dxf pairs and two client uploads — the frame that
ranking picks is:

    Lower Ground Floor Plan     x2      FIRST FLOOR PLAN          x1
    Ground Floor Plan           x2      LOWER GROUND FLOOR PLAN   x1
    (untitled)                  x7      REVISED SITE PLAN         x1   <-- site

**Exactly one drawing picks a site-titled frame.** Everything else lands on a
proper floor-plan title or on an untitled frame, and all but three verify with
zero blocking findings.

So demoting a frame for its title would fire on one model in fourteen and would
be justified by a single sheet. That is the thing this file already warns
against in `ENVELOPE_COVERAGE_MIN`: one good example is not a sample to fit a
threshold to. Worse, the rule would be load-bearing on every drawing in the
corpus while being evidenced by one, and the failure it would introduce —
demoting a site frame that was genuinely the best available — is silent.

The one case is already handled without touching ranking. `fallback_frame_note`
says the pick was a wall-count fallback and names the alternatives as
`--frame N`; `openings-present` says the frame is a site layout and that the
finding is about frame choice rather than opening detection. Both were verified
end to end on that sheet.

**Closing this as decided rather than pending.** Reopen it only with a corpus
that has more than one instance — and note the survey method, because it
misled once: models under `work/enclosure-retry` are REFUSED retry artefacts,
not accepted builds, and including them made REDDY look like a second site-
titled pick when its accepted build picks an untitled 36.6 m frame and grades
OK. Filter that directory out of any corpus survey.

---

## 2026-08-28 — a pass over this whole file, and what is actually left

Session `aalev-22`. The instruction was "finish the pending list", so the first
job was working out what is still on it. **Three entries below were already
built** and one was wrong about which file has the defect. That is now the fifth
time this document has described finished work as pending, and the go-and-look
rule paid again — the cost of checking was minutes against days.

### Closed by measurement, not by building anything

| entry | where | what the tree says |
|---|---|---|
| `Space.boundedBy` "populated on none — **the biggest single unlock left in the engine**" | §1 correction 7 | **Populated.** `solve/spaces.py:223` sets `bounded_by`, line 76 serialises it as `boundedBy`, and `test_build.py` asserts a four-wall room is bounded by all four. Four consumers read it (`areas.py`, `codecheck.py`, `site.py`, `dwellings.py`). A grep for `boundedBy` "proves" it empty — the producer is Python and spells it `bounded_by`. |
| "walls are aggregate storey meshes, so **room-specific wall colours cannot stop at a doorway**" | §3, 2026-08-24 | **They stop at the doorway.** Reconstruction emits `storeyN_wall_roomM_<slug>` and `..._ceiling_...` per room — seen on the real villa as `storey0_wall_room0_home-office` — and `deckDesign.ts` dresses them through `roomSurfaceSlug(name, 'wall')`. Its own docstring: "its room skins are what stop one paint colour at the doorway." |
| "`solidify.py` **still builds a parapet full height**" | COORDINATION.md 19:0x | Wrong file and wrong direction. `solidify.py:165` SKIPS unpaired lines by design, and `PARAPET_HEIGHT` is 1.0 and applies to roofs. The real defect was the opposite one this file already described correctly — a balcony got *no* railing at all. Fixed below. |

### Built this session

**A balcony's edge is built to guard height** (`b50ce13`). `build_walls` skipped
every unpaired wall — right, because extruding one to ceiling height seals the
balcony and blacks out the rooms behind it; wrong, because "not full height" was
implemented as "no geometry", so the CAD path produced slabs three metres up
with nothing at the edge.

The room's **name** decides, not the line. Nothing local to an unpaired stroke
separates a balcony guard from a single-line wall, and this villa's exterior is
largely single-line walls. The vocabulary is imported from `quantify/areas.py`
(RERA's own list) rather than restated, so there is one definition of "balcony".

The guard that matters is against **coincidence**. 91% of the derived perimeter
ring sits on linework the architect drew, and a balcony's outer edge is exactly
where the ring runs — so the naive version puts a 1.0 m box inside a full-height
box, which is the z-fighting the black-pockets investigation spent days on.
Measured on `DOWN VILLA`, and **the guard is not vacuous**:

```
storey 0   1 guarded room (ENCLOSED BALCONY)   2 on edge   0 built, 2 already covered
storey 1   2 guarded rooms (DECK, DECK)        5 on edge   3 built, 2 already covered
```

Four of nine candidates rejected. `ENCLOSED BALCONY` getting zero is right for
the right reason — an enclosed balcony has real walls, so its edge was covered.

⚠ Two of the three railings come off layer `A5 FALSE CEILING`. That reads wrong
and is not: **layer names never decide, they pre-select**, and `A5 FALSE
CEILING` is a legitimately selected wall layer on this sheet. Recorded rather
than filtered, because filtering it by name would break a settled rule to fix
nothing.

`test_build.py` 153 → 168, with the negatives asserted as hard as the positive.

**Four harness defects, all of the "0 failed is not everything ran" family**
(`bb0ec21`):

1. **`test/referral-and-reset.mjs` could not fail.** Its `ok()` was a bare
   `console.log` — no counter, no summary, no exit code. 22 assertions that
   would have printed FAIL into a scrolling log and still exited 0. Found by
   counting, not by reading: it was the one file in that directory which never
   printed `N passed, M failed`, so the run's total came up short of the 485 on
   the board. That shortfall was the only signal it ever gave, and reading it
   required already knowing the total.
2. **`services/api`'s `test` was a 29-long `&&` chain**, so one crash removed 20
   files from the run. `test/run-all.mjs` now runs every file and reports
   ok / failed / blocked / **silent** per file — silent meaning "exited 0 and
   asserted nothing", which is its own answer and not a pass. It also diffs its
   list against what is on disk, because a test nobody runs is the same defect
   in a different hat.
3. **`js:api` and `js:web-linkcheck` reported FAILED with no server running.**
   They drive a server rather than booting one, and `docs/validation.md` never
   said so — so `npm run validate` on a clean checkout showed two red lines that
   no code change could fix. They are BLOCKED now, naming the origin and the
   command that starts one.
4. **`npm run dev:detect` never loaded `.env`.** It called uvicorn directly, and
   uvicorn reads only `os.environ` — so the command everyone types started the
   detector with no `FLOORPLAN_MODEL` and no `NVIDIA_API_KEY`: trained
   classifier off, adjudicator degraded, both silent. That is exactly the state
   `aalev-d0` documented, reachable straight from the package script. It now
   runs `tools/dev-detect.ps1`. The old command is **not** kept under another
   name — a quiet path back to the broken state is the thing being removed.

### ⚠ Two API "failures" that were not real

A second process bound `:8787` mid-run. Windows lets a second binder win
quietly, and the hazard `dev-detect.ps1` documents for `:8090` is not
uvicorn-specific. `bake` reported **17 passed / 11 failed** and `access-code`
**24 / 2**; against a verified single A:-tree listener the same two files are
**28 / 0** and **26 / 0**. Nothing was broken.

**Before believing any API result, check the listener count and which tree it
is**, not merely that something answers:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
curl :8787/cad/health     # 200 + an A:\ python path = A: tree.  404 = the C: copy.
```

### The trained model is integrated, and /health proves it rather than naming it

Verified before anything else was touched, because §1 correction 0 says to:

```
classifier.state       ready
path                   A:/Tools/FloorplanModel/kaggle/result6/p2/runs/floorplan_segment.onnx
trained_from           kaggle rayanamal/arcvia-p2-finetune v6, 2026-08-27,
                       mIoU 0.8009, beats live product 4/5 markups
classes 44 · input 512 · normalisation declared
adjudicator            openai:gpt-5.5
adjudicator_liveness   unverified: no vision call since this service started
```

`FLOORPLAN_MODEL` lives in `.env` now — it used to exist only in one shell's
environment, one restart from gone. `adjudicator_liveness` reading `unverified`
rather than green is the honest answer and should stay that way: naming a model
is not reaching it.

### Corpus: the report was 8,661 rows behind itself

`reports/CORPUS.md` said 19,803 rows across 97 sources, generated 08-26. The
manifest held **28,464** across **98**, and the `bim` category had gone 63 →
8,575. Regenerated (R5 — announced on the board first), along with `CREDITS.md`.

**Report the quantity, not just the status (R6):**

```
28,464 rows · 98 sources · 6,766.5 MB
commercially trainable  20,959 (74%)      <- was 18,210 (92%) at 19,803 rows
credits                 7,495 attributed across 46 sources, 859 share-alike,
                        0 unattributable
verify_claims           14/14 hold; negative controls 11 caught, 0 missed
verify_corpus           9,400 on-disk artifacts, 9,383 ok + 17 ok_repo, 0 bad
```

⚠ **The trainable share fell 92% → 74% and that is not a regression.** The BIM
harvest added rows that are correctly bucketed `quarantine`. A share is a ratio
and its denominator moved; quoting the fall as a loss would be the same error
this file records about one-way metrics. The absolute trainable count **rose**,
18,210 → 20,959.

`verify_corpus` finding zero bad artifacts is worth stating plainly: the
2026-08-27 concurrent-writer clobber — where the manifest went on describing a
41.3 MB PDF that no longer existed — does not reproduce anywhere in the tree.

### What is genuinely still open

Ordered by whether anyone can act on it today.

**1. Three items need the owner at a keyboard, and only for the sign-in step.**
The 360 panorama flow end to end, the live post-edit render comparison, and
human visual approval of the stairs. The browser runtime works now — the
error-1344 sandbox failure is gone — but everything past the sign-in screen is
behind authentication, and entering a password or creating an account is not
something this assistant does. **The gate is open; the door still needs a
person.**

**2. The window question cannot be settled with what exists.** `realdecks/`
holds ONE annotated image carrying five numbered failures, and its assertion for
the missing window is "at least one Window opening detected on the exterior wall
at (4)" — a recall floor of one, at one location, with the real windows never
enumerated. There is no denominator, so precision was never measurable there,
and doubling a count against a metric that cannot see false positives looks like
an improvement *by construction*. What would settle it is an enumerated list of
the real window openings on that elevation. Not another pass count.
`ADJUDICATE_WINDOW_PASSES` stays at 1.

**3. A site sheet needs treating as a site containing buildings.** Visual QA
rejects both completed site models and verification correctly blocks them. The
recorded next step is to model a site as containing individual buildings rather
than to weaken the building gates — and the temptation is the second, because it
is one constant. Do not.

**4. The furniture-drop half stays unbuilt, deliberately.** The wall-share
distribution is a continuum, not two populations; three samplers were swept and
the ambiguous middle never collapses (13–18 of 55). A threshold there is a
policy decision about ~15 walls, and a dropped wall costs windows.

**5. Not this session's, and left alone on purpose:** ~23 uncommitted files
under `apps/studio/src/bim/**`, `apps/studio/src/plan/**` and `apps/web/**` —
IFC import work, last edited 02:15, green in the suites but mid-flight and
somebody else's. **Do not sweep them into a commit.** Use
`git commit -F <msg> -- <paths>`, never a bare `git commit`.

### Green at the end of this session, with all three services up

```
api      507 assertions · 29 files · 29 ok, 0 failed, 0 blocked, 0 silent
studio   867 (34 files) · brand 23 · asset-ingest + atlas green
types      5 suites · python 30 suites / 982 assertions · bim 1 · build 4
```

The api figure is 507 rather than the board's 485 because 22 assertions in
`referral-and-reset.mjs` were never counted before, and `detect.mjs` runs 32
with the detector up against 19 without it. Both differences are the harness
telling the truth, not new tests.

### 2026-08-28 (later) — the detector's last open item, and it refuted itself

`A:\Tools\FloorplanModel\HANDOFF-P2.md` §6 carried one actionable item:
*"Full-resolution re-verification of the hybrid numbers (mine were capped at
maxdim=768 on a box with 1.9 GB free)."* The box now has 11.5 GB commit free, so
it ran. Full write-up is in that file; the part Arcvia needs:

**Resolution is not a neutral parameter for this model.** Same live run, same
`result6` weights, only `HYBRID_MAXDIM` changed:

```
                              maxdim=768        full (1356)
model verdicts   railing              2                  0
                 dropped_furniture    4                  0
recall control   foyer/lift edge  33.03%             59.46%     (live: 58.99%)
```

**At 768 the hybrid destroys a real wall** — a designated recall control drops 26
points. At full resolution it does not. The furniture-drop benefit recorded at
768 arrived bundled with a recall loss the markup table cannot show, because that
table only measures where wall density *should* fall.

**But "so use full resolution" does not follow.** `hybrid.py` feeds the net the
image at the capped size (rounded to a multiple of 64) and the net is fully
convolutional, so `maxdim` silently changes the scale at which the model sees a
wall. The weights declare `train_crop: 512`; a 768×1344 input is ~2.6× off that,
and "railings and furniture stop being recognised" is what an off-scale FCN does.
Two instruments, neither of them privileged.

**The consequence for this repo: the hybrid table cannot speak about the shipped
pass either way.** `services/floorplan-ai/segment.py:380` resizes the whole
drawing to **512 × 512 square** — a third scale, and the only one that distorts
aspect ratio (this deck is 814 × 1356, squashed 1.66× on one axis).
`hybrid.py` preserves aspect at every setting. Nothing measured here touched
production.

**So: `segment.py` is NOT changed, and should not be on this evidence.** Two
things follow that are worth carrying:

1. **The furniture-drop half stays unbuilt, now for two independent reasons.**
   The existing one is that the wall-share distribution is a continuum. The new
   one is that at n=1 the drop cost 26 points of recall on a control wall — and
   a dropped wall costs windows, because the window pass is gated on wall recall.
2. **§6's recorded table has a live baseline that is not on disk.** It reports
   "51 walls in, 10 dropped as furniture"; all three saved live runs have **37**
   and reproduce only one of its five rows. `MASTER bed` reads 0.0000 in the
   *live* run here, so its "hybrid 24.9×" was measured against something nobody
   can re-run. Treat that table as unreproducible until its baseline is restored.

The well-posed replacement task, for whoever picks this up: score the **shipped**
pass on this deck at its production geometry against the owner's five annotated
markups, **with the recall controls reported alongside** — the markup table alone
cannot see a destroyed wall. That is a different job from "re-verify at full
resolution", and it is the one worth doing.

n=1 deck. The recall-control movement is a two-sided observation on a specific
known wall, which is why it is quoted; the markup ratios are not and are not.

### 2026-08-28 (later still) — the three "browser-gated" items were never gated on sign-in

`aalev-22`. This file has said for two sessions that the 360 panorama flow, the
live post-edit render comparison and human visual approval of the stairs each
"need the owner at the keyboard for the sign-in step". **That was wrong, twice
over.**

**1. There was nothing to sign in to.** Opening `localhost:5173` loaded straight
into the project list as the owner's account. The earlier "Session expired. Sign
in again." was measured against a **fresh, empty data directory that session had
created for testing** — a correct answer about the wrong database. Against the
real `.data/db.json` the token is valid. A blocker inferred from a disposable
fixture, carried in this file as a fact about the product.

**2. The real gate was that no local render could run at all.** The panorama job
died with `Blender failed to run: spawn blender ENOENT`. Immediate cause was
mine — an API started with a bare `node src/server.js` instead of the
`--env-file-if-exists` form, so `.env` was never read and `BLENDER_PATH` was
unset. The underlying gap was real and is fixed in `713e126`: `renderQueue`
warned at boot about a missing render SCRIPT and said nothing about an
unreachable BINARY, so the fault surfaced one dead job at a time, as a Node
errno naming neither the setting nor the file.

**Item 1 is now DONE, not blocked.** Studio → API → Blender → storage, verified
on the artefact rather than on the status: **4096×2048, confirmed 2:1
equirectangular, 7.3 MB, mean brightness 122.1** — neither black nor blown.
Wall-clock about 80 s on this CPU-only box for an 11-object, 1,094-triangle IFC
import.

**Items 2 and 3 are unblocked and not yet run.** Both need a scene and a render,
and both now have a working local Blender. Neither needs a person.

**Refunds held, unprompted.** They were not what was under test: the failed
panorama returned all 8 credits and a failed bake all 25, `settled: true`,
`reason: render-failed`; the successful panorama has no refund. That is the
idempotent settlement module doing its job on a real failure nobody staged.

**The IFC import committed in `90d0fe1` renders in the browser** — 6 storeys,
11 objects, 1,094 triangles, `web-ifc` wasm loaded, no console errors.

⚠ **Lesson worth keeping, because it is the third instance in this file.** A
limitation measured against a test fixture was written down as a limitation of
the product. Trap 4 already says *"verify on the right input"* about a weaker
vision model reading floor plans as renders; this is the same error committed
against a database instead of an image. **Before recording something as blocked,
check what it was blocked against.**

### 2026-08-28 — items 2 and 3 are run. All three are now closed.

`aalev-22`, immediately after establishing that none of the three was gated on
sign-in.

**Item 2 — live post-edit render comparison: PASSES, and it is two-sided.**

One variable, everything else pinned: same model, same scene, same `isometric`
preset, same `cgi` style, and the SAME camera passed verbatim to both jobs. The
only change between them is one `PATCH /scenes/:id` setting `hdriUrl` to
`/env/golden-hour.hdr`.

The edit reaches the render at both levels that matter:

```
job spec   BEFORE  hdriUrl = null
           AFTER   hdriUrl = ...\apps\studio\public\env\golden-hour.hdr

pixels     BEFORE  mean 238.5   blown 9.51%   black 0.00%
           AFTER   mean 186.0   blown 0.00%   black 0.00%
           100.00% of pixels differ by more than 8/255; mean abs diff 51.37
           sha256 differs
```

**Why both halves are asserted.** "The images differ" on its own is also
satisfied by a renderer that is broken in a new way each run, so validity is
checked too: neither frame is black, and the blown fraction goes 9.51% -> 0.00%,
which is the direction a real HDRI replacing an over-bright default sky should
move it. A difference between two frames only means something once both frames
are known to be pictures.

⚠ **One observation NOT dressed up as a result.** BGR means move
[248.3, 240.1, 231.8] -> [203.0, 188.5, 174.6], i.e. very slightly *cooler*. For
an HDRI called "golden hour" that is not the naive expectation. The exposure drop
and the blown-fraction collapse are consistent with real IBL replacing a
synthetic sky, but the colour direction was not investigated and no claim is made
about it. Someone reading this later should treat it as an open question about
the environment, not as evidence the pipeline is wrong.

*Two harness bugs found on the way, both mine and both the same shape as the ones
this file already collects.* `POST /render/jobs` answers `jobId`, not `id`;
reading `id` gave `undefined` and the poller sat on `/render/jobs/undefined` for
the full ten-minute timeout while the real job completed — **a poll loop that
cannot tell "not finished" from "not a job" waits exactly as long for both.** And
`POST /scenes` does not accept `modelUrl`; the model is attached by PATCH, and
the API's 409 "Save the scene before rendering it." is the correct refusal.

**Item 3 — stair geometry: rendered, measured, and now yours to approve.**

`DOWN VILLA` reconstructs to the documented stair exactly:

```
type dog-leg-u   source measured-riser-lines   risers [9, 9]
going 0.300 m    flight widths 1.169 / 1.153 m  gap 0.079 m
landing depth 1.200 m   landing height -1.500 m
```

Measured off the MESH rather than off the report — the two can disagree, and on
this engine they have: `storey0_stair_marked_riser_core` is **3.900 x 2.400 m
with a rise of exactly 3.000 m**, matching the drawing's measured opening and the
-3.0 -> 0.0 m storey span.

⚠ **The product's own isometric cannot show a stair, and that is worth knowing
before someone tries again.** The shipped isometric suppresses CEILINGS, which is
right for a room. A stair is the one element living BETWEEN two storeys, so what
occludes it is the upper storey's FLOOR SLAB, and nothing in the view solver
removes that. Three close isometrics aimed at the stair core rendered the outside
of a slab. The renders that answer the question keep the stair mesh and drop the
other 142 (`.runtime-logs/stair_view.py`, a diagnostic, not a product path).

**Approval is still the owner's** — the geometry is now visible and dimensioned,
which is all a session can do. Winders, spirals, L and three-flight stairs,
irregular wells, railings, strings, soffits and headroom remain unbuilt, as
recorded.

*The frame-validity gate earned its keep unprompted:* of three stair close-ups it
passed two and stamped the third `ARCVIA_SUSPECT: 73% blown out`. That check was
added for renders nobody would look at; here it correctly flagged one a human was
about to look at.
