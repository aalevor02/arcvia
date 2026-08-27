"""Load the versioned structured ruleset, preserving provenance and rejecting what
cannot honestly be measured against a building.

The ruleset is produced outside this repo (`A:\\Research\\Corpus\\tools\\codes_rules.py`)
from the eCFR API, and lands in `data/rulesets/`. This module is the only door it comes
through, and every assumption the rest of the package makes is checked here, once, loudly.

WHAT IS REJECTED, AND WHY EACH REJECTION EXISTS
-----------------------------------------------
* **unverified conversions** — 36 CFR 1191 prints every dimension twice ("60 inches
  (1525 mm)"), so its inch→mm conversion is cross-checked against the regulation's own
  figure. OSHA and HUD print imperial only; 54% of the ruleset therefore carries a
  conversion nothing ever checked. Those do not measure buildings here.
* **non-minimum comparators** — the geometry predicates express minima. A `max` rule
  silently treated as a minimum inverts the regulation.
* **missing citation or issue date** — a figure nobody can trace to a dated clause is a
  working figure, and working figures belong in `clearance`, not in a compliance finding.
* **quarantined prose** — never present in the export at all. The extractor holds back
  1,835 statements (permissive allowances, ambiguous comparator binding, exemptions) and
  this package would rather check four rules than guess at a fifth.

Nothing is dropped silently: `load_ruleset` returns the rejects with their reasons, and
the bridge reports them as coverage skips.

PROVENANCE IS CARRIED, NOT SUMMARISED
-------------------------------------
Every `Rule` keeps the clause, the issue date of that text, the regulation's verbatim
sentence, and **the original value and unit** alongside the normalised millimetres. The
original is authoritative; the SI form is a convenience. A rule that reached a building
without the sentence it came from cannot be argued with, and that is the whole point of
extracting them from a citable source rather than typing them in.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

#: Ruleset schema MAJOR this code understands. A different major means the rule shape
#: changed; refuse rather than best-effort parse.
SUPPORTED_MAJOR = 0

_REQUIRED = {"id", "source", "subject", "predicate", "normalised", "quote"}
_REQUIRED_SOURCE = {"document", "issue_date", "url"}
_REQUIRED_PRED = {"comparator", "value", "unit"}


class RulesetError(ValueError):
    """The ruleset file is not something we will measure a building against."""


@dataclass(frozen=True)
class Rule:
    id: str
    document: str
    section: str | None
    heading: str | None
    issue_date: str
    url: str
    subject: str
    comparator: str
    value: float          # ORIGINAL value, authoritative
    unit: str             # ORIGINAL unit: 'in' | 'ft'
    value_mm: float       # normalised convenience
    value_m: float
    source_stated_mm: float | None
    quote: str
    jurisdiction: str = "US federal"

    @property
    def citation(self) -> str:
        base = f"{self.document} §{self.section}" if self.section else self.document
        return f"{base}, as issued {self.issue_date}"

    def provenance(self) -> dict:
        """Everything needed to argue with this rule, in one place."""
        return {
            "ruleId": self.id,
            "document": self.document,
            "section": self.section,
            "heading": self.heading,
            "issueDate": self.issue_date,
            "url": self.url,
            "jurisdiction": self.jurisdiction,
            "originalValue": f"{self.value} {self.unit}",
            "normalisedMm": self.value_mm,
            "sourceStatedMm": self.source_stated_mm,
            "conversionVerifiedAgainstSource": True,
            "quote": self.quote,
        }


@dataclass(frozen=True)
class Reject:
    rule_id: str
    citation: str
    reason: str


class Ruleset:
    def __init__(self, version: str, rules: list[Rule], rejects: list[Reject],
                 meta: dict, limitations: list[str]):
        self.version = version
        self.rules = rules
        self.rejects = rejects
        self.meta = meta
        self.limitations = limitations

    def by_citation(self, document: str, section: str) -> Rule | None:
        for r in self.rules:
            if r.document == document and r.section == section:
                return r
        return None

    def __len__(self) -> int:
        return len(self.rules)


def load_ruleset(path: str | Path) -> Ruleset:
    p = Path(path)
    if not p.exists():
        raise RulesetError(f"no ruleset at {p}")
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise RulesetError(f"{p} is not valid JSON: {e}") from e

    version = doc.get("ruleset_version")
    if not isinstance(version, str) or not version:
        raise RulesetError("ruleset_version missing — refusing to guess it")
    try:
        major = int(version.split(".")[0])
    except (ValueError, IndexError) as e:
        raise RulesetError(f"ruleset_version {version!r} is not semantic") from e
    if major != SUPPORTED_MAJOR:
        raise RulesetError(
            f"ruleset major {major}, this code understands {SUPPORTED_MAJOR}")

    if not doc.get("limitations"):
        # A ruleset asserting no limitations is claiming a completeness it has not
        # earned. The generator always writes them.
        raise RulesetError("ruleset declares no limitations — refusing to trust it")

    raw = doc.get("rules")
    if not isinstance(raw, list) or not raw:
        raise RulesetError("ruleset contains no rules")

    rules: list[Rule] = []
    rejects: list[Reject] = []
    for i, r in enumerate(raw):
        if _REQUIRED - set(r):
            raise RulesetError(f"rule[{i}] missing {sorted(_REQUIRED - set(r))}")
        src, pred, norm = r["source"], r["predicate"], r["normalised"]
        cite = f"{src.get('document', '?')} §{src.get('section', '?')}"

        if _REQUIRED_SOURCE - set(src):
            rejects.append(Reject(r["id"], cite, "no traceable citation or issue date"))
            continue
        if _REQUIRED_PRED - set(pred):
            rejects.append(Reject(r["id"], cite, "incomplete predicate"))
            continue
        if pred["comparator"] not in ("min", "max"):
            # Never default this: a guessed comparator inverts the regulation.
            raise RulesetError(
                f"rule[{i}] comparator {pred['comparator']!r} is neither min nor max")
        if not norm.get("verified_against_source"):
            rejects.append(Reject(
                r["id"], cite,
                "unit conversion was never cross-checked against a metric figure "
                "printed in the regulation itself"))
            continue
        if pred["comparator"] != "min":
            rejects.append(Reject(
                r["id"], cite,
                f"comparator is {pred['comparator']}; the geometry predicates here "
                "express minima only"))
            continue

        mm = float(norm["value_mm"])
        rules.append(Rule(
            id=r["id"], document=src["document"], section=src.get("section"),
            heading=src.get("heading"), issue_date=src["issue_date"], url=src["url"],
            subject=r["subject"], comparator=pred["comparator"],
            value=float(pred["value"]), unit=pred["unit"],
            value_mm=mm, value_m=round(mm / 1000.0, 4),
            source_stated_mm=norm.get("source_stated_mm"), quote=r["quote"],
        ))
    return Ruleset(version=version, rules=rules, rejects=rejects,
                   meta=doc.get("counts", {}), limitations=doc["limitations"])
