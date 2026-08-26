"""
The area statement: RERA carpet vs IS 3861 carpet, with definitions attached.

Run:  .venv/Scripts/python.exe test/test_areas.py

The defect this module exists to prevent is an UNLABELLED area: RERA §2(k)
carpet includes internal partition walls and in-unit kitchens/baths; IS 3861
cl. 5 carpet excludes both. On the synthetic flat below the two figures are
38.40 vs 26.00 m2 — a 48% spread on the same rooms — which is why every
assertion here checks the definition tag and the convention record alongside
the number. A figure that drifts is a bug; a figure whose definition tag
vanishes is a liability.

Hand-computed truth for the fixture:
  rooms (indoor, finished-face): LIVING 20 + KITCHEN 8 + BATH 4 + unnamed 6 = 38
  partition (LIVING|KITCHEN):    4.0 m x 0.10 m = 0.40
  RERA_2k     = 38 + 0.40 = 38.40 m2        (kitchen and bath stay IN)
  IS3861      = 20 + 6    = 26.00 m2        (kitchen, bath OUT; walls OUT)
  balcony     = 5.00 m2                     (separate line, never folded in)
  lawn        = 40 m2                       (site: appears in NO figure)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantify import areas  # noqa: E402

passed = 0
failed = 0


def ok(label: str, cond: bool, extra: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


def square(x, y, w, h):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def wall(x0, y0, x1, y1, thickness=0.1):
    return {"a": {"x": x0, "y": y0}, "b": {"x": x1, "y": y1},
            "thickness": thickness, "paired": True, "confidence": 1.0}


MODEL = {
    "elements": {
        "walls": [
            wall(5.0, 0.0, 5.0, 4.0),      # 0: the LIVING|KITCHEN partition
            wall(0.0, 0.0, 5.0, 0.0),      # 1: envelope piece (one room only)
        ],
        "spaces": [
            {"index": 0, "name": "LIVING ROOM", "kind": "bedroom", "area": 20.0,
             "grossArea": 21.0, "loop": square(0, 0, 5, 4), "boundedBy": [0, 1]},
            {"index": 1, "name": "KITCHEN", "kind": "kitchen", "area": 8.0,
             "grossArea": 8.6, "loop": square(5, 0, 3, 4), "boundedBy": [0]},
            {"index": 2, "name": "BATH", "kind": "bathroom", "area": 4.0,
             "grossArea": 4.4, "loop": square(0, 5, 2, 2), "boundedBy": []},
            {"index": 3, "name": None, "kind": "unknown", "area": 6.0,
             "grossArea": 6.5, "loop": square(3, 5, 3, 2), "boundedBy": []},
            {"index": 4, "name": "BALCONY", "kind": "outdoor", "area": 5.0,
             "grossArea": 5.2, "loop": square(9, 0, 2.5, 2), "boundedBy": []},
            {"index": 5, "name": "LAWN", "kind": "outdoor", "area": 40.0,
             "grossArea": 41.0, "loop": square(0, 8, 8, 5), "boundedBy": []},
        ],
        "openings": [],
    }
}


statement = areas.area_statement(MODEL)
storey = statement["storeys"][0]
by_def = {f["definition"]: f for f in storey["figures"]}

print("-- the two carpets differ, and each names itself --")
ok("RERA carpet = rooms + partition = 38.40",
   by_def["RERA_2k"]["valueM2"] == 38.40, str(by_def["RERA_2k"]["valueM2"]))
ok("IS 3861 carpet = habitable only = 26.00",
   by_def["IS3861_carpet"]["valueM2"] == 26.00,
   str(by_def["IS3861_carpet"]["valueM2"]))
ok("the spread is material (48%), which is the whole point",
   by_def["RERA_2k"]["valueM2"] / by_def["IS3861_carpet"]["valueM2"] > 1.4)
ok("sqft companion uses 10.7639",
   by_def["RERA_2k"]["valueSqft"] == round(38.40 * 10.7639, 1),
   str(by_def["RERA_2k"]["valueSqft"]))
ok("every figure carries a definition tag",
   all(f.get("definition") for f in storey["figures"]))

print("-- §2(k) line items stay line items --")
ok("balcony is its own figure, not folded into carpet",
   by_def["exclusive_balcony_verandah"]["valueM2"] == 5.00)
ok("no terrace on this model",
   by_def["exclusive_open_terrace"]["valueM2"] == 0.00)
ok("the lawn appears in NO figure",
   all(abs(f["valueM2"] - 40.0) > 1 for f in storey["figures"]))
ok("...but is named in a caveat",
   any("40.00 m2" in c for c in storey["caveats"]))

print("-- the audit trail --")
ok("partition convention records the count and the basis",
   "1 walls" in storey["conventions"]["partitionWalls"],
   storey["conventions"]["partitionWalls"])
ok("single-unit assumption is recorded",
   "one unit" in storey["conventions"]["unit"])
ok("unnamed room counted into IS figure raises the caveat",
   any("cannot" in c and "6.00 m2" in c for c in storey["caveats"]))
ok("definition-difference caveat is always present",
   any("Never quote one as the other" in c for c in storey["caveats"]))

print("-- one label moving most of the IS figure gets called out --")
hall_model = {
    "elements": {
        **MODEL["elements"],
        "spaces": MODEL["elements"]["spaces"] + [
            # A 40 m2 "FOYER" — over 25% of the indoor floor, excluded from
            # the IS figure purely by its circulation label. The villa's real
            # 127.8 m2 FOYER is this case.
            {"index": 6, "name": "FOYER", "kind": "circulation", "area": 40.0,
             "grossArea": 42.0, "loop": square(12, 0, 8, 5), "boundedBy": []},
        ],
    }
}
hall = areas.area_statement(hall_model)["storeys"][0]
ok("dominant label-driven exclusion raises the caveat",
   any("FOYER" in c and "badly low" in c for c in hall["caveats"]))
ok("small exclusions (this fixture's 4 m2 BATH) do not",
   not any("badly low" in c for c in storey["caveats"]))

print("-- a model without wall attribution says so, loudly --")
stripped = {
    "elements": {
        **MODEL["elements"],
        "spaces": [
            {**s, "boundedBy": []} for s in MODEL["elements"]["spaces"]
        ],
    }
}
bare = areas.area_statement(stripped)["storeys"][0]
bare_rera = next(f for f in bare["figures"] if f["definition"] == "RERA_2k")
ok("RERA figure falls back to rooms-only", bare_rera["valueM2"] == 38.00)
ok("...and carries the UNDERSTATED note",
   "UNDERSTATED" in bare_rera.get("note", ""))
ok("convention says attribution was unavailable",
   "unavailable" in bare["conventions"]["partitionWalls"])

print("-- multi-storey: per-storey figures plus a labelled building sum --")
TWO = {
    "elements": {
        "storeys": [
            {"storey": 0, "title": "Ground", **MODEL["elements"]},
            {"storey": 1, "title": "First", **MODEL["elements"]},
        ],
    }
}
double = areas.area_statement(TWO)
ok("one block per storey", len(double["storeys"]) == 2)
ok("storey titles carried",
   double["storeys"][0].get("storeyTitle") == "Ground")
building = {f["definition"]: f for f in double["building"]["figures"]}
ok("building RERA = 2 x storey RERA", building["RERA_2k"]["valueM2"] == 76.80)
ok("the sum names its villa assumption",
   any("same unit" in c for c in double["building"]["caveats"]))

print("-- the text rendering --")
text = areas.as_text(statement)
ok("text carries both definitions",
   "RERA_2k" in text and "IS3861_carpet" in text)
ok("text carries the sqft companion", "413.3" in text)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
