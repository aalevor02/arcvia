"""
The raster adapter against ground truth, with no detector running.

Run:  .venv/Scripts/python.exe test/test_raster_plangraph.py

`ingest/raster.py`'s hard-won finding is that a detector's wall list is MIXED:
some segments arrive as measured poché bands (already a wall), some as single
hairline strokes (one face, partner elsewhere in the list), and the thickness
is the per-segment discriminator. The live detector is a service on :8090 and
is usually not running where tests run — so this test builds the
DetectionResult itself, from the KIT-institute ground truth, with the mix made
explicit: alternating walls arrive as a band or as two hairline strokes at
±thickness/2. `raster.detect` is monkeypatched; everything downstream of the
HTTP call — normalised→metres conversion with the aspect correction, the
75 mm band/hairline split, pairing of the strokes, corner joining, perimeter,
rooms — is the real code.

What it pins:
* the y-flip and aspect correction survive a round trip — walls land within
  centimetres of where the ground truth put them, or every plan is silently
  stretched (the exact failure the conversion comment warns about);
* hairline strokes pair back into the walls they were split from;
* pre-paired bands are NOT paired again (a band re-entering `pair_faces`
  can consume a stroke and drop a wall);
* the whole thing still encloses rooms.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json  # noqa: E402

from hypothesise.pair import join_corners, pair_faces  # noqa: E402
from hypothesise.perimeter import add_perimeter  # noqa: E402
from ingest import raster  # noqa: E402
from solve.spaces import detect_spaces  # noqa: E402

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


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "plangraph" / \
    "kit-institute--Erdgeschoss.json"
DOC = json.loads(FIXTURE.read_text(encoding="utf-8"))

# The synthetic sheet: 1000 x 800 px, and a scale chosen so the 42 x 16 m
# building sits inside with a metre of margin. metres_per_unit converts a
# normalised X distance, exactly as the live detector reports it.
PX_W, PX_H = 1000, 800
MPU = 44.0
ASPECT = PX_H / PX_W          # to_world: y_m = (1 - y_n) * aspect * mpu


def to_norm(x_m: float, y_m: float) -> dict:
    return {"x": (x_m + 1.0) / MPU, "y": 1.0 - (y_m + 1.0) / (ASPECT * MPU)}


def gt_walls():
    out = []
    for w in DOC["walls"]:
        t = w.get("thickness")
        if t is None or not (0.075 <= t <= 0.45):
            continue
        for a, b in zip(w["pts"], w["pts"][1:]):
            if math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.5:
                out.append((tuple(a), tuple(b), t))
    return out


def fake_detection() -> dict:
    """The DetectionResult the live service would have returned."""
    walls = []
    for index, (a, b, t) in enumerate(gt_walls()):
        if index % 2 == 0:
            # A measured poché band: thickness in normalised-x units.
            walls.append({"start": to_norm(*a), "end": to_norm(*b),
                          "thickness": t / MPU, "confidence": 0.9})
        else:
            # Two hairline strokes at the faces; ~0.04 m of "ink" thickness,
            # safely under the 75 mm build floor.
            dx, dy = b[0] - a[0], b[1] - a[1]
            n = math.hypot(dx, dy)
            px, py = -dy / n, dx / n
            for side in (0.5, -0.5):
                ox, oy = px * t * side, py * t * side
                walls.append({
                    "start": to_norm(a[0] + ox, a[1] + oy),
                    "end": to_norm(b[0] + ox, b[1] + oy),
                    "thickness": 0.001, "confidence": 0.8,
                })
    rooms = [
        {"polygon": [to_norm(x, y) for x, y in r["poly"]],
         "name": r.get("name"), "kind": None, "area": None}
        for r in DOC.get("rooms", []) if len(r.get("poly", [])) >= 3
    ]
    return {
        "width": PX_W, "height": PX_H,
        "walls": walls, "rooms": rooms, "objects": [],
        "scale": {"metres_per_unit": MPU, "samples": 3, "spread": 0.01},
        "low_confidence": False,
    }


PAYLOAD = fake_detection()
raster.detect = lambda image_path, url=None, timeout=600: PAYLOAD
reading = raster.read("synthetic-kit.png")

bands = sum(1 for i in range(len(gt_walls())) if i % 2 == 0)
strokes = 2 * (len(gt_walls()) - bands)

print("-- the split is per segment, exactly as measured on real drawings --")
ok("bands arrive pre-paired", len(reading.walls) == bands,
   f"{len(reading.walls)} of {bands}")
ok("hairline strokes arrive as faces", len(reading.faces) == strokes,
   f"{len(reading.faces)} of {strokes}")
ok("scale is trustworthy at 3 samples / 1% spread", reading.scale_trustworthy)
ok("rooms carried through with names",
   sum(1 for r in reading.rooms if r.get("name")) >= 15,
   str(len(reading.rooms)))

print("-- the round trip does not stretch the plan --")
# The sheet places the building 1 m in from the corner, and to_world has no
# reason to undo that — so the comparison is against ground truth PLUS the
# margin. A uniform translation is harmless; what this hunts is the aspect
# failure, where x and y scale differently and the error grows with position.
worst = 0.0
for (a, b, t), segment in zip(
    [g for i, g in enumerate(gt_walls()) if i % 2 == 0],
    reading.walls,
):
    worst = max(worst,
                math.hypot(segment.ax - (a[0] + 1), segment.ay - (a[1] + 1)),
                math.hypot(segment.bx - (b[0] + 1), segment.by - (b[1] + 1)))
ok("band endpoints within 2 cm of ground truth (+margin)", worst < 0.02,
   f"worst {worst:.4f} m")
thick_err = max(
    abs(segment.thickness - t)
    for ((_a, _b, t), segment) in zip(
        [g for i, g in enumerate(gt_walls()) if i % 2 == 0], reading.walls)
)
ok("band thickness survives the unit round trip", thick_err < 1e-6,
   f"worst {thick_err:.2e}")

print("-- strokes pair, bands are left alone, rooms enclose --")
paired = pair_faces(reading.faces)
walls = join_corners(paired + reading.walls)
walls = add_perimeter(walls)
walls = join_corners(walls)
spaces = detect_spaces(walls)

# Wall COUNT is the wrong assertion here: two collinear ground-truth walls'
# strokes legitimately merge into one longer face (`merge_collinear` doing
# its job), so the count can come out one short while nothing is lost. The
# quantity that must survive is LENGTH — a failed pairing loses metres.
stroke_walls = [w for w in paired if w.paired]
gt_stroke_length = sum(
    math.hypot(b[0] - a[0], b[1] - a[1])
    for i, (a, b, t) in enumerate(gt_walls()) if i % 2 == 1
)
got_length = sum(w.length for w in stroke_walls)
ok("stroke pairs reassemble the full wall run",
   abs(got_length - gt_stroke_length) / gt_stroke_length < 0.05,
   f"{got_length:.1f} of {gt_stroke_length:.1f} m in {len(stroke_walls)} walls")
encoded = {t for i, (_a, _b, t) in enumerate(gt_walls()) if i % 2 == 1}
stroke_thick_err = max(
    (min(abs(w.thickness - t) for t in encoded) for w in stroke_walls),
    default=1.0,
)
ok(f"...at a thickness the strokes encoded ({sorted(encoded)})",
   stroke_thick_err < 0.01, f"worst {stroke_thick_err:.4f}")
ok("the assembled plan encloses rooms", len(spaces) >= 10,
   f"{len(spaces)} rooms")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
