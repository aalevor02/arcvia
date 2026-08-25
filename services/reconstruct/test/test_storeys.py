"""
Deciding that two drawings are two storeys of one building.

Run:  .venv/Scripts/python.exe test/test_storeys.py

── What this defends ───────────────────────────────────────────────────────────
Two storeys of one villa and two identical villa units side by side on a site
plan are the SAME PICTURE — same footprint, same alignment, same spacing. An
independent pass proved it by building both from one helper and comparing the
wall lists elementwise: not similar inputs, the same input. So geometry may
propose and only text may confirm, and a group the drawing did not name is
refused rather than guessed.

The other half is order. On the real villa the frame HIGHER on the sheet is
'Lower Ground Floor Plan' and the one LOWER is 'Ground Floor Plan' — sheet
layout is inverted against storey order. Anything ranking by position puts the
lawn upstairs.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from solve.storeys import (  # noqa: E402
    DEFAULT_STOREY_RISE,
    classify_level,
    register_storeys,
)

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


@dataclass
class FakeFrame:
    index: int
    bbox: tuple[float, float, float, float]
    title: str | None = None
    cuts: list = field(default_factory=list)
    level_hint: float | None = None
    level_label: str | None = None


print("-- what a title says the level is --")
ok("ground is the datum", classify_level("Ground Floor Plan") == 0)
ok("first is above it", classify_level("First Floor Plan") == 1)
ok("basement is below it", classify_level("Basement Plan") == -1)

# THE ORDERING BUG THIS PREVENTS. 'lower ground' contains 'ground', so a
# shortest-match-first table scores it as the ground floor — and the storey that
# is actually underneath gets stacked on top. Silent, and it puts the lawn
# upstairs.
ok("'lower ground' is BELOW ground, not equal to it",
   classify_level("Lower Ground Floor Plan") == -1,
   str(classify_level("Lower Ground Floor Plan")))
ok("and a mezzanine sits between two floors",
   0 < classify_level("Mezzanine Floor Plan") < 1)
ok("a roof is above everything", classify_level("Roof Plan") > 10)

# 'TYPICAL FLOOR PLAN' names a REPEATED level, not a specific one. It cannot be
# ordered against a ground floor, so refusing is correct — an apartment sheet
# full of them should say so rather than stack an arbitrary guess.
ok("'typical' is not a level", classify_level("TYPICAL FLOOR PLAN") is None)
ok("a site plan is not a level", classify_level("Site Plan") is None)
ok("and neither is nothing", classify_level(None) is None)


print("\n-- stair directions can order an untitled two-storey house --")
stairs = [
    FakeFrame(0, (0, 0, 10, 8), level_hint=0, level_label="Lower level (stair UP)"),
    FakeFrame(1, (15, 0, 25, 8), level_hint=1, level_label="Upper level (stair DOWN)"),
]
stair_result = register_storeys(stairs)
ok("UP and DOWN provide two relative levels",
   stair_result.as_dict()["storeys"] == 2, str(stair_result.as_dict()))
ok("the UP plan is below the DOWN plan",
   [s.frame_index for s in stair_result.stacks[0]] == [0, 1])
ok("relative labels remain visible in the model",
   [s.title for s in stair_result.stacks[0]]
   == ["Lower level (stair UP)", "Upper level (stair DOWN)"])


print("\n-- the villa: two storeys, one building --")
# The real geometry. Frame 0 is HIGHER on the sheet (y 317.5..332.6) and is the
# LOWER storey; frame 1 is lower on the sheet and is the ground floor.
villa = [
    FakeFrame(0, (90.63, 317.51, 111.44, 332.61), "Lower Ground Floor Plan"),
    FakeFrame(1, (90.63, 299.94, 111.44, 315.04), "Ground Floor Plan"),
]
result = register_storeys(villa)
ok("two congruent named drawings become one building",
   len(result.stacks) == 1, str(len(result.stacks)))
ok("with two storeys in it", result.as_dict()["storeys"] == 2)
ok("and nothing refused", not result.refusals, str(result.refusals))

stack = result.stacks[0]
ok("ordered by TITLE, not by position on the sheet",
   [s.title for s in stack] == ["Lower Ground Floor Plan", "Ground Floor Plan"],
   str([s.title for s in stack]))
ok("so the frame HIGHER on the paper is placed BELOW",
   stack[0].frame_index == 0 and stack[0].base_z < stack[1].base_z,
   f"frame {stack[0].frame_index} at z={stack[0].base_z}")
ok("the ground floor is the datum at z=0",
   next(s.base_z for s in stack if s.level == 0) == 0.0)
ok("and the storey below it is one rise down",
   abs(next(s.base_z for s in stack if s.level == -1) + DEFAULT_STOREY_RISE) < 1e-9,
   str(next(s.base_z for s in stack if s.level == -1)))


print("\n-- it refuses rather than guessing --")
# The case geometry CANNOT distinguish: two identical villa units side by side.
# Same footprint, same alignment. Only the titles differ — and here they do not.
twins = [
    FakeFrame(0, (0, 0, 20, 15), "Ground Floor Plan"),
    FakeFrame(1, (0, 20, 20, 35), "Ground Floor Plan"),
]
twin_result = register_storeys(twins)
ok("two drawings claiming the SAME level are not stacked",
   not twin_result.stacks and len(twin_result.refusals) == 1,
   str(twin_result.as_dict()))
ok("and the refusal says why",
   "same level" in twin_result.refusals[0].reason,
   twin_result.refusals[0].reason)

partly = [
    FakeFrame(0, (0, 0, 20, 15), "Ground Floor Plan"),
    FakeFrame(1, (0, 20, 20, 35), "First Floor Plan"),
    FakeFrame(2, (0, 40, 20, 55), None),
]
part_result = register_storeys(partly)
ok("a group where one drawing is unnamed is refused WHOLE",
   not part_result.stacks and len(part_result.refusals) == 1,
   str(part_result.as_dict()))
# Stacking the two we understand would quietly drop the third from the building.
ok("all three are named in the refusal, not just the unnamed one",
   part_result.refusals[0].frames == [0, 1, 2],
   str(part_result.refusals[0].frames))

lone = register_storeys([FakeFrame(0, (0, 0, 20, 15), "Ground Floor Plan")])
ok("a single drawing is not a stack", not lone.stacks and not lone.refusals)


print("\n-- geometry proposes, and it is allowed to be wrong --")
# Very different footprints are not one building, whatever they are called.
unlike = [
    FakeFrame(0, (0, 0, 20, 15), "Ground Floor Plan"),
    FakeFrame(1, (40, 0, 44, 18), "First Floor Plan"),
]
ok("drawings with unlike footprints are not grouped",
   not register_storeys(unlike).stacks)

# But an upper floor is ROUTINELY smaller than the one below — setbacks,
# terraces, a roof over a single-storey wing. A tight congruence test rejects
# exactly the buildings this is for.
setback = [
    FakeFrame(0, (0, 0, 20, 15), "Ground Floor Plan"),
    FakeFrame(1, (0, 20, 16, 32), "First Floor Plan"),
]
ok("but a setback upper floor still groups",
   len(register_storeys(setback).stacks) == 1,
   str(register_storeys(setback).as_dict()))

print("\n-- three storeys order correctly --")
three = [
    FakeFrame(0, (0, 40, 20, 55), "Second Floor Plan"),
    FakeFrame(1, (0, 0, 20, 15), "Ground Floor Plan"),
    FakeFrame(2, (0, 20, 20, 35), "First Floor Plan"),
]
tall = register_storeys(three).stacks[0]
ok("ordered ground, first, second regardless of frame order",
   [s.level for s in tall] == [0, 1, 2], str([s.level for s in tall]))
ok("and stacked at one rise each",
   [s.base_z for s in tall] == [0.0, DEFAULT_STOREY_RISE, 2 * DEFAULT_STOREY_RISE],
   str([s.base_z for s in tall]))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
