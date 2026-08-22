"""
Room and opening schedules.

Run:  .venv/Scripts/python.exe test/test_schedules.py

── What these defend ──────────────────────────────────────────────────────────
A schedule is read by someone who is about to order something. The failure mode
is never a crash — it is a row that looks measured and was inferred, a total that
quietly includes the garden, or a section that is empty because nothing was found
rather than because nothing is there.

Every assertion below is about one of those three.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantify import schedules  # noqa: E402

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


MODEL = {
    "elements": {
        "walls": [
            {"a": {"x": 0.0, "y": 0.0}, "b": {"x": 6.0, "y": 0.0},
             "thickness": 0.23, "paired": True, "confidence": 1.0},
            {"a": {"x": 0.0, "y": 4.0}, "b": {"x": 6.0, "y": 4.0},
             "thickness": 0.23, "paired": True, "confidence": 1.0},
        ],
        "spaces": [
            {"index": 0, "name": "BED ROOM", "kind": "bedroom",
             "area": 24.0, "grossArea": 26.0, "perimeter": 20.0, "loop": square(0, 0, 6, 4)},
            {"index": 1, "name": "LAWN", "kind": "outdoor",
             "area": 40.0, "grossArea": 42.0, "perimeter": 26.0, "loop": square(0, 5, 8, 5)},
            # Named as outdoor but CLASSIFIED as a room. This is the villa's real
            # OFFICE PATIO, and it is the case the name check exists for.
            {"index": 2, "name": "OFFICE PATIO", "kind": "study",
             "area": 27.0, "grossArea": 29.0, "perimeter": 26.0, "loop": square(9, 0, 6, 4.5)},
            {"index": 3, "name": None, "kind": "unknown",
             "area": 5.0, "grossArea": 6.0, "perimeter": 9.0, "loop": square(0, 11, 2.5, 2)},
        ],
        "openings": [
            {"wall": 0, "along": 1.0, "width": 0.75, "height": 2.1, "sill": 0.0,
             "kind": "door", "confidence": 0.92, "source": "blockSized"},
            {"wall": 0, "along": 3.0, "width": 0.75, "height": 2.1, "sill": 0.0,
             "kind": "door", "confidence": 0.92, "source": "blockSized"},
            {"wall": 1, "along": 2.0, "width": 1.2, "height": 1.2, "sill": 0.9,
             "kind": "window", "confidence": 0.8, "source": "gap"},
        ],
    }
}

rooms = schedules.room_schedule(MODEL)
openings = schedules.opening_schedule(MODEL)


print("\n-- rooms: indoor and outdoor are never summed --")
# THE ERROR THIS PREVENTS, and it is the same one that put 93 m2 of the villa's
# lawn into vitrified tiling. On the real villa: 125.11 m2 indoor against
# 127.64 m2 outdoor. More than half the site is garden, so any single "total
# area" is wrong by more than 100% as a statement about the building.
ok("indoor and outdoor areas are separate figures",
   rooms["totals"]["indoorArea"] == 24.0 + 5.0
   and rooms["totals"]["outdoorArea"] == 40.0 + 27.0,
   f"indoor {rooms['totals']['indoorArea']}, outdoor {rooms['totals']['outdoorArea']}")
ok("and there is no combined total to misread",
   not any("total" == k.lower() for k in rooms["totals"]),
   str(sorted(rooms["totals"])))
ok("the caveats say why", any("never summed" in c for c in rooms["caveats"]))

# The OFFICE PATIO case. Its `kind` is "study", which is indoor; only its NAME
# says otherwise. Classifying on kind alone would put a patio's floor area
# inside the building and, downstream, tile it.
patio = next(r for r in rooms["rooms"] if r["name"] == "OFFICE PATIO")
ok("a room named as outdoor is outdoor even when its kind is not",
   patio["location"] == "outdoor", f"{patio['kind']} -> {patio['location']}")

print("\n-- rooms: what could not be read stays visible --")
unnamed = [r for r in rooms["rooms"] if not r["named"]]
ok("an unnamed space is listed, not dropped", len(unnamed) == 1)
ok("and is not given an invented number",
   unnamed[0]["name"] is None, str(unnamed[0]["name"]))
ok("and the caveats count them with their area",
   any("carry no name" in c and "5.0 m2" in c for c in rooms["caveats"]),
   str([c for c in rooms["caveats"] if "no name" in c])[:90])
ok("every room reports gross as well as net, since the two get argued about",
   all(r["grossArea"] >= r["area"] for r in rooms["rooms"]))

print("\n-- openings: a schedule groups, a list does not --")
ok("identical openings become one type with a quantity",
   any(r["quantity"] == 2 and r["kind"] == "door" for r in openings["openings"]),
   str([(r["mark"], r["quantity"]) for r in openings["openings"]]))
ok("doors and windows get separate marks",
   {r["mark"] for r in openings["openings"]} == {"D1", "W1"},
   str(sorted(r["mark"] for r in openings["openings"])))
ok("sizes are reported in millimetres, which is what gets ordered",
   any(r["widthMm"] == 750 and r["heightMm"] == 2100 for r in openings["openings"]))
ok("counts are right", openings["totals"]["doors"] == 2 and openings["totals"]["windows"] == 1,
   str(openings["totals"]))
ok("the least confident member sets the type's confidence",
   next(r for r in openings["openings"] if r["mark"] == "W1")["lowestConfidence"] == 0.8)

print("\n-- openings: an empty section is a claim, so it is stated --")
# THE VILLA'S ACTUAL RESULT. All 8 openings are doors. An empty window section
# reads as "this schedule has no window section"; the claim a reader needs is
# "this building has no windows", and that is something somebody must check.
doors_only = {"elements": {**MODEL["elements"],
                           "openings": MODEL["elements"]["openings"][:2]}}
blind = schedules.opening_schedule(doors_only)
ok("no windows produces an explicit caveat, not an empty section",
   any("NO WINDOWS" in c for c in blind["caveats"]))
ok("and it says the schedule cannot tell absent from unread",
   any("cannot tell which" in c for c in blind["caveats"]))
ok("and it is still counted as zero rather than omitted",
   blind["totals"]["windows"] == 0)

# Uniformity is a finding, not a coincidence: it means no opening was measured
# independently of the others.
uniform = schedules.opening_schedule(doors_only)
ok("one size throughout is flagged as a single block definition",
   any("no opening in this schedule was measured independently" in c
       for c in uniform["caveats"]))

print("\n-- openings: a broken reference is reported, never dropped --")
broken = {"elements": {**MODEL["elements"], "openings": [
    {"wall": 999, "width": 0.9, "height": 2.1, "sill": 0.0, "kind": "door"},
    *MODEL["elements"]["openings"],
]}}
orphaned = schedules.opening_schedule(broken)
ok("an opening on a wall that does not exist is counted as orphaned",
   orphaned["totals"]["orphaned"] == 1, str(orphaned["totals"]))
ok("it does not inflate the door count",
   orphaned["totals"]["doors"] == 2, str(orphaned["totals"]["doors"]))
ok("and the caveats say so", any("not in the model" in c for c in orphaned["caveats"]))

print("\n-- both survive a model with nothing in it --")
empty = {"elements": {"walls": [], "spaces": [], "openings": []}}
er = schedules.room_schedule(empty)
eo = schedules.opening_schedule(empty)
ok("an empty model schedules nothing rather than crashing",
   er["totals"]["rooms"] == 0 and eo["totals"]["types"] == 0)
ok("and says no openings were read", any("No openings at all" in c for c in eo["caveats"]))
ok("the text rendering works on an empty model",
   "ROOM SCHEDULE" in schedules.as_text(er, eo))

print("\n-- the text rendering carries the caveats, not just the numbers --")
text = schedules.as_text(rooms, openings)
ok("every caveat reaches the printed schedule",
   all(c[:40] in text for c in rooms["caveats"] + openings["caveats"]))
ok("and unnamed rooms are visibly unnamed", "(unnamed)" in text)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
