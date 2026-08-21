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

#: A perimeter this thin is not a building outline.
MIN_ENVELOPE_AREA = 8.0

#: External walls are thicker than partitions. Used only where the drawing gives
#: us nothing better to go on.
DEFAULT_EXTERNAL_THICKNESS = 0.23


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
        return list(walls)

    if blob.geom_type == "MultiPolygon":
        # A sheet can leave more than one footprint even inside one frame.
        # Keep every part big enough to be a building; drop the specks.
        parts = [g for g in blob.geoms if g.area >= MIN_ENVELOPE_AREA]
    else:
        parts = [blob] if blob.area >= MIN_ENVELOPE_AREA else []

    if not parts:
        return list(walls)

    if thickness is None:
        paired = [w.thickness for w in walls if w.paired]
        thickness = (
            sorted(paired)[len(paired) // 2] if paired else DEFAULT_EXTERNAL_THICKNESS
        )

    out = list(walls)
    for part in parts:
        if not isinstance(part, Polygon):
            continue
        # Exterior first, then any courtyards. A courtyard ring has to become
        # wall as well, or the courtyard reads as the largest room in the house.
        for ring in [part.exterior, *part.interiors]:
            coords = list(ring.simplify(SIMPLIFY, preserve_topology=True).coords)
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                if abs(bx - ax) < 1e-9 and abs(by - ay) < 1e-9:
                    continue
                out.append(
                    Wall(
                        ax=ax, ay=ay, bx=bx, by=by,
                        thickness=thickness,
                        paired=True,
                        # Lower than a measured pair, because the position is
                        # inferred from where the walls are rather than read.
                        confidence=0.55,
                        layer="<derived:perimeter>",
                    )
                )

    return out


def summarise(walls: list[Wall]) -> dict:
    derived = [w for w in walls if w.layer == "<derived:perimeter>"]
    return {
        "segments": len(derived),
        "length": round(sum(w.length for w in derived), 2),
    }
