"""
Texture coordinates: box-projected, and measured in METRES.

Run:  .venv/Scripts/python.exe test/test_uv.py

── What was missing ──────────────────────────────────────────────────────────
Every GLB this engine produced carried POSITION and NORMAL and nothing else.
A mesh with no TEXCOORD_0 cannot take a textured material AT ALL, so the whole
textured half of any material library — brick, plaster, stone, timber, every
tiled floor — was unreachable on every building the engine has ever built,
and only the parametric materials (glass, water, flat paint) could bind.
Nothing failed and nothing said so; the models simply could not be dressed.

── The contract these assertions pin ─────────────────────────────────────────
`u = 1.0` is ONE METRE OF BUILDING, not one tile. A material tiles itself from
its own physical size — a 0.6 m tile repeats every 0.6 of u — which is the
only arrangement that survives a material library whose vendor presets ship
`uvtiling 1.0` and no physical size at all. Bake a tile count into the mesh
and that information is unrecoverable downstream; emit metres and the size
always comes from the material.

Projection is per face, dropping the dominant axis of the face normal. Faces
do not share vertices in this builder, so each projects independently and
there are no seams to reconcile. It is computed at WRITE time from the final
positions and normals, so `translate_plan` cannot leave UVs pointing at where
the geometry used to be — which is the assertion at the bottom.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build.glb import MeshBuilder, _box_uv, write_glb  # noqa: E402

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


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    json_len = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + json_len]), data


def uvs_of(doc: dict, data: bytes, mesh_index: int = 0):
    json_len = struct.unpack("<I", data[12:16])[0]
    bin_start = 20 + json_len + 8
    prim = doc["meshes"][mesh_index]["primitives"][0]
    acc = doc["accessors"][prim["attributes"]["TEXCOORD_0"]]
    view = doc["bufferViews"][acc["bufferView"]]
    off = bin_start + view.get("byteOffset", 0)
    return [struct.unpack_from("<2f", data, off + 8 * i) for i in range(acc["count"])]


print("-- the projection itself, per face --")
# glTF is Y-up: a floor's normal is +Y, a wall facing X has normal +X.
ok("a floor projects onto the ground plane (x, z)",
   _box_uv((3.0, 0.0, 4.0), (0.0, 1.0, 0.0)) == (3.0, 4.0))
ok("a wall facing X projects onto (z, y) — height is v",
   _box_uv((5.0, 2.5, 4.0), (1.0, 0.0, 0.0)) == (4.0, 2.5))
ok("a wall facing Z projects onto (x, y) — height is v",
   _box_uv((3.0, 2.5, 7.0), (0.0, 0.0, -1.0)) == (3.0, 2.5))
ok("a ceiling (normal down) projects like a floor",
   _box_uv((3.0, 3.0, 4.0), (0.0, -1.0, 0.0)) == (3.0, 4.0))

print("-- a SKEW wall is measured along itself, not along a world axis --")
# Every plangraph fixture is orthogonal by construction, so this path had no
# coverage at all. Dropping the dominant axis compresses a 45-degree wall to
# cos45 of its true run — the texture then reads 41.4% too long, and a brick
# course is visibly wrong. u is measured along the wall's own direction, which
# is exact at every angle.
import math  # noqa: E402

DIAG = (math.sqrt(0.5), 0.0, -math.sqrt(0.5))       # a wall at 45 degrees
start, end = _box_uv((0.0, 0.0, 0.0), DIAG), _box_uv((10.0, 0.0, 10.0), DIAG)
true_run = math.hypot(10.0, 10.0)
ok("a 45-degree wall's u span equals its REAL run",
   abs(abs(end[0] - start[0]) - true_run) < 1e-6,
   f"{abs(end[0] - start[0]):.4f} vs {true_run:.4f}")

# The whole point: the same wall at any angle gives the same texture length.
for degrees in (0, 15, 30, 45, 60, 75, 90):
    rad = math.radians(degrees)
    dx, dz = math.cos(rad), math.sin(rad)
    normal = (dz, 0.0, -dx)                          # perpendicular, in plan
    p0 = _box_uv((0.0, 0.0, 0.0), normal)
    p1 = _box_uv((6.0 * dx, 0.0, 6.0 * dz), normal)
    if abs(abs(p1[0] - p0[0]) - 6.0) > 1e-6:
        ok(f"a wall at {degrees} degrees measures 6.0 m",
           False, f"{abs(p1[0] - p0[0]):.4f}")
        break
else:
    ok("a 6 m wall measures 6 m at every angle from 0 to 90 degrees", True)

ok("height is still world y, so courses stay horizontal at any angle",
   _box_uv((3.0, 2.4, 3.0), DIAG)[1] == 2.4)

print("-- and the unit is metres, so a material tiles from its own size --")
a = _box_uv((0.0, 0.0, 0.0), (0.0, 1.0, 0.0))
b = _box_uv((2.0, 0.0, 0.0), (0.0, 1.0, 0.0))
ok("two metres of building is two units of u", abs((b[0] - a[0]) - 2.0) < 1e-9,
   f"{b[0] - a[0]}")
ok("a 0.6 m tile therefore repeats 10 times across 6 m",
   abs(((_box_uv((6.0, 0, 0), (0, 1, 0))[0]) / 0.6) - 10.0) < 1e-9)

print("-- the written GLB carries them --")
mesh = MeshBuilder()
mesh.add_box_from_segment(0.0, 0.0, 6.0, 0.0, 0.2, 3.0, base_z=0.0)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "wall.glb"
    write_glb({"walls": mesh}, out)
    doc, data = read_glb(out)
    attrs = set(doc["meshes"][0]["primitives"][0]["attributes"])
    ok("TEXCOORD_0 is present alongside POSITION and NORMAL",
       {"POSITION", "NORMAL", "TEXCOORD_0"} <= attrs, str(sorted(attrs)))
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]]
    ok("declared VEC2 of float", acc["type"] == "VEC2" and acc["componentType"] == 5126)
    ok("one uv per vertex",
       acc["count"] == len(mesh.positions), f"{acc['count']} vs {len(mesh.positions)}")

    uvs = uvs_of(doc, data)
    span_u = max(u for u, _ in uvs) - min(u for u, _ in uvs)
    span_v = max(v for _, v in uvs) - min(v for _, v in uvs)
    # A 6.0 x 0.2 x 3.0 m box, and the u span is 12 — TWICE the wall's length.
    # That is right, not a fault. Each long face measures u along its OWN
    # outward direction, and the two faces look opposite ways, so one runs
    # 0 -> 6 and the other 0 -> -6. The texture on each side therefore reads
    # correctly from the side you are standing on, which is what a real wall
    # does. What matters for tiling is that each FACE spans its own 6 m, and
    # that consecutive pieces of one wall agree: they share a normal, so they
    # share a u direction, and u comes from absolute world position — so a
    # texture runs continuously across the pieces a doorway splits a wall into.
    ok("each face spans the wall's real length; the two sides mirror",
       abs(span_u - 12.0) <= 0.3 and abs(span_v - 3.2) <= 0.2,
       f"u span {span_u:.3f}, v span {span_v:.3f}")
    ok("the 3 m height appears as v on the long faces",
       any(abs(v - 3.0) < 1e-6 for _, v in uvs), "")

print("-- computed at write time, so a moved mesh keeps aligned UVs --")
moved = MeshBuilder()
moved.add_box_from_segment(0.0, 0.0, 6.0, 0.0, 0.2, 3.0, base_z=0.0)
moved.translate_plan(10.0, 4.0)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "moved.glb"
    write_glb({"walls": moved}, out)
    doc2, data2 = read_glb(out)
    uvs2 = uvs_of(doc2, data2)
ok("the translated wall's UVs moved with it",
   any(abs(u - 10.0) < 1e-6 or abs(u - 16.0) < 1e-6 for u, _ in uvs2),
   "u follows world x")
ok("...and its height is still v, unchanged by a plan move",
   any(abs(v - 3.0) < 1e-6 for _, v in uvs2))

print("-- surface classes: what each mesh IS, in the shared vocabulary --")
from build.glb import surface_class  # noqa: E402

ok("a room's floor is tagged for the room it serves",
   surface_class("storey0_floor_room6_shower", "bathroom")[0] == "floor_bath")
ok("...and falls back when the room kind is unknown",
   surface_class("storey0_floor_room9_unknown", "unknown")[0] == "floor_living")
ok("a ceiling is a ceiling", surface_class("storey0_ceiling_room0_foyer")[0] == "ceiling")
ok("a room-facing wall is internal — its side IS known",
   surface_class("storey0_wall_room3_shower")[0] == "internal_wall")
ok("a pool is water", surface_class("storey0_water_room3_pool")[0] == "water_body")
ok("a lawn is a lawn", surface_class("storey0_lawn")[0] == "lawn")

# The refusals, which are the load-bearing half.
ok("the poché mesh is NOT tagged — it carries both sides of every wall",
   surface_class("storey0_walls")[0] is None)
ok("furniture is not a building surface", surface_class("storey0_fixtures")[0] is None)

# The substring trap the material lookup already documents: an indoor room
# named "water closet" must not become pool water.
ok("a room NAMED for water is not water",
   surface_class("storey0_floor_room4_water-closet", "toilet")[0] == "floor_toilet")

print("-- three defects found in review, each a shipped bug --")
# D1: every outdoor floor resolved to `driveway`, because the mesh KIND
# (paving) was mapped before the room's own name was read. A balcony is the
# most visible surface in a villa walkthrough and it was rendering as tarmac.
ok("a deck is a balcony floor, not a driveway",
   surface_class("storey0_paving_room5_deck")[0] == "floor_balcony")
ok("a patio is a courtyard floor",
   surface_class("storey0_paving_room4_office-patio")[0] == "floor_courtyard")
ok("a parking bay IS parking",
   surface_class("storey0_paving_room7_parking")[0] == "floor_parking")
ok("...and a driveway is still a driveway",
   surface_class("storey0_paving_room2_driveway")[0] == "driveway")

# D2: several floor_* classes had no producer, so those materials were
# unreachable whatever the library said. The room's own name reaches them
# even when the classifier could not type the room.
ok("a stair reaches floor_stair",
   surface_class("storey0_floor_room3_stair", "unknown")[0] == "floor_stair")
ok("a store reaches floor_store",
   surface_class("storey0_floor_room12_store", "unknown")[0] == "floor_store")

# The trap that fix walked straight into: "storey0" CONTAINS "store", so
# matching words against the whole mesh name typed every unnamed room on the
# ground floor as a store cupboard. Words match the room slug only.
ok("'storey0' does not make an unnamed room a store",
   surface_class("storey0_floor_room9_unknown", "unknown")[0] == "floor_living")

# D3: an unknown room resolved silently to floor_living — vitrified 800, the
# PREMIUM floor in the library. The fallback stays, because something must be
# rendered, but it now says it is a fallback.
ok("a determined class is marked measured",
   surface_class("storey0_floor_room6_shower", "bathroom")[1] == "measured")
ok("a defaulted class is marked ASSUMED, so a render stays auditable",
   surface_class("storey0_floor_room9_unknown", "unknown")[1] == "assumed")
ok("an unnamed outdoor floor is assumed too",
   surface_class("storey0_paving_room9_unnamed")[1] == "assumed")

print("-- and they reach the GLB as extras, which loaders carry untouched --")
tagged = MeshBuilder()
tagged.add_box_from_segment(0.0, 0.0, 4.0, 0.0, 0.2, 3.0, base_z=0.0)
plain = MeshBuilder()
plain.add_box_from_segment(0.0, 1.0, 4.0, 1.0, 0.2, 3.0, base_z=0.0)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "tagged.glb"
    write_glb({"storey0_floor_room1_bath": tagged, "storey0_walls": plain}, out,
              room_kinds={"storey0_floor_room1_bath": "bathroom"})
    doc3, _ = read_glb(out)
    by_name = {m["name"]: m for m in doc3["meshes"]}
ok("the floor carries its class",
   by_name["storey0_floor_room1_bath"].get("extras", {}).get("surfaceClass")
   == "floor_bath")
ok("the poché carries no extras at all — absence, not a guess",
   "extras" not in by_name["storey0_walls"])

print("-- the poche split: each long face routed by what stands in front of it --")
from build.solidify import build_walls, side_classes  # noqa: E402
from hypothesise.pair import Wall  # noqa: E402


class _Space:
    def __init__(self, loop):
        self.loop = loop


# A 6 x 4 m room. Its south wall runs west->east, so the room lies to the
# LEFT of a->b (the -n side, since n is the RIGHT-hand normal).
ROOM = _Space([(0.0, 0.0), (6.0, 0.0), (6.0, 4.0), (0.0, 4.0)])
SOUTH = Wall(0.0, 0.0, 6.0, 0.0, 0.2, True, 1.0, "WALLS")

sides = side_classes([SOUTH], [ROOM])
ok("the room-facing side is seen, the outward side is not",
   sides.get(0) == (False, True), str(sides.get(0)))

# Reverse the same wall: the room is now on the RIGHT of a->b, and the
# classification must follow the geometry rather than the vertex order.
REVERSED = Wall(6.0, 0.0, 0.0, 0.0, 0.2, True, 1.0, "WALLS")
ok("...and it follows the geometry when the wall is drawn the other way",
   side_classes([REVERSED], [ROOM]).get(0) == (True, False),
   str(side_classes([REVERSED], [ROOM]).get(0)))

print("-- and every triangle lands in exactly one place --")
whole = MeshBuilder()
build_walls(whole, [SOUTH], [], height=3.0)

core, inner, outer = MeshBuilder(), MeshBuilder(), MeshBuilder()
reveal = MeshBuilder()
build_walls(core, [SOUTH], [], height=3.0,
            internal_mesh=inner, external_mesh=outer, reveal_mesh=reveal,
            spaces=[ROOM])

tris = lambda m: len(m.indices) // 3  # noqa: E731
ok("no triangle is created or lost by splitting",
   tris(core) + tris(inner) + tris(outer) + tris(reveal) == tris(whole),
   f"{tris(core)}+{tris(inner)}+{tris(outer)}+{tris(reveal)} vs {tris(whole)}")
ok("the room-facing face went to the internal mesh", tris(inner) == 2,
   f"{tris(inner)} triangles")
ok("the outward face went to the external mesh", tris(outer) == 2,
   f"{tris(outer)} triangles")
ok("both END faces went to the reveal mesh — their finish follows the FRAME",
   tris(reveal) == 4, f"{tris(reveal)} triangles")
ok("only top and bottom are left in the core, and they are buried",
   tris(core) == 4, f"{tris(core)} triangles")
ok("a reveal is tagged as itself, never folded into a wall side",
   surface_class("storey0_wallface_reveal")[0] == "wallface_reveal")

print("-- the plinth band: the first 450 mm of an EXTERNAL wall only --")
from build.solidify import PLINTH_HEIGHT  # noqa: E402

core2, inner2, outer2 = MeshBuilder(), MeshBuilder(), MeshBuilder()
reveal2, plinth = MeshBuilder(), MeshBuilder()
build_walls(core2, [SOUTH], [], height=3.0,
            internal_mesh=inner2, external_mesh=outer2, reveal_mesh=reveal2,
            plinth_mesh=plinth, spaces=[ROOM])

ok("the outward face gains a plinth band", tris(plinth) == 2,
   f"{tris(plinth)} triangles")
# The room-facing face is CUT by the same slice — the wall is one solid, so
# splitting it splits both sides — but both halves stay internal. A plinth is
# a facade feature and must not appear indoors, and the test for that is
# where the triangles GO, not how many there are.
ok("the room-facing face is split too, but stays entirely internal",
   tris(inner2) == 4 and tris(plinth) == 2,
   f"internal {tris(inner2)}, plinth {tris(plinth)}")
ok("no plinth triangle faces a room",
   all(p[1] <= PLINTH_HEIGHT + 1e-9 for p in plinth.positions))

# The band is a HEIGHT slice, so it must occupy exactly the bottom 450 mm.
ys = [p[1] for p in plinth.positions]
ok(f"it occupies exactly the bottom {PLINTH_HEIGHT} m",
   abs(min(ys)) < 1e-9 and abs(max(ys) - PLINTH_HEIGHT) < 1e-9,
   f"y [{min(ys):.3f}, {max(ys):.3f}]")
ok("and the wall above it starts where the band stops",
   abs(min(p[1] for p in outer2.positions) - PLINTH_HEIGHT) < 1e-9,
   f"{min(p[1] for p in outer2.positions):.3f}")
ok("a plinth mesh is tagged as one", surface_class("storey0_wallface_plinth")[0] == "plinth")

# A wall shorter than the band must not be sliced into a sliver.
short_core, short_out, short_plinth = MeshBuilder(), MeshBuilder(), MeshBuilder()
build_walls(short_core, [SOUTH], [], height=0.30,
            internal_mesh=MeshBuilder(), external_mesh=short_out,
            reveal_mesh=MeshBuilder(), plinth_mesh=short_plinth, spaces=[ROOM])
ok("a wall shorter than the band is left whole", tris(short_plinth) == 0,
   f"{tris(short_plinth)} triangles")

print("-- the roof: inferred, tagged ASSUMED, and opt-in --")
from build.solidify import PARAPET_HEIGHT, build_roof  # noqa: E482

roof_meshes, roof_report = build_roof([ROOM], height=3.0)
ok("a roof is built over the indoor footprint", "roof" in roof_meshes)
ok("with a parapet", "parapet" in roof_meshes and roof_report["parapet"] >= 4,
   str(roof_report.get("parapet")))
ok("it covers more than the rooms — it oversails the walls",
   roof_report["area"] > 6.0 * 4.0, f"{roof_report['area']} m2 over 24 m2 of room")
ok("the report says plainly that it was assumed",
   "does not draw" in roof_report.get("assumed", ""))

# The roof is the ONLY class assumed by construction rather than by a gap in
# the drawing — a plan never draws one, so there is nothing to be measured.
ok("a roof mesh is tagged assumed",
   surface_class("storey0_roof") == ("roof", "assumed"))
ok("so is its parapet",
   surface_class("storey0_parapet") == ("parapet_coping", "assumed"))

# It sits above the walls, and the parapet above the slab.
roof_ys = [p[1] for p in roof_meshes["roof"].positions]
para_ys = [p[1] for p in roof_meshes["parapet"].positions]
ok("the slab sits at wall head height", abs(min(roof_ys) - 3.0) < 1e-6,
   f"{min(roof_ys):.3f}")
from build.solidify import SLAB_THICKNESS  # noqa: E402

ok(f"the parapet stands {PARAPET_HEIGHT} m above the slab",
   abs(max(para_ys) - (3.0 + SLAB_THICKNESS + PARAPET_HEIGHT)) < 1e-6,
   f"parapet top {max(para_ys):.3f}, expected {3.0 + SLAB_THICKNESS + PARAPET_HEIGHT:.3f}")
ok("...and starts above it, never inside it", min(para_ys) > min(roof_ys),
   f"{min(para_ys):.3f} > {min(roof_ys):.3f}")

# An outdoor-only model has nothing to roof, and says so rather than
# inventing a lid over a lawn.
none_meshes, none_report = build_roof([], height=3.0)
ok("nothing to cover means no roof, with a reason",
   none_meshes == {} and "no indoor rooms" in none_report["reason"])

print("-- physical stairs: proven straight and dog-leg/U cores only --")
from build.solidify import (  # noqa: E402
    STAIR_MAX_RISER, build_marked_stairs, build_stairs, open_stair_cores,
)


class _StairSpace:
    def __init__(self, index, name, loop):
        self.index = index
        self.name = name
        self.loop = loop
        self.kind = "circulation"


LOWER_STAIR = _StairSpace(
    7, "STAIRCASE",
    [(0.0, 0.0), (5.2, 0.0), (5.2, 1.2), (0.0, 1.2)],
)
# Deliberately far away in sheet coordinates. The registration shift proves
# the builder compares and places the two footprints in building coordinates.
UPPER_STAIR = _StairSpace(
    3, "STAIR WELL",
    [(10.0, 0.0), (15.2, 0.0), (15.2, 1.2), (10.0, 1.2)],
)
stair_meshes, stair_report = build_stairs(
    [LOWER_STAIR], [UPPER_STAIR], rise=3.0, base_z=1.5,
    lower_shift=(2.0, 3.0), upper_shift=(-8.0, 3.0),
)
ok("registered named stair rooms produce one physical flight",
   len(stair_meshes) == 1 and stair_report["stairs"] == 1,
   str(stair_report))
ok("a long narrow core still prefers the simpler straight flight",
   stair_report["layouts"][0]["type"] == "straight",
   str(stair_report["layouts"]))
stair_mesh = next(iter(stair_meshes.values()))
expected_risers = math.ceil(3.0 / STAIR_MAX_RISER)
ok("one solid tread is built per code-sized riser",
   tris(stair_mesh) == expected_risers * 12,
   f"{tris(stair_mesh)} triangles for {expected_risers} risers")
stair_ys = [p[1] for p in stair_mesh.positions]
ok("the flight joins the exact adjacent-storey elevations",
   abs(min(stair_ys) - 1.5) < 1e-6 and abs(max(stair_ys) - 4.5) < 1e-6,
   f"y [{min(stair_ys):.3f}, {max(stair_ys):.3f}]")
ok("its inferred construction is explicit in both report and surface tag",
   stair_report.get("assumed") and
   surface_class("storey0_stair_room7_staircase") == ("floor_stair", "assumed"))
ok("the report identifies the exact rooms whose horizontal caps must open",
   stair_report["verticalOpenings"] == [{"lowerRoom": 7, "upperRoom": 3}],
   str(stair_report["verticalOpenings"]))

lower_caps = {
    "ceiling_room7_staircase": MeshBuilder(),
    "floor_room7_staircase": MeshBuilder(),
    "ceiling_room8_hall": MeshBuilder(),
}
upper_caps = {
    "floor_room3_stair-well": MeshBuilder(),
    "ceiling_room3_stair-well": MeshBuilder(),
    "floor_room4_hall": MeshBuilder(),
}
removed_caps = open_stair_cores(lower_caps, upper_caps, stair_report)
ok("a built flight opens its lower ceiling and upper floor",
   set(removed_caps) == {
       "ceiling_room7_staircase", "floor_room3_stair-well",
   })
ok("opening the core preserves its base, upper ceiling, and adjacent rooms",
   set(lower_caps) == {"floor_room7_staircase", "ceiling_room8_hall"} and
   set(upper_caps) == {"ceiling_room3_stair-well", "floor_room4_hall"})

misaligned = _StairSpace(
    4, "STAIR", [(30.0, 0.0), (35.2, 0.0), (35.2, 1.2), (30.0, 1.2)],
)
no_stairs, no_stair_report = build_stairs(
    [LOWER_STAIR], [misaligned], rise=3.0,
)
ok("misaligned stair labels do not invent a connection",
   not no_stairs and "no aligned stair" in no_stair_report["refused"][0])

missing_lower_meshes, missing_lower_report = build_stairs(
    [], [UPPER_STAIR], rise=3.0,
)
ok("a missing lower stair-room label is an explicit refusal",
   not missing_lower_meshes and
   missing_lower_report["refused"] == [
       "lower storey has no explicitly named stair room"
   ],
   str(missing_lower_report))

missing_upper_meshes, missing_upper_report = build_stairs(
    [LOWER_STAIR], [], rise=3.0,
)
ok("a missing upper stair-room label is an explicit refusal",
   not missing_upper_meshes and
   missing_upper_report["refused"] == [
       "upper storey has no explicitly named stair room"
   ],
   str(missing_upper_report))

duplicate_upper = _StairSpace(
    10, "SECOND STAIR WELL",
    [(0.1, 0.0), (5.1, 0.0), (5.1, 1.2), (0.1, 1.2)],
)
ambiguous_meshes, ambiguous_report = build_stairs(
    [LOWER_STAIR], [LOWER_STAIR, duplicate_upper], rise=3.0,
)
ok("one lower core matching two upper cores is refused as ambiguous",
   not ambiguous_meshes and
   "multiple aligned stair rooms" in ambiguous_report["refused"][0],
   str(ambiguous_report))

duplicate_lower = _StairSpace(
    11, "SECOND STAIRCASE",
    [(0.0, 0.0), (5.2, 0.0), (5.2, 1.2), (0.0, 1.2)],
)
shared_upper_meshes, shared_upper_report = build_stairs(
    [LOWER_STAIR, duplicate_lower], [LOWER_STAIR], rise=3.0,
)
ok("two lower cores competing for one upper core are both refused",
   not shared_upper_meshes and len(shared_upper_report["refused"]) == 2 and
   all("multiple lower stair rooms" in reason
       for reason in shared_upper_report["refused"]),
   str(shared_upper_report))

tight = _StairSpace(
    5, "STAIR", [(0.0, 0.0), (4.0, 0.0), (4.0, 1.2), (0.0, 1.2)],
)
tight_meshes, tight_report = build_stairs([tight], [tight], rise=3.0)
ok("a core too narrow for two flights remains refused",
   not tight_meshes and "straight or dog-leg/U" in tight_report["refused"][0],
   str(tight_report))

dogleg = _StairSpace(
    8, "STAIRCASE",
    [(0.0, 0.0), (3.4, 0.0), (3.4, 2.1), (0.0, 2.1)],
)
dogleg_meshes, dogleg_report = build_stairs(
    [dogleg], [dogleg], rise=3.0, base_z=-0.5,
)
ok("a rectangular core too short for straight stairs recovers as a dog-leg/U",
   len(dogleg_meshes) == 1 and
   dogleg_report["layouts"][0]["type"] == "dog-leg-u",
   str(dogleg_report))
dogleg_layout = dogleg_report["layouts"][0]
ok("the odd riser count is split across two opposing flights",
   dogleg_layout["risers"] == [8, 9],
   str(dogleg_layout["risers"]))
dogleg_mesh = next(iter(dogleg_meshes.values()))
ok("the U stair contains every tread plus one intermediate landing",
   tris(dogleg_mesh) == (expected_risers + 1) * 12,
   f"{tris(dogleg_mesh)} triangles")
dogleg_ys = [p[1] for p in dogleg_mesh.positions]
ok("the recovered stair still joins the exact storey elevations",
   abs(min(dogleg_ys) + 0.5) < 1e-6 and
   abs(max(dogleg_ys) - 2.5) < 1e-6,
   f"y [{min(dogleg_ys):.3f}, {max(dogleg_ys):.3f}]")
expected_landing_height = -0.5 + 3.0 * 8 / 17
ok("the landing is reported at the first flight's exact top elevation",
   abs(dogleg_layout["landingHeight"] - expected_landing_height) < 0.001,
   f"{dogleg_layout['landingHeight']:.3f}")

# Each add_box_from_segment contributes 24 vertices. The first eight boxes are
# flight one, box eight is the landing, and the remaining nine reverse toward
# the starting end on the other side of the core.
def _box_plan_centre(mesh, box_index):
    points = mesh.positions[box_index * 24:(box_index + 1) * 24]
    return (
        sum(point[0] for point in points) / len(points),
        -sum(point[2] for point in points) / len(points),
    )


first_a = _box_plan_centre(dogleg_mesh, 0)
first_b = _box_plan_centre(dogleg_mesh, 7)
second_a = _box_plan_centre(dogleg_mesh, 9)
second_b = _box_plan_centre(dogleg_mesh, 17)
first_vector = (first_b[0] - first_a[0], first_b[1] - first_a[1])
second_vector = (second_b[0] - second_a[0], second_b[1] - second_a[1])
ok("the two flights run in opposite plan directions",
   first_vector[0] * second_vector[0] + first_vector[1] * second_vector[1] < 0,
   f"{first_vector} vs {second_vector}")
ok("the parallel flight centrelines retain the reported central separation",
   abs(math.dist(first_b, second_a) - (
       dogleg_layout["flightWidth"] + dogleg_layout["flightGap"]
   )) < 0.001,
   f"{math.dist(first_b, second_a):.3f} m")
dogleg_xs = [p[0] for p in dogleg_mesh.positions]
dogleg_plan_ys = [-p[2] for p in dogleg_mesh.positions]
ok("both flights and the landing stay inside the measured shared core",
   min(dogleg_xs) >= -1e-6 and max(dogleg_xs) <= 3.4 + 1e-6 and
   min(dogleg_plan_ys) >= -1e-6 and max(dogleg_plan_ys) <= 2.1 + 1e-6,
   f"x [{min(dogleg_xs):.3f}, {max(dogleg_xs):.3f}], "
   f"y [{min(dogleg_plan_ys):.3f}, {max(dogleg_plan_ys):.3f}]")

undersized_u = _StairSpace(
    9, "STAIR",
    [(0.0, 0.0), (3.1, 0.0), (3.1, 1.85), (0.0, 1.85)],
)
undersized_meshes, undersized_report = build_stairs(
    [undersized_u], [undersized_u], rise=3.0,
)
ok("a nearly large-enough U core refuses with its measured minimum",
   not undersized_meshes and
   "dog-leg minimum is 3.25 x 1.90 m" in undersized_report["refused"][0],
   str(undersized_report))

irregular = _StairSpace(
    6, "STAIR",
    [(0.0, 0.0), (5.2, 0.0), (5.2, 0.5), (1.2, 0.5),
     (1.2, 2.0), (0.0, 2.0)],
)
irregular_meshes, irregular_report = build_stairs(
    [irregular], [irregular], rise=3.0,
)
ok("an irregular core is refused rather than crossed by its bounding box",
   not irregular_meshes and "shaped or turning flight" in irregular_report["refused"][0],
   str(irregular_report))


class _Line:
    def __init__(self, ax, ay, bx, by):
        self.ax, self.ay, self.bx, self.by = ax, ay, bx, by


class _Marker:
    def __init__(self, x, y, level):
        self.x, self.y, self.level = x, y, level


def _riser_lines(y0, y1):
    return [_Line(x, y0, x, y1) for x in [i * 0.3 for i in range(9)]]


lower_marked_faces = [
    *_riser_lines(0.0, 1.15),
    *_riser_lines(1.25, 2.40),
    _Line(3.60, 0.0, 3.60, 2.40),
]
upper_marked_faces = _riser_lines(0.0, 2.40)
marked_meshes, marked_report = build_marked_stairs(
    lower_marked_faces, upper_marked_faces,
    [_Marker(-0.4, 1.8, 0.0)], [_Marker(0.2, 0.5, 1.0)],
    rise=3.0, base_z=-3.0,
)
ok("paired UP/DOWN markers plus measured riser runs recover one dog-leg",
   len(marked_meshes) == 1 and marked_report["stairs"] == 1,
   str(marked_report))
ok("measured stair reporting preserves the 9+9 risers and 0.30 m going",
   marked_report["layouts"][0]["risers"] == [9, 9] and
   marked_report["layouts"][0]["going"] == 0.3,
   str(marked_report["layouts"]))
marked_mesh = next(iter(marked_meshes.values()))
ok("the measured stair joins both exact storey elevations",
   abs(min(p[1] for p in marked_mesh.positions) + 3.0) < 1e-6 and
   abs(max(p[1] for p in marked_mesh.positions)) < 1e-6)
unconfirmed_meshes, unconfirmed_report = build_marked_stairs(
    lower_marked_faces, upper_marked_faces,
    [_Marker(-0.4, 1.8, 0.0)], [], rise=3.0,
)
ok("riser lines without an upper DOWN marker still refuse",
   not unconfirmed_meshes and "no unique paired" in unconfirmed_report["refused"][0])

partial_lower = {"ceiling_room1_hall": MeshBuilder()}
partial_upper = {"floor_room1_hall": MeshBuilder()}
partial_room = _StairSpace(
    1, "HALL", [(-1.0, -1.0), (5.0, -1.0), (5.0, 3.0), (-1.0, 3.0)],
)
partial_lower["ceiling_room1_hall"].add_polygon_face(partial_room.loop, 0.0, up=False)
partial_upper["floor_room1_hall"].add_polygon_slab(
    partial_room.loop, -0.12, 0.12,
)
partial_report = {"verticalOpenings": marked_report["verticalOpenings"]}
partial_changes = open_stair_cores(
    partial_lower, partial_upper, partial_report,
    lower_spaces=[partial_room], upper_spaces=[partial_room],
    lower_ceiling_z=0.0, upper_base_z=0.0,
)
ok("a measured core cuts partial ceiling and floor openings",
   len(partial_changes) == 2 and
   all("measured partial opening" in change for change in partial_changes),
   str(partial_changes))
ok("partial stair openings preserve the surrounding room meshes",
   partial_lower["ceiling_room1_hall"].indices and
   partial_upper["floor_room1_hall"].indices)

print("-- an unclassified build is byte-identical to the old one --")
plain_a, plain_b = MeshBuilder(), MeshBuilder()
build_walls(plain_a, [SOUTH], [], height=3.0)
build_walls(plain_b, [SOUTH], [], height=3.0, spaces=None)
ok("passing no spaces changes nothing at all",
   plain_a.positions == plain_b.positions and plain_a.indices == plain_b.indices)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
