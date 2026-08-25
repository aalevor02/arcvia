# OpenAI vision evaluation - 2026-08-25

## Verdict

**Integration works; accuracy is partial and is not approved for unattended
whole-plan processing yet.** The live OpenAI request path accepted image input,
returned the expected structured contracts, and respected the hard three-call
budget. The render reader made one material error, and the deliberately tiny
plan budget could inspect only one of the annotated suspect regions.

## Inputs and spend guard

- Real two-sheet presentation deck: one plan and one bedroom render.
- Companion full-plan PNG with five owner-annotated detector failures.
- Model: `gpt-4.1-mini`.
- Hard limits: 3 provider calls, 1 suspect crop, 1,200 maximum output tokens
  per call.
- Actual: 3 calls, 1,885 input tokens, 402 output tokens, 2,287 total tokens.
- Approximate API cost at the model's 2026-08-25 published token prices:
  $0.0014. Check the OpenAI project Costs view for the billing record.

No credential was written to the repository, temp output, command line, or
user environment. It existed only in the evaluation process and was removed
after the run.

## Render result

Correct/useful: bedroom, painted wall colour `#6f7f75`, accent `#796f7f`,
modern style, and a plausible inventory of bed, bedside table, chair, rug,
plant, and pendant. All dominant colours remained grounded in the measured
image palette.

Incorrect: the floor was classified as `wood` / `plank`; the established source
review identifies it as carpet. The prompt now explicitly distinguishes carpet
pile from plank seams/grain and refuses to guess when construction cues are not
visible. That correction has no-network contract coverage but has not consumed
another live call yet.

## Plan result

Before AI: 55 walls, 2 objects, 13 rooms. After the capped pass: 54 walls,
5 objects, 12 rooms, including 3 windows. The one permitted suspect crop was
classified as a fixture at 90% confidence and removed one false enclosure plus
one inner wall. The whole-image pass proposed four window centres; deterministic
wall snapping and deduplication accepted three.

The ground truth names five defect groups: plant, open lift lobby, two beds,
one missed window, and railing/boundary confusion. One crop cannot adjudicate
all of them. The result therefore proves the hybrid architecture, not complete
plan accuracy.

## Next bounded comparison

1. Re-run the bedroom only after the floor-cue prompt change.
2. Compare `gpt-4.1-mini` with `gpt-5-mini` on that same image, one call each.
3. If the render passes, run five plan crops plus the window pass against the
   annotated defects and score each defect explicitly.
4. Raise production limits only after that score is acceptable. Exact geometry
   remains deterministic even if every provider call fails.
