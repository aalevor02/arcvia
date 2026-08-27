# rulebooks — and how they differ from `data/rulesets`

Two directories hold building rules and they are **not** interchangeable. Which one a
finding came from tells a reader what kind of claim it is, so the split is deliberate.

| | `data/rulebooks/` | `data/rulesets/` |
|---|---|---|
| **shape** | `{id, metric, appliesTo, min, unit, cite, note}` | full extraction: clause, section, issue date, verbatim quote, original value + unit, conversion-verified flag |
| **origin** | hand-transcribed by a person from a published code | machine-extracted from the eCFR API |
| **engine** | `solve/codecheck.py` | `comply/` |
| **written into** | `building.json → codecheck` | `building.json → compliance` |
| **holdings** | `nbc-2016-residential.json`, 13 rules | `building-rules-v0.1.0.json`, 634 rules |

## Why not merge them

A rulebook entry is a **figure someone typed**, and its `basis` says the architect of
record must verify it. A ruleset entry is a **clause with a date and its own sentence
attached**, and its conversion was cross-checked against a millimetre figure printed in
the regulation itself. Flattening the second into the first throws away the provenance
that makes it worth more than the first — you would be left with a number and a citation
string, which is what the rulebook format already is.

They also answer for different jurisdictions. `codecheck` runs NBC unconditionally because
these are Indian buildings. `comply` runs US federal rules and **evaluates nothing** unless
the project's jurisdiction is declared in scope. Merging them would put those two on the
same footing, and they are not.

## What was removed, and why

`ada-2010-federal.json` used to sit here: 4 ADA rules converted into rulebook shape. It was
written before `comply/` existed, as a way to reach the `codecheck` engine. Once `comply/`
consumed the ruleset directly it became a second path to the same rules carrying **less**
information — and nothing ever referenced it (`DEFAULT_RULEBOOK` selects NBC; a grep found
no consumer anywhere). Two representations of one fact, drifting apart unobserved, is the
defect this repo has already paid for twice. Deleted rather than left as a decoy.

The ADA rules are not lost: all 634 live in `data/rulesets/building-rules-v0.1.0.json`, and
`comply/` measures buildings against 206 of them that survive its rejection filters.

## Adding a rulebook

`load_rulebook()` refuses any rule whose `metric` is outside `KNOWN_METRICS`, and any rule
without a `cite`. Both refusals are deliberate: a metric the engine cannot measure would
otherwise read as passing, and a figure nobody can trace to a clause is a working figure,
which belongs in `clearance` rather than here.
