"""
Pairing, rooms, openings, wall splitting, and the verify gate.

Run:  .venv/Scripts/python.exe test/test_build.py

Synthetic geometry throughout, because the answers have to be known exactly. A
4 x 3 m room built from two-faced walls has one right number for its area, one
right number for its wall thickness, and one right piece count when a door is
put in it — and none of those can be read off a real drawing, where every
discrepancy is arguable.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build.glb import MeshBuilder, write_glb  # noqa: E402
from build.solidify import build_slabs, build_walls  # noqa: E402
from hypothesise import openings as op  # noqa: E402
from hypothesise.pair import Face, join_corners, pair_faces  # noqa: E402
from solve import spaces as sp  # noqa: E402
from solve import verify as vf  # noqa: E402
from solve.frames import segment_frames  # noqa: E402

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


def close(a: float, b: float, tol: float = 0.02) -> bool:
    return abs(a - b) <= tol


# ── A room drawn the way an architect draws one ──────────────────────────────
# 4.0 x 3.0 m to the OUTSIDE faces, with 0.23 m walls (a nine-inch brick wall).
# Two faces per wall, so eight lines in total.
T = 0.23
W, H = 4.0, 3.0


def room_faces(ox: float = 0.0, oy: float = 0.0) -> list[Face]:
    o, i = 0.0, T
    return [
        Face(ox + o,     oy + o,     ox + W - o, oy + o,     "WALLS"),   # outer S
        Face(ox + i,     oy + i,     ox + W - i, oy + i,     "WALLS"),   # inner S
        Face(ox + o,     oy + H - o, ox + W - o, oy + H - o, "WALLS"),   # outer N
        Face(ox + i,     oy + H - i, ox + W - i, oy + H - i, "WALLS"),   # inner N
        Face(ox + o,     oy + o,     ox + o,     oy + H - o, "WALLS"),   # outer W
        Face(ox + i,     oy + i,     ox + i,     oy + H - i, "WALLS"),   # inner W
        Face(ox + W - o, oy + o,     ox + W - o, oy + H - o, "WALLS"),   # outer E
        Face(ox + W - i, oy + i,     ox + W - i, oy + H - i, "WALLS"),   # inner E
    ]


print("\n-- pairing --")
walls = join_corners(pair_faces(room_faces()))
paired = [w for w in walls if w.paired]

ok("eight faces become four walls", len(walls) == 4, str(len(walls)))
ok("all four are paired", len(paired) == 4, str(len(paired)))
ok("thickness is MEASURED, not assumed",
   all(close(w.thickness, T, 0.005) for w in paired),
   str(sorted(round(w.thickness, 3) for w in paired)))

# Centrelines run half a thickness in from each outer face, so the rectangle
# they describe is (W - T) x (H - T).
lengths = sorted(round(w.length, 3) for w in walls)
ok("corner-joining closes the rectangle",
   close(lengths[0], H - T, 0.03) and close(lengths[-1], W - T, 0.03),
   f"lengths {lengths}")


print("\n-- rooms --")
spaces = sp.detect_spaces(walls)
ok("one closed cycle is found", len(spaces) == 1, str(len(spaces)))

if spaces:
    space = spaces[0]
    # Gross runs to centrelines: (W-T) x (H-T). Finished insets another T/2 all
    # round, giving the clear internal dimension (W-2T) x (H-2T).
    ok("gross area is to the centrelines",
       close(space.gross_area, (W - T) * (H - T), 0.05),
       f"{space.gross_area:.3f} vs {(W - T) * (H - T):.3f}")
    ok("finished area is the clear internal dimension",
       close(space.area, (W - 2 * T) * (H - 2 * T), 0.06),
       f"{space.area:.3f} vs {(W - 2 * T) * (H - 2 * T):.3f}")
    ok("and finished is smaller than gross", space.area < space.gross_area)


print("\n-- corner-joining is load-bearing --")
# The same faces WITHOUT the corner join. Every centreline is trimmed to the
# overlap, so each is short at both ends and nothing closes.
unjoined = pair_faces(room_faces())
ok("without joining there are still four walls", len(unjoined) == 4)
ok("but they enclose nothing", len(sp.detect_spaces(unjoined)) == 0,
   f"{len(sp.detect_spaces(unjoined))} rooms")


print("\n-- frames --")
# Two rooms, 40 m apart. That is a sheet, not a building.
far = join_corners(pair_faces(room_faces() + room_faces(40.0, 0.0)))
frames = segment_frames(far, min_walls=3)
ok("two drawings on a sheet are separated", len(frames) == 2, str(len(frames)))
ok("each frame is one room's worth of walls",
   all(len(f.wall_indices) == 4 for f in frames),
   str([len(f.wall_indices) for f in frames]))
ok("and each spans about one room",
   all(f.span < 6 for f in frames), str([round(f.span, 2) for f in frames]))


print("\n-- openings --")
south = min(walls, key=lambda w: (w.ay + w.by) / 2)
mid_x = (south.ax + south.bx) / 2
mid_y = (south.ay + south.by) / 2

index, along = op.host(mid_x, mid_y, walls)
ok("a point on a wall finds that wall", index is not None)
ok("and lands halfway along it", close(along, south.length / 2, 0.05),
   f"{along:.3f} of {south.length:.3f}")

off = op.host(mid_x, mid_y + 20.0, walls)[0]
ok("a point far from every wall finds none", off is None)

placements = [
    {"block": "D900", "position": {"x": mid_x, "y": mid_y}, "rotation": 0.0},
    {"block": "W1200", "position": {"x": mid_x + 90, "y": mid_y}, "rotation": 0.0},
]
holes, unhosted = op.from_sized_blocks(placements, walls, lambda b: None)
ok("a sized name is read without the kernel", len(holes) == 1, str(len(holes)))
ok("the far one is reported, not dropped", unhosted == 1, str(unhosted))
if holes:
    ok("the door width comes from its name", close(holes[0].width, 0.9, 0.001),
       str(holes[0].width))
    ok("and it is a door", holes[0].kind == "door", holes[0].kind)

# Dedupe: two emitters describing the same door.
twin = [
    op.Opening("door", 0, 1.0, 0.9, 2.1, 0.0, "blockSized", 0.92),
    op.Opening("door", 0, 1.05, 0.9, 2.1, 0.0, "openingCluster", 0.6),
]
ok("two emitters on one door cut one hole", len(op.dedupe(twin)) == 1)
ok("and the more confident emitter wins",
   op.dedupe(twin)[0].source == "blockSized")


print("\n-- wall splitting --")
mesh = MeshBuilder()
door = op.Opening("door", walls.index(south), south.length / 2, 0.9, 2.1, 0.0,
                  "blockSized")
stats = build_walls(mesh, walls, [door], height=2.7)

# One door in the middle of one wall: that wall becomes 2 solids + 1 lintel,
# the other three stay whole. Arithmetic, not a boolean.
ok("the pierced wall splits into two solids plus three whole walls",
   stats["solids"] == 5, str(stats["solids"]))
ok("and gains exactly one lintel", stats["lintels"] == 1, str(stats["lintels"]))
ok("a door has no apron below it", stats["aprons"] == 0, str(stats["aprons"]))

window = op.Opening("window", walls.index(south), south.length / 2, 1.2, 1.2, 0.9,
                    "blockSized")
wmesh = MeshBuilder()
wstats = build_walls(wmesh, walls, [window], height=2.7)
ok("a window gains an apron below it", wstats["aprons"] == 1, str(wstats["aprons"]))

unpaired_only = [w for w in walls]
for w in unpaired_only:
    w.paired = False
skipped = build_walls(MeshBuilder(), unpaired_only, [], height=2.7)
ok("unpaired lines are not extruded into sealed boxes",
   skipped["pieces"] == 0 and skipped["skippedUnpaired"] == 4,
   f"pieces={skipped['pieces']}")
for w in unpaired_only:
    w.paired = True


print("\n-- glb --")
gmesh = MeshBuilder()
build_walls(gmesh, walls, [door], height=2.7)
fmesh = MeshBuilder()
build_slabs(fmesh, spaces)
out = Path("A:/tmp/test-build/room.glb")
manifest = write_glb({"storey0_walls": gmesh, "storey0_floors": fmesh}, out)

ok("a glb is written", out.exists())
ok("it declares its own length", manifest["bytes"] == out.stat().st_size,
   f"{manifest['bytes']} vs {out.stat().st_size}")
ok("the header is 12-byte aligned", manifest["bytes"] % 4 == 0)
ok("it has both meshes", len(manifest["meshes"]) == 2, str(manifest["meshes"]))
ok("mesh names survive three.js sanitising",
   all("/" not in n for n in manifest["meshes"]), str(manifest["meshes"]))
ok("triangles are a multiple of three vertices", manifest["vertices"] % 4 == 0)

# Every normal must have length. A zero-length normal is not a geometry error —
# the mesh loads, the bounds are right, the triangle count is right — it is a
# SHADING error, and it renders as a black hole in the building. The whole suite
# passed while every floor slab was doing exactly that, because nothing here
# looked at a normal until it was rendered and seen.
import math as _m
def _lengths(mesh):
    return [_m.sqrt(x * x + y * y + z * z) for x, y, z in mesh.normals]

for _name, _mesh in (("walls", gmesh), ("floors", fmesh)):
    _l = _lengths(_mesh)
    ok(f"every {_name} normal is unit length",
       bool(_l) and all(abs(v - 1.0) < 1e-6 for v in _l),
       f"{len(_l)} normals, min {min(_l) if _l else 0:.4f}")

# Facing, not just length. A box can have six unit normals and still be
# inside-out — which is exactly what happened: measured, the top face pointed
# down, the bottom pointed up, and all four sides faced inward. Cycles renders
# backfacing diffuse by flipping, so it looked almost right for a long time.
_box = MeshBuilder()
_box.add_box_from_segment(0, 0, 4, 0, 0.23, 2.7)
_faces = [_box.normals[i] for i in range(0, len(_box.normals), 4)]
_up = sum(1 for n in _faces if n[1] > 0.9)
_down = sum(1 for n in _faces if n[1] < -0.9)
ok("a wall box has exactly one upward face", _up == 1, str(_up))
ok("and exactly one downward face", _down == 1, str(_down))

_centre = (2.0, 1.35, 0.0)
_inward = 0
for _i, _n in enumerate(_faces):
    if abs(_n[1]) >= 0.5:
        continue
    _p = _box.positions[_i * 4]
    if (_p[0] - _centre[0]) * _n[0] + (_p[2] - _centre[2]) * _n[2] <= 0:
        _inward += 1
ok("and every side faces outward, not inward", _inward == 0, f"{_inward} inward")

_degenerate = MeshBuilder()
_degenerate.add_tri((0, 0, 0), (1, 0, 0), (2, 0, 0))   # collinear
ok("a degenerate triangle is dropped, not written with a zero normal",
   _degenerate.triangles == 0, str(_degenerate.triangles))


print("\n-- the verify gate --")
good = vf.check(input_segments=8, walls=walls, spaces=spaces, openings=[door],
                unhosted=0)
ok("a sound model passes", good.ok, str([c.name for c in good.blocking]))

# The failure that started this: real linework in, empty building out.
empty = vf.check(input_segments=4778, walls=[], spaces=[], openings=[], unhosted=26,
                 scale_candidates=[{"label": "centimetres", "extent": 37.88}])
ok("thousands of segments producing no walls is BLOCKING", not empty.ok)
ok("and it names the unit as the likely cause",
   any("unit error" in c.message for c in empty.blocking))
ok("and offers the candidates",
   any("centimetres" in c.message for c in empty.blocking))

thick = [type(walls[0])(0, 0, 5, 0, 4.0, True, 1.0, "W") for _ in range(10)]
bad_unit = vf.check(input_segments=40, walls=thick, spaces=[], openings=[], unhosted=0)
ok("an unbuildable wall thickness is BLOCKING", not bad_unit.ok,
   str([c.name for c in bad_unit.blocking]))

huge = vf.check(input_segments=40, walls=walls, spaces=spaces, openings=[],
                unhosted=0)
ok("a plausible model is not blocked by warnings alone", huge.ok)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
