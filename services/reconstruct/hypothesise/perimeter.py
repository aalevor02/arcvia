"""
The building's outer wall, derived rather than drawn.

── Why a partitions-only plan encloses almost nothing ───────────────────────
Measured on a real villa: 185 walls spanning 28 x 32 m enclosed 71.8 m2, and the
largest room came out at 10 m2. Every layer combination tried topped out at
92.5 m2. The filters were innocent — `polygonize` simply found no large faces.

The reason is architectural, not a defect. A modern villa's living and dining
space is **open plan**. It is bounded by the exterior wall, by columns and by
wide openings — not by interior partitions. There is no closed loop of interior
walls around it because the building does not have one. Only the small wet rooms
(toilets, walk-ins) are fully partitioned, which is exactly the set that came
back correct.

So the outer envelope has to be supplied. With it, an open-plan interior is
bounded by the building itself and becomes a room; without it, the largest space
in the house is the one thing the model does not contain.

This is `add_perimeter` from `tools/cad-to-3d/blender_build.py`, whose README
records it as doing more for output quality than every material and lighting
change combined.

── How ──────────────────────────────────────────────────────────────────────
Morphological closing on the wall network: buffer every centreline outward,
union, then buffer back in by the same amount. Bridging distance is 2R, so an
R of 1.0 m spans doorways, wide openings and the gaps left where a wall run was
trimmed — and does not span the street.

The result's exterior ring is the envelope. Interior rings are courtyards and
are kept as walls too, which is what stops a courtyard being read as a room.
"""

from __future__ import annotations

import math

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from .pair import Wall

#: Half the bridging distance. 1.0 m closes a 2 m gap — wider than any door or
#: arch, narrower than the space between a building and its neighbour.
CLOSE_RADIUS = 1.0

#: Straighten the traced outline. Building outlines are made of straight runs,
#: and without this the envelope arrives as hundreds of short segments that
#: slow every downstream stage and mitre badly.
SIMPLIFY = 0.15

#: How far from an existing wall a piece of envelope still counts as that
#: same wall. Half a thickness plus a margin for the closing radius rounding.
OVERLAP_MARGIN = 0.20

#: Envelope fragments shorter than this are corner crumbs left by the
#: subtraction, not gaps worth building.
MIN_GAP_PIECE = 0.12

#: A perimeter this thin is not a building outline.
MIN_ENVELOPE_AREA = 8.0

#: External walls are thicker than partitions. Used only where the drawing gives
#: us nothing better to go on.
DEFAULT_EXTERNAL_THICKNESS = 0.23


def _side_coverage(walls, horizontal, coordinate, low, high) -> float:
    '''Fraction of one bounding-box side already supported by wall runs.'''
    tolerance = 0.25
    intervals = []
    for wall in walls:
        if wall.length <= 1e-6:
            continue
        if horizontal:
            if abs(wall.by - wall.ay) > tolerance:
                continue
            if abs((wall.ay + wall.by) / 2 - coordinate) > tolerance:
                continue
            start, end = sorted((wall.ax, wall.bx))
        else:
            if abs(wall.bx - wall.ax) > tolerance:
                continue
            if abs((wall.ax + wall.bx) / 2 - coordinate) > tolerance:
                continue
            start, end = sorted((wall.ay, wall.by))
        start, end = max(start, low), min(end, high)
        if end > start:
            intervals.append((start, end))

    covered = 0.0
    cursor = low
    for start, end in sorted(intervals):
        if end <= cursor:
            continue
        covered += end - max(start, cursor)
        cursor = max(cursor, end)
    return covered / max(high - low, 1e-9)


def _complete_one_rectangular_side(walls: list[Wall]) -> list[Wall]:
    '''Complete one absent facade when the other three sides prove the box.'''
    points = [
        point for wall in walls
        for point in ((wall.ax, wall.ay), (wall.bx, wall.by))
    ]
    if not points:
        return list(walls)
    x0, x1 = min(p[0] for p in points), max(p[0] for p in points)
    y0, y1 = min(p[1] for p in points), max(p[1] for p in points)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return list(walls)

    coverage = {
        'bottom': _side_coverage(walls, True, y0, x0, x1),
        'top': _side_coverage(walls, True, y1, x0, x1),
        'left': _side_coverage(walls, False, x0, y0, y1),
        'right': _side_coverage(walls, False, x1, y0, y1),
    }
    missing = [side for side, value in coverage.items() if value < 0.15]
    if len(missing) != 1 or any(
        value < 0.65 for side, value in coverage.items() if side != missing[0]
    ):
        return list(walls)

    paired = [wall.thickness for wall in walls if wall.paired]
    thickness = sorted(paired)[len(paired) // 2] if paired else DEFAULT_EXTERNAL_THICKNESS
    endpoints = {
        'bottom': (x0, y0, x1, y0),
        'top': (x0, y1, x1, y1),
        'left': (x0, y0, x0, y1),
        'right': (x1, y0, x1, y1),
    }[missing[0]]
    return [*walls, Wall(
        ax=endpoints[0], ay=endpoints[1], bx=endpoints[2], by=endpoints[3],
        thickness=thickness, paired=True, confidence=0.45,
        layer='<derived:perimeter>', duplicate=0.0,
    )]


def _reconnect(coords: list) -> list:
    """
    Push a gap piece back over the walls at either end.

    Subtracting a buffer around the existing walls is what stops the envelope
    double-counting them — but it also cuts each surviving piece short by the
    buffer radius at both ends, so the piece meets nothing and the loop it was
    meant to close stays open.

    Measured: the first version of this fix removed 310 m of double-counted
    perimeter and closed exactly zero additional rooms, because all 16 pieces
    floated free of the walls on either side.

    Extending both ends along their own direction costs about 0.3 m of overlap
    per piece — around 5 m in total, against the 310 m the subtraction removed.
    """
    if len(coords) < 2:
        return coords

    def extend(a, b, by):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            return a
        return (a[0] - dx / length * by, a[1] - dy / length * by)

    reach = OVERLAP_MARGIN * 1.6
    out = list(coords)
    out[0] = extend(out[0], out[1], reach)
    out[-1] = extend(out[-1], out[-2], reach)
    return out


def add_perimeter(
    walls: list[Wall],
    radius: float = CLOSE_RADIUS,
    thickness: float | None = None,
) -> list[Wall]:
    """
    Return `walls` plus the derived building envelope.

    The envelope is marked `paired=False`... deliberately NOT. It is a real,
    buildable wall — it just was not read off a pair of faces — so it carries
    `paired=True` (it gets extruded) with a reduced confidence, and its layer is
    stamped `<derived:perimeter>` so it can always be told apart from linework
    the architect drew.
    """
    lines = [
        LineString([(w.ax, w.ay), (w.bx, w.by)])
        for w in walls
        if w.length > 1e-6
    ]
    if not lines:
        return list(walls)

    # Close: dilate, union, erode. What survives is the footprint the wall
    # network implies, with doorway-sized gaps bridged.
    blob = unary_union([ln.buffer(radius, join_style=2) for ln in lines])
    blob = blob.buffer(-radius, join_style=2)
    if blob.is_empty:
        return _complete_one_rectangular_side(walls)

    if blob.geom_type == "MultiPolygon":
        # A sheet can leave more than one footprint even inside one frame.
        # Keep every part big enough to be a building; drop the specks.
        parts = [g for g in blob.geoms if g.area >= MIN_ENVELOPE_AREA]
    else:
        parts = [blob] if blob.area >= MIN_ENVELOPE_AREA else []

    if not parts:
        return _complete_one_rectangular_side(walls)

    if thickness is None:
        paired = [w.thickness for w in walls if w.paired]
        thickness = (
            sorted(paired)[len(paired) // 2] if paired else DEFAULT_EXTERNAL_THICKNESS
        )

    # ── Emit the full ring, and MEASURE what it duplicates ──────────────────
    # The first attempt at this emitted only the parts of the ring that were not
    # already a wall, on the reasoning that anything else double-counts. The
    # arithmetic was right and the conclusion was wrong: measured on one storey
    # of the villa, full rings give 27 rooms and 241 m2, gap-only gives 9 rooms
    # and 36.5 m2. The ring is not filling gaps — it IS the outer boundary. This
    # drawing's exterior is largely unpaired single lines that never close on
    # their own, and removing the ring removes the closure it exists to provide.
    #
    # So both things are true: the ring is load-bearing for GEOMETRY, and 91% of
    # it lies on top of a wall somebody already drew, which for QUANTITIES is
    # 310.8 m of masonry counted twice — a 53% overstatement that reached a
    # priced bill of materials before anyone noticed.
    #
    # A model is a shape; a schedule is a claim. The shape needs the ring. So
    # the ring is emitted whole and each segment records how much of itself
    # duplicates an existing wall, and anything quantifying subtracts that. The
    # geometry is unchanged; only the counting is corrected.
    covered = unary_union([
        LineString([(w.ax, w.ay), (w.bx, w.by)]).buffer(
            max(w.thickness, 0.15) / 2 + OVERLAP_MARGIN
        )
        for w in walls
        if w.length > 1e-6
    ]) if walls else None

    out = list(walls)
    duplicated = 0.0
    for part in parts:
        if not isinstance(part, Polygon):
            continue
        # Exterior first, then any courtyards. A courtyard ring has to become
        # wall as well, or the courtyard reads as the largest room in the house.
        for ring in [part.exterior, *part.interiors]:
            coords = list(ring.simplify(SIMPLIFY, preserve_topology=True).coords)
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                if math.hypot(bx - ax, by - ay) < MIN_GAP_PIECE:
                    continue
                piece = LineString([(ax, ay), (bx, by)])
                overlap = (
                    piece.intersection(covered).length if covered is not None else 0.0
                )
                duplicated += overlap
                out.append(
                    Wall(
                        ax=ax, ay=ay, bx=bx, by=by,
                        thickness=thickness,
                        paired=True,
                        # Lower than a measured pair, because the position is
                        # inferred from where the walls are rather than read.
                        confidence=0.55,
                        layer="<derived:perimeter>",
                        duplicate=round(overlap, 4),
                    )
                )

    return out


def summarise(walls: list[Wall]) -> dict:
    derived = [w for w in walls if w.layer == "<derived:perimeter>"]
    return {
        "segments": len(derived),
        "length": round(sum(w.length for w in derived), 2),
    }
