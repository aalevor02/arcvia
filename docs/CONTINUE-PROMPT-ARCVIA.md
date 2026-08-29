# Arcvia continuation prompt

You are continuing work in `A:\Web\Arcvia`. Preserve all existing uncommitted
changes. Do not reset or cherry-pick blindly.

## Current objective

Turn architect PDF/CAD inputs plus presentation renders into a faithful,
publishable 3D walkthrough containing measured building geometry, room finishes,
furniture, lawn, pool, lighting, and reviewable unresolved items.

## Completed before this handoff

- Per-room floor, wall-finish, and underside ceiling meshes are emitted by the
  reconstruction pipeline. The real villa rebuild verified 121 GLB meshes, 45
  floors/site meshes, 35 room walls, and 35 room ceilings with zero blocking
  verification findings.
- Render design persistence, re-dressing after edits/reloads, render furniture
  review, reviewer-selected wall/ceiling attachment targets, and
  publish/export/still-render parity are wired.
- Automatic frame ranking is available under `--auto-layers`; explicit frame
  selection remains supported.
- Session policy is decided and implemented: 12-hour idle / 30-day absolute.
- Credit policy is decided and implemented: hold queueable work; hard-block
  non-queueable work when credits are unavailable.

## Latest change

**A rejected build could publish itself as a clean pass, and a site sheet now
names its buildings.** Both 2026-08-26.

`cli.py` runs a second, layer-re-seeded reconstruct when a build blocks, and
`enclosure_retry_improves()` decides which one to keep. The guard was correct
and refused the bad retry; it was defeated anyway, because `reconstruct()`
writes the model and the GLB itself and both builds wrote to the same `--out`.
On `PLANS_FOR_3D` the console printed 106 walls / 28 rooms / BLOCKED while the
file on disk held 4 walls / 1 room / 2.49 m2 and `"ok": true`. The API reads
that file and never sees stdout, so the more broken the drawing, the smaller
and tidier the model it shipped to a viewer — the failure magnitude is
inverted, and a monitor watching for failed builds would never have seen it. A
trial build now goes to `work/enclosure-retry` and only a decision promotes it;
a refused retry and a failed re-seed both say so instead of vanishing.

`solve/site.py` separates the buildings on a site — the third scale of
separation in this engine, after drawings on a sheet (`frames.py`, by
emptiness) and dwellings in a building (`dwellings.py`, by the door graph).
Its criterion is topological and has nothing to tune: the rooms of one building
tile and so share bounding walls, while two villas on a plot share none.
`verify.check()` BLOCKS on two or more buildings and names each, reports INFO
on one, and `--building N` rebuilds a single building by narrowing the wall
list and re-solving. Four real drawings that pass today each return exactly one
building; `SITE PLAN FOR 3D` returns six plus 3,503.8 m of linework that bounds
no room. `--building` refuses a multi-storey stack, because the numbering is
per frame. Full detail and the honest limits are in `PENDING-ARCVIA.md`.


Physical stair recovery now includes straight and dog-leg/U layouts. The first
path uses explicitly named, registered stair-room footprints. A second,
conservative path reads paired regular riser-line runs only when the lower plan
also has `UP`, the registered upper plan has matching risers plus `DOWN`, and a
measured landing edge closes a unique core. On the Casa Altinho villa this
recovers a measured 9+9 dog-leg: 0.300 m going, 1.169/1.153 m flight widths,
0.079 m gap, 1.200 m landing depth, and a 3.900 x 2.400 m opening. Partial room
caps are triangulated around that measured opening. Opposing direction and the
tread solids remain explicitly assumed. `building.json.stairs` records layout,
vertical openings, removed caps, assumptions, label-path refusals, and source.
Stair surfaces are `floor_stair / assumed`; upper-floor egress still uses named
aligned stair rooms and real doors.
Ambiguous one-to-many or many-to-one stair-room matches refuse instead of
selecting a core by overlap.

Focused stair/GLB geometry passes 93/93; multi-storey passes 21/21; the full
reconstruction suite passes 874 assertions across 24 scripts. A real `--storeys`
rebuild of `DOWN VILLA -WD 22-1-24.dxf` was run on 2026-08-26 and emits
`storey0_stair_marked_riser_core`: 456 vertices / 228 triangles spanning the
exact -3.0 m to 0.0 m storey elevations. The full GLB has 6,255 triangles and
13,855 vertices. Blender 5.1 imported all 143 meshes and completed a 1280x720
isometric validation render with 221 tones and no frame warning; denoising was
disabled after OpenImageDenoise exhausted host memory. Direct visual inspection
through the in-app browser remains unavailable under the current Windows sandbox,
so do not describe this as a human visual approval. Of the seven local DXFs,
`ALL PLANS` remains ambiguous/repeated-floor evidence and the Reddy site plan
remains a blocked single garden-level build; neither was coerced into a stair.
Winders, spiral/L/three-flight stairs, irregular wells, railings/guards,
strings/soffits, headroom, and structural stair design remain unbuilt.

The 360 panorama delivery path is implemented across the API, Blender worker,
pricing, Studio, public walkthrough, and shared viewer package. The `panorama`
preset queues a 4096×2048, 64-sample equirectangular render for 8 credits on the
heavy lane. Successful output persists as `scene.panoramaUrl`; Studio can
preview, reopen, and remove it, and a later still render does not hide it. The
published walkthrough loads the same panorama on demand, withholds it on
protected scenes until access-code unlock, and removes **View 360** when Studio
clears the field. Studio and web share the disposable Three.js
`PanoramaViewer` implementation.

A real asymmetric colour-coded GLB rendered successfully through Blender 5.1
on CPU at 512×256 and one sample. The seam averaged 0.58 RGB difference and the
frame contained distinct red, green, and blue regions. This proves the worker's
equirectangular path, not the full 4096×2048 64-sample production cost.

The post-restart browser-control retry on 2026-08-25 still failed before launch
with `SetTokenInformation(TokenDefaultDacl) failed: 1344`. No browser panorama
flow is claimed. Do not substitute another browser automation surface; retry
the required in-app browser runtime only after the Windows sandbox fault is
fixed.

The first CAD-review slice is also built. Reconstruction jobs already carried
`verifyChecks`, but Studio ignored them and opened the model immediately. The
typed import flow now pauses successful jobs that contain warning or blocking
findings, shows the exact verifier messages plus model facts, and requires an
explicit **Use reconstruction** decision. Informational measurements remain
inspectable without interrupting clean imports. This is not the full M5 solver:
choice patches, re-solve, and persistent `ModelPatch` replay remain unbuilt.

The initial review integration passed 43/43 and delivered seven checks. A later
layer-selection correction brings the real villa API seam to 49/49 with zero
warnings; focused reconstruction passes 144/144. Focused review logic passed
7/7; the full Studio suite, strict TypeScript, and production build passed.

The preceding OpenAI vision milestone remains available:

OpenAI vision is now live-tested behind process-wide spend guardrails. The
bounded evaluator made exactly 3 calls (2,287 total tokens) across one real
bedroom render and one complete annotated plan. The provider/image/structured
contracts work, but the accuracy verdict is **partial**: the render inventory
and wall palette were useful while the floor was misread as wood instead of
carpet; the one-crop plan cap corrected one false enclosure and found three
windows but could not inspect all five annotated defect groups. See
`docs/OPENAI-VISION-EVAL-2026-08-25.md`. The floor prompt was tightened without
spending another call. Do not raise production limits until the bounded model
comparison in that report passes.

The credential was process-scoped and removed after the run. It was never
written to the repo or environment. Because it was pasted into chat, rotate it.

The preceding Studio milestone remains complete:

The reviewed Asset Hub flow now supports floor, wall, and ceiling templates.
Wall and ceiling choices require the reviewer to select a specific measured
room face or in-room ceiling point; in-wall templates remain blocked because
they require a real opening. Preview, isometric, and full stills now capture and
persist the current dressed/furnished editor model before the render job is
queued. A baked scene deliberately keeps its bake-time model because its atlas
depends on that exact mesh/UV layout.

The preceding provider change remains available:

`services/floorplan-ai/adjudicate.py` now supports an OpenAI-compatible vision
provider as well as NVIDIA. Configure the Python service, never the browser:

```powershell
$env:FLOORPLAN_AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'server-secret'
# optional: $env:OPENAI_VISION_MODEL = 'gpt-4.1-mini'
```

With `FLOORPLAN_AI_PROVIDER=auto`, OpenAI is selected only when no NVIDIA key
is present. The reader remains fail-open without a key. Exact dimensions,
coordinates, walls, and final geometry remain deterministic CAD responsibilities.

## Verification already run

- Python compilation for `adjudicate.py` and `main.py`: passed.
- No-network OpenAI provider-selection smoke test: passed.
- Mocked OpenAI-compatible response contract (`test/test_adjudicate.py`): passed.
- Current Studio verification: 800 assertions passed; strict TypeScript passed;
  Studio production build passed; `git diff --check` passed.
- Floorplan AI verification: provider budget contract passed; deck suite 27/27;
  label suite 21/21; Python compilation passed; bounded live run completed.
- Previous cross-service verification: reconstruction suite 554 assertions
  passed; full API suite passed, including the 17-assertion Hub contract.
- Panorama verification: brand pricing 23/23; isolated API render 28/28; queue
  lanes 10/10; scene patch 35/35; access-code integration 26/26; Studio strict
  TypeScript and production build passed; web Astro check and production build
  passed; real low-resolution Blender panorama passed.

## Next work

1. Retry the required browser-control runtime after the Windows error 1344 is
   fixed, then run the complete panorama flow: Studio render, drag/zoom,
   persistence after reload, later-still coexistence, publish, clean-context
   public viewing, access-code withholding/unlock, and removal parity.
2. Run a real preview/isometric/full render after an editor change and visually
   compare all three outputs with the editor. The saved-model seam is covered
   by automated tests, but no live post-edit image comparison is claimed.
3. Continue M5 from the warning-review slice into solver-provided choices,
   re-solve, and persistent patches once the required drawing corpus exists.
   CAD fidelity advanced: the villa now selects `A1 WALLS HIDDEN`,
   `A5 FALSE CEILING`, and `A7 COMPOUND WALL`; builds 148 walls / 21 rooms /
   260.09 m²; hosts all four openings; and passes wall-run verification at
   1.263 m/m² with zero warnings. Only seven unique local drawings exist, not
   the required twelve. Four completed the 2026-08-25 production-path corpus
   run; three dense site sheets exceeded a 15-minute cutoff. The fused
   `ALL PLANS` winner is now rejected: the validated result is one compact
   `FIRST FLOOR PLAN` with 77 walls, 6 rooms / 5 named, 46.53 m², four hosted
   doors, and zero verifier warnings or blocks. One shared DXF document plus an
   audited strict-read fast path (full recovery remains the fallback) cut the
   unprofiled `PLANS_FOR_3D` path from 15.572 s to 9.091 s and `ALL PLANS`
   from 273.42 s to 174.90 s, with identical results. Four-thread candidate
   fitting regressed the large sheet to 279.97 s and was reverted. Candidate
   preflight now rejects enclosing/fused frames, semantic non-wall layers, and
   large unknown layers with less than 10% paired coverage. `ALL PLANS` fell
   again to 110.09 s; `LATEST DRAWINGS` now finishes in 240.06 s; and
   `SITE PLAN FOR 3D` now finishes in 646.84 s instead of exceeding 15 minutes.
   `SITE PLAN WITH GARDEN LEVELS` finishes in 5.67 s, while its same-code
   large-unknown control still exceeded 15 minutes; do not claim model
   equivalence because the control never completed. The CLI enclosure retry is
   now guarded against scale changes and room/name evidence regression; the real
   `PLANS_FOR_3D` CLI replay retains measured metres and its 106-wall / 28-room
   model. Focused tests pass 153/153 and ranking/pruning/retry tests pass 22/22.

   Visual QA is complete and rejects both dense site models as corpus truth.
   `SITE PLAN FOR 3D` renders as a small central villa cluster overwhelmed by a
   577.13 m unpaired `A1 WALLS` diagonal and large layer-`0` rectangles; its
   833.28 m span, broken envelope, separated room groups, and zero openings are
   correctly blocked/warned. `SITE PLAN WITH GARDEN LEVELS` renders only two
   tiny fragments: 8 walls / 0 rooms across 3.72 m at scale 0.01 despite 252
   room labels, and is correctly blocked. Do not accept either quantity set.

   The garden unit review is now actionable without lowering the global
   confidence threshold. Walls prefer metres 13 pairs to feet's 5, but the
   2.6x margin remains an honest ask below the 3x decision threshold. The
   zero-room blocking finding names metres/scale 1 before layer review. A
   forced-metre control completes in 16.06 s with 142 walls, 20 rooms / 16
   named, and 122.98 m2, but remains blocked for zero openings and warns on
   wall run, envelope coverage, and separated room groups. Tests pass 153/153
   plus 24/24 focused ranking/pruning/retry/unit-guidance assertions.

   ✅ DONE 2026-08-26. The other sheet is now encoded as a site containing
   individual buildings: `solve/site.py` separates them by shared-wall
   topology, `site-scope` BLOCKS at two or more named buildings, and
   `--building N` rebuilds one — 833.28 m span becomes 50.39 m, 2 blocking + 3
   warnings become 1 + 0. No gate was weakened; the sheet now reports MORE
   blocking findings than before, not fewer.

   Still open on that sheet, and it is a FRAME question rather than a site one:
   ranking picks frame 0, `REVISED SITE PLAN`, because every candidate errors
   and the fallback is the wall-count incumbent. Frame 2 builds a model that
   PASSES with 15 hosted doors. Both facts are now reported — the framing note
   names the rejected candidates as `--frame N`, and `openings-present` says
   the frame is a site layout — but ranking itself does not read the title, and
   wiring it in would change frame selection on every drawing in the corpus.
   That wants the full seven-drawing run in front of it, not one sheet.

   The garden sheet also still needs opening recovery and frame separation
   after a reviewer confirms metres.
4. The real villa now emits a measured-riser dog-leg and has structural plus
   Blender render validation. Complete human visual approval when the in-app
   browser/runtime no longer fails with Windows error 1344. Next recover winders
   or L/three-flight forms only when their marks prove them. Railings/guards,
   headroom and structural stair detailing remain separate work. Roof geometry
   already has an opt-in flat-RCC fallback; pitched-roof form recovery remains
   unbuilt.
5. ✅ The weekly construction-rate refresh is scheduled for Mondays at 09:00
   and was executed end to end on 2026-08-26. The original batch wrapper falsely
   returned success without running Python because UTF-8 comments were misparsed
   by `cmd.exe` and its log path was relative to the wrong directory. The wrapper
   is now ASCII-safe, resolves paths from `%~dp0`, logs under repository-root
   `data/rates`, and propagates the Python exit code. The live run reached every
   configured source: 28 same-date rows confirmed, 0 unreachable, 171 refused.
   Three timber rows exposed a second defect: an older 2026-08-06 page could
   replace a newer 2026-08-12 library row when the price stayed inside
   `TRUST_BAND`. `quantify/refresh.py` now refuses any backwards date; the three
   rows were restored and the guarded scheduled rerun finished with Last Result
   0. Rate/BOQ tests pass 96/96; full reconstruction is 874/874.
6. Keep deployment-only work gated on deliberate configuration: email/SMS
   providers, production secrets/origins/storage/URLs and rewrites, clean-device
   CORS testing, JSON-store replacement, and CPU-versus-GPU capacity.
7. Run the bounded OpenAI comparison only when a server-side key is deliberately
   supplied: corrected carpet prompt, then one `gpt-4.1-mini` and one
   `gpt-5-mini` call before spending on five plan crops plus the window pass.

## Safety

Do not expose API keys in frontend code, commits, screenshots, logs, or this
file. Do not claim live AI verification until a real key is configured and a
real deck has been processed.

## 2026-08-29 continuation delta

Local branch `codex/finish-arcvia-20260828` is clean and contains two validated
commits after the last pushed tip `9cb7afa`:

- `b454123 Refuse unsafe scale guesses and enforce asset fit`
- `edf074d Add guarded CAD re-solve with persistent choices`

Do not reimplement these slices. Scale, fit, CAD-patch, Studio review,
TypeScript, backend syntax, and the memory-bounded Studio production build are
green; exact counts are recorded in `docs/PENDING-ARCVIA.md`.

The remaining work is not an unbounded invitation to guess geometry or invent
production configuration. Owner authentication/visual approval, drawings that
prove pitched roofs or additional stair forms, deployment provider choices and
credentials, and a deliberately supplied server-side OpenAI key are required.
The two local commits also need a new explicit push authorization because they
postdate the already completed 22-commit push.
