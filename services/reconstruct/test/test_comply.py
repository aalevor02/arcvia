"""Compliance bridge — pass / fail / unknown, units, applicability, provenance.

The assertions that matter most here are the refusals. A compliance checker proving it
can spot a narrow door has proved the easy half; the dangerous failures are all in the
other direction — certifying what it never measured, passing what it could not resolve,
or acting on a ruleset from the wrong country.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from comply import assess, load_ruleset, PASS, FAIL, UNKNOWN, PREDICATES   # noqa: E402
from comply.ruleset import RulesetError                                    # noqa: E402
from comply.predicates import door_clear_width, turning_space              # noqa: E402

RULESET = ROOT.parent.parent / "data" / "rulesets" / "building-rules-v0.1.0.json"
FIXTURE = ROOT / "test" / "fixtures" / "comply_model.json"

PASSED = FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}  {detail}")


def main() -> int:
    if not RULESET.exists():
        print(f"no ruleset at {RULESET}")
        return 2
    rs = load_ruleset(RULESET)
    model = json.loads(FIXTURE.read_text(encoding="utf-8"))
    print(f"ruleset v{rs.version}: {len(rs)} usable, {len(rs.rejects)} rejected\n")

    # ---- loader: what it refuses -------------------------------------------
    print("RULESET LOADER")
    tmp = ROOT / "test" / "_tmp_rs.json"
    base = json.loads(RULESET.read_text(encoding="utf-8"))

    def refuses(name, mutate):
        d = json.loads(json.dumps(base))
        mutate(d)
        tmp.write_text(json.dumps(d), encoding="utf-8")
        try:
            load_ruleset(tmp)
            check(name, False, "loaded it anyway")
        except RulesetError:
            check(name, True)
        finally:
            tmp.unlink(missing_ok=True)

    refuses("refuses a bumped MAJOR", lambda d: d.update(ruleset_version="9.0.0"))
    refuses("refuses a ruleset with no limitations", lambda d: d.update(limitations=[]))
    refuses("refuses an empty rule list", lambda d: d.update(rules=[]))
    refuses("refuses an unknown comparator (never defaults it)",
            lambda d: d["rules"][0]["predicate"].update(comparator="about"))

    check("rejects unverified conversions rather than using them",
          any("cross-checked" in r.reason for r in rs.rejects),
          f"{len(rs.rejects)} rejects")
    check("rejects max-comparator rules (predicates express minima)",
          any("minima" in r.reason for r in rs.rejects))
    check("every rejection carries a reason",
          all(r.reason for r in rs.rejects))
    check("no unverified rule survives into the usable set",
          len(rs.rules) > 0)

    # ---- provenance is carried, not summarised ------------------------------
    print("\nPROVENANCE")
    r = rs.by_citation("36 CFR 1191", "404.2.3")
    check("the door rule is present", r is not None)
    if r:
        p = r.provenance()
        check("keeps the ORIGINAL value and unit", p["originalValue"] == "32.0 in",
              p["originalValue"])
        check("keeps the normalised millimetres", abs(p["normalisedMm"] - 812.8) < 0.01)
        check("keeps the regulation's own stated mm", p["sourceStatedMm"] is not None)
        check("keeps the issue date", p["issueDate"].startswith("20"))
        check("keeps the verbatim quote", len(p["quote"]) > 20)
        check("citation names clause AND date",
              "36 CFR 1191 §404.2.3" in r.citation and "issued" in r.citation,
              r.citation)

    # ---- unit normalisation --------------------------------------------------
    print("\nUNIT NORMALISATION")
    if r:
        check("32 in normalises to 0.8128 m", r.value_m == 0.8128, str(r.value_m))
        check("mm is reproducible from the original",
              abs(r.value * 25.4 - r.value_mm) < 0.01)
        check("normalised agrees with the regulation's own figure within rounding",
              abs(r.value_mm - r.source_stated_mm) <= 3.0,
              f"{r.value_mm} vs {r.source_stated_mm}")

    # ---- three-valued results on real-ish geometry ---------------------------
    print("\nPASS / FAIL / UNKNOWN")
    ts = rs.by_citation("36 CFR 1191", "304.3.1")
    if ts:
        ms = turning_space(ts, model)
        verdicts = {m.subject: m.verdict for m in ms}
        check("a 6x6 m room PASSES the turning circle",
              verdicts.get("LIVING") == PASS, str(verdicts))
        check("a 1.2x1.2 m room FAILS it", verdicts.get("STORE") == FAIL, str(verdicts))
        check("a 2-point degenerate loop is UNKNOWN, not a pass",
              verdicts.get("SLIVER") == UNKNOWN, str(verdicts))
        check("the UNKNOWN carries a reason",
              all(m.reason for m in ms if m.verdict == UNKNOWN))

    if r:
        ds = door_clear_width(r, model)
        got = sorted(m.verdict for m in ds)
        check("a 0.70 m and 0.75 m door both FAIL", got.count(FAIL) == 2, str(got))
        check("a 1.20 m door is UNKNOWN, never PASS",
              PASS not in got and UNKNOWN in got, str(got))
        check("no door predicate can report PASS at all",
              not next(p for p in PREDICATES
                       if p.key == "ada-door-clear-width").can_pass)

    # ---- regional applicability ----------------------------------------------
    print("\nREGIONAL APPLICABILITY")
    ind = assess(model, rs, jurisdiction="IN")
    check("an Indian project evaluates NOTHING", ind.counts["checked"] == 0)
    check("and is marked not applicable", ind.applicable is False)
    check("and says why", "outside this ruleset" in ind.counts.get("note", ""))
    check("and produces no findings to act on", not ind.findings)

    us = assess(model, rs, jurisdiction="US federal")
    check("a US project does evaluate", us.applicable and us.counts["checked"] > 0,
          str(us.counts))
    check("findings are produced", len(us.findings) > 0)

    # ---- output schema is the product's own ----------------------------------
    print("\nOUTPUT SCHEMA")
    d = us.as_dict()
    check("report carries rulesetVersion", d["rulesetVersion"] == rs.version)
    check("report declares its own jurisdiction", d["jurisdiction"] == "US federal")
    check("summary carries an honest basis", "not a certification" in
          d["summary"]["basis"])
    f0 = d["findings"][0]
    check("finding uses the product's Finding schema",
          {"rule", "cite", "message", "room", "roomName", "measured", "required"}
          <= set(f0), sorted(f0))
    check("finding carries measured AND required", f0["measured"] is not None
          and f0["required"] is not None)
    check("finding cites clause and date", "§" in f0["cite"] and "issued" in f0["cite"])
    check("finding states applicability is conditional",
          "IF THIS RULE APPLIES" in f0["message"])
    check("finding shows the original unit alongside metres",
          " in = " in f0["message"] or " ft = " in f0["message"], f0["message"][:120])
    check("coverage rows use the product's shape",
          all({"rule", "checked", "short", "skipped"} <= set(c) for c in d["coverage"]))
    check("unknowns are reported as coverage skips, not dropped",
          any(c["skipped"] for c in d["coverage"]))
    check("rejected rules are reported", len(d["rejectedRules"]) > 0)

    # ---- never blocks, never crashes an empty model ---------------------------
    print("\nSAFETY")
    empty = assess({"elements": {"walls": [], "spaces": [], "openings": []}}, rs,
                   jurisdiction="US federal")
    check("an empty model produces no findings", not empty.findings)
    check("an empty model still reports coverage", len(empty.coverage) == len(PREDICATES))
    check("counts always include unknown", "unknown" in us.counts)

    print()
    if FAILED:
        print(f"FAILED: {FAILED} of {PASSED + FAILED}")
        return 1
    print(f"ALL {PASSED} CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
