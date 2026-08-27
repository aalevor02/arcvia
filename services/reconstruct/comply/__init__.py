"""Compliance: a reconstructed model measured against a cited, dated ruleset.

`solve/codecheck.py` answers "does this building meet the rulebook the architect works
to?" — a hand-transcribed NBC 2016 book. This package answers the same shape of question
from a different source: rules machine-extracted from the eCFR API, each carrying its
clause, the issue date of that text, the regulation's verbatim sentence, and a unit
conversion cross-checked against a millimetre figure printed in the regulation itself.

It is a BRIDGE, not a second engine. Geometry comes from `solve.codecheck`
(`map_openings`, `finished_face`, `inscribed_width`, `corridor_width`) and findings are
`solve.codecheck.Finding`, so the output schema is the one the product already publishes.
An earlier draft of this package reimplemented all of that in parallel and was deleted;
two implementations of "how wide is this room" that drift apart is the worse outcome.

    from comply import assess, load_ruleset
    report = assess(model, "data/rulesets/building-rules-v0.1.0.json",
                    jurisdiction="IN")
    model["compliance"] = report.as_dict()
"""

from .ruleset import Rule, Ruleset, RulesetError, load_ruleset   # noqa: F401
from .bridge import ComplianceReport, assess                     # noqa: F401
from .predicates import FAIL, PASS, UNKNOWN, PREDICATES          # noqa: F401

__all__ = ["Rule", "Ruleset", "RulesetError", "load_ruleset",
           "ComplianceReport", "assess", "PASS", "FAIL", "UNKNOWN", "PREDICATES"]
