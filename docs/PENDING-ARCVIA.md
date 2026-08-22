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

  > **Stage and commit in ONE step, or skip the index entirely:**
  > `git commit -- <paths>` with nothing staged.

  `git commit -- <paths>` commits only those paths and leaves the index alone.
  And **do not rebase to tidy an attribution mistake** — putting real work at
  risk to fix whose name is on a commit is a bad trade. Record it and move on.
- **Report what you refuted, not just what you found.** Two of today's
  hypotheses were killed by measurement and telling the other sessions saved
  them the same dead ends. A well-measured negative is a real result.

---

## 1. Who owns what, as of 2026-08-22

| Area | Session |
|---|---|
| `solve/frames.py` | aalev-35 |
| `services/floorplan-ai/` PDF backends | aalev-35 |
| `hypothesise/`, `solve/{verify,spaces,clearance}.py`, `render/` | aalev-f3 |
| `quantify/`, `apps/studio`, API routes, `floorplan-ai` generally | aalev-51 |
| `tools/asset-ingest/`, the asset curation | aalev-1b |
| **Everything in §3 below** | **nobody** |

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

Estimated 10–14 days. It is the largest single unlock in the product and it is
now unblocked.

---

## 3. Untouched by any current session — start here

Ordered by value per day, which is not the same as by size.

### Quick wins, genuinely quick

| Task | Est. | Note |
|---|---|---|
| `pricing.astro` is hand-maintained | 1 d | Generate it from `creditCost`. A price list that drifts from what the code charges is a support ticket and possibly a refund. |
| `scenes.js` allow-list **silently drops** unknown fields | 1 d | It should reject. Silent field-dropping is the same failure class as everything else that has bitten this repo today. |
| Idempotency on submit | 1 d | A double-clicked submit currently bills twice. |
| Room area schedule | 1 d | A report over `building.json`. The data is all there. |
| Door / window schedule | 1–2 d | Same. |

### Highest value per day in the whole product

**`A:\Assets\Hub` is unwired — 3–5 d.** There is a `/asset-hub` skill for it.

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

**Poché is not the studio's front door — 2–3 d.** The thing that differentiates
Arcvia from every image-generator competitor cannot be reached from the product.
The studio's GLB-import project start was never finished, and Poché emits GLBs.
Both ends are small; nobody has joined them.

**Lightmap bake has no UI — 3–4 d.** API and worker both already exist.

### The Validate stage — nothing in it exists at all

Clearance checking is the notable one: **the furniture catalogue is dimensioned
specifically for it and nothing uses those dimensions.** 4–6 d.

Then sun path / shadow study (4–6 d), code checks — min room, corridor, egress
(8–12 d), and daylight factor (6–8 d).

⚠ **Daylight factor needs reference values before it is built, not after.** It
was deferred once for exactly this reason and then asked for anyway. A daylight
number that has never been checked against a known-correct case is a liability
in a document an architect will sign. Find validation data first; if none can be
found, say so and build something else.

### Deliver — the biggest gap between "works" and "sellable"

Publisher app (15–20 d) · configurator, object and material switching (8–12 d) ·
client comments (5–7 d) · per-scene branding (2–3 d) · PDF summary of chosen
options (3–4 d).

### Operations

Queue persistence (2–3 d) · per-preset queue lanes (1–2 d).

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

Two things found while measuring, both open at the time of writing:

- **Three of the six styles do not render.** `cad` and `sketch` die at
  `arcvia_style.py:139` — `FreestyleLineSet.crease_angle` no longer exists in
  Blender 5; it moved to `view_layer.freestyle_settings.crease_angle`. That is a
  fifth instance of the same API-break family as the four already recorded on
  the AOV path. `raw` renders but produces a flat near-white frame with no
  structure — possibly correct, since it is emission-based and emission ignores
  facing, but it is not legible on its own.
- **Blender exits 0 on a Python traceback.** A render that crashed is
  indistinguishable from one that worked by return code alone.
  `renderQueue.js:332` is already guarded — it requires `code === 0 && outputPath`,
  so a total failure is caught. The **multi-view path is not**: `render_views.py`
  prints `ARCVIA_DONE:n/n`, the queue captures it into `markers`, and nothing
  compares the two numbers. A 22-view run where two views die exits 0, publishes
  the ones that worked, and is marked `done` at 100% with the evidence of
  incompleteness sitting unread in the job record.

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

  **The live hypothesis, not yet confirmed:** `fit_of` grades a layer set
  *without* `add_perimeter`, while the pipeline builds *with* it. A set that
  encloses badly on its own can enclose well once the envelope ring is added,
  and the objective would never see it. That is the shared-basis trap one level
  up — two measurements of the same quantity must share a basis, not just a
  band. Confirm by running `fit_of` with and without the perimeter on this
  frame before changing anything.

  Ownership: `solve/layerscan.py` is unclaimed. Note it is genuinely
  load-bearing — `Fit.score` deliberately excludes raw room count, and its
  docstring records the measurement that settled that. Do not "fix" it by
  adding room count back.

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

13. **`apps/studio/dist` is an untracked local build** — gitignored, not in
   `git ls-files` — and it still swamps a repo-wide grep with the whole three.js
   bundle. Search `src` only. (Do not go looking for it in git and conclude this
   note is stale; the directory is real, it is just not tracked.)
