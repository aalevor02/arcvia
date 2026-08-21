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

⚠ **The "~1 min/frame" figure that used to be here was never measured, and it is
wrong.** Measured 2026-08-22 on the m11 villa (2,076 tri, Blender 5.1.2, 16
threads, CPU): `fast` (32 samples, 1280×720) renders an isometric in **15–19 s
wall-clock including Blender startup and glTF import** — photoreal 19.3 s, cgi
15.2 s, clay 15.7 s. That is 4–5× faster than the figure every wall-clock
estimate on the roadmap derives from.

**Do not re-plan on this yet.** It is one model at one tier, and 2,076 triangles
is small. `standard` is 128 samples at 1920×1080 and `ultra` is 512 at
2560×1440 — 16× the samples and 4× the pixels of `fast` — and those have not
been measured. A full pass is ~22 usable views of 29 (`--skip-tight` defaults
true).

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
per-asset failures. Ideal for a session that can babysit it.

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
- **`LATEST DRAWINGS` yields only small rooms**, and frame selection is still
  manual. `solve/frames.py` splits sheets correctly now, but choosing the *right*
  frame needs a human and gets it wrong on that file. 3–5 d. aalev-35's lane.
- **~44% wall pairing** on the villa. Some are genuinely single lines — railings,
  jali, compound walls — but not all of them.

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
