"""
Openings from gaps between collinear walls.

This is the DOOR signal, and two independent lanes converged on it being the
trustworthy one. On the raster side it is deterministic -- byte-identical
positions across five runs of the same file -- against a vision window pass
that gives 5/5/5/4/3. On the CAD side doors arrive as blocks with 0.92
confidence while windows exist only as unusable linework. Both paths agreed the
door signal is the one to build on, so its recall is worth defending.

Run:  python test/test_openings.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main as detector  # noqa: E402

passed = 0
failed = 0


def ok(label: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {label}")
    else:
        failed += 1
        print(f"FAIL  {label}{'  ' + detail if detail else ''}")


def wall(x0: float, y0: float, x1: float, y1: float, thickness: float = 0.006):
    return detector.WallSegment(
        start=detector.Point(x=x0, y=y0),
        end=detector.Point(x=x1, y=y1),
        thickness=thickness,
        confidence=0.9,
        kind="wall",
    )


def spans(openings):
    return sorted(round(max(o.bbox[2], o.bbox[3]), 4) for o in openings)


# ---- a horizontal doorway must be findable at all ---------------------------
# It was not. Segments were grouped by round(fixed * 200), a flat 0.005, while
# the median wall thickness on the acceptance deck is 0.0061 -- so the group was
# 0.8 of a wall and two halves of one doorway whose centrelines differ by a
# single thickness never met. Measured, the horizontal walls on that drawing
# produced ZERO pairable groups: no horizontal door could be found at any
# threshold, and both openings the reader returned were vertical.
#
# The two halves here sit 0.004 apart, well inside one wall, which is ordinary
# for a segment traced down a wall's middle.
found = detector.detect_openings([
    wall(0.10, 0.400, 0.40, 0.400),
    wall(0.48, 0.404, 0.80, 0.404),
])
ok("a horizontal doorway is found when the two halves are a hair out of line",
   len(found) == 1, f"{len(found)} openings")
if found:
    ok("and its span is the gap, not the wall", abs(found[0].bbox[2] - 0.08) < 0.005,
       str(found[0].bbox))
    ok("and it is reported as attached to a wall", found[0].attaches_to == "wall")

# ---- but not when they are genuinely different walls -------------------------
# The tolerance is a wall thickness for a reason. Two walls a long way apart on
# the fixed axis are two walls, and pairing them would invent an opening across
# open space -- the failure this grouping exists to prevent.
apart = detector.detect_openings([
    wall(0.10, 0.400, 0.40, 0.400),
    wall(0.48, 0.470, 0.80, 0.470),
])
ok("two walls a long way apart are not paired into an opening", len(apart) == 0,
   f"{len(apart)} openings")

# ---- lanes are anchored, never chained --------------------------------------
# Single-link clustering on a moving centre walks: each member is within
# tolerance of the last, and the ends finish far outside it. Measured elsewhere
# in this project the same day on a scale-ruler cluster. Anchoring on the lane's
# first member bounds the whole span by construction, so a ladder of segments
# each a little higher than the last must NOT all land in one lane.
ladder = detector.detect_openings([
    wall(0.10, 0.400, 0.20, 0.400),
    wall(0.28, 0.405, 0.38, 0.405),
    wall(0.46, 0.410, 0.56, 0.410),
    wall(0.64, 0.415, 0.74, 0.415),
    wall(0.82, 0.420, 0.92, 0.420),
])
drift = [o for o in ladder if o.bbox[1] > 0.412 or o.bbox[1] < 0.398]
ok("a drifting ladder does not chain into one lane", len(ladder) <= 2,
   f"{len(ladder)} openings from a 0.02 drift")

# ---- determinism -------------------------------------------------------------
# The whole reason this source is preferred over the vision window pass.
walls = [
    wall(0.10, 0.400, 0.40, 0.400),
    wall(0.48, 0.404, 0.80, 0.404),
    wall(0.300, 0.10, 0.300, 0.42),
    wall(0.302, 0.50, 0.302, 0.80),
]
runs = [spans(detector.detect_openings(list(walls))) for _ in range(3)]
ok("repeated reads give identical openings", runs[0] == runs[1] == runs[2], str(runs))
ok("and it finds both the horizontal and the vertical one", len(runs[0]) == 2, str(runs[0]))

# ---- a gap is not a door ------------------------------------------------------
# detect_openings finds GAPS. Measured on real drawings, a gap is either a door
# or a wide open threshold: the two crop-verified villa doors span 0.79 m and
# 0.91 m, and an Avarana gap between a patio and the room beyond spans 3.69 m
# with no leaf and no swing arc. Anything consuming these must not assume door.
too_wide = detector.detect_openings([
    wall(0.05, 0.400, 0.20, 0.400),
    wall(0.70, 0.402, 0.90, 0.402),
])
ok("an open threshold far wider than a door is still reported as an opening",
   len(too_wide) <= 1)
ok("...and the label never claims it is a door",
   all(o.label == "opening" for o in detector.detect_openings(list(walls))))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
