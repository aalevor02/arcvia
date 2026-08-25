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

## Next work

1. Configure a real server secret in the deployment environment and restart
   `services/floorplan-ai`.
2. Run `/health`, then test `/detect/document/design` on a real saturated living
   room render and compare the returned structured spec to the image.
3. Add provider integration tests with a mocked HTTP response; do not call a
   live model in CI.
4. Add a review surface for unsupported/bespoke render furniture instead of
   silently dropping it. **This is now done:** unresolved items appear in
   `FurnitureReview` and are filtered out before `placeFurniture`.
5. Keep AI out of exact wall/door coordinates; use it for classification,
   room/material/furniture recognition, and confidence-ranked suggestions.
6. Unknown-but-plausible room labels now survive CAD filtering via
   `ingest.blocks.usable_room_labels`; verify a real bespoke-labeled drawing
   end-to-end before broadening the exclusion list.
7. Unresolved render items now carry `hubQuery` and a copy action in
   `FurnitureReview`. **The hub-to-catalogue placement step is now done for
   floor-standing items:** Find asset → choose a catalogue size/placement
   template → choose a Hub result → condition → return to review → place. The
   plan object persists a licence-bearing `customModel`; publication credits it.
8. **Done:** the same reviewed flow now supports wall and ceiling items only
   after the reviewer chooses a specific measured room-wall or ceiling target.
   In-wall templates remain refused because no reviewed opening is available.
9. Run a live browser smoke test of Find asset → Use this → Place these when the
   Windows browser-control process is available. Automated verification is
   green; the prior attempt was blocked before the browser launched.
10. Run one real preview/isometric/full render after an edit and visually
    compare it with the editor. The saved-model seam is covered and automated
    checks are green, but no live worker image is claimed in this handoff.
11. Run the next bounded vision comparison from
    `docs/OPENAI-VISION-EVAL-2026-08-25.md`: corrected prompt on the same render,
    then `gpt-4.1-mini` versus `gpt-5-mini`, before increasing the one-crop
    plan budget.

## Safety

Do not expose API keys in frontend code, commits, screenshots, logs, or this
file. Do not claim live AI verification until a real key is configured and a
real deck has been processed.
