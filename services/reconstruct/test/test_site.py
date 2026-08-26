"""
Site segmentation: which rooms make one building.

Run:  .venv/Scripts/python.exe test/test_site.py

The fixture is a small estate — two detached villas and a bin store, with a
compound wall and a road running past all three:

    VILLA A                VILLA B            STORE
    LIVING(0)|BED(1)       HALL(2)|BED(3)     STORE(4)
    shares wall 1          shares wall 4      alone

    ─────────── compound wall (bounds nothing) ───────────
    ─────────── road centreline (bounds nothing) ─────────

What this encodes, and why each case is here:

* Two villas that share NO wall are two buildings, however close they are
  drawn. The distance between them is deliberately small in the fixture (they
  are 1 m apart) because a distance rule would merge them and the whole point
  of the shared-wall criterion is that it does not.
* Two rooms that DO share a wall are one building however far apart their
  centres are — the mirror of the case above.
* A wall bounding no room is site linework and belongs to nobody. It must be
  reported, with its length, not dropped and not billed to the nearest villa.
* Room indices must survive segmentation: `spaceIndices` are the caller's way
  back to the rooms, and an off-by-one here would silently reassign floor area
  between two owners.
* A model whose rooms all connect is ONE building, which is the case that must
  not regress — four real drawings all produce exactly one.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from solve.site import segment_site  # noqa: E402

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


class W:
    """A wall, in the shape `solve` passes around."""

    def __init__(self, ax, ay, bx, by):
        self.ax, self.ay, self.bx, self.by = ax, ay, bx, by


class S:
    """A room, in the shape `solve` passes around."""

    def __init__(self, bounded_by, loop, area, name=None):
        self.bounded_by = bounded_by
        self.loop = loop
        self.area = area
        self.name = name


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# 0,1,2 bound villa A; 3,4,5 bound villa B; 6 bounds the store;
# 7 is the compound wall and 8 the road — neither bounds anything.
WALLS = [
    W(0, 0, 4, 0), W(4, 0, 4, 4), W(0, 4, 4, 4),
    W(5, 0, 9, 0), W(9, 0, 9, 4), W(5, 4, 9, 4),
    W(20, 0, 22, 0),
    W(-5, -3, 40, -3),        # compound wall, 45 m, bounds no room
    W(-5, -6, 15, -6),        # road centreline, 20 m, bounds no room
]

SPACES = [
    S([0, 1], rect(0, 0, 2, 4), 8.0, "LIVING"),
    S([1, 2], rect(2, 0, 4, 4), 8.0, "BED ROOM"),
    S([3, 4], rect(5, 0, 7, 4), 8.0, "HALL"),
    S([4, 5], rect(7, 0, 9, 4), 8.0, None),
    S([6], rect(20, 0, 22, 2), 4.0, "STORE"),
]

seg = segment_site(WALLS, SPACES)

print("-- the estate splits into its buildings --")
ok("three buildings, not one", seg.count == 3, f"got {seg.count}")

by_rooms = {tuple(b.space_indices): b for b in seg.buildings}
ok("villa A is rooms 0 and 1", (0, 1) in by_rooms)
ok("villa B is rooms 2 and 3", (2, 3) in by_rooms)
ok("the store stands alone", (4,) in by_rooms)

print("\n-- one metre apart is still two buildings --")
# Villa A ends at x=4 and villa B starts at x=5. Any gutter or proximity rule
# wide enough to keep one villa whole merges these two; the shared-wall rule
# does not, and this is the assertion that says so.
a, b = by_rooms[(0, 1)], by_rooms[(2, 3)]
ok("the two villas are 1.00 m apart", abs((b.bbox[0] - a.bbox[2]) - 1.0) < 1e-9,
   f"{b.bbox[0] - a.bbox[2]:.2f} m")
ok("and still separate", a.index != b.index)

print("\n-- ranking is by floor area, largest first --")
ok("buildings[0] is a villa, not the store", seg.buildings[0].area == 16.0,
   f"{seg.buildings[0].area:.2f} m2")
ok("the store ranks last", seg.buildings[-1].space_indices == [4])
ok("indices are dense and ordered",
   [x.index for x in seg.buildings] == [0, 1, 2])

print("\n-- what each building carries --")
ok("villa A totals both rooms' area", a.area == 16.0, f"{a.area:.2f} m2")
ok("villa A counts its named rooms", a.named == 2, str(a.named))
ok("villa B counts only the named one", by_rooms[(2, 3)].named == 1)
ok("villa A owns its three walls", a.wall_indices == [0, 1, 2], str(a.wall_indices))
ok("villa A's bbox is its rooms' extent", a.bbox == (0.0, 0.0, 4.0, 4.0), str(a.bbox))
ok("span is the longer side", a.span == 4.0, str(a.span))

print("\n-- linework that bounds nothing belongs to nobody --")
ok("the compound wall and the road are site linework",
   seg.site_wall_indices == [7, 8], str(seg.site_wall_indices))
ok("and their length is reported, not lost",
   abs(seg.site_wall_length - 65.0) < 1e-9, f"{seg.site_wall_length:.2f} m")
ok("no building claims them",
   all(7 not in x.wall_indices and 8 not in x.wall_indices for x in seg.buildings))

print("\n-- a connected plan stays ONE building --")
# The regression that matters. Every real drawing tested produces exactly one
# building; a change that starts splitting villas would break the bill of
# quantities silently, because each fragment is individually plausible.
#
# A CHAIN, deliberately: room 0 never touches room 3, and they are one building
# only because 1 and 2 carry the connection across. A rule that grouped rooms
# by direct adjacency alone would report two here and look correct on a plan
# where every room happens to touch every other.
chain = [
    S([0, 1], rect(0, 0, 2, 4), 8.0, "LIVING"),
    S([1, 2], rect(2, 0, 4, 4), 8.0, "HALL"),
    S([2, 3], rect(4, 0, 6, 4), 8.0, "KITCHEN"),
    S([3, 4], rect(6, 0, 8, 4), 8.0, "BED ROOM"),
]
one = segment_site(WALLS, chain)
ok("a chain of four rooms is one building", one.count == 1, f"got {one.count}")
ok("it holds every room", one.buildings[0].space_indices == [0, 1, 2, 3])
ok("the ends never touch but still share a building",
   set(chain[0].bounded_by) & set(chain[3].bounded_by) == set())

print("\n-- distance alone never merges or splits --")
# The same two rooms, moved 500 m apart, still share wall 1 and so are still
# one building. A proximity rule cannot express this and would report two.
far = [
    S([0, 1], rect(0, 0, 2, 4), 8.0, "LIVING"),
    S([1, 2], rect(500, 0, 502, 4), 8.0, "BED ROOM"),
]
ok("rooms 500 m apart sharing a wall are one building",
   segment_site(WALLS, far).count == 1)

print("\n-- the dict shape, which is what building.json carries --")
as_dicts = [
    {"boundedBy": s.bounded_by, "loop": [list(p) for p in s.loop],
     "area": s.area, "name": s.name}
    for s in SPACES
]
wall_dicts = [
    {"a": {"x": w.ax, "y": w.ay}, "b": {"x": w.bx, "y": w.by}} for w in WALLS
]
from_dicts = segment_site(wall_dicts, as_dicts)
ok("dicts segment identically to dataclasses",
   from_dicts.count == seg.count
   and [x.space_indices for x in from_dicts.buildings]
   == [x.space_indices for x in seg.buildings])
ok("and report the same site linework",
   from_dicts.site_wall_indices == seg.site_wall_indices)

print("\n-- degenerate inputs refuse rather than invent --")
empty = segment_site(WALLS, [])
ok("no rooms means no buildings", empty.count == 0)
ok("and every wall becomes site linework",
   len(empty.site_wall_indices) == len(WALLS), str(len(empty.site_wall_indices)))

# A room whose `boundedBy` never got populated is the failure mode the helpers
# in site.py warn about: it must become its own building rather than vanish.
orphan = segment_site(WALLS, [S([], rect(0, 0, 2, 2), 4.0, "SHED")])
ok("a room with no bounding walls is still a building", orphan.count == 1)
ok("and claims no walls", orphan.buildings[0].wall_indices == [])

print("\n-- serialisation keeps the caller's way back to the rooms --")
d = seg.as_dict()
ok("as_dict reports the count", d["count"] == 3)
ok("as_dict carries space indices",
   d["buildings"][0]["spaceIndices"] == seg.buildings[0].space_indices)
ok("as_dict rounds but does not drop the site length",
   d["siteWallLength"] == 65.0, str(d["siteWallLength"]))

print("\n-- and the grading that reads it --")
# `solve/verify.py` is where the judgement lives; site.py only measures. These
# assertions pin the part that changes what a caller DOES: a site must block,
# because every quantity in the model is summed across structures that were
# never one building, and each of those figures looks perfectly ordinary alone.
import math  # noqa: E402

from solve import verify as vf  # noqa: E402


class VW(W):
    """A wall carrying the extra fields `verify` reads."""

    def __init__(self, ax, ay, bx, by, thickness=0.23, paired=True):
        super().__init__(ax, ay, bx, by)
        self.thickness = thickness
        self.paired = paired
        self.confidence = 1.0
        self.duplicate = 0.0

    @property
    def length(self):
        return math.hypot(self.bx - self.ax, self.by - self.ay)


class VS(S):
    def __init__(self, bounded_by, loop, area, name=None, kind="bedroom"):
        super().__init__(bounded_by, loop, area, name)
        self.kind = kind


VWALLS = [VW(w.ax, w.ay, w.bx, w.by) for w in WALLS]
VSPACES = [VS(s.bounded_by, s.loop, s.area, s.name) for s in SPACES]


def find(verdict, name):
    return next((c for c in verdict.checks if c.name == name), None)


site_verdict = vf.check(input_segments=40, walls=VWALLS, spaces=VSPACES,
                        openings=[], unhosted=0)
found = find(site_verdict, "site-scope")
ok("a site raises site-scope", found is not None)
ok("and it BLOCKS", found is not None and found.level == "blocking",
   found.level if found else "-")
ok("the count is the finding's value", found is not None and found.value == 3)
ok("the message names the buildings",
   found is not None and "#0" in found.message and "#2" in found.message)
ok("and says how to get out of it",
   found is not None and "--building" in found.message)
ok("a site is not ok overall", not site_verdict.ok)

# The regression guard that matters most: the models the engine accepts today
# must keep verifying. A one-building plan reports the same check as INFO.
one_verdict = vf.check(input_segments=40, walls=VWALLS[:6],
                       spaces=[VS(s.bounded_by, s.loop, s.area, s.name)
                               for s in chain],
                       openings=[], unhosted=0)
one_found = find(one_verdict, "site-scope")
ok("one building still reports site-scope", one_found is not None)
ok("as INFO, not blocking",
   one_found is not None and one_found.level == "info",
   one_found.level if one_found else "-")
ok("site-scope alone does not block a single building",
   all(c.name != "site-scope" for c in one_verdict.blocking))
ok("and it names the linework that bounds nothing",
   one_found is not None and "bound no room" in one_found.message)

print("\n-- a repeated unnamed symbol is not a dozen buildings --")
# The false positive this gate exists to stop, taken from real geometry: frame
# 2 of the site sheet segments into 13 components, and 12 of them are the SAME
# stamped rectangle — one room, four walls, no name, ~2 m2, 3.33 m across.
# Blocking a real drawing because a hatch symbol repeats is worse than missing
# a building, so the count that decides is of components carrying NAMED rooms.
#
# Note 3.33 m clears PLAUSIBLE_SPAN's floor of 3.0, which is why span could not
# have been the discriminator and a fresh area constant was refused.
real = [VS([0, 1, 2, 3], rect(0, 0, 10, 10), 100.0, "LIVING")]
stamps = [
    VS([10 + i], rect(50 + i * 10, 0, 50 + i * 10 + 3.33, 0.6), 2.0, None)
    for i in range(12)
]
stamp_walls = VWALLS + [VW(50 + i * 10, 0, 50 + i * 10 + 3.33, 0) for i in range(12)]
verdict = vf.check(input_segments=40, walls=stamp_walls, spaces=real + stamps,
                   openings=[], unhosted=0)
stamped = find(verdict, "site-scope")
ok("twelve unnamed stamps do not make a site",
   stamped is not None and stamped.level == "info",
   stamped.level if stamped else "-")
ok("the discounted fragments are still REPORTED, not hidden",
   stamped is not None and "12 unnamed fragment" in stamped.message,
   stamped.message if stamped else "-")
ok("and site-scope does not block on them",
   all(c.name != "site-scope" for c in verdict.blocking))

# The mirror: name one of them and it becomes a real second building. The rule
# is the drawing's labelling, so changing the labelling must change the answer.
named_stamp = list(stamps)
named_stamp[0] = VS(named_stamp[0].bounded_by, named_stamp[0].loop, 2.0, "STORE")
promoted = find(vf.check(input_segments=40, walls=stamp_walls,
                         spaces=real + named_stamp, openings=[], unhosted=0),
                "site-scope")
ok("naming one fragment makes it a second building",
   promoted is not None and promoted.level == "blocking",
   promoted.level if promoted else "-")
ok("and the other eleven stay uncounted",
   promoted is not None and "11 unnamed fragment" in promoted.message)

print("\n-- a long site list is summarised, never truncated silently --")
many_walls = [VW(i * 100.0, 0, i * 100.0 + 2, 0) for i in range(20)]
many_spaces = [
    VS([i], rect(i * 100.0, 0, i * 100.0 + 2, 2), 4.0, f"ROOM {i}")
    for i in range(vf.BUILDINGS_LISTED + 3)
]
many = find(vf.check(input_segments=40, walls=many_walls, spaces=many_spaces,
                     openings=[], unhosted=0), "site-scope")
ok("every building is counted",
   many is not None and many.value == vf.BUILDINGS_LISTED + 3, str(many.value))
ok("the unlisted ones are declared, not dropped",
   many is not None and "and 3 more" in many.message)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
