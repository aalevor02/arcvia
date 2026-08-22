"""
Deriving rooms from walls.

── Rooms are never stored ────────────────────────────────────────────────────
A room is not a thing an architect draws. It is the space left over when walls
enclose something, and the only honest way to find one is to look for closed
cycles in the wall network. `apps/studio/src/plan/rooms.ts` already works this
way and recomputes on every edit; this is the same idea in the reconstruction
pipeline, using shapely's `polygonize` as the cycle finder.

That choice pays for itself immediately: a shared wall is one edge belonging to
two faces, not two coincident polygon edges, so moving it moves both rooms. And
a courtyard comes out correctly as a hole rather than as a room, which every
"largest polygon is the outside" heuristic gets wrong.

── Why this is the real test of the pairing stage ────────────────────────────
Walls that are half a thickness short at each corner render perfectly and
enclose nothing. `polygonize` finds no cycles in them at all. So the number of
rooms found here is the honest measure of whether `join_corners` did its job —
which is why a low count is reported as a warning about the walls rather than
silently returned as a building with no interior.

── The finished face ─────────────────────────────────────────────────────────
Cycles run down wall *centrelines*, so the raw polygon is too big by half a wall
thickness all round. A room measured that way is consistently a few percent
larger than the number printed on the drawing. Insetting each face by half the
mean thickness of the walls bounding it gives the finished-face area, which is
the one an architect would recognise and the one a printed dimension can be
checked against.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import Polygon
from shapely.ops import polygonize, unary_union
from shapely.geometry import LineString

#: Smaller than this and it is a gap between two badly-joined walls, not a room.
MIN_AREA_M2 = 1.2
#: Larger than this and it is the space between separate buildings on a sheet,
#: or the site boundary — not a room. A very large hall is ~150 m2.
MAX_AREA_M2 = 400.0
#: Faces thinner than this are slivers thrown off by near-collinear walls.
MIN_WIDTH_M = 0.6


@dataclass
class Space:
    index: int
    loop: list[tuple[float, float]]
    area: float                 # finished-face, m2
    gross_area: float           # to wall centrelines, m2
    perimeter: float
    name: str | None = None
    kind: str = "unknown"
    bounded_by: list[int] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "kind": self.kind,
            "area": round(self.area, 2),
            "grossArea": round(self.gross_area, 2),
            "perimeter": round(self.perimeter, 2),
            "boundedBy": self.bounded_by,
            "loop": [[round(x, 4), round(y, 4)] for x, y in self.loop],
        }


#: How close a wall's centreline must run to a room's boundary to be bounding it.
#:
#: **CHOSEN, not measured.** A face produced by `polygonize` runs ALONG wall
#: centrelines by construction, so a bounding wall's distance is nominally zero
#: and this only has to absorb floating-point noise and the corner-joining
#: trims. 50 mm is comfortably under the thinnest wall anyone builds (0.075 m),
#: so it cannot reach across a wall to the room on the other side — which is the
#: error that would matter, because it would attribute one wall to two rooms
#: that do not share it.
BOUNDING_TOLERANCE = 0.05


def _walls_around(poly: Polygon, walls) -> list[int]:
    """
    Indices of the walls that actually bound this face.

    ── Why this is worth having, and why it was missing ────────────────────────
    `Space.bounded_by` has been in the schema and empty on every space the engine
    has ever produced. It is the missing link under three separate things:

      * **wall run cannot be attributed to the rooms it bounds**, so a bill of
        quantities can total a building's masonry but not say which room's walls
        it is;
      * **`wall-run-per-area` has to report two bases** — indoor-only and
        including-site — because it has no way to know which walls belong to the
        indoor rooms and which enclose a lawn;
      * **indoor/outdoor cannot be resolved geometrically**, so it falls back to
        reading a room's name and its kind, which on this one villa disagree in
        both directions (`OFFICE PATIO` has kind `study`; `Enclosed Balcony` has
        kind `outdoor`).

    The geometry was already here — `_thickness_around` did exactly this test and
    threw the identities away, keeping only the mean thickness. So this is the
    same pass, returning what it found.
    """
    boundary = poly.exterior
    return [
        i
        for i, w in enumerate(walls)
        if boundary.distance(LineString([(w.ax, w.ay), (w.bx, w.by)]))
        < BOUNDING_TOLERANCE
    ]


def _thickness_of(indices: list[int], walls, default: float) -> float:
    """Mean thickness of the walls bounding a face."""
    if not indices:
        return default
    return sum(walls[i].thickness for i in indices) / len(indices)


def detect_spaces(walls, labels=None, classify_room=None) -> list[Space]:
    """
    Find the rooms enclosed by a set of walls.

    `labels` are the drawing's own room-name texts; the nearest one inside a
    face names it. Naming by containment rather than proximity matters — the
    nearest label to a small bathroom is very often the bedroom's, printed just
    the other side of the wall.
    """
    lines = [
        LineString([(w.ax, w.ay), (w.bx, w.by)])
        for w in walls
        if w.length > 1e-6
    ]
    if not lines:
        return []

    # unary_union nodes the network at every crossing. Without it polygonize
    # sees a pile of segments that merely touch and finds nothing.
    faces = list(polygonize(unary_union(lines)))

    # ── Drop the envelopes ──────────────────────────────────────────────────
    # polygonize returns every bounded face, and the outline of the building is
    # one of them — a single face containing all the rooms. Left in, it becomes
    # the largest "room" in the model, and whichever label happens to fall
    # inside it gets the name. That is how a toilet ends up at 283 m2.
    #
    # A threshold cannot separate these, because a large envelope and a large
    # hall are the same number. Containment can: a room contains no other face,
    # an envelope contains many. Exact, and no parameter to tune.
    interior: list[Polygon] = []
    for poly in faces:
        points = [
            other.representative_point()
            for other in faces
            if other is not poly
        ]
        if any(poly.contains(p) for p in points):
            continue
        interior.append(poly)

    mean_thickness = (
        sum(w.thickness for w in walls) / len(walls) if walls else 0.115
    )

    spaces: list[Space] = []
    for poly in interior:
        gross = poly.area
        if gross < MIN_AREA_M2 or gross > MAX_AREA_M2:
            continue

        # A sliver has area but no width. Comparing the inscribed-circle radius
        # to the area separates a real room from the wedge two near-collinear
        # walls leave behind.
        if poly.area / max(poly.length, 1e-6) < MIN_WIDTH_M / 4:
            continue

        bounding = _walls_around(poly, walls)
        inset = _thickness_of(bounding, walls, mean_thickness) / 2
        finished = poly.buffer(-inset, join_style=2)
        if finished.is_empty:
            continue
        if finished.geom_type == "MultiPolygon":
            finished = max(finished.geoms, key=lambda g: g.area)

        space = Space(
            index=len(spaces),
            loop=list(poly.exterior.coords)[:-1],
            area=finished.area,
            gross_area=gross,
            perimeter=poly.exterior.length,
            bounded_by=bounding,
        )

        if labels:
            inside = [lb for lb in labels if poly.contains_properly(_pt(lb))]
            if not inside:
                # A label printed just outside a tight room still belongs to it.
                inside = [lb for lb in labels if poly.buffer(0.4).contains(_pt(lb))]
            if inside:
                centre = poly.representative_point()
                nearest = min(
                    inside, key=lambda lb: math.hypot(lb.x - centre.x, lb.y - centre.y)
                )
                space.name = nearest.text
                if classify_room:
                    space.kind = classify_room(nearest.text)

        spaces.append(space)

    spaces.sort(key=lambda s: -s.area)
    for n, space in enumerate(spaces):
        space.index = n
    return spaces


def _pt(label):
    from shapely.geometry import Point

    return Point(label.x, label.y)


def summarise(spaces: list[Space]) -> dict:
    if not spaces:
        return {
            "count": 0, "totalArea": 0.0, "named": 0,
            "warning": "No closed cycles. The walls do not enclose anything — "
                       "this is almost always corner-joining, not room detection.",
        }
    return {
        "count": len(spaces),
        "totalArea": round(sum(s.area for s in spaces), 2),
        "named": sum(1 for s in spaces if s.name),
        "largest": round(spaces[0].area, 2),
        "smallest": round(spaces[-1].area, 2),
    }
