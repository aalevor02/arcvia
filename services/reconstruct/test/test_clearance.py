"""
Clearance checks.

Run:  .venv/Scripts/python.exe test/test_clearance.py

Synthetic geometry, because a clearance of "about 300 mm" has to be checkable
against a number somebody chose. On a real drawing every figure is arguable.

The case worth protecting most is the door with furniture on ONE side. The
reconstruction does not know which way a leaf hangs, so that door is fine — the
leaf goes the other way. A checker that reported it would flag roughly half the
doors in every building and be switched off within a day.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.catalogue_dims import CATALOGUE_DIMS  # noqa: E402
from solve import clearance  # noqa: E402

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
    return {"a": {"x": ax, "y": ay}, "b": {"x": bx, "y": by},
            "thickness": t, "paired": True}


def fixture(item, x, y, rot=0.0):
    return {"label": "fixture", "item": item, "position": {"x": x, "y": y},
            "rotation": rot, "footprint": {"w": 1.0, "d": 1.0}}


def room(index, loop, area, name=None, kind="unknown"):
    return {"index": index, "loop": loop, "area": area, "name": name, "kind": kind}


def model(walls=(), spaces=(), openings=(), fixtures=()):
    return {"elements": {"walls": list(walls), "spaces": list(spaces),
                         "openings": list(openings), "fixtures": list(fixtures)}}


def kinds(issues):
    return [i.kind for i in issues]


# A 6 x 5 m room. South wall is index 0, so openings host on it.
ROOM = [(0, 0), (6, 0), (6, 5), (0, 5)]
WALLS = [wall(0, 0, 6, 0), wall(6, 0, 6, 5), wall(6, 5, 0, 5), wall(0, 5, 0, 0)]
SPACES = [room(0, ROOM, 30.0, "BEDROOM", "bedroom")]
DOOR = {"kind": "door", "wall": 0, "along": 3.0, "width": 0.9,
        "height": 2.1, "sill": 0.0}


print("\n-- door swings --")
# Furniture on the inside only. The leaf hangs outward; this is not a problem.
one_side = clearance.check(
    model(WALLS, SPACES, [DOOR], [fixture("wardrobe", 3.0, 0.75)]),
    CATALOGUE_DIMS,
)
ok("a door blocked on ONE side is not reported",
   "swing-blocked" not in kinds(one_side),
   str(kinds(one_side)))

# Furniture both sides. Whichever way it hangs, it hits something.
both = clearance.check(
    model(WALLS, SPACES, [DOOR],
          [fixture("wardrobe", 3.0, 0.75), fixture("wardrobe", 3.0, -0.75)]),
    CATALOGUE_DIMS,
)
ok("a door blocked on BOTH sides is reported",
   "swing-blocked" in kinds(both), str(kinds(both)))

blocked = next(i for i in both if i.kind == "swing-blocked")
ok("and it is blocking, not a note", blocked.severity == "blocking", blocked.severity)
ok("and it says how much is obstructed", blocked.measured and blocked.measured > 0,
   str(blocked.measured))

clear = clearance.check(model(WALLS, SPACES, [DOOR], []), CATALOGUE_DIMS)
ok("a clear door is not reported", "swing-blocked" not in kinds(clear))


print("\n-- things in the same place --")
# Two beds a hand's width apart: the same bed, imported twice.
twice = clearance.check(
    model(WALLS, SPACES, [DOOR],
          [fixture("bed-queen", 3.0, 2.5), fixture("bed-queen", 3.1, 2.5)]),
    CATALOGUE_DIMS,
)
ok("two objects in the same place are reported",
   "overlap" in kinds(twice), str(kinds(twice)))
overlap = next(i for i in twice if i.kind == "overlap")
ok("it is blocking", overlap.severity == "blocking")
ok("and names both", len(overlap.items) == 2, str(overlap.items))

apart = clearance.check(
    model(WALLS, SPACES, [DOOR],
          [fixture("bed-single", 1.2, 2.5), fixture("bed-single", 4.8, 2.5)]),
    CATALOGUE_DIMS,
)
ok("two objects that merely stand near each other are not",
   "overlap" not in kinds(apart), str(kinds(apart)))


print("\n-- furniture inside a wall --")
inwall = clearance.check(
    model(WALLS, SPACES, [DOOR], [fixture("wardrobe", 3.0, 0.0)]),
    CATALOGUE_DIMS,
)
ok("a fixture standing in a wall is reported",
   "in-wall" in kinds(inwall), str(kinds(inwall)))
note = next((i for i in inwall if i.kind == "in-wall"), None)
ok("as a NOTE — it points at the import, not the layout",
   note is not None and note.severity == "note",
   note.severity if note else "missing")


print("\n-- room to use it --")
# A wardrobe facing a wall 0.3 m away. It wants 0.75 m.
tight = clearance.check(
    model([wall(0, 0, 6, 0), wall(0, 1.0, 6, 1.0), wall(6, 0, 6, 5), wall(0, 5, 0, 0)],
          SPACES, [], [fixture("wardrobe", 3.0, 0.4, rot=0.0)]),
    CATALOGUE_DIMS,
)
approach = next((i for i in tight if i.kind == "tight-approach"), None)
ok("a wardrobe with nowhere to open is reported", approach is not None,
   str(kinds(tight)))
if approach:
    ok("it reports the working figure it used",
       abs((approach.wanted or 0) - 0.75) < 1e-9, str(approach.wanted))
    ok("and the depth actually left, in a number you can act on",
       approach.measured is not None and 0 <= approach.measured < 0.75,
       f"{(approach.measured or 0) * 1000:.0f} mm")
    ok("the message quotes millimetres", "mm" in approach.message)

roomy = clearance.check(
    model(WALLS, SPACES, [], [fixture("wardrobe", 3.0, 2.5)]),
    CATALOGUE_DIMS,
)
ok("a wardrobe with room in front is not reported",
   "tight-approach" not in kinds(roomy), str(kinds(roomy)))


print("\n-- no way in --")
shut = clearance.check(
    model(WALLS, [room(0, ROOM, 30.0, "STORE", "store")], [DOOR],
          [fixture("wardrobe", 1.0, 4.0)]),
    CATALOGUE_DIMS,
)
# The door hosts on wall 0 and its inside zone lands in the room, so this room
# IS served — the check should stay quiet.
ok("a room its door opens into is not reported",
   "no-door" not in kinds(shut), str(kinds(shut)))

# A second room nothing opens into.
two_rooms = clearance.check(
    model(WALLS,
          [room(0, ROOM, 30.0, "BEDROOM", "bedroom"),
           room(1, [(10, 10), (14, 10), (14, 13), (10, 13)], 12.0, "STORE", "store")],
          [DOOR], []),
    CATALOGUE_DIMS,
)
ok("a room nothing opens into is reported",
   "no-door" in kinds(two_rooms), str(kinds(two_rooms)))

outdoors = clearance.check(
    model(WALLS,
          [room(0, ROOM, 30.0, "BEDROOM", "bedroom"),
           room(1, [(10, 10), (14, 10), (14, 13), (10, 13)], 12.0, "LAWN", "outdoor")],
          [DOOR], []),
    CATALOGUE_DIMS,
)
ok("but a lawn is not expected to have a door",
   "no-door" not in kinds(outdoors), str(kinds(outdoors)))


print("\n-- the report refuses to judge --")
summary = clearance.summarise(both)
ok("it counts findings", summary["total"] == len(both), str(summary["total"]))
ok("it grades severity", set(summary) >= {"blocking", "tight", "notes", "byKind"})
ok("there is NO ok/pass/score field — that decision is not ours",
   not ({"ok", "pass", "passed", "score", "compliant"} & set(summary)),
   str(sorted(summary)))
ok("and it states what it is not",
   "not a compliance check" in summary["basis"].lower(), summary["basis"][:44])

for issue in both:
    ok_words = "compliant" not in issue.message.lower() and "violation" not in issue.message.lower()
    if not ok_words:
        break
ok("no finding claims compliance or a violation",
   all("compliant" not in i.message.lower() and "violation" not in i.message.lower()
       for i in both))


print("\n-- empty input --")
ok("an empty model yields nothing rather than throwing",
   clearance.check(model(), CATALOGUE_DIMS) == [])


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
