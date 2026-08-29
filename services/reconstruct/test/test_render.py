"""
Camera solving, the render surface, and the plan drawing.

Run:  .venv/Scripts/python.exe test/test_render.py

The case that matters most is the L-shaped room. Its centroid falls in the
missing corner — outside the room — so a camera placed there is inside a wall
and the render is black. That failure is silent: the job succeeds, the image
exists, and it is dark. A test is the only thing that catches it.
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import Point, Polygon  # noqa: E402

from render import cameras, styles  # noqa: E402
from render.plan_svg import render_plan  # noqa: E402

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


# ---- The L-shaped room ------------------------------------------------------
# A thin L: a 10 x 2 arm along the bottom and a 2 x 8 arm up the left. Its
# centroid is at roughly (3.2, 3.2), which is in the missing quadrant — outside
# the room entirely. A camera dropped there is inside a wall and the render is
# black, and nothing about the job reports a problem.
#
# A fat L will not demonstrate this: with wide enough arms the centroid falls
# back inside and the test passes for the wrong reason. The first version of
# this test used an 8 x 8 with a 4 x 4 bite and proved nothing.
L = Polygon([(0, 0), (10, 0), (10, 2), (2, 2), (2, 10), (0, 10)])

print("\n-- pole of inaccessibility --")
centroid = L.centroid
ok("the centroid really is outside this room", not L.contains(centroid),
   f"({centroid.x:.2f}, {centroid.y:.2f})")

eye, clearance = cameras.pole_of_inaccessibility(L)
ok("the solved eye is inside the room", L.contains(eye), f"({eye.x:.2f}, {eye.y:.2f})")
ok("and it has real clearance", clearance > 0.9, f"{clearance:.2f} m")
ok("clearance is the true distance to the boundary",
   abs(clearance - L.exterior.distance(eye)) < 0.05,
   f"{clearance:.3f} vs {L.exterior.distance(eye):.3f}")

# A square room's answer is its centre, and the clearance is half its width.
square = Polygon([(0, 0), (6, 0), (6, 6), (0, 6)])
seye, sclear = cameras.pole_of_inaccessibility(square)
ok("a square room solves to its centre",
   abs(seye.x - 3) < 0.2 and abs(seye.y - 3) < 0.2, f"({seye.x:.2f}, {seye.y:.2f})")
ok("with clearance of half its width", abs(sclear - 3.0) < 0.2, f"{sclear:.2f} m")


# ---- Views ------------------------------------------------------------------
class S:
    def __init__(self, i, loop, area, name=None):
        self.index, self.loop, self.area, self.name = i, loop, area, name


class W:
    def __init__(self, ax, ay, bx, by, t=0.23):
        self.ax, self.ay, self.bx, self.by = ax, ay, bx, by
        self.thickness, self.paired = t, True

    @property
    def length(self):
        import math
        return math.hypot(self.bx - self.ax, self.by - self.ay)


spaces = [
    S(0, list(L.exterior.coords)[:-1], L.area, "LIVING"),
    S(1, list(square.exterior.coords)[:-1], square.area, "BED ROOM"),
    S(2, [(0, 0), (0.8, 0), (0.8, 0.8), (0, 0.8)], 0.64, "CUPBOARD"),
]
walls = [W(0, 0, 8, 0), W(8, 0, 8, 8), W(8, 8, 0, 8), W(0, 8, 0, 0)]

print("\n-- interior cameras --")
views = cameras.interior_views(spaces, walls=walls)
ok("one camera per room", len(views) == 3, str(len(views)))
ok("every eye is at standing height",
   all(abs(v.eye[2] - cameras.EYE_HEIGHT) < 1e-9 for v in views))
ok("each carries a measured clearance", all(v.clearance >= 0 for v in views))

tight = next(v for v in views if v.name == "CUPBOARD")
ok("a cupboard is flagged as too tight to render",
   tight.clearance < cameras.MIN_CLEARANCE and tight.notes,
   f"{tight.clearance:.2f} m")

big = next(v for v in views if v.name == "LIVING")
ok("the camera is not aimed at its own position",
   (big.eye[0], big.eye[1]) != (big.target[0], big.target[1]))
ok("interiors are shot wide", big.fov > 60, f"{big.fov}°")

furnished = cameras.interior_views(
    [spaces[1]],
    walls=walls,
    fixtures=[
        {"item": "plant", "position": {"x": 2.0, "y": 2.0},
         "footprint": {"w": 0.5, "d": 0.5}},
        {"item": "bed-king", "position": {"x": 4.0, "y": 3.0},
         "footprint": {"w": 2.0, "d": 2.0}},
        {"item": "neighbour-bed", "position": {"x": 7.0, "y": 3.0},
         "footprint": {"w": 4.0, "d": 4.0}},
    ],
)[0]
ok("without glazing the camera aims at the largest contained fixture",
   furnished.target[:2] == (4.0, 3.0), str(furnished.target))
ok("a neighbour's larger fixture is excluded by room containment",
   furnished.target[:2] != (7.0, 3.0))
ok("the camera aims down at furniture rather than over it",
   furnished.target[2] == cameras.FURNITURE_AIM_HEIGHT
   and "aimed at furniture" in furnished.notes)

print("\n-- the rest of the rig --")
orbit = cameras.exterior_views(walls, count=4)
ok("an orbit has the requested number of stops", len(orbit) == 4)
ok("every orbit camera looks at the same target",
   len({tuple(round(c, 6) for c in v.target) for v in orbit}) == 1)
ok("and they are at different places",
   len({tuple(round(c, 3) for c in v.eye) for v in orbit}) == 4)

# This is the consistency claim: four different views, one building.
ok("all four are the same distance from it",
   len({round(v.clearance, 3) for v in orbit}) == 1,
   f"{orbit[0].clearance:.2f} m")

iso = cameras.isometric_view(walls)
ok("the isometric is orthographic", iso.orthographic)
ok("at the true isometric pitch, not the drafting 30°",
   abs(cameras.ISO_PITCH_DEG - 35.264) < 0.001)
ok("and frames the whole building", iso.ortho_scale > 8, f"{iso.ortho_scale:.1f} m")

plan = cameras.plan_view(walls)
ok("the plan looks straight down",
   plan.eye[0] == plan.target[0] and plan.eye[1] == plan.target[1])
ok("and is orthographic too", plan.orthographic)

everything = cameras.solve(spaces, walls)
ok("solve returns the whole rig", len(everything) == 3 + 4 + 1 + 1, str(len(everything)))
ok("interiors come back best-first",
   everything[0].clearance >= everything[1].clearance)
summary = cameras.summarise(everything)
ok("and it counts the unusable ones", summary["tooTight"] == 1, str(summary["tooTight"]))


# ---- The surface ------------------------------------------------------------
print("\n-- engine / expert / style --")
cfg = styles.resolve(engine="ultra", expert="interior", style="cad", seed=534614)
ok("an engine sets a real sample count", cfg["engine"]["samples"] == 512,
   str(cfg["engine"]["samples"]))
ok("an expert selects which cameras to solve", cfg["expert"]["views"] == ["interior"])
ok("a line-art style turns Freestyle on", cfg["style"]["freestyle"] is True)
ok("a photoreal style does not", styles.resolve(style="photoreal")["style"]["freestyle"] is False)
ok("the seed is carried", cfg["seed"] == 534614)
ok("and the contract says what it does NOT touch",
   "deterministic" in cfg["determinism"].lower(), cfg["determinism"][:48])
ok("an unknown engine falls back rather than throwing",
   styles.resolve(engine="nonsense")["engine"]["id"] == "standard")

cat = styles.catalogue()
ok("the surface is enumerable for a UI",
   len(cat["engines"]) == 3 and len(cat["experts"]) == 5 and len(cat["styles"]) == 6,
   f"{len(cat['engines'])}/{len(cat['experts'])}/{len(cat['styles'])}")


# ---- The plan drawing -------------------------------------------------------
print("\n-- plan svg --")
model = {
    "source": "test/room.dxf",
    "wallHeight": 2.7,
    "elements": {
        "walls": [
            {"a": {"x": w.ax, "y": w.ay}, "b": {"x": w.bx, "y": w.by},
             "thickness": w.thickness, "paired": True} for w in walls
        ],
        "spaces": [
            {"index": s.index, "loop": [list(p) for p in s.loop],
             "area": s.area, "name": s.name} for s in spaces
        ],
        "openings": [
            {"kind": "door", "wall": 0, "along": 4.0, "width": 0.9,
             "height": 2.1, "sill": 0.0},
            {"kind": "window", "wall": 1, "along": 4.0, "width": 1.2,
             "height": 1.2, "sill": 0.9},
        ],
        "fixtures": [
            {"label": "fixture", "item": "sofa-3", "position": {"x": 2.0, "y": 2.0},
             "rotation": 0.0, "footprint": {"w": 2.1, "d": 0.9}},
        ],
    },
}

out = Path("A:/tmp/test-render/plan.svg")
manifest = render_plan(model, out, title="Test Room")

ok("a plan is written", out.exists())
ok("it draws the poche", manifest["walls"] == 4, str(manifest["walls"]))
ok("it draws the rooms", manifest["rooms"] == 3, str(manifest["rooms"]))
ok("it draws the fixtures", manifest["fixtures"] == 1, str(manifest["fixtures"]))

raw = out.read_text(encoding="utf-8")
root = ET.fromstring(raw)          # throws if malformed
ns = "{http://www.w3.org/2000/svg}"
ok("the svg is well-formed XML", root.tag == f"{ns}svg")

poche = root.find(f"{ns}g[@id='poche']")
ok("the poche is a solid dark fill, not a stroke",
   poche is not None and poche[0].get("fill") == "#1B1E24",
   poche[0].get("fill") if poche is not None and len(poche) else "missing")

gaps = root.find(f"{ns}g[@id='openings']")
ok("openings are punched out of the wall", gaps is not None and len(gaps) == 2,
   str(len(gaps) if gaps is not None else 0))

width = float(root.get("viewBox").split()[2])
height = float(root.get("viewBox").split()[3])
coords = [
    tuple(map(float, pair.split(",")))
    for el in root.iter()
    if el.get("points")
    for pair in el.get("points").split()
]
ok("every drawn coordinate is inside the frame",
   all(-1 <= x <= width + 1 and -1 <= y <= height + 1 for x, y in coords),
   f"{len(coords)} points")

ok("room names are printed", "LIVING" in raw and "BED ROOM" in raw)
ok("areas are printed", "m²" in raw)
ok("and there is a scale bar", 'id="scale"' in raw)

views_json = json.dumps([v.as_dict() for v in everything])
ok("views serialise for a renderer", "orthoScale" in views_json)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
