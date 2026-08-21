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
from solve.frames import MIN_CHANNEL, segment_frames  # noqa: E402

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


print("\n-- frames: drawings the gutter cannot separate --")
# The villa that prompted this. `DOWN VILLA -WD 22-1-24.dxf` draws two storeys
# of one building 2.477 m apart on one sheet. The gutter is added to BOTH boxes,
# so the 3.0 m default merges anything within 6.0 m and the two storeys came out
# as one flat 505 m2 "building" with 901 m of wall — a bill of quantities for
# something that does not exist.
#
# Offsets are derived from the fixture and from MIN_CHANNEL rather than written
# as literals, so these keep testing the rule and not a pair of numbers that
# happened to work. Two rooms offset by `d` leave a gap of `d - H + T` between
# their centrelines.
def _offset_for(gap: float) -> float:
    return H - T + gap


two_storeys = join_corners(
    pair_faces(room_faces() + room_faces(0.0, _offset_for(MIN_CHANNEL * 2)))
)
frames = segment_frames(two_storeys, min_walls=3)
ok("two plans closer than the gutter are still separated",
   len(frames) == 2, str(len(frames)))
ok("and each says why it was cut",
   all("channel" in f.origin for f in frames),
   str([f.origin for f in frames]))

# The guards. A courtyard is not a gutter: the perimeter runs past it on both
# sides, so the projection has no gap at all. This is why the test is a
# projection and not a search for empty rectangles — an empty rectangle is
# everywhere in a floor plan.
one_plan = join_corners(pair_faces(room_faces()))
ok("a single room is never cut",
   len(segment_frames(one_plan, min_walls=3)) == 1)
ok("and it reports that it was not cut",
   segment_frames(one_plan, min_walls=3)[0].origin == "component")

# A gap under the floor stays merged, deliberately. Two plans a metre apart are
# indistinguishable from one plan with a wide corridor, and guessing wrong in
# this direction merely reproduces the old behaviour rather than inventing a new
# failure.
tight = join_corners(
    pair_faces(room_faces() + room_faces(0.0, _offset_for(MIN_CHANNEL * 0.8)))
)
ok("a gap under MIN_CHANNEL is left alone",
   len(segment_frames(tight, min_walls=3)) == 1,
   str(len(segment_frames(tight, min_walls=3))))

# `min_walls` on BOTH sides. The villa's upper storey has a 7.73 m gap in x
# that looks exactly like a gutter and is one stray callout line off to the
# right — wider than the real gutter that separates the two storeys, so width
# alone cannot tell them apart.
with_stray = one_plan + [w for w in join_corners(pair_faces(room_faces(30.0, 0.0)))[:1]]
ok("a stray line is not a drawing",
   len(segment_frames(with_stray, min_walls=3)) == 1,
   str(len(segment_frames(with_stray, min_walls=3))))

# Nothing may be lost. A wall that fell into neither side of a cut would vanish
# from every frame, and it would vanish silently.
pieces = segment_frames(two_storeys, min_walls=3)
ok("a cut divides the linework and does not drop any",
   sorted(i for f in pieces for i in f.wall_indices) == list(range(len(two_storeys))),
   f"{sum(len(f.wall_indices) for f in pieces)} of {len(two_storeys)}")

# The two sides of one cut must be TELLABLE APART.
#
# The first version of `_split` handed both children the same label and let a
# second cut overwrite the first, so a 2x2 sheet produced four frames that all
# described themselves identically and none of which could say where it sat.
# Storey registration reads this to know that two frames came from one cut and
# which side each was on, so it has to survive nesting.
ok("the two sides of a cut are distinguishable",
   {f.cuts[-1]["side"] for f in pieces} == {"low", "high"},
   str([f.cuts for f in pieces]))

grid = join_corners(pair_faces(
    room_faces() + room_faces(W + 4, 0)
    + room_faces(0, _offset_for(MIN_CHANNEL * 2))
    + room_faces(W + 4, _offset_for(MIN_CHANNEL * 2))
))
quads = segment_frames(grid, min_walls=3)
ok("a 2x2 sheet gives four frames", len(quads) == 4, str(len(quads)))
ok("and each carries its FULL ancestry, not just the last cut",
   all(len(f.cuts) == 2 for f in quads), str([len(f.cuts) for f in quads]))
ok("so all four are uniquely identified by where they sat",
   len({tuple((c["axis"], c["side"]) for c in f.cuts) for f in quads}) == 4,
   str([f.origin for f in quads]))


print("\n-- frames: at PRODUCTION defaults --")
# Everything above passes min_walls=3. Production is MIN_WALLS=8, and at that
# setting MIN_SIDE_EXTENT and MAX_SPLIT_DEPTH had no coverage at all — all three
# defects below were found by an independent adversarial pass, not by this file.


def plan_at(x0, y0, x1, y1, n=4):
    """A rectangular outline as 4n separate segments, so it clears MIN_WALLS."""
    sx, sy = (x1 - x0) / n, (y1 - y0) / n
    out = []
    for k in range(n):
        out += [
            Face(x0 + k * sx, y0, x0 + (k + 1) * sx, y0, "W"),
            Face(x0 + k * sx, y1, x0 + (k + 1) * sx, y1, "W"),
            Face(x0, y0 + k * sy, x0, y0 + (k + 1) * sy, "W"),
            Face(x1, y0 + k * sy, x1, y0 + (k + 1) * sy, "W"),
        ]
    return out


# ── One line lying inside the gutter used to suppress the cut entirely ──────
# Measured on the real villa: 2.38 m of line at x=100, wholly inside the 2.48 m
# channel between the two storeys and touching neither plan, put both storeys
# back on one slab — the 505 m2 / 901 m building that does not exist, reinstated
# by 2.4 m of linework.
#
# And the tell you would reach for does not exist: that frame's origin said
# "cut at x=... low side", NOT "component". It WAS cut, just not on the axis
# that mattered. A guard keyed on origin == "component" cannot see this.
two_plans = plan_at(0, 0, 20, 15) + plan_at(0, 17.5, 20, 32.5)
ok("two plans 2.5 m apart split at production defaults",
   len(segment_frames(two_plans)) == 2, str(len(segment_frames(two_plans))))

with_orphan = two_plans + [Face(10, 15.06, 10, 17.44, "W")]
split = segment_frames(with_orphan)
ok("and a stray line inside the channel does not suppress the cut",
   len(split) == 2, f"{len(split)} frames")
ok("with the stray line still accounted for",
   sum(len(f.wall_indices) for f in split) == len(with_orphan),
   f"{sum(len(f.wall_indices) for f in split)} of {len(with_orphan)}")

# The support count is what keeps that safe: a real small drawing sitting
# between two real gutters is kept, not eaten as noise.
ok("a genuine small drawing between two gutters survives",
   len(segment_frames(plan_at(0, 0, 20, 15) + plan_at(0, 20, 8, 28)
                      + plan_at(0, 34, 20, 49))) == 3)

# ── A neighbour's size must not decide whether a building stays whole ───────
# MIN_SIDE_EXTENT was a FRACTION of the parent, so a 200 x 150 m site plan drawn
# beside a 20 x 25 m villa swallowed it into one 48-wall frame — and reported
# its origin as "component", i.e. "there was nothing to cut".
beside = plan_at(0, 0, 200, 150) + plan_at(203, 0, 223, 25)
ok("a villa beside a large site plan is still its own frame",
   len(segment_frames(beside)) == 2,
   str([round(f.span, 1) for f in segment_frames(beside)]))

# The guard that replaced still has to refuse an actual sliver.
ticks = [Face(34, 10 + k * 0.05, 34, 10.05 + k * 0.05, "W") for k in range(12)]
ok("but a 0.6 m strip of dimension ticks is still refused",
   len(segment_frames(plan_at(0, 0, 30, 20) + ticks)) == 1)

# ── The depth cap truncated, and truncation looked exactly like completion ──
# `_split` takes the WIDEST channel each level, which is greedy and unrelated to
# balance, so depth needed is data-dependent up to n-1 — not ceil(log2 n). At
# the old cap of 4, six plans in a row gave FIVE frames with frames[0] holding
# two buildings, and nothing in the output said the recursion had run out.
for count in (5, 6, 8, 10):
    row = []
    for k in range(count):
        row += plan_at(k * 25.0, 0, k * 25.0 + 20, 15)
    ok(f"{count} plans in a row give {count} frames",
       len(segment_frames(row)) == count, str(len(segment_frames(row))))

big_grid = []
for r in range(4):
    for c in range(4):
        big_grid += plan_at(c * 25.0, r * 25.0, c * 25.0 + 20, r * 25.0 + 20)
sixteen = segment_frames(big_grid)
ok("a 4x4 grid gives 16 frames, not 11", len(sixteen) == 16, str(len(sixteen)))
# 6 levels deep, not the 4 that ceil(log2 16) suggests — which is exactly why
# the old cap silently truncated this case.
ok("and needs more than log2(n) levels to get there",
   max(len(f.cuts) for f in sixteen) > 4,
   str(sorted({len(f.cuts) for f in sixteen})))

ok("a single plan is still never cut at production defaults",
   len(segment_frames(plan_at(0, 0, 20, 15))) == 1)
ok("and still reports that it was not cut",
   segment_frames(plan_at(0, 0, 20, 15))[0].origin == "component")


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


# -- The duplication accounting is invariant under the closing radius --------
# Found by accident. `add_perimeter` emits the building envelope WHOLE, because
# on a real drawing that ring IS the outer boundary and shrinking it destroys
# the closure it exists to provide: measured, at R=0.50 the villa drops from 23
# rooms to 9. But most of the ring lies on walls already drawn, so every derived
# segment records how much of itself duplicates one.
#
# Sweeping R to test a rival theory produced the evidence that the accounting is
# right: BILLABLE length held at 290-305 m across the whole sweep, a 2.5%
# spread, while TOTAL swung 290-459 m, 58%. Subtracting duplication recovers the
# same wall run whatever the closing radius does.
#
# Nobody designed a test for that, so here it is. It is the property that breaks
# first if the duplication measurement drifts, and such a drift is invisible in
# the geometry while doubling a bill of materials.
print("")
print("-- billable length is invariant under CLOSE_RADIUS --")
from hypothesise import perimeter as _per   # noqa: E402

# The room's four centrelines: 2*(4.0-0.23) + 2*(3.0-0.23) = 13.08 m.
_TRUE_RUN = 2 * (W - T) + 2 * (H - T)
_billables, _totals = [], []
for _R in (1.5, 1.0, 0.75, 0.5):
    _ws = _per.add_perimeter(walls, radius=_R)
    _total = sum(w.length for w in _ws)
    _totals.append(_total)
    _billables.append(_total - sum(w.duplicate for w in _ws))

_spread = (max(_billables) - min(_billables)) / max(_billables)
ok("billable length is the same at every closing radius", _spread < 0.02,
   f"{[round(b, 2) for b in _billables]}  spread {_spread:.1%}")
ok("and it equals the walls actually drawn",
   all(abs(b - _TRUE_RUN) < 0.05 for b in _billables),
   f"{_billables[0]:.2f} vs {_TRUE_RUN:.2f}")
ok("while TOTAL length is not invariant, which is why the two must differ",
   (max(_totals) - min(_totals)) / max(_totals) > 0.2,
   f"{[round(t, 2) for t in _totals]}")
ok("anything drawn reports zero duplication",
   all(w.duplicate == 0.0 for w in _per.add_perimeter(walls)
       if w.layer != "<derived:perimeter>"))


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
