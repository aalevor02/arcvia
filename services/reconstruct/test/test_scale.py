"""
Catching a drawing read at the wrong unit.

Run:  .venv/Scripts/python.exe test/test_scale.py

A wrong unit is the most expensive defect this engine can ship, because nothing
about the output looks broken. `LATEST DRAWINGS` read at centimetres arrives
12.35 m across with 11 rooms and 0.074 m walls, and every check in verify.py
passed it: the span is an ordinary small building, and the thickness sits inside
the buildable band -- as does the 0.092 m the same drawing gives if read as
inches. Three plausible units, three plausible-looking models, one right answer.

What separates them is that a unit error is LINEAR in span and QUADRATIC in
area. A factor of 100 on the ruler is a factor of 10,000 on every room, and no
building has eleven rooms whose largest is under 7 m2.

So this file is about a check that looks at area precisely because the other two
cannot see it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hypothesise.pair import Wall  # noqa: E402
from solve import spaces as sp  # noqa: E402
from solve import verify as vf  # noqa: E402

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


def grid(rooms_across, rooms_up, room_w, room_h, thickness=0.115):
    """A block of rooms, each exactly room_w x room_h, on a regular grid."""
    walls = []
    width = rooms_across * room_w
    height = rooms_up * room_h
    for i in range(rooms_across + 1):
        x = i * room_w
        walls.append(Wall(ax=x, ay=0.0, bx=x, by=height, thickness=thickness,
                          paired=True, confidence=0.9, layer="A1 WALLS"))
    for j in range(rooms_up + 1):
        y = j * room_h
        walls.append(Wall(ax=0.0, ay=y, bx=width, by=y, thickness=thickness,
                          paired=True, confidence=0.9, layer="A1 WALLS"))
    return walls


def report(walls):
    spaces = sp.detect_spaces(walls)
    return spaces, vf.check(input_segments=len(walls), walls=walls,
                            spaces=spaces, openings=[], unhosted=0)


def named(verdict, name):
    return [c for c in verdict.checks if c.name == name]


print("-- the same building at two units --")

# Six rooms of 4 x 3 m: an ordinary small dwelling.
right = grid(3, 2, 4.0, 3.0)
right_spaces, right_report = report(right)
ok("a plan at the correct unit solves rooms of a normal size",
   len(right_spaces) >= 4 and max(s.area for s in right_spaces) > vf.MIN_LARGEST_ROOM,
   f"{len(right_spaces)} rooms, largest "
   f"{max(s.area for s in right_spaces):.1f} m2")
ok("and is not flagged for scale",
   not any(c.level == "warning" for c in named(right_report, "room-size")),
   str([c.value for c in named(right_report, "room-size")]))

# The same plan mis-scaled, sized to land where the real failure lands rather
# than where a naive 100x would. On LATEST DRAWINGS the centimetre reading does
# not produce sub-millimetre rooms: the frame segmentation collapses the whole
# site into one 12.35 m "building" and solves 11 rooms averaging 4.98 m2, the
# largest 6.87. Rooms two orders of magnitude too small would be caught by the
# room detector's own minimum area, so they never reach verify -- the dangerous
# band is exactly this one, small enough to be wrong and large enough to solve.
#
# Thickness is scaled too, because a unit error scales everything. 0.06 m is
# what makes this invisible: it is a plausible partition, and it sits inside
# PLAUSIBLE_THICKNESS just as the real drawing's 0.074 m does.
wrong = grid(3, 2, 2.5, 2.0, thickness=0.06)
wrong_spaces, wrong_report = report(wrong)
ok("a mis-scaled plan still solves the same number of rooms",
   len(wrong_spaces) == len(right_spaces),
   f"{len(wrong_spaces)} vs {len(right_spaces)}")
ok("so room COUNT cannot tell the two apart",
   len(wrong_spaces) == len(right_spaces) and len(wrong_spaces) >= 4,
   f"{len(wrong_spaces)} rooms either way")
ok("but the largest room lands under the threshold",
   max(s.area for s in wrong_spaces) < vf.MIN_LARGEST_ROOM,
   f"{max(s.area for s in wrong_spaces):.1f} m2 vs "
   f"{max(s.area for s in right_spaces):.1f} m2 correct")
ok("so the wrong unit IS flagged",
   any(c.level == "warning" for c in named(wrong_report, "room-size")),
   str([c.message[:50] for c in named(wrong_report, "room-size")]))


print("\n-- why span and thickness cannot do this job --")

# The two checks that already exist both pass the wrong-unit model. This is the
# reason the area check earns its place rather than duplicating them; if either
# of these starts failing, this check is redundant and should go.
span_check = named(wrong_report, "plan-span")
ok("the span check passes a wrong-unit plan",
   span_check and span_check[0].level == "info",
   f"span {span_check[0].value if span_check else '?'} m")

thick = named(wrong_report, "median-thickness")
ok("and so does the thickness check, at 0.06 m",
   thick and thick[0].level == "info",
   f"{thick[0].value if thick else '?'} m")
ok("because 0.05-0.60 m has to admit a real stud partition",
   vf.PLAUSIBLE_THICKNESS[0] <= 0.075,
   str(vf.PLAUSIBLE_THICKNESS))


print("\n-- the check does not fire on things that are merely small --")

# One small room is a legitimate building: a guard hut, a plant enclosure, a
# single toilet. Refusing those would cost more than the check is worth.
tiny = grid(1, 1, 2.5, 2.0)
tiny_spaces, tiny_report = report(tiny)
ok("a single small structure is not called a scale error",
   not any(c.level == "warning" for c in named(tiny_report, "room-size")),
   f"{len(tiny_spaces)} room(s)")
ok("because the check needs several rooms before it judges",
   vf.MIN_ROOMS_TO_JUDGE_SCALE >= 3, str(vf.MIN_ROOMS_TO_JUDGE_SCALE))

# And the threshold is an order of magnitude off the real data, not a fine call:
# 58.1 / 70.3 / 82.7 m2 on correctly-read drawings against 6.9 m2 on the wrong
# one. A band that needed tuning between those would not be worth trusting.
ok("the threshold sits an order of magnitude below real largest rooms",
   vf.MIN_LARGEST_ROOM < 58.1 / 4, f"{vf.MIN_LARGEST_ROOM} m2")
ok("and well above the wrong-unit case it has to catch",
   vf.MIN_LARGEST_ROOM > 6.87, f"{vf.MIN_LARGEST_ROOM} m2")

# A too-big largest room already means something else — undetected partitions —
# and must keep reporting that instead.
huge = grid(1, 1, 20.0, 15.0)
huge_spaces, huge_report = report(huge)
big = named(huge_report, "room-size")
ok("an oversized room still reports as missing partitions, not as scale",
   big and "dividing walls" in big[0].message,
   str([c.message[:40] for c in big]))


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
