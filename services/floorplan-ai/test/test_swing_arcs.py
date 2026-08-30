"""
Doors from the swing arc the draughtsman drew.

`detect_openings` finds a GAP between two collinear walls, and a gap is an
ABSENCE. Measured on the owner's 1.png against an enumerated ground truth
(A:/Tools/FloorplanModel/realdecks/avarana-cottage3-1png.doors-groundtruth.md),
that method cannot reach most doors on that sheet, and not for the reason it
first appeared: the walls either side are NOT missing, the tracer runs one
continuous wall straight through the doorway. There are not two segments to
find a gap between, so no threshold on the opening code can help.

An arc is the other kind of evidence -- a mark made on purpose rather than an
absence. These fixtures are drawn rather than sampled, because a drawn fixture
can exercise the cases a real sheet happens not to contain: the oval that is the
only false positive ever observed, and the arc with no leaf.

Run:  .venv/Scripts/python.exe test/test_swing_arcs.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

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


WIDTH, HEIGHT = 900, 900
# 0.01 m/px, so a 0.9 m door is 90 px and the accepted radius band is 60..130.
SCALE = detector.PlanScale(
    metres_per_unit=WIDTH * 0.01, source="test", confidence=0.9, samples=1, spread=0.0
)


def blank() -> np.ndarray:
    return np.full((HEIGHT, WIDTH, 3), 245, np.uint8)


def wall(image, x0, y0, x1, y1, thickness=10):
    """A wall is a FILLED mass -- that is what separates it from a leaf."""
    cv2.rectangle(image, (x0, y0), (x1 + thickness, y1 + thickness), (40, 40, 40), -1)


def door(image, hx, hy, radius, leaf_angle, closed_angle):
    """A leaf drawn open, and the arc round to where it closes."""
    end = (int(hx + radius * np.cos(np.radians(leaf_angle))),
           int(hy + radius * np.sin(np.radians(leaf_angle))))
    cv2.line(image, (hx, hy), end, (30, 30, 30), 2)
    lo, hi = sorted((leaf_angle, closed_angle))
    cv2.ellipse(image, (hx, hy), (radius, radius), 0, lo, hi, (30, 30, 30), 1)


WALLS = [
    detector.WallSegment(
        start=detector.Point(x=0.1, y=0.4), end=detector.Point(x=0.9, y=0.4),
        thickness=0.011, confidence=0.9, kind="wall",
    )
]


def spans(openings):
    return [round(max(o.bbox[2] * WIDTH, o.bbox[3] * HEIGHT) * 0.01, 2) for o in openings]


def centres(openings):
    return [((o.bbox[0] + o.bbox[2] / 2) * WIDTH, (o.bbox[1] + o.bbox[3] / 2) * HEIGHT)
            for o in openings]


# ---- a door in a horizontal wall ---------------------------------------------
# Hinged at (400, 360), open upward, closing to the right along the wall. The
# opening is therefore the 90 px to the right of the hinge.
#
# NOTE THE GAP IN THE WALL. The drawing shows a break at every doorway; it is
# the wall TRACER that bridges it, which is why the arc pass exists at all. A
# first version of this fixture drew the wall straight through and the door was
# correctly refused: the "opening" ran through solid ink, which an opening does
# not.
image = blank()
wall(image, 100, 360, 400, 360)
wall(image, 490, 360, 800, 360)
door(image, 400, 360, 90, leaf_angle=-90, closed_angle=0)
found = detector.detect_swing_arcs(image, WALLS, SCALE)

ok("a drawn swing is found", len(found) == 1, f"{len(found)} openings")
if len(found) == 1:
    ok("and its width is the leaf length", spans(found) == [0.9], str(spans(found)))
    cx, cy = centres(found)[0]
    ok("and the opening is where the door CLOSES, not where the leaf is drawn",
       abs(cx - 445) < 12 and abs(cy - 360) < 12, f"({cx:.0f}, {cy:.0f})")

# ---- the leaf is not the opening ---------------------------------------------
# The failure this replaced. A first version chose the sweep end nearest a wall
# and got both real doors it found BACKWARDS, reporting the leaf's own line as
# the doorway -- the leaf lies against a wall too. Here the leaf points along
# the wall and the door closes across it, so the two are unambiguous.
image = blank()
wall(image, 100, 360, 800, 360)
wall(image, 400, 490, 400, 800)
door(image, 400, 400, 90, leaf_angle=0, closed_angle=90)
found = detector.detect_swing_arcs(image, WALLS, SCALE)
if len(found) == 1:
    cx, cy = centres(found)[0]
    ok("a leaf drawn along one axis puts the opening across the other",
       abs(cx - 400) < 12 and cy > 420, f"({cx:.0f}, {cy:.0f})")
else:
    ok("a leaf drawn along one axis puts the opening across the other", False,
       f"{len(found)} openings")

# ---- an oval is not a door ---------------------------------------------------
# The only false positive ever observed on a real sheet: the WC bowl. It is the
# right size and it is a thin closed curve, so nothing but the CIRCLE FIT
# separates it. Measured on 1.png, the real arcs sit on their circle at 0.24,
# 0.24 and 0.25 px rms and the bowl at 1.87 -- seven times worse.
image = blank()
wall(image, 100, 360, 800, 360)
cv2.ellipse(image, (400, 500), (85, 62), 0, 0, 360, (30, 30, 30), 2)
ok("a WC bowl is not a door", len(detector.detect_swing_arcs(image, WALLS, SCALE)) == 0,
   str(len(detector.detect_swing_arcs(image, WALLS, SCALE))))

# ---- an arc with no leaf is not a door ---------------------------------------
# A door is drawn as leaf AND sweep. A lone curve of door-ish radius is a
# worktop edge, a planter, the corner of a rug.
image = blank()
wall(image, 100, 360, 800, 360)
cv2.ellipse(image, (400, 500), (90, 90), 0, 0, 90, (30, 30, 30), 1)
ok("an arc with no leaf drawn is not a door",
   len(detector.detect_swing_arcs(image, WALLS, SCALE)) == 0)

# ---- a circle far too big to be a door ---------------------------------------
# A dining table, a turning circle, a compass rose. The radius band is 0.6-1.3 m
# and it is checked before anything expensive runs.
image = blank()
wall(image, 100, 360, 800, 360)
cv2.line(image, (400, 400), (400, 700), (30, 30, 30), 2)
cv2.ellipse(image, (400, 400), (300, 300), 0, 0, 90, (30, 30, 30), 1)
ok("a curve far wider than any door is ignored",
   len(detector.detect_swing_arcs(image, WALLS, SCALE)) == 0)

# ---- no walls at all -----------------------------------------------------------
# The wall list only supplies a thickness for the reported box. A drawing that
# produced no walls must not crash, and an arc found there is still an arc: the
# studio decides whether anything can be cut.
image = blank()
door(image, 400, 360, 90, leaf_angle=-90, closed_angle=0)
try:
    detector.detect_swing_arcs(image, [], SCALE)
    ok("no walls is not a crash", True)
except Exception as error:  # noqa: BLE001
    ok("no walls is not a crash", False, repr(error))

# ---- and a door is reported as an opening, never as a door ---------------------
# The same rule detect_openings follows. Downstream decides what to hang in it,
# using the measured width; a 3.69 m threshold gets no leaf.
image = blank()
wall(image, 100, 360, 400, 360)
wall(image, 490, 360, 800, 360)
door(image, 400, 360, 90, leaf_angle=-90, closed_angle=0)
found = detector.detect_swing_arcs(image, WALLS, SCALE)
# `found` is asserted non-empty first, because `all()` over nothing is True and
# these two would otherwise pass on a detector that found no doors at all.
ok("the label is 'opening'",
   len(found) > 0 and all(o.label == "opening" for o in found), f"{len(found)} found")
ok("and it carries more confidence than a gap, having been drawn on purpose",
   len(found) > 0 and all(o.confidence > 0.6 for o in found), f"{len(found)} found")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
