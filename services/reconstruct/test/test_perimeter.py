"""
The derived envelope: how it is built, how it is checked, what must not move.

Run:  .venv/Scripts/python.exe test/test_perimeter.py

Three defects live here, and they share a shape worth stating once. Each was
invisible in every number the engine printed:

  * the ring is extruded coincident with the walls it duplicates, which
    z-fights and renders as large black surfaces. No quantity changes.
  * `join_corners` rebuilt Wall positionally and dropped a field. No error.
  * nothing checked that the derived envelope goes round the building. On the
    villa it contains 46% of the floor, and the model reported PASS.

So these assertions are mostly about things that stay the same. A test that only
watches the number that moved would have caught none of them.
"""

from __future__ import annotations

import sys
from dataclasses import fields
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build.glb import MeshBuilder  # noqa: E402
from build.solidify import (  # noqa: E402
    DERIVED_PERIMETER,
    RING_INSET,
    build_walls,
)
from hypothesise.pair import Wall, join_corners  # noqa: E402
from hypothesise.perimeter import add_perimeter  # noqa: E402
from solve import spaces as sp  # noqa: E402
from solve import verify as vf  # noqa: E402

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


def close(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def box(x0, y0, x1, y1, thickness=0.23, layer="A1 WALLS", paired=True):
    """Four walls round a rectangle, as the pairing stage would leave them."""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    return [
        Wall(ax=a[0], ay=a[1], bx=b[0], by=b[1], thickness=thickness,
             paired=paired, confidence=0.9, layer=layer)
        for a, b in zip(corners, corners[1:])
    ]


def cellular(x0, y0, x1, y1, spacing=1.5):
    """
    A rectangle with partitions close enough together to derive an envelope.

    A bare rectangle derives NOTHING, which is the whole defect in miniature.
    add_perimeter dilates the centrelines by CLOSE_RADIUS and erodes by the
    same, and closing a lone outline returns the outline -- zero area, no ring.
    A ring only appears where dilation MERGES neighbouring walls, so the
    envelope is the wall network thickened rather than a footprint. Partitions
    at 1.5 m are inside the 2 m bridging distance and produce one; the same
    walls at 4 m apart would not.
    """
    walls = box(x0, y0, x1, y1)
    x = x0 + spacing
    while x < x1 - spacing / 2:
        walls.append(Wall(ax=x, ay=y0, bx=x, by=y1, thickness=0.115,
                          paired=True, confidence=0.8, layer="A1 WALLS"))
        x += spacing
    return walls


print("-- join_corners keeps every field --")

# The positional rebuild listed eight of Wall's nine fields, so `duplicate` came
# back 0.0 on every wall that passed through. Nothing raised: a dropped field
# and a field that was always zero are indistinguishable downstream.
carrying = box(0, 0, 4, 3)
for i, w in enumerate(carrying):
    w.duplicate = round(0.5 + i * 0.25, 4)

before = sum(w.duplicate for w in carrying)
after = sum(w.duplicate for w in join_corners(carrying))
ok("a round trip through join_corners preserves `duplicate`",
   close(before, after), f"{before} in, {after} out")

# The real defect was that Wall could grow a field and this would silently drop
# it. Pin the mechanism, not the one field that happened to be lost.
joined = join_corners(carrying)
ok("and preserves every declared field, so a new one cannot be dropped",
   all(
       any(close(getattr(j, f.name), getattr(w, f.name))
           if isinstance(getattr(w, f.name), float)
           else getattr(j, f.name) == getattr(w, f.name)
           for j in joined)
       for w in carrying
       for f in fields(Wall)
       if f.name not in ("ax", "ay", "bx", "by")  # these move, by design
   ),
   f"{len(fields(Wall))} fields")


print("\n-- the ring is built clear of what it duplicates --")

drawn = cellular(0, 0, 12, 9)
walls = add_perimeter(drawn)
ring = [w for w in walls if w.layer == DERIVED_PERIMETER]
ok("a closed plan still derives an envelope", len(ring) > 0, f"{len(ring)} segs")

mesh = MeshBuilder()
stats = build_walls(mesh, walls, [], height=2.7)
ok("every wall is extruded, ring included",
   stats["skippedUnpaired"] == 0 and stats["pieces"] == len(walls),
   f"{stats['pieces']} pieces from {len(walls)} walls")

# The fix is clearance, not deletion. Deleting the duplicated ring was measured
# and rejected: it removes 44 m of envelope on the villa that no paired wall
# stands under, because build_walls skips unpaired walls and the ring is the
# only thing meshing that stretch.
only_ring = MeshBuilder()
build_walls(only_ring, ring, [], height=2.7)
ring_tris = only_ring.triangles
ok("the ring contributes real geometry rather than being skipped",
   ring_tris > 0, f"{ring_tris} triangles")

# Both axes matter. A wall box shares its TOP face with its neighbour as well as
# its sides, so insetting thickness alone leaves the roof-plane z-fighting.
ok("the inset is applied to thickness", RING_INSET > 0, f"{RING_INSET} m")
ok("and is at least four times the half-millimetre coplanarity threshold",
   RING_INSET >= 0.002, f"{RING_INSET} m")
ok("and is small enough to be invisible to any quantity",
   RING_INSET < 0.01, f"{RING_INSET} m")

# What must NOT move: the schedule prices Wall.thickness, and spaces.py reads
# every wall within 0.05 m to work out finished-face room areas. The inset lives
# inside build_walls and must not leak into either.
ok("building the mesh does not alter the ring's recorded thickness",
   all(w.thickness > RING_INSET for w in ring) and len({round(w.thickness, 6) for w in ring}) == 1,
   f"{sorted({round(w.thickness, 4) for w in ring})}")


print("\n-- the envelope is checked against the building --")


def coverage_of(report):
    for c in report.checks:
        if c.name == "envelope-coverage":
            return c
    return None


# A ring round the building: coverage is high and the check is quiet.
good_walls = add_perimeter(cellular(0, 0, 12, 9))
good_spaces = sp.detect_spaces(good_walls)
good = vf.check(input_segments=len(good_walls), walls=good_walls,
                spaces=good_spaces, openings=[], unhosted=0)
got = coverage_of(good)
ok("a sound envelope reports its coverage",
   got is not None and got.level == "info", str(got.value if got else None))

# A ring that misses the building. Built by putting the rooms somewhere the
# envelope cannot reach rather than by deforming the ring, so the check is being
# asked the question it exists for.
# A cellular block that DOES derive an envelope, plus a plain room far away
# that does not contribute to it. The ring goes round the first and ignores the
# second, which is exactly the villa's failure at synthetic scale.
far = cellular(0, 0, 12, 9) + box(40, 40, 50, 50)
far_walls = add_perimeter(far)
far_spaces = sp.detect_spaces(far_walls)
report = vf.check(input_segments=len(far_walls), walls=far_walls,
                  spaces=far_spaces, openings=[], unhosted=0)
missed = coverage_of(report)
ok("an envelope that misses part of the building is flagged",
   missed is not None and missed.level == "warning",
   f"{missed.value if missed else None}")
ok("and the ratio is reported as a number, not only as a verdict",
   missed is not None and isinstance(missed.value, (int, float))
   and 0.0 <= missed.value <= 1.0,
   str(missed.value if missed else None))

# A courtyard is a legitimate hole. Faces are unioned rather than summed so an
# atrium plan is not punished for having one.
ok("the threshold demands most of the floor, not all of it",
   0.5 < vf.ENVELOPE_COVERAGE_MIN < 1.0, str(vf.ENVELOPE_COVERAGE_MIN))

# Outdoor space is excluded on purpose: a correct envelope leaves the lawn out,
# and on the villa it gets 7 of 8 outdoor labels right. Counting them would mark
# a correct exclusion as a failure.
outdoor_ignored = [s for s in far_spaces if getattr(s, "kind", "") == "outdoor"]
ok("outdoor spaces are not counted against the envelope",
   missed is not None,
   f"{len(outdoor_ignored)} outdoor space(s) present")

# No ring, no claim. A drawing whose walls close on their own derives no
# envelope, and a check about an envelope must then say nothing rather than 0.0.
bare = box(0, 0, 6, 5)
bare_report = vf.check(input_segments=len(bare), walls=bare,
                       spaces=sp.detect_spaces(bare), openings=[], unhosted=0)
ok("no derived envelope means no coverage check at all",
   coverage_of(bare_report) is None)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
