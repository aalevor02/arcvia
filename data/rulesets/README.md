# Building rulesets — PROPOSED, not wired in

Machine-checkable dimensional rules extracted from harvested US federal regulation.
**Nothing in the product reads these files.** They are here so the product side can
evaluate the shape before anyone commits to it. See `MANIFEST.json` for counts,
checksums, licence and validation.

| | |
|---|---|
| version | `0.1.0` |
| rules | **572** |
| quarantined | **1,615** (kept in the corpus — it is a work queue, not a deliverable) |
| licence | Public domain (US Government works, 17 USC 105). No attribution required. |
| produced by | `A:\Research\Corpus\tools\codes_rules.py` |
| tests | `A:\Research\Corpus\tools\test_codes_rules.py --negative` — 22 checks, 10 perturbations caught |

## What a rule looks like

```json
{
  "id": "…",
  "source": {
    "document": "36 CFR 1191", "citation": "Appendix D to Part 1191, Title 36",
    "section": "304.3.1", "heading": "Circular Space",
    "issue_date": "2026-08-24", "url": "https://www.ecfr.gov/api/versioner/…"
  },
  "subject": "turning space",
  "predicate":  { "comparator": "min", "value": 60.0, "unit": "in" },
  "normalised": { "value_mm": 1524.0, "source_stated_mm": 1525.0,
                  "delta_mm": 1.0, "verified_against_source": true },
  "quote": "The turning space shall be a space of 60 inches (1525 mm) diameter minimum."
}
```

`predicate` is authoritative; `normalised` is a convenience. The original value and unit
are never discarded in translation.

## Three things worth knowing before you build on this

**1. The unit conversion is verified, not asserted — but the 46% is not evenly spread, and
the split is the number that matters.** The ADA guidelines print every dimension twice —
`60 inches (1525 mm)` — so the extractor converts the inches itself and compares against
the regulation's own millimetres. 265 of 572 rules (46%) carry that independent check.

Per unit, which the aggregate hides:

| unit | rules | verified | % | max delta | tolerance | calibrated on |
|---|---|---|---|---|---|---|
| `in` | 432 | 259 | **60.0%** | 2.40 mm | 3.0 mm | n=259 |
| `ft` | 140 | 6 | **4.3%** | 4.00 mm | 6.0 mm | **n=6** |

But the per-unit split is *itself* an aggregate hiding the real axis. **Verification is a
property of the DOCUMENT, not the unit** — and this is the number to actually build on:

| document | rules | verified | % | |
|---|---|---|---|---|
| 36 CFR 1191 | 261 | 258 | **98.9%** | prints every dimension twice |
| 29 CFR 1926 | 152 | 5 | 3.3% | imperial only |
| 29 CFR 1910 | 128 | 1 | 0.8% | imperial only |
| 24 CFR 3280 | 31 | 1 | 3.2% | imperial only |

**311 of 572 rules (54.4%) are *structurally* unverifiable** by this cross-check: their
source prints no metric equivalent, so there is nothing to compare against — in **both**
units. Feet looked uniquely bad only because 132 of the 140 foot rules come from
imperial-only documents; inside 36 CFR 1191, feet verify at 4/5.

That distinction matters because it is **permanent**. It is a structural ceiling, not a
sample-size problem — collecting more text, or more parts, cannot raise it. Anyone tempted
to "fix the low verification rate" by harvesting more should know that first.

**Practical consequence:** treat 36 CFR 1191 rules as cross-checked, and every other
document's rules as *parsed but unconfirmed*, and weight a compliance finding accordingly.
`counts.verification_by_document`, `counts.unit_verified_by_unit` and
`counts.tolerance_basis` carry all of it so a consumer never has to re-derive it.

The `ft = 6.0` tolerance stands: its *value* is principled (10 mm rounding ⇒ 5 mm maximum
error, so 6 is a ceiling, not a curve fit), while the *premise* that feet round to 10 mm
rests on n=6. Nothing here is known to be wrong — it is known to be less checked than
"46% unit-verified" implies.

That check earned its keep immediately. It caught a fraction bug — `1/2 inch (13 mm)`
was parsing as **2 inches**, and `3/4 inch` as **4 inches** — which would have exported
29 rules at 4× to 8× their true value. Every other field on those rules looked perfect.
It later caught two more: `19,000 feet per minute` (a tip speed) and `17,500 foot-pounds`
(impact energy) being read as lengths — failures not of arithmetic but of *kind*, which
no amount of checking the numbers would have surfaced.

**2. The quarantine is the honest part.** 1,615 statements containing a number were
refused, each with a machine-readable reason. The big ones: `no-obligation-verb` (674),
`no-explicit-comparator` (489), `multiple-values-one-comparator` (189, e.g. "30 inches by
48 inches" where one comparator cannot be bound to two numbers), `permissive-allowance`
(153). Permissive prose is refused deliberately: *"shall be permitted to be 48 inches"* is
an allowance, not a requirement, and a checker that cannot tell them apart will
confidently fail a compliant building.

A quarantined rule is visible work. A dropped one is invisible.

**3. How much of the CFR this actually is — measured, not estimated.** The eCFR search API
reports **2,957 sections CFR-wide** carrying the dual-unit dimensional pattern, across
**230 parts**, with count relation `eq` (not a capped `gte`). The 7 parts here hold **185
of them, 6.3%**.

That 6.3% understates building coverage, and the reason matters: the denominator is
dimensional prose *in general*, and its biggest holders are **fisheries, endangered
species, hazmat shipping and consumer appliances**. Filtering the 223 unharvested parts by
building-related headings leaves 23 parts / 148 sections — and most of those are vehicles
(46 CFR vessel construction, 49 CFR 38, 36 CFR 1192) or nuclear (10 CFR 50). Genuinely
building-relevant and still missing, named rather than left as an unbounded gap:

| part | what |
|---|---|
| 28 CFR 36 | DOJ ADA Title III — adopts the 2010 Standards |
| 36 CFR 1190 | PROWAG — pedestrian facilities in the public right-of-way |
| 36 CFR 1234 | facility standards for records storage |
| 16 CFR 1211 | residential garage door operators |
| 7 CFR 1924 | construction and repair |

So coverage of *building* dimensional CFR is high — but "high" is the honest word, not
"complete". The UFC/ADA PDF gap (limitation 1) has **no number at all** yet, which makes it
the larger unknown of the two.

**4. What it does not know.** Applicability is **not modelled** — a rule carries its
section and heading, not which occupancies, building types or jurisdictions it governs.
So these cannot yet be applied to a plan unconditionally. Nor is any of this Indian law:
it is US federal regulation, and the ICC model codes that US buildings are actually
designed to (IBC/IRC) are copyrighted and deliberately absent — federal regs cite them by
reference without reproducing them. **Do not mistake a citation for a code.**

No rule here has been evaluated against a real reconstructed plan.

## Consuming it

`building-rules.schema.json` is a real JSON Schema (draft 2020-12) — validate with `ajv`
before trusting a file you did not generate. Regenerating is one command in the corpus
tree; re-running on a later eCFR issue date produces new rows and never overwrites, so a
rule's date always means something.

## Status

Proposed. Needs a product-side owner to decide where a compliance surface belongs before
anything imports this. Tracked in `../../COORDINATION.md` as finding **F14** (§7), queue
item 11 (§9c), and **§12** — which carries the full counts, the exclusion table, and the
three extraction defects the validation caught.
