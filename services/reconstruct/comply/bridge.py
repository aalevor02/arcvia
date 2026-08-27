"""Run the predicates and emit findings in the schema the product already publishes.

OUTPUT SCHEMA IS NOT NEGOTIABLE
-------------------------------
Findings are `solve.codecheck.Finding` and coverage rows are the same
`{rule, checked, short, skipped}` shape `check()` returns, so a compliance block is
indistinguishable in structure from the NBC one already written into every
`building.json`. Anything consuming `codecheck` — the API, the studio, a report — reads
this without changing.

The block is emitted under its own key so the two never merge: `codecheck` stays the
rulebook the architect of record works to, and this sits beside it.

REGIONAL APPLICABILITY IS DECLARED, NEVER ASSUMED
-------------------------------------------------
This ruleset is US federal law. Arcvia's buildings are largely Indian. So the report
carries `jurisdiction` and an `applicability` note in every summary, and a caller may
pass `jurisdiction=` to have the whole pass reported as `not-applicable` rather than
producing findings nobody should act on. A 0.75 m door is a perfectly legal Indian
internal door and a shortfall against ADA; both statements are true, and which one
matters is a fact about the project, not about the geometry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from solve.codecheck import Finding
from .predicates import FAIL, PASS, PREDICATES, UNKNOWN
from .ruleset import Rule, Ruleset, load_ruleset

#: Jurisdictions this ruleset is law in. Anything else gets a not-applicable report.
NATIVE_JURISDICTIONS = {"US", "US federal", "us"}


@dataclass
class ComplianceReport:
    ruleset_version: str
    jurisdiction: str
    applicable: bool
    findings: list[Finding] = field(default_factory=list)
    coverage: list[dict] = field(default_factory=list)
    rejected_rules: list[dict] = field(default_factory=list)
    counts: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "ruleset": "ADA/ABA Accessibility Guidelines (36 CFR 1191), machine-extracted",
            "rulesetVersion": self.ruleset_version,
            "jurisdiction": "US federal",
            "projectJurisdiction": self.jurisdiction,
            "applicable": self.applicable,
            "summary": {
                **self.counts,
                "basis": (
                    "Measured against rules extracted from the eCFR API, each carrying "
                    "its clause, the issue date of that text, and the regulation's own "
                    "sentence. Every conversion here was cross-checked against a "
                    "millimetre figure printed in the regulation itself. "
                    "US FEDERAL LAW — not Indian, not a certification, and deliberately "
                    "no verdict. Applicability is not modelled: a finding means 'if this "
                    "rule applies, the geometry does not meet it'."
                ),
            },
            "findings": [f.as_dict() for f in self.findings],
            "coverage": self.coverage,
            "rejectedRules": self.rejected_rules,
        }


def _skip(reason: str, subject: str) -> str:
    return f"{subject}: {reason}"


def assess(model: dict, ruleset: Ruleset | str | Path, *,
           jurisdiction: str = "US federal") -> ComplianceReport:
    """Measure a reconstructed model against the ruleset. Never blocks, never certifies."""
    rs = ruleset if isinstance(ruleset, Ruleset) else load_ruleset(ruleset)

    applicable = jurisdiction in NATIVE_JURISDICTIONS
    rep = ComplianceReport(ruleset_version=rs.version, jurisdiction=jurisdiction,
                           applicable=applicable)
    rep.rejected_rules = [
        {"ruleId": r.rule_id, "cite": r.citation, "reason": r.reason}
        for r in rs.rejects[:200]
    ]

    if not applicable:
        rep.counts = {
            "total": 0, "checked": 0, "unknown": 0, "passed": 0,
            "rulesEvaluated": 0, "rulesAvailable": len(rs),
            "rejectedRules": len(rs.rejects),
            "note": (f"project jurisdiction {jurisdiction!r} is outside this ruleset's "
                     "US federal scope — evaluated nothing rather than produce findings "
                     "nobody should act on"),
        }
        return rep

    total_checked = total_unknown = total_pass = rules_evaluated = 0

    for pred in PREDICATES:
        rule: Rule | None = rs.by_citation(pred.document, pred.section)
        row = {"rule": pred.key, "checked": 0, "short": 0, "skipped": []}
        rep.coverage.append(row)

        if rule is None:
            # Named a rule the ruleset does not carry. Say so — a predicate that quietly
            # stops running is a check nobody notices has gone.
            row["skipped"].append(_skip(
                f"ruleset has no {pred.document} §{pred.section}", "rule"))
            continue
        rules_evaluated += 1

        try:
            results = pred.fn(rule, model)
        except Exception as e:            # never fail a build for a compliance pass
            row["skipped"].append(_skip(f"{type(e).__name__}: {e}", "predicate"))
            continue

        for m in results:
            # Room-scoped rules honour appliesTo, and a room outside it is a SKIP with a
            # reason, not a silent omission.
            if pred.applies_to and m.room is not None:
                kind = _room_kind(model, m.room)
                if kind not in pred.applies_to:
                    row["skipped"].append(_skip(
                        f"room kind {kind!r} is outside this rule's appliesTo", m.subject))
                    continue

            if m.verdict == UNKNOWN:
                total_unknown += 1
                row["skipped"].append(_skip(m.reason or "not measurable", m.subject))
                continue

            row["checked"] += 1
            total_checked += 1

            if m.verdict == PASS:
                if not pred.can_pass:
                    # Enforced, not trusted: a fail-only predicate must never report a
                    # pass, because the measurement cannot support one.
                    raise AssertionError(
                        f"predicate {pred.key!r} returned PASS but can_pass is False")
                total_pass += 1
                continue

            row["short"] += 1
            unit_note = (f"{rule.value} {rule.unit} = {rule.value_m} m")
            rep.findings.append(Finding(
                rule=pred.key,
                cite=rule.citation,
                message=(
                    f"{m.subject} measures {m.measured} m against {rule.value_m} m "
                    f"({unit_note}) required by {rule.citation}."
                    + (f" {pred.one_sided_because.capitalize()}."
                       if pred.one_sided_because else "")
                    + " IF THIS RULE APPLIES — applicability is not modelled."
                ),
                room=m.room,
                room_name=m.room_name,
                measured=m.measured,
                required=rule.value_m,
                at=m.at,
                items=[rule.id],
            ))

    rep.counts = {
        "total": len(rep.findings),
        "checked": total_checked,
        "unknown": total_unknown,
        "passed": total_pass,
        "rulesEvaluated": rules_evaluated,
        "rulesAvailable": len(rs),
        "rejectedRules": len(rs.rejects),
        "byRule": _by_rule(rep.findings),
    }
    return rep


def _room_kind(model: dict, index: int) -> str:
    for sp in (model.get("elements", {}) or {}).get("spaces", []) or []:
        if sp.get("index") == index:
            return sp.get("kind", "unknown")
    return "unknown"


def _by_rule(findings: list[Finding]) -> dict:
    out: dict[str, int] = {}
    for f in findings:
        out[f.rule] = out.get(f.rule, 0) + 1
    return out
