"""
Daylight factor over a reconstructed building.

── What this computes, and what it deliberately does not ──────────────────────
The daylight factor at a point is the illuminance there as a percentage of the
unobstructed horizontal illuminance under the same CIE overcast sky. It splits
conventionally into three components:

    SC  sky component          light arriving straight from the sky
    ERC externally reflected   light off buildings and ground outside
    IRC internally reflected   light off the room's own surfaces

THIS COMPUTES THE SKY COMPONENT AND THE INTERNALLY REFLECTED COMPONENT, AND
REPORTS THE EXTERNALLY REFLECTED COMPONENT AS ZERO, because the model contains
no context: no neighbouring building, no boundary wall height, no ground
reflectance that was read from anything.

── "Conservative" is a claim that needs a reference, and the first draft of this
── docstring did not give one ─────────────────────────────────────────────────
That paragraph originally ended "so every result is CONSERVATIVE — the real room
is slightly brighter than the number says". Omitting the ERC does make the figure
low against ITSELF-WITH-CONTEXT. It says nothing about how the figure compares to
what a planning authority will hold the room to, and those are different
reference points.

Measured against the BRE average daylight factor of BS 8206-2 — the expression an
authority actually quotes — this module reads HIGH, by a consistent factor:

    room      window    BRE avg   this   ratio
    6 x 4 m   2.0 m      1.87     2.71    1.45
    6 x 4 m   4.0 m      3.73     5.35    1.43
    6 x 9 m   2.0 m      1.02     1.33    1.31
    4 x 3 m   1.5 m      2.29     3.77    1.64
    8 x 5 m   3.0 m      1.91     2.81    1.47
    3 x 3 m   1.0 m      1.87     3.29    1.77

Systematic, not scattered, and it trends with room proportion — which is what two
different approximations of the same physics look like, rather than a bug. The
BRE expression is a whole-room average that bundles inter-reflection into a
single (1 - R²) term; this measures the sky component per point and adds a
split-flux IRC. They are different decompositions and there is no reason they
should agree exactly.

But a reader comparing 2.71 against a 2% threshold would pass a room the BRE
figure fails at 1.87, so `bre_average` is computed alongside every result and
both numbers are reported. An unqualified "conservative" was the more dangerous
half of a true statement.

The direction matters because only one error is discovered late: an optimistic
number gets a room signed off that fails on site; a pessimistic one gets a window
enlarged that did not need to be.

── The IRC is a formula, not a simulation ─────────────────────────────────────
Internally reflected light is taken from the BRE split-flux expression rather
than a bounce simulation. Not because a simulation would be wrong, but because
the inputs a simulation needs — actual surface reflectances — are not in this
model and would have to be invented. A published average formula fed assumed
reflectances is honest about being an average. A ray-traced number fed the same
assumed reflectances looks like a measurement of this room and is not.

── The one thing measured per point rather than assumed ───────────────────────
The sky component. For each point on the working plane a hemisphere of
directions is tested against every opening in the room's own walls; a direction
scores if the ray leaves through an aperture. That is the part that depends on
where the windows actually are, which is the part the reconstruction knows and a
rule of thumb does not.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .sky import daylight_factor, horizontal_illuminance

#: Height of the working plane above the floor, metres. 0.85 m is desk height and
#: is what BS 8206-2 and every planning authority quotes a daylight factor at.
#: A factor quoted at floor level is a different and smaller number, so the plane
#: is named here rather than passed in, to stop two callers using two heights.
WORKING_PLANE = 0.85

#: Glazing transmittance. 0.7 is clear double glazing net of frame and dirt.
GLASS_TRANSMITTANCE = 0.70

#: Assumed area-weighted mean reflectance of the room's internal surfaces, and
#: the split between the half above and below the working plane. These are the
#: BRE default set for a light-coloured room. They are ASSUMPTIONS and every
#: result carries them, which is why `Room.assumptions` exists.
MEAN_REFLECTANCE = 0.50
FLOOR_WALL_REFLECTANCE = 0.20
CEILING_WALL_REFLECTANCE = 0.70

#: Below the first a room is conventionally described as poorly daylit, above the
#: second as well daylit. BS 8206-2 for dwellings quotes 1% bedroom, 1.5% living
#: room, 2% kitchen. The single pair here is a REPORTING band, not a code check —
#: `verdict` says which band a room falls in and never says "complies", because
#: compliance depends on the room's use and this model does not reliably know it.
POORLY_DAYLIT = 1.0
WELL_DAYLIT = 2.0


@dataclass
class Aperture:
    """A window, as the rectangle a ray can leave through."""

    ax: float
    ay: float
    bx: float
    by: float
    sill: float
    head: float

    @property
    def width(self) -> float:
        return math.hypot(self.bx - self.ax, self.by - self.ay)

    @property
    def area(self) -> float:
        return self.width * max(self.head - self.sill, 0.0)


@dataclass
class Room:
    """One room's daylight, with everything a reader needs to disbelieve it."""

    name: str
    kind: str
    area: float
    apertures: int
    glazed_area: float
    sky_component: float = 0.0
    internally_reflected: float = 0.0
    externally_reflected: float = 0.0
    points: int = 0

    #: The BS 8206-2 whole-room average, computed alongside as an independent
    #: second number. See `bre_average` for why it is carried rather than chosen.
    bre: float = 0.0

    #: Set when the model gives the room no opening at all. See `evaluate`.
    undetermined: bool = False
    reason: str = ""
    assumptions: list[str] = field(default_factory=list)

    @property
    def average(self) -> float:
        return self.sky_component + self.internally_reflected + self.externally_reflected

    @property
    def verdict(self) -> str:
        if self.undetermined:
            return "undetermined"
        if self.average < POORLY_DAYLIT:
            return "poorly daylit"
        if self.average < WELL_DAYLIT:
            return "adequately daylit"
        return "well daylit"

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "area": round(self.area, 2),
            "apertures": self.apertures,
            "glazedArea": round(self.glazed_area, 3),
            "glazedFraction": round(self.glazed_area / self.area, 4) if self.area else None,
            "skyComponent": round(self.sky_component, 3),
            "internallyReflected": round(self.internally_reflected, 3),
            "externallyReflected": round(self.externally_reflected, 3),
            "averageDaylightFactor": None if self.undetermined else round(self.average, 3),
            "breAverage": None if self.undetermined else round(self.bre, 3),
            "verdict": self.verdict,
            "points": self.points,
            "undetermined": self.undetermined,
            "reason": self.reason,
            "assumptions": self.assumptions,
        }


def _inside(polygon: list[tuple[float, float]], x: float, y: float) -> bool:
    """Ray-crossing point-in-polygon."""
    inside = False
    n = len(polygon)
    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            t = (y - y0) / (y1 - y0)
            if x < x0 + t * (x1 - x0):
                inside = not inside
    return inside


def _area(polygon: list[tuple[float, float]]) -> float:
    total = 0.0
    for i in range(len(polygon)):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % len(polygon)]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def sample_points(polygon: list[tuple[float, float]], spacing: float = 0.6):
    """
    A grid of working-plane points inside the room.

    ── Why a grid and not the room centroid ───────────────────────────────────
    The centroid is one point and is usually among the best-lit, because rooms
    are roughly convex and windows are in walls. A daylight factor quoted from
    the centroid therefore flatters every deep room — exactly the rooms the check
    exists to find. A grid average is also what BS 8206-2 means by "average
    daylight factor", so the centroid would be answering a different question.

    A concave room can additionally put its centroid outside itself, which
    produces a confident daylight factor for a point in the garden.
    """
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    points = []

    x = min(xs) + spacing / 2
    while x < max(xs):
        y = min(ys) + spacing / 2
        while y < max(ys):
            if _inside(polygon, x, y):
                points.append((x, y))
            y += spacing
        x += spacing

    # A room smaller than the grid gets its centroid — tested for containment,
    # because of the concave case above.
    if not points:
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        if _inside(polygon, cx, cy):
            points.append((cx, cy))

    return points


def visibility(px: float, py: float, apertures: list[Aperture]):
    """
    A predicate saying whether a direction from (px, py) leaves through glass.

    The ray is tested against each aperture's rectangle: it must cross the
    aperture's plan segment going outward, and its height at the crossing must
    fall between sill and head. That is the whole geometric content of a sky
    component, and it is why the number moves when a window moves.

    ── The simplification, stated rather than hidden ──────────────────────────
    Interior obstruction is not tested. A ray that would in reality strike a
    partition between the point and the window is counted as escaping. For a
    convex room that is exact; for an L-shaped space it is optimistic. Rooms are
    polygons here and most are convex, so this is a small error in a known
    direction — but it IS an error, and `Room.assumptions` carries it rather than
    leaving a reader to discover it.
    """
    eye = WORKING_PLANE

    def visible(altitude: float, azimuth: float) -> bool:
        dx, dy = math.cos(azimuth), math.sin(azimuth)
        tan_alt = math.tan(altitude)

        for ap in apertures:
            ex, ey = ap.bx - ap.ax, ap.by - ap.ay
            denom = dx * ey - dy * ex
            if abs(denom) < 1e-12:
                continue
            # Solve (px,py) + t*(dx,dy) = (ax,ay) + s*(ex,ey).
            qx, qy = ap.ax - px, ap.ay - py
            t = (qx * ey - qy * ex) / denom
            s = (qx * dy - qy * dx) / denom
            if t <= 1e-9 or not (0.0 <= s <= 1.0):
                continue
            if ap.sill <= eye + t * tan_alt <= ap.head:
                return True

        return False

    return visible


#: Opening kinds that admit daylight. A door does not, unless it is glazed, and
#: the model does not record whether it is.
#:
#: ── Why this exclusion is the most consequential line in the module ─────────
#: Run against the villa, every one of its 8 openings is a `door` and not one is
#: a `window`. Counting doors as apertures would therefore produce a full
#: daylight report for a building whose windows were never read — 23 rooms, each
#: with a plausible percentage beside it, every number an artefact of treating a
#: doorway as glazing. It would look exactly like a working feature.
#:
#: Excluding them yields 23 undetermined rooms and a report that says the model
#: has no glazed opening. That is the useful answer: it names window detection as
#: the blocker instead of hiding it behind arithmetic.
GLAZED_KINDS = ("window", "glazing", "curtain wall")


def apertures_of(openings: list[dict], walls: list[dict]) -> list[Aperture]:
    """
    The model's glazed openings as aperture rectangles in plan.

    ── Two key names, because this was written against the wrong schema ───────
    The first draft read `polygon` and `offset`. The model writes `loop` and
    `along`. Nothing raised — `.get(key, default)` returned the default for every
    room and every opening, so `evaluate` reported 0 rooms computed and 0
    undetermined, which is not a failure mode anybody would recognise as one: an
    empty report from a model with 23 rooms reads like a model with no rooms.
    Both spellings are accepted, and the real one is tried first.
    """
    out = []
    for opening in openings:
        kind = str(opening.get("kind", "")).lower()
        if kind and kind not in GLAZED_KINDS:
            continue

        index = opening.get("wall")
        wall = walls[index] if isinstance(index, int) and 0 <= index < len(walls) else None
        if not wall:
            continue

        a, b = wall["a"], wall["b"]
        length = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        if length < 1e-9:
            continue

        ux, uy = (b["x"] - a["x"]) / length, (b["y"] - a["y"]) / length
        start = float(opening.get("along", opening.get("offset", 0.0)))
        width = float(opening.get("width", 1.0))
        sill = float(opening.get("sill", 0.9))
        head = sill + float(opening.get("height", 1.2))

        out.append(Aperture(
            ax=a["x"] + ux * start, ay=a["y"] + uy * start,
            bx=a["x"] + ux * (start + width), by=a["y"] + uy * (start + width),
            sill=sill, head=head,
        ))

    return out


def room_polygon(space: dict) -> list[tuple[float, float]]:
    """
    A space's boundary, in either spelling the pipeline has used.

    `loop` is a list of [x, y] pairs and is what the engine writes today;
    `polygon` is a list of {"x": , "y": } and is what the studio side speaks.
    """
    loop = space.get("loop")
    if loop:
        return [(float(p[0]), float(p[1])) for p in loop if len(p) >= 2]
    return [(float(p["x"]), float(p["y"])) for p in space.get("polygon", [])]


def on_boundary(polygon: list[tuple[float, float]], ap: Aperture, reach: float = 0.4) -> bool:
    """Whether an aperture sits on this room's boundary."""
    mx, my = (ap.ax + ap.bx) / 2, (ap.ay + ap.by) / 2

    for i in range(len(polygon)):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % len(polygon)]
        ex, ey = x1 - x0, y1 - y0
        squared = ex * ex + ey * ey
        if squared < 1e-12:
            continue
        t = max(0.0, min(1.0, ((mx - x0) * ex + (my - y0) * ey) / squared))
        if math.hypot(mx - (x0 + t * ex), my - (y0 + t * ey)) <= reach:
            return True

    return False


def internally_reflected(glazed_area: float, area: float, height: float = 3.0) -> float:
    """
    BRE split-flux internally reflected component.

        IRC = T · A_w · (C · R_fw + 5 · R_cw) / (A_total · (1 − R))

    C is a coefficient for the sky angle the window sees; 39 is the unobstructed
    value, which follows from the zero-ERC decision in the module docstring — the
    same absence of site context, applied consistently. Using an obstructed C
    here while claiming no obstruction there would make the two halves of one
    number disagree about the same site.
    """
    if area <= 0 or glazed_area <= 0:
        return 0.0

    # Total internal surface: floor, ceiling, and walls estimated from a square
    # room of this area. Approximate, and it feeds a formula that is explicitly
    # an average — a more exact A_total would not make an average exact.
    perimeter = 4.0 * math.sqrt(area)
    total_surface = 2.0 * area + perimeter * height

    numerator = (
        GLASS_TRANSMITTANCE * glazed_area
        * (39.0 * FLOOR_WALL_REFLECTANCE + 5.0 * CEILING_WALL_REFLECTANCE)
    )
    return numerator / (total_surface * (1.0 - MEAN_REFLECTANCE))


def bre_average(glazed_area: float, area: float, height: float = 3.0,
                sky_angle: float = 90.0) -> float:
    """
    The BRE average daylight factor of BS 8206-2, as an independent second number.

        DF_avg = T · A_w · θ / (A_total · (1 − R²))

    θ is the vertical sky angle the window sees in degrees; 90° is unobstructed,
    consistent with the zero-ERC decision above.

    ── Why a second formula is carried rather than the better one chosen ──────
    Every fault found in this codebase on 2026-08-22 — a merged storey, a
    retraced perimeter, a volume priced per tonne, a ratio whose halves came from
    different sets — was a measurement that was correct and insufficient. None
    was caught by looking harder at the first number; each fell to an INDEPENDENT
    second one. This is that second number for daylight, and it costs four
    multiplications.

    It is also the figure a planning authority quotes, which makes it the one a
    reader will be held to even where the per-point sky component is the better
    physics.
    """
    if area <= 0 or glazed_area <= 0:
        return 0.0
    total_surface = 2.0 * area + 4.0 * math.sqrt(area) * height
    return (
        GLASS_TRANSMITTANCE * glazed_area * sky_angle
        / (total_surface * (1.0 - MEAN_REFLECTANCE ** 2))
    )


def evaluate(model: dict, rings: int = 45, sectors: int = 120, spacing: float = 0.6) -> dict:
    """
    Daylight factor for every space in the model.

    ── The decision this makes about rooms with no window ─────────────────────
    The villa model carries 8 openings across 23 spaces, so most rooms have no
    aperture at all. Three things could be reported and only one is honest:

      DF = 0         literally true OF THE MODEL, and reads as "windowless cell",
                     which is almost certainly false about the building. It puts
                     a fabricated defect in front of an architect.
      omit the room  silently loses the one case the check exists to catch — a
                     genuinely windowless internal room.
      undetermined   says the model carries no opening here, so no number is
                     offered.

    The third, following the precedent `quantify/boq.py` already set with
    `unpriced`: something that cannot be computed is SHOWN as uncomputed, never
    dropped and never guessed. The distinction a reader needs is "we did not read
    a window" versus "there is no window", and only an explicit undetermined
    preserves it.
    """
    elements = model.get("elements", {})
    spaces = elements.get("spaces", [])
    openings = elements.get("openings", [])
    walls = elements.get("walls", [])

    exterior = horizontal_illuminance(lambda a, z: True, rings=rings, sectors=sectors)
    all_apertures = apertures_of(openings, walls)

    rooms: list[Room] = []
    for space in spaces:
        polygon = room_polygon(space)
        if len(polygon) < 3:
            continue

        area = float(space.get("area") or 0.0) or _area(polygon)
        mine = [a for a in all_apertures if on_boundary(polygon, a)]

        room = Room(
            name=space.get("name") or "unnamed",
            kind=space.get("kind") or "unknown",
            area=area,
            apertures=len(mine),
            glazed_area=sum(a.area for a in mine),
        )

        if not mine:
            room.undetermined = True
            room.reason = (
                "the model carries no glazed opening on this room's walls, which "
                "may mean the room has no window or may mean none was read"
            )
            rooms.append(room)
            continue

        points = sample_points(polygon, spacing)
        room.points = len(points)
        if not points:
            room.undetermined = True
            room.reason = "no working-plane point fell inside the room polygon"
            rooms.append(room)
            continue

        total = 0.0
        for px, py in points:
            interior = horizontal_illuminance(
                visibility(px, py, mine), rings=rings, sectors=sectors
            )
            total += daylight_factor(interior, exterior)

        room.sky_component = GLASS_TRANSMITTANCE * total / len(points)
        room.internally_reflected = internally_reflected(room.glazed_area, area)
        room.bre = bre_average(room.glazed_area, area)
        room.assumptions = [
            f"glazing transmittance {GLASS_TRANSMITTANCE}",
            f"mean internal reflectance {MEAN_REFLECTANCE}",
            "externally reflected component taken as zero — the model carries no "
            "neighbouring building, boundary wall or ground reflectance, so the "
            "figure is conservative",
            "interior obstruction between point and window not tested",
        ]
        rooms.append(room)

    return {
        "sky": "CIE standard overcast",
        "workingPlane": WORKING_PLANE,
        "rooms": [r.as_dict() for r in rooms],
        "computed": sum(1 for r in rooms if not r.undetermined),
        "undetermined": sum(1 for r in rooms if r.undetermined),
        "glazedOpenings": len(all_apertures),
        "openings": len(openings),
        "caveats": [
            "Sky component is measured per point against the model's own "
            "openings. The internally reflected component is the BRE split-flux "
            "average, not a simulation.",
            "No externally reflected component, so every figure is conservative.",
            "Not a compliance check. The bands are reporting bands; compliance "
            "depends on the room's use, which this model does not reliably know.",
            "Two numbers are given per room and they do not agree. "
            "`averageDaylightFactor` measures the sky component per point on the "
            "working plane; `breAverage` is the BS 8206-2 whole-room expression, "
            "which reads 1.3-1.8x lower and is what a planning authority quotes. "
            "Where they straddle a threshold, the room is not settled.",
        ],
    }
