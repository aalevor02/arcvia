"""
Openings drawn as a THINNING of the wall rather than a gap in it.

The third door signal, and the one that reaches what the other two cannot. A
gap is an absence and a swing is a mark; a lift door and a glazed slider are
neither. Measured against an enumerated ground truth
(A:/Tools/FloorplanModel/realdecks/avarana-cottage3-1png.doors-groundtruth.md),
gaps and arcs together reach 4 of the 7 doorways on that sheet and this pass
takes it to 7 of 7 with no false positive.

It is also the signal that most nearly shipped wrong. Thinning ALONE scores
3 of 14; every one of the extra tests below was added because something
measurable failed without it, and the fixtures here are drawn so each can be
exercised on its own.

Run:  .venv/Scripts/python.exe test/test_glazed_openings.py
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


WIDTH, HEIGHT = 800, 800
SCALE = detector.PlanScale(
    metres_per_unit=WIDTH * 0.01, source="test", confidence=0.9, samples=1, spread=0.0
)  # 0.01 m/px


def blank():
    return np.full((HEIGHT, WIDTH, 3), 245, np.uint8)


def solid_wall(image, x0, y0, x1, y1):
    cv2.rectangle(image, (x0, y0), (x1, y1), (40, 40, 40), -1)


def glazing(image, x0, y0, x1, y1):
    """Two thin lines with white between: how glazing is drawn."""
    cv2.rectangle(image, (x0, y0), (x1, y1), (255, 255, 255), -1)
    cv2.line(image, (x0, y0 + 1), (x1, y0 + 1), (40, 40, 40), 2)
    cv2.line(image, (x0, y1 - 1), (x1, y1 - 1), (40, 40, 40), 2)


def room(name, x0, y0, x1, y1):
    return detector.Room(
        polygon=[
            detector.Point(x=x0 / WIDTH, y=y0 / HEIGHT),
            detector.Point(x=x1 / WIDTH, y=y0 / HEIGHT),
            detector.Point(x=x1 / WIDTH, y=y1 / HEIGHT),
            detector.Point(x=x0 / WIDTH, y=y1 / HEIGHT),
        ],
        area=0.2, name=name, kind="room", size=None, also=[],
    )


WALL_Y = 400
WALL_T = 18
WALLS = [
    detector.WallSegment(
        start=detector.Point(x=0.1, y=WALL_Y / HEIGHT),
        end=detector.Point(x=0.9, y=WALL_Y / HEIGHT),
        thickness=WALL_T / WIDTH, confidence=0.9, kind="wall",
    )
]
ABOVE = room("Bedroom", 80, 150, 720, WALL_Y - 2)
BELOW = room("Balcony", 80, WALL_Y + WALL_T + 2, 720, 700)


def wall_with(gap_from=None, gap_to=None, glazed=True):
    image = blank()
    solid_wall(image, 80, WALL_Y, 720, WALL_Y + WALL_T)
    if gap_from is not None:
        if glazed:
            glazing(image, gap_from, WALL_Y, gap_to, WALL_Y + WALL_T)
        else:
            # A wall that is simply THINNER here: one solid band, no white.
            cv2.rectangle(image, (gap_from, WALL_Y), (gap_to, WALL_Y + WALL_T),
                          (255, 255, 255), -1)
            cv2.rectangle(image, (gap_from, WALL_Y + 6), (gap_to, WALL_Y + 12),
                          (40, 40, 40), -1)
    return image


def spans(found):
    return [round(max(o.bbox[2] * WIDTH, o.bbox[3] * HEIGHT) * 0.01, 2) for o in found]


# ---- a glazed section between two rooms is an opening ------------------------
found = detector.detect_glazed_openings(
    wall_with(300, 480), WALLS, [ABOVE, BELOW], SCALE)
ok("a glazed section of wall is found", len(found) == 1, f"{len(found)} found")
if found:
    ok("and its span is the glazing, not the wall",
       abs(spans(found)[0] - 1.8) <= 0.03, str(spans(found)))
    ok("and it is reported as an opening", found[0].label == "opening")
    ok("with less confidence than a drawn swing, being an inference",
       found[0].confidence < 0.85)

# ---- a wall that is merely thinner is NOT an opening -------------------------
# The test that took this from 3-in-14 to usable. A thinning on its own says
# nothing: measured on 1.png, solid wall with a wardrobe elevation drawn
# alongside it reads as thin, and so does wall beside a planter. Glazing is
# drawn as two lines with white between; a thinner wall is ONE band.
thinner = detector.detect_glazed_openings(
    wall_with(300, 480, glazed=False), WALLS, [ABOVE, BELOW], SCALE)
ok("a wall that is simply thinner here is not an opening",
   len(thinner) == 0, f"{len(thinner)} found")

# ---- an opening must lead somewhere, and somewhere else ----------------------
# This is what keeps WINDOWS out of the geometry. An exterior window has open
# ground on one side and no region there, so it never qualifies. Windows are
# deliberately not converted -- the vision pass returned 5, 5, 5, 4 and 3 over
# five reads of one file -- and this pass must not smuggle them in.
outside = detector.detect_glazed_openings(wall_with(300, 480), WALLS, [ABOVE], SCALE)
ok("glazing with nothing on the far side is a window, and is left alone",
   len(outside) == 0, f"{len(outside)} found")

same = detector.detect_glazed_openings(
    wall_with(300, 480), WALLS, [room("Bedroom", 80, 150, 720, 700)], SCALE)
ok("and glazing with the SAME space both sides is not a way through",
   len(same) == 0, f"{len(same)} found")

# ---- a mullion does not make two openings -----------------------------------
# A slider is drawn with a solid post between its panels. Unmerged, the owner's
# BED-2 slider measured 1.76 m against a true 2.94 m -- 40% short -- and its far
# panel looked like a separate detection.
split = wall_with(250, 530)
cv2.rectangle(split, (388, WALL_Y), (398, WALL_Y + WALL_T), (40, 40, 40), -1)
merged = detector.detect_glazed_openings(split, WALLS, [ABOVE, BELOW], SCALE)
ok("a mullion does not split one slider into two openings",
   len(merged) == 1, f"{len(merged)} found")
if merged:
    ok("and the span covers the whole slider, not one panel",
       spans(merged)[0] > 2.4, str(spans(merged)))

# ---- an opening needs a pier at each end ------------------------------------
# Glazing running off the end of the wall is where the wall STOPS, which the
# gap pass already reports. Cutting it here would report it twice.
to_the_end = blank()
solid_wall(to_the_end, 80, WALL_Y, 720, WALL_Y + WALL_T)
glazing(to_the_end, 560, WALL_Y, 720, WALL_Y + WALL_T)
ok("glazing running off the end of a wall is not cut",
   len(detector.detect_glazed_openings(to_the_end, WALLS, [ABOVE, BELOW], SCALE)) == 0)

# ---- nothing to work with ----------------------------------------------------
plain = wall_with()
ok("a solid wall yields nothing",
   len(detector.detect_glazed_openings(plain, WALLS, [ABOVE, BELOW], SCALE)) == 0)
ok("no rooms is not a crash",
   detector.detect_glazed_openings(wall_with(300, 480), WALLS, [], SCALE) == [])
ok("no walls is not a crash",
   detector.detect_glazed_openings(wall_with(300, 480), [], [ABOVE, BELOW], SCALE) == [])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
