"""
`Wall.offset` — the axis stays put, the body moves.

Run:  .venv/Scripts/python.exe test/test_offset.py

── What the field is for ─────────────────────────────────────────────────────
A composite wall (a 240 mm structural leaf with a 160 mm lining) is one wall
with a thickness that is not centred on the line pairing measured. Every BIM
format in the corpus stores that the same way — IFC's
`IfcMaterialLayerSetUsage.OffsetFromReferenceLine`, Revit's location-line
setting — an axis PLUS a signed displacement to the body.

Poché needs it for a specific, measured reason. Merging leaves by moving the
merged wall's centreline was tried and REFUTED (the record is in
hypothesise/assemble.py): the axis is what the room graph, the label bridges
and the corner joins are all built against, so moving it laterally tears every
one of those coincidences and costs more rooms than the thickness fix is
worth. With `offset`, the axis never moves and only the two stages that turn
an axis INTO a body — `build/solidify` and the plan's poché — read it.

So the assertions here are about a separation of concerns:
  * default 0.0 and symmetric, so every existing wall is unaffected;
  * the solid moves by exactly `offset` along the axis's left normal;
  * the plan's poché moves with it, and an opening's gap moves with the body
    (a hole punched at the axis would miss a displaced wall entirely);
  * NOTHING upstream of the body — length, joins, room cycles — changes.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build.glb import MeshBuilder  # noqa: E402
from build.solidify import build_walls  # noqa: E402
from hypothesise.pair import Wall, join_corners  # noqa: E402
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


def bounds(mesh: MeshBuilder) -> tuple[float, float, float, float]:
    """(min_x, max_x, min_planar_y, max_planar_y) of everything built."""
    xs, ys = [], []
    for x, _y, z in mesh.positions:
        xs.append(x)
        # glb.py maps plan (x, y) -> gltf (x, ..., -y); recover plan y.
        ys.append(-z)
    return min(xs), max(xs), min(ys), max(ys)


def built(wall: Wall) -> MeshBuilder:
    mesh = MeshBuilder()
    build_walls(mesh, [wall], [], height=3.0)
    return mesh


# A wall running east along y = 0. Its left normal is (0, +1), so a POSITIVE
# offset must move the body north.
BASE = Wall(ax=0.0, ay=0.0, bx=6.0, by=0.0, thickness=0.2,
            paired=True, confidence=1.0, layer="WALLS")

print("-- the default is centred, and unchanged from before the field existed --")
ok("offset defaults to 0.0", Wall(0, 0, 1, 0, 0.2, True, 1.0).offset == 0.0)
_x0, _x1, y0, y1 = bounds(built(BASE))
ok("a symmetric wall straddles its axis",
   abs(y0 + 0.1) < 1e-6 and abs(y1 - 0.1) < 1e-6, f"y [{y0:.4f}, {y1:.4f}]")

print("-- a positive offset moves the SOLID along the axis's left normal --")
shifted = Wall(ax=0.0, ay=0.0, bx=6.0, by=0.0, thickness=0.2, paired=True,
               confidence=1.0, layer="WALLS", offset=0.15)
_x0, _x1, sy0, sy1 = bounds(built(shifted))
ok("body displaced by exactly the offset",
   abs(sy0 - 0.05) < 1e-6 and abs(sy1 - 0.25) < 1e-6, f"y [{sy0:.4f}, {sy1:.4f}]")
ok("thickness is unchanged by the displacement",
   abs((sy1 - sy0) - 0.2) < 1e-6, f"{sy1 - sy0:.4f} m")

print("-- and a negative offset moves it the other way, symmetrically --")
_x0, _x1, ny0, ny1 = bounds(built(
    Wall(ax=0.0, ay=0.0, bx=6.0, by=0.0, thickness=0.2, paired=True,
         confidence=1.0, layer="WALLS", offset=-0.15)))
ok("mirror image of the positive case",
   abs(ny0 + 0.25) < 1e-6 and abs(ny1 + 0.05) < 1e-6, f"y [{ny0:.4f}, {ny1:.4f}]")

print("-- the axis is untouched, so nothing upstream of the body can move --")
ok("length is a property of the axis alone",
   abs(shifted.length - BASE.length) < 1e-12)
ok("endpoints are identical",
   (shifted.ax, shifted.ay, shifted.bx, shifted.by)
   == (BASE.ax, BASE.ay, BASE.bx, BASE.by))
ok("offset survives the round trip through as_dict",
   built and shifted.as_dict()["offset"] == 0.15,
   str(shifted.as_dict()["offset"]))

print("-- room derivation reads the axis, so rooms do not move with the body --")
def room(offset: float):
    box = [
        Wall(0.0, 0.0, 6.0, 0.0, 0.2, True, 1.0, "WALLS", offset=offset),
        Wall(6.0, 0.0, 6.0, 4.0, 0.2, True, 1.0, "WALLS"),
        Wall(6.0, 4.0, 0.0, 4.0, 0.2, True, 1.0, "WALLS"),
        Wall(0.0, 4.0, 0.0, 0.0, 0.2, True, 1.0, "WALLS"),
    ]
    spaces = detect_spaces(join_corners(box))
    return spaces[0] if spaces else None

flat, displaced = room(0.0), room(0.15)
ok("a room forms either way", flat is not None and displaced is not None)
ok("and it is the SAME room — the graph never saw the offset",
   flat is not None and displaced is not None
   and abs(flat.gross_area - displaced.gross_area) < 1e-9,
   f"{flat.gross_area:.4f} vs {displaced.gross_area:.4f} m2")

print("-- the plan's poche and its opening gaps move WITH the body --")
from render.plan_svg import render_plan  # noqa: E402
import tempfile  # noqa: E402


def plan_ys(offset: float) -> list[float]:
    model = {
        "source": "offset-test",
        "wallHeight": 3.0,
        "elements": {
            "walls": [
                Wall(0.0, 0.0, 6.0, 0.0, 0.2, True, 1.0, "WALLS",
                     offset=offset).as_dict(),
                Wall(6.0, 0.0, 6.0, 4.0, 0.2, True, 1.0, "WALLS").as_dict(),
                Wall(6.0, 4.0, 0.0, 4.0, 0.2, True, 1.0, "WALLS").as_dict(),
                Wall(0.0, 4.0, 0.0, 0.0, 0.2, True, 1.0, "WALLS").as_dict(),
            ],
            "spaces": [],
            "openings": [{"kind": "door", "wall": 0, "along": 3.0,
                          "width": 0.9, "height": 2.1, "sill": 0.0}],
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "p.svg"
        render_plan(model, out)
        text = out.read_text(encoding="utf-8")
    # Every y coordinate in the file; the SVG's own scale is irrelevant
    # because only the DIFFERENCE between the two runs is asserted.
    import re
    return [float(v) for v in re.findall(r"[-\d.]+,([-\d.]+)", text)]


flat_ys, moved_ys = plan_ys(0.0), plan_ys(0.15)
ok("the drawn plan changes when the body moves",
   flat_ys != moved_ys, f"{len(flat_ys)} coords compared")
ok("...and both plans are still drawable",
   len(flat_ys) > 8 and len(moved_ys) == len(flat_ys),
   f"{len(flat_ys)} vs {len(moved_ys)}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
