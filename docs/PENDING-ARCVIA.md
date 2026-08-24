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
on different floors are NOT an overlap; egress runs only on the entry storey,
with the others skipped in coverage saying "stairs are not modelled" — never
silently). Openings re-host by index offset in the concatenated view, or
every upstairs door lands on a ground-floor wall. **On the villa the bill
went from ₹957,376 to ₹1,985,270 — the old bill priced half the building.**
`test/test_multistorey.py`, 17 assertions; the full engine suite is 531
green.

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
reachability on the primary storey's door graph; stairs are not modelled, and
a storey with no exterior door says so rather than guessing.

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
`services/api/src/lib/credits.js:109` (credit enforcement). The user has said
they will decide these last. **Do not implement them on your own judgement** —
they are policy, and one of them decides when a site office gets logged out.

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
- **6 of 18 doors unhosted** on the villa. Not a tolerance problem: the gap
  distribution is bimodal (hosted at 0.02 m, lost at 7–13 m). Those walls do not
  exist in the model.
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

- **Frame *selection* is still manual.** Splitting is solved; choosing the right
  frame is not. `frames[0]` is whichever cluster has the most wall segments, and
  on a 37-frame sheet that is a guess — worse, dense elevation linework outranks
  a sparse floor plan, which is the same mistake layer selection already learned
  to avoid ("optimise named rooms, not room count"). 3–5 d, aalev-35's lane.
  Note the ranking key is load-bearing: on the villa the compound wall is 8
  walls over 28 m and correctly ranks last *because* count is primary, so
  ranking by area or length is not the fix.
- **~44% wall pairing** on the villa. Some are genuinely single lines — railings,
  jali, compound walls — but not all of them.

- **`solve/layerscan.py` picks the wrong layers for the villa's ground floor**,
  and its own objective disagrees with its own outcome. Found 2026-08-22,
  measured, unfixed. On frame 1 (`Ground Floor Plan`, bbox
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
