# comply — a reconstructed model measured against a cited, dated ruleset

`solve/codecheck.py` asks *"does this building meet the rulebook the architect works to?"*
against a hand-transcribed NBC 2016 book. This package asks the same shape of question
from a different source: rules machine-extracted from the eCFR API, each carrying its
clause, the issue date of that text, the regulation's verbatim sentence, and a unit
conversion cross-checked against a millimetre figure printed in the regulation itself.

**It is a bridge, not a second engine.** Geometry comes from `solve.codecheck`
(`map_openings`, `finished_face`, `inscribed_width`, `corridor_width`); findings are
`solve.codecheck.Finding`. An earlier draft reimplemented all of that in parallel and was
deleted — two implementations of *"how wide is this room"* that drift apart is the worse
outcome.

```python
from comply import assess
report = assess(model, "data/rulesets/building-rules-v0.1.0.json", jurisdiction="IN")
model["compliance"] = report.as_dict()      # cli.py already does exactly this
```

## Verified against six real reconstructed buildings

Command:

```bash
cd services/reconstruct
.venv/Scripts/python.exe -c "...assess(model, RULESET, jurisdiction='US federal')..."
```

| building | rooms | doors | FAIL | PASS | UNKNOWN | checked |
|---|---:|---:|---:|---:|---:|---:|
| `0iAnEnOn8Rwr` | 41 | 12 | 14 | 8 | 0 | 22 |
| `15m3fv8PXMVv` | 6 | 3 | 5 | 0 | 0 | 5 |
| `1geC8QXhMmSZ` | 6 | 3 | 5 | 0 | 0 | 5 |
| `27Ipfjp-DG7s` | 6 | 3 | 5 | 0 | 0 | 5 |
| `6BggAjo_1Gq-` | 6 | 3 | 5 | 0 | 0 | 5 |
| `6gGY7L6DBoHo` | 22 | 8 | 9 | 4 | 1 | 13 |
| **TOTAL** | | | **43** | **12** | **1** | **55** |

Findings by rule: `ada-door-clear-width` 32, `ada-turning-space` 11,
`ada-route-clear-width` 0.

Subjects *checked* per predicate: door 32, turning-space 20, route-width 3.

### Reading these numbers honestly

**The failures are real and expected.** These are Indian villas measured against US federal
accessibility law. A 0.75 m internal door is entirely legal in India and is a shortfall
against ADA's 812.8 mm. Both statements are true; which one matters is a fact about the
project, not about the geometry. `assess(..., jurisdiction="IN")` evaluates **nothing** for
exactly this reason.

**`ada-route-clear-width` found nothing, and that is not a pass.** It checked only 3
subjects. The rest were skipped because their room `kind` is `unknown` (36 skips), or
`outdoor` (16), or a kind outside the rule's `appliesTo`. Room classification, not
geometry, is the limiting factor — most reconstructed rooms are unclassified, and an
unclassified room cannot be matched to a rule scoped by room type.

**One UNKNOWN across 56 subjects is not reassuring on its own.** UNKNOWN counts only
subjects that reached a predicate and could not be measured; the far larger number is the
`appliesTo` skips above, which are recorded as coverage skips rather than as UNKNOWN.

## What it cannot measure — 73 of 206 usable rules

These families survive the ruleset's own rejection filters but have no counterpart in a
reconstructed model. Reconstruction produces walls, rooms, openings and fixtures; it does
not produce grab bars.

| family | usable rules | why unmeasurable |
|---|---:|---|
| signage / tactile | 17 | no signage in the model |
| handrails | 16 | no handrail geometry |
| grab bars | 13 | no sanitary-fitting geometry |
| ramps / slope | 10 | no ramp element; floors are level per storey |
| stairs / treads / risers | 8 | stair *cores* are recovered, individual treads and nosings are not |
| toilet / lavatory | 7 | fixtures are placed but not dimensioned to clause level |
| reach range | 2 | no operable-part geometry |
| **total** | **73** | |

The remaining ~133 usable rules are clearances, dimensions and route requirements, of
which 3 are currently wired. **Coverage is small by construction:** each predicate is
hand-written against a metric the geometry can actually measure, because a matcher that
guessed would fire confidently on rules it had misunderstood.

## Rejection, before anything is measured

The ruleset ships 634 rules; 206 are usable here.

| rejected | count | reason |
|---|---:|---|
| unverified conversion | 323 | the source prints imperial only, so the inch→mm conversion was never cross-checked against the regulation's own figure |
| `max` comparator | 105 | the geometry predicates express minima; a `max` rule silently treated as a minimum inverts the regulation |
| **total** | **428** | every rejection carries its reason and is reported in `rejectedRules` |

## Three-valued by design

Every predicate returns **PASS**, **FAIL** or **UNKNOWN** — never a boolean. UNKNOWN is
reported as a coverage skip with its reason, because folding *"could not measure"* into
*"passed"* is how a checker certifies buildings it never examined.

`ada-door-clear-width` **cannot return PASS at all** (`can_pass=False`, enforced by an
assertion in `bridge.py`). The model measures the *structural* opening; §404.2.3 governs
*clear* width — door open 90°, between the door face and the opposite stop — which is
smaller by the leaf, stop and hinge, commonly 50–75 mm. Structural width therefore bounds
clear width from above:

```
structural <  required   ->  clear width is certainly below it too   -> FAIL
structural >= required   ->  clear width may still be below it       -> UNKNOWN
```

## Tests

```bash
cd services/reconstruct && .venv/Scripts/python.exe test/test_comply.py
```

**45/45 pass.** Covers loader refusals (bumped major, no limitations, empty rules, unknown
comparator), provenance retention (original value/unit, stated mm, issue date, quote),
unit normalisation (32 in → 0.8128 m, reproducible, agreeing with the regulation's own
figure within rounding), all three verdicts on fixture geometry, regional applicability,
output-schema conformance, and safety on empty and degenerate models.

Fixture: `test/fixtures/comply_model.json` — three rooms and four openings chosen so PASS,
FAIL and UNKNOWN are each exercised. Its wall endpoints use the real model's `{x, y}`
object schema; a first draft used `[x, y]` pairs, `map_openings` rejected it, and the test
caught it. That is what the fixture is for.

## Blockers

1. ~~**Not wired into `cli.py`.**~~ **CLOSED.** `cli.py` imports `comply.assess`, runs it
   on every build with `DEFAULT_RULESET` and `DEFAULT_JURISDICTION`, and writes
   `model["compliance"]` beside `model["codecheck"]` — wrapped so a compliance pass can
   never fail a build. This blocker outlived its own fix; it was still being read as open
   on 2026-08-28, which is why it is struck through here rather than deleted.
2. **Room classification limits coverage more than geometry does** — see the
   `ada-route-clear-width` note above.
3. ~~**`cc.summarise()` hardcodes** *"a transcription the architect of record must
   verify"*.~~ **FIXED 2026-08-28.** `solve/codecheck.py` grew `basis_of()`, which reads
   the book's own `basis`. A book carrying none is now reported as provenance **UNKNOWN**
   rather than being handed a confident sentence it never earned — a silent book is more
   suspect, not less. Asserted in `test/test_codecheck.py` (30 -> 37), including the case
   that was wrong: a machine-extracted book must NOT be described as a transcription.
4. **US federal law, Indian product.** The durable value is as the template for an
   NBC/RERA ruleset. NBC is paywalled (`nbc_india`, quarantined); the Indian area law is
   written up in `A:\Research\BIM\knowledge\10`.
