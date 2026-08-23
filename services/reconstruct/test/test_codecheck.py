"""
Code checks against a rulebook.

Run:  .venv/Scripts/python.exe test/test_codecheck.py

Synthetic geometry, same discipline as test_clearance: every figure asserted
here is checkable by hand against a loop somebody drew.

The case worth protecting most is the PINCHED CORRIDOR. Its widest pocket
passes the rule and its pinch does not, so it separates the two width
measurements: an inscribed-circle "width" would pass it, erosion-connectivity
between its doors fails it. If that test ever goes green with a measured value
near the pocket width instead of the pinch width, the corridor metric has
quietly become the wrong one.

Loops are wall CENTRELINES, walls are 0.23 m thick, so finished faces are
0.23 m smaller than the loop in each axis. Assertions use finished figures.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from solve import codecheck  # noqa: E402

passed = 0
failed = 0


def ok(label, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


def wall(ax, ay, bx, by, t=0.23):
    return {"a": {"x": ax, "y": ay}, "b": {"x": bx, "y": by}, "thickness": t}


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def room(index, loop, area, name=None, kind="unknown"):
    return {"index": index, "loop": loop, "area": area, "name": name, "kind": kind}


def model(walls=(), spaces=(), openings=()):
    return {"elements": {"walls": list(walls), "spaces": list(spaces),
                         "openings": list(openings), "fixtures": []}}


def door(wall_index, along, width, height=2.1):
    return {"kind": "door", "wall": wall_index, "along": along,
            "width": width, "height": height, "sill": 0.0}


def window(wall_index, along, width, height=None):
    op = {"kind": "window", "wall": wall_index, "along": along,
          "width": width, "sill": 0.9}
    if height is not None:
        op["height"] = height
    return op


def by_rule(findings, rule):
    return [f for f in findings if f.rule == rule]


#: The engine's own figures, pinned independently of the shipped data file so
#: an architect editing data/rulebooks/ cannot break an ENGINE test.
TEST_BOOK = {
    "title": "test figures",
    "rules": [
        {"id": "habitable-area", "metric": "room-area",
         "appliesTo": ["bedroom", "living"], "min": 9.5, "cite": "t1"},
        {"id": "habitable-width", "metric": "room-width",
         "appliesTo": ["bedroom", "living"], "min": 2.4, "cite": "t2"},
        {"id": "corridor-width", "metric": "corridor-width",
         "appliesTo": ["circulation"], "min": 0.9, "cite": "t3"},
        {"id": "exit-door", "metric": "exit-door-width", "min": 0.9, "cite": "t4"},
        {"id": "door-sanitary", "metric": "internal-door-width",
         "servesAny": ["bathroom"], "min": 0.7, "cite": "t5"},
        {"id": "door-general", "metric": "internal-door-width",
         "min": 0.75, "cite": "t6"},
        {"id": "egress", "metric": "egress-reach",
         "appliesTo": ["bedroom", "living"], "cite": "t7"},
        {"id": "ventilation", "metric": "ventilation-ratio",
         "appliesTo": ["bedroom"], "min": 0.1, "cite": "t8"},
    ],
}


print("\n-- room area and width --")

# A 6 x 2.2 m (centreline) bedroom: finished 5.77 x 1.97. Generous area if we
# say so, but only 1.97 m wide — the sliver the width rule exists to catch.
sliver = model(
    walls=[wall(0, 0, 6, 0), wall(6, 0, 6, 2.2), wall(6, 2.2, 0, 2.2), wall(0, 2.2, 0, 0)],
    spaces=[room(0, rect(0, 0, 6, 2.2), 11.4, "BEDROOM", "bedroom")],
)
findings, coverage = codecheck.check(sliver, TEST_BOOK)
ok("generous area passes the area rule", not by_rule(findings, "habitable-area"))
width_hits = by_rule(findings, "habitable-width")
ok("1.97 m sliver fails the width rule", len(width_hits) == 1)
ok("width measured on the finished face, not the centreline",
   width_hits and 1.85 <= width_hits[0].measured <= 2.05,
   f"measured={width_hits[0].measured if width_hits else None}")

small = model(
    walls=[wall(0, 0, 3, 0), wall(3, 0, 3, 3), wall(3, 3, 0, 3), wall(0, 3, 0, 0)],
    spaces=[room(0, rect(0, 0, 3, 3), 7.67, "BEDROOM", "bedroom")],
)
findings, _ = codecheck.check(small, TEST_BOOK)
ok("7.67 m2 bedroom fails the 9.5 m2 rule", len(by_rule(findings, "habitable-area")) == 1)

fine = model(
    walls=[wall(0, 0, 4, 0), wall(4, 0, 4, 3.6), wall(4, 3.6, 0, 3.6), wall(0, 3.6, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 3.6), 12.7, "BEDROOM", "bedroom")],
)
findings, coverage = codecheck.check(fine, TEST_BOOK)
ok("a 3.77 x 3.37 m bedroom passes both room rules",
   not by_rule(findings, "habitable-area") and not by_rule(findings, "habitable-width"))
ok("unclassified rooms are not judged by habitable rules",
   codecheck.check(model(spaces=[room(0, rect(0, 0, 2, 2), 3.2, "?", "unknown")]),
                   TEST_BOOK)[0] == [])


print("\n-- corridor: the pinch, not the pocket --")

# An 8 m corridor, 1.2 m at the centreline (0.97 finished) with a notch
# squeezing it to 0.7 (0.47 finished) in the middle. Doors at both ends.
# The widest pocket passes the 0.9 rule; the pinch is what you walk through.
pinched_loop = [(0, 0), (8, 0), (8, 1.2), (4.5, 1.2), (4.5, 0.7),
                (3.5, 0.7), (3.5, 1.2), (0, 1.2)]
pinched = model(
    walls=[wall(0, 0, 0, 1.2), wall(8, 0, 8, 1.2)],
    spaces=[room(0, pinched_loop, 8.9, "PASSAGE", "circulation")],
    openings=[door(0, 0.6, 0.9), door(1, 0.6, 0.9)],
)
findings, _ = codecheck.check(pinched, TEST_BOOK)
hits = by_rule(findings, "corridor-width")
ok("pinched corridor fails between its doors", len(hits) == 1)
ok("measured at the pinch (~0.47 m), not the pocket (~0.97 m)",
   hits and 0.38 <= hits[0].measured <= 0.55,
   f"measured={hits[0].measured if hits else None}")

straight = model(
    walls=[wall(0, 0, 0, 1.2), wall(8, 0, 8, 1.2)],
    spaces=[room(0, rect(0, 0, 8, 1.2), 7.7, "PASSAGE", "circulation")],
    openings=[door(0, 0.6, 0.9), door(1, 0.6, 0.9)],
)
findings, _ = codecheck.check(straight, TEST_BOOK)
ok("a straight 0.97 m corridor passes", not by_rule(findings, "corridor-width"))

one_door = model(
    walls=[wall(0, 0, 0, 0.8)],
    spaces=[room(0, rect(0, 0, 8, 0.8), 4.4, "PASSAGE", "circulation")],
    openings=[door(0, 0.4, 0.9)],
)
findings, _ = codecheck.check(one_door, TEST_BOOK)
hits = by_rule(findings, "corridor-width")
ok("one-door corridor falls back to widest point and still fails at 0.57 m",
   len(hits) == 1 and "widest point" in hits[0].message,
   f"measured={hits[0].measured if hits else None}")


print("\n-- doors: exit, internal, first-match-wins --")

# One room with its door to the outside; nothing on the far side of wall 0.
exit_narrow = model(
    walls=[wall(0, 0, 4, 0), wall(4, 0, 4, 4), wall(4, 4, 0, 4), wall(0, 4, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living")],
    openings=[door(0, 2.0, 0.75)],
)
findings, _ = codecheck.check(exit_narrow, TEST_BOOK)
ok("a 0.75 m door to the outside fails the 0.9 m exit rule",
   len(by_rule(findings, "exit-door")) == 1)
ok("an exit door is not judged as an internal one",
   not by_rule(findings, "door-general") and not by_rule(findings, "door-sanitary"))

# Two rooms sharing wall 1; a veranda (outdoor kind) behind wall 2 of room B.
pair = model(
    walls=[
        wall(0, 0, 8, 0), wall(4, 0, 4, 4), wall(8, 0, 8, 4),
        wall(8, 4, 0, 4), wall(0, 4, 0, 0), wall(4, 4, 8, 4),
    ],
    spaces=[
        room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living"),
        room(1, rect(4, 0, 8, 4), 14.2, "BATH", "bathroom"),
        room(2, rect(4, 4, 8, 7), 10.0, "VERANDA", "outdoor"),
    ],
    openings=[door(1, 2.0, 0.72), door(5, 6.0 - 4.0, 0.75)],
)
findings, _ = codecheck.check(pair, TEST_BOOK)
ok("a 0.72 m bathroom door passes: the sanitary rule claims it first",
   not by_rule(findings, "door-sanitary") and not by_rule(findings, "door-general"))
ok("a 0.75 m door into an outdoor space is an exit and fails the 0.9 m rule",
   len(by_rule(findings, "exit-door")) == 1)

tight_bath = model(
    walls=[wall(0, 0, 8, 0), wall(4, 0, 4, 4), wall(8, 0, 8, 4),
           wall(8, 4, 0, 4), wall(0, 4, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living"),
            room(1, rect(4, 0, 8, 4), 14.2, "BATH", "bathroom")],
    openings=[door(1, 2.0, 0.65)],
)
findings, _ = codecheck.check(tight_bath, TEST_BOOK)
ok("a 0.65 m bathroom door fails the 0.7 m sanitary figure",
   len(by_rule(findings, "door-sanitary")) == 1)

narrow_general = model(
    walls=[wall(0, 0, 8, 0), wall(4, 0, 4, 4), wall(8, 0, 8, 4),
           wall(8, 4, 0, 4), wall(0, 4, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living"),
            room(1, rect(4, 0, 8, 4), 14.2, "BED", "bedroom")],
    openings=[door(1, 2.0, 0.6)],
)
findings, _ = codecheck.check(narrow_general, TEST_BOOK)
ok("a 0.6 m bedroom door fails the general 0.75 m figure",
   len(by_rule(findings, "door-general")) == 1)


print("\n-- egress --")

# A chain: LIVING (exterior door) <-> PASSAGE <-> BEDROOM, plus an island
# bedroom with no door at all.
chain = model(
    walls=[
        wall(0, 0, 12, 0), wall(0, 4, 0, 0), wall(4, 0, 4, 4),
        wall(8, 0, 8, 4), wall(12, 0, 12, 4), wall(12, 4, 0, 4),
    ],
    spaces=[
        room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living"),
        room(1, rect(4, 0, 8, 4), 14.2, "PASSAGE", "circulation"),
        room(2, rect(8, 0, 12, 4), 14.2, "BEDROOM", "bedroom"),
        room(3, rect(20, 0, 23, 3), 7.7, "BEDROOM 2", "bedroom"),
    ],
    openings=[door(1, 2.0, 1.0), door(2, 2.0, 0.8), door(3, 2.0, 0.8)],
)
findings, _ = codecheck.check(chain, TEST_BOOK)
hits = by_rule(findings, "egress")
ok("rooms on the chain reach the exit; the doorless island does not",
   len(hits) == 1 and hits[0].room == 3)
ok("the island's finding says no door opens into it",
   hits and "no door opens into it" in hits[0].message)

landlocked = model(
    walls=[wall(0, 0, 8, 0), wall(4, 0, 4, 4), wall(8, 0, 8, 4),
           wall(8, 4, 0, 4), wall(0, 4, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 4), 14.2, "LIVING", "living"),
            room(1, rect(4, 0, 8, 4), 14.2, "BEDROOM", "bedroom")],
    openings=[door(1, 2.0, 0.8)],
)
findings, _ = codecheck.check(landlocked, TEST_BOOK)
hits = by_rule(findings, "egress")
ok("a storey with no exterior door reports that fact",
   any("No door on this storey opens to the outside" in f.message for f in hits))
ok("...and both habitable rooms as unreachable", len(hits) == 3)

no_doors, coverage = codecheck.check(
    model(spaces=[room(0, rect(0, 0, 4, 4), 14.2, "BED", "bedroom")]), TEST_BOOK)
row = next(r for r in coverage if r["rule"] == "egress")
ok("a model with no doors at all is a skip, not a silent pass",
   not by_rule(no_doors, "egress") and row["skipped"]
   and "no doors" in row["skipped"][0]["reason"])


print("\n-- ventilation --")

aired = model(
    walls=[wall(0, 0, 4, 0), wall(4, 0, 4, 3.6), wall(4, 3.6, 0, 3.6), wall(0, 3.6, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 3.6), 12.0, "BEDROOM", "bedroom")],
    openings=[window(0, 2.0, 1.2, height=1.2)],
)
findings, _ = codecheck.check(aired, TEST_BOOK)
ok("a 1.44 m2 window on 12 m2 (12%) passes the 10% rule",
   not by_rule(findings, "ventilation"))

stuffy = model(
    walls=[wall(0, 0, 4, 0), wall(4, 0, 4, 3.6), wall(4, 3.6, 0, 3.6), wall(0, 3.6, 0, 0)],
    spaces=[room(0, rect(0, 0, 4, 3.6), 12.0, "BEDROOM", "bedroom")],
    openings=[window(0, 2.0, 0.9, height=0.9)],
)
findings, _ = codecheck.check(stuffy, TEST_BOOK)
hits = by_rule(findings, "ventilation")
ok("a 0.81 m2 window on 12 m2 (7%) falls short", len(hits) == 1)

_, coverage = codecheck.check(fine, TEST_BOOK)
row = next(r for r in coverage if r["rule"] == "ventilation")
ok("no windows in the model: rooms are skipped with the reason, never passed",
   row["checked"] == 0 and row["skipped"]
   and "no windows" in row["skipped"][0]["reason"])


print("\n-- the rulebook gate --")

import json as _json
import tempfile


def try_load(book):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     encoding="utf-8") as f:
        _json.dump(book, f)
        p = f.name
    try:
        codecheck.load_rulebook(p)
        return None
    except codecheck.RulebookError as e:
        return str(e)
    finally:
        Path(p).unlink(missing_ok=True)


err = try_load({"rules": [{"id": "x", "metric": "vibes", "min": 1, "cite": "c"}]})
ok("an unknown metric is refused by name", err is not None and "vibes" in err)
err = try_load({"rules": [{"id": "x", "metric": "room-area", "min": 1}]})
ok("a rule without a citation is refused", err is not None and "citation" in err)
err = try_load({"rules": [
    {"id": "x", "metric": "room-area", "min": 1, "cite": "c"},
    {"id": "x", "metric": "room-width", "min": 1, "cite": "c"},
]})
ok("a duplicate rule id is refused", err is not None and "twice" in err)

shipped = Path(__file__).resolve().parents[3] / "data" / "rulebooks" / "nbc-2016-residential.json"
book = codecheck.load_rulebook(shipped)
ok("the shipped NBC transcription loads through the gate", bool(book["rules"]))
findings, coverage = codecheck.check(chain, book)
summary = codecheck.summarise(findings, coverage, book)
ok("summary carries coverage and refuses a verdict",
   "checked" in summary and "ok" not in summary and "verdict" not in summary)
ok("the basis names the rulebook and the architect's ownership",
   "verify" in summary["basis"])


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
