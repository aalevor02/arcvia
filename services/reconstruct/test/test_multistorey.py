"""
Per-storey elements: the whole building reaches every consumer.

Run:  .venv/Scripts/python.exe test/test_multistorey.py

Clearance, the code checks, the bill of quantities and the schedules all read
`elements.*`, and all of them were silently covering ONE floor of a
multi-storey building. They now read through one iterator
(solve/storeys.py::element_blocks), and these are the invariants that keep
that honest:

  * a single-storey model passes through UNCHANGED — every model ever
    produced keeps meaning what it meant;
  * fixtures land on their own floor — two beds at the same (x, y) on
    different storeys are NOT an overlap, and the same two on one storey are;
  * egress runs only on the storey the site is entered from, and the skipped
    storeys appear in coverage saying so — never silently;
  * an opening hosts on a wall BY INDEX within its own storey, so the
    concatenated building view must re-index or every upstairs door re-hosts
    onto a ground-floor wall.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.catalogue_dims import CATALOGUE_DIMS  # noqa: E402
from quantify.boq import _building_elements  # noqa: E402
from quantify.schedules import room_schedule  # noqa: E402
from solve import clearance, codecheck  # noqa: E402
from solve.storeys import element_blocks  # noqa: E402

passed = 0
failed = 0


def ok(label, cond, extra=""):
    global passed, failed
    state = "PASS" if cond else "FAIL"
    print(f"{state}  {label}" + (f"  {extra}" if extra else ""))
    if cond:
        passed += 1
    else:
        failed += 1


def _wall(ax, ay, bx, by, t=0.23):
    return {"a": {"x": ax, "y": ay}, "b": {"x": bx, "y": by}, "thickness": t}


ROOM = [(0, 0), (4, 0), (4, 4), (0, 4)]
WALLS = [_wall(0, 0, 4, 0), _wall(4, 0, 4, 4), _wall(4, 4, 0, 4), _wall(0, 4, 0, 0)]


def _space(name, kind, area=14.2):
    return {"index": 0, "loop": ROOM, "area": area, "grossArea": 16.0,
            "perimeter": 16.0, "name": name, "kind": kind}


def _bed(storey, x=2.0, y=2.0):
    return {"label": "fixture", "item": "bed-king", "storey": storey,
            "position": {"x": x, "y": y}, "rotation": 0.0,
            "footprint": {"w": 1.83, "d": 2.03}}


DOOR = {"kind": "door", "wall": 0, "along": 2.0, "width": 1.0,
        "height": 2.1, "sill": 0.0}

TWO_STOREY = {
    "storeys": {"primary": 0},
    "elements": {
        "walls": WALLS, "spaces": [_space("LIVING", "living")], "openings": [DOOR],
        "fixtures": [_bed(0), _bed(1)],
        "storeys": [
            {"storey": 0, "level": 0, "title": "Ground Floor Plan",
             "shift": [0, 0], "walls": WALLS,
             "spaces": [_space("LIVING", "living")], "openings": [DOOR]},
            {"storey": 1, "level": 1, "title": "First Floor Plan",
             "shift": [0, -17.6], "walls": WALLS,
             "spaces": [_space("BEDROOM", "bedroom", area=7.9)], "openings": [DOOR]},
        ],
    },
}

SINGLE = {"elements": {"walls": WALLS, "spaces": [_space("LIVING", "living")],
                       "openings": [DOOR], "fixtures": [_bed(0)]}}


print("-- element_blocks --")
single = list(element_blocks(SINGLE))
ok("a single-storey model yields one block, tag None",
   len(single) == 1 and single[0][0] is None)
ok("and its elements pass through unchanged",
   single[0][1] is SINGLE["elements"])

blocks = list(element_blocks(TWO_STOREY))
ok("a stacked model yields one block per storey", len(blocks) == 2)
ok("fixtures land on their own floor",
   [f["storey"] for f in blocks[0][1]["fixtures"]] == [0]
   and [f["storey"] for f in blocks[1][1]["fixtures"]] == [1])


print("")
print("-- clearance across storeys --")
issues = clearance.check_building(TWO_STOREY, CATALOGUE_DIMS)
ok("two beds at the same (x, y) on DIFFERENT floors are not an overlap",
   not any(i.kind == "overlap" for i in issues),
   str([i.kind for i in issues]))

crowded = {**TWO_STOREY, "elements": {**TWO_STOREY["elements"],
           "fixtures": [_bed(0), _bed(1), _bed(1, x=2.4)]}}
issues = clearance.check_building(crowded, CATALOGUE_DIMS)
overlaps = [i for i in issues if i.kind == "overlap"]
ok("two beds overlapping on the SAME floor still are", len(overlaps) == 1)
ok("and the finding says which floor",
   bool(overlaps) and overlaps[0].storey == 1
   and overlaps[0].storey_title == "First Floor Plan")


print("")
print("-- code checks across storeys --")
BOOK = {"title": "t", "rules": [
    {"id": "habitable-area", "metric": "room-area",
     "appliesTo": ["living", "bedroom"], "min": 9.5, "cite": "c"},
    {"id": "egress", "metric": "egress-reach",
     "appliesTo": ["living", "bedroom"], "cite": "c"},
]}
findings, coverage = codecheck.check_building(TWO_STOREY, BOOK)
area_hits = [f for f in findings if f.rule == "habitable-area"]
ok("an upstairs bedroom answers to the same area figure",
   len(area_hits) == 1 and area_hits[0].storey == 1
   and area_hits[0].storey_title == "First Floor Plan",
   str([(f.rule, f.storey) for f in findings]))
egress_row = next(r for r in coverage if r["rule"] == "egress")
ok("egress ran on the entry storey only",
   egress_row["checked"] == 1
   and any("stairs are not modelled" in skip["reason"]
           for skip in egress_row["skipped"]),
   str(egress_row))
ok("and no upstairs room is called unreachable",
   not any(f.rule == "egress" for f in findings))
single_findings, _ = codecheck.check_building(SINGLE, BOOK)
ok("a single-storey model behaves as plain check()",
   not any(f.storey is not None for f in single_findings))


print("")
print("-- the concatenated building: bill and schedules --")
building = _building_elements(TWO_STOREY)
ok("the whole building's walls are counted", len(building["walls"]) == 8)
ok("an upper-storey opening re-hosts onto its own wall after concatenation",
   building["openings"][1]["wall"] == 4,
   str([o["wall"] for o in building["openings"]]))
ok("a single-storey model concatenates to itself",
   len(_building_elements(SINGLE)["walls"]) == 4)

schedule = room_schedule(TWO_STOREY)
rows = schedule["rooms"]
ok("the room schedule lists every floor's rooms", len(rows) == 2)
ok("and rows say which floor they are on",
   sorted(r.get("storeyTitle") for r in rows)
   == ["First Floor Plan", "Ground Floor Plan"],
   str([r.get("storeyTitle") for r in rows]))
ok("a single-storey schedule row carries no storey tag",
   "storeyTitle" not in room_schedule(SINGLE)["rooms"][0])


print("")
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
