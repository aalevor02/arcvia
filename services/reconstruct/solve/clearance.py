"""
Can you actually use this room?

── What this is, and firmly what it is not ──────────────────────────────────
Every check here is a **geometric fact about the model**: two objects overlap,
a door has nothing but furniture behind it, a room has no way in. None of it is
a compliance claim, none of it cites a standard, and none of it says a building
is or is not acceptable — that is a professional judgement and this is a tape
measure.

The distinction is not pedantry. "Bedroom 3 is compliant" is an opinion that
carries liability. "The wardrobe leaves 310 mm in front of it, and 750 mm is the
working figure this check used" is information the reader draws their own
conclusion from. Everything below is written in the second voice, and the output
deliberately has no pass/fail badge to render.

Code compliance is a *separate* feature: the rulebook is jurisdiction-specific
data, authored and owned by the customer's architect, with a citation per rule.
It shares this engine and does not share this file.

── Where the numbers come from ──────────────────────────────────────────────
Conventional working figures — the space a person needs to open a wardrobe,
walk past a bed, or pull out a chair. They are ergonomics, not law, and they are
in one table so anyone can disagree with them by editing it. Nothing here is
sourced from a building code, deliberately.

── Why door swings are checked on both sides ────────────────────────────────
The reconstruction does not detect hinge side — a `D750` block gives width and
position, not which way the leaf goes. So a door with one side blocked is not a
problem; the leaf goes the other way. A door with *both* sides blocked is a real
one, and that is the only case reported. Guessing a hinge and reporting half the
doors as faults would be worse than useless.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

#: How much free floor an object needs in front of it to be usable, in metres,
#: and on which face. `front` is the direction the object faces; `side` means
#: at least one of the two long sides must be clear.
#:
#: Working figures, not standards. A wardrobe needs enough room to open a door
#: and stand in it; a WC needs enough to sit down. Disagree by editing this.
APPROACH: dict[str, tuple[str, float]] = {
    "wardrobe": ("front", 0.75),
    "wardrobe-small": ("front", 0.70),
    "chest": ("front", 0.65),
    "bookshelf": ("front", 0.55),
    "fridge": ("front", 0.90),
    "desk": ("front", 0.75),
    "wc": ("front", 0.60),
    "basin": ("front", 0.55),
    "shower": ("front", 0.60),
    "bathtub": ("side", 0.60),
    "bed-king": ("side", 0.60),
    "bed-queen": ("side", 0.60),
    "bed-single": ("side", 0.55),
    "sofa-3": ("front", 0.45),
    "sofa-2": ("front", 0.45),
    "dining-table-6": ("front", 0.75),
    "dining-table-4": ("front", 0.75),
    "hob": ("front", 0.90),
    "sink-unit": ("front", 0.90),
    "counter": ("front", 0.90),
}

#: A door leaf needs its own width of clear floor to swing through.
#: Swing depth is the leaf width, which is what a quarter-circle sweeps.
SWING_MARGIN = 0.05

#: Overlaps smaller than this are drafting slop, not a collision.
OVERLAP_TOLERANCE = 0.02

#: Two fixtures sharing more than this fraction of the smaller one's footprint
#: are in the same place — usually a reconstruction fault rather than a design one.
OVERLAP_SHARE = 0.15


@dataclass
class Issue:
    """One measured fact. Never a verdict."""

    kind: str          # swing-blocked | overlap | in-wall | tight-approach | no-door
    severity: str      # blocking | tight | note
    message: str
    room: int | None = None
    room_name: str | None = None
    items: list[str] = field(default_factory=list)
    measured: float | None = None
    wanted: float | None = None
    at: tuple[float, float] | None = None

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "message": self.message,
            "room": self.room,
            "roomName": self.room_name,
            "items": self.items,
            "measured": round(self.measured, 3) if self.measured is not None else None,
            "wanted": round(self.wanted, 3) if self.wanted is not None else None,
            "at": [round(v, 3) for v in self.at] if self.at else None,
        }


# ---------------------------------------------------------------------------
# Footprints
# ---------------------------------------------------------------------------


def _rect(cx: float, cy: float, w: float, d: float, rot: float) -> Polygon:
    """An oriented rectangle centred on a point."""
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for ox, oy in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        pts.append((cx + ox * c - oy * s, cy + ox * s + oy * c))
    return Polygon(pts)


def fixture_footprint(fixture: dict, dims: dict) -> Polygon | None:
    """
    Where a fixture actually sits.

    Prefers the catalogue's dimensions over the drawn footprint: the catalogue
    is what the object *is*, and a block drawn slightly small is still a bed.
    Falls back to the measured footprint for anything unrecognised.
    """
    item = fixture.get("item")
    spec = dims.get(item) if item else None

    if spec:
        w, d = spec["w"], spec["d"]
    else:
        fp = fixture.get("footprint") or {}
        w, d = fp.get("w", 0.0), fp.get("d", 0.0)

    if w <= 0 or d <= 0:
        return None

    pos = fixture["position"]
    return _rect(pos["x"], pos["y"], w, d, fixture.get("rotation") or 0.0)


def approach_candidates(fixture: dict, dims: dict) -> list[tuple]:
    """
    The ways an object can be approached: (zone, direction, origin, need, face).

    A 'front' item has one candidate. A 'side' item has two, and only needs ONE
    of them clear — you walk down whichever side of the bed is free.
    """
    item = fixture.get("item")
    if not item or item not in APPROACH:
        return []
    spec = dims.get(item)
    if not spec:
        return []

    face, need = APPROACH[item]
    pos = fixture["position"]
    px, py = pos["x"], pos["y"]
    rot = fixture.get("rotation") or 0.0
    w, d = spec["w"], spec["d"]

    def band(angle, offset, across, depth):
        ux, uy = math.cos(angle), math.sin(angle)
        ox, oy = px + ux * offset, py + uy * offset          # face midpoint
        cx, cy = px + ux * (offset + depth / 2), py + uy * (offset + depth / 2)
        zone = _rect(cx, cy, across, depth, angle - math.pi / 2)
        return zone, (ux, uy), (ox, oy), need, face

    if face == "front":
        return [band(rot + math.pi / 2, d / 2, w, need)]

    return [band(rot, w / 2, d, need), band(rot + math.pi, w / 2, d, need)]


def usable_depth(zone: Polygon, direction, origin, blockers) -> float:
    """
    How far you can actually walk in before something stops you.

    Measured, not estimated by area. Free *area* inside the zone counts space on
    the far side of an obstruction — a wardrobe 185 mm from a wall reads as 69%
    clear, because the floor beyond the wall is empty too. Depth from the
    object's own face is the number that means something, and it is the number
    a person can act on: "310 mm" tells you to move something.
    """
    if not blockers:
        return _extent(zone, direction, origin)

    free = zone.difference(unary_union(blockers))
    if free.is_empty:
        return 0.0

    parts = list(free.geoms) if free.geom_type == "MultiPolygon" else [free]

    # Only the piece touching the object's face is reachable from it.
    ox, oy = origin
    here = Point(ox, oy)
    reachable = [p for p in parts if p.distance(here) < 0.05]
    if not reachable:
        return 0.0

    return max(_extent(p, direction, origin) for p in reachable)


def _extent(shape: Polygon, direction, origin) -> float:
    """How far `shape` reaches along `direction` from `origin`."""
    ux, uy = direction
    ox, oy = origin
    try:
        coords = list(shape.exterior.coords)
    except AttributeError:
        return 0.0
    return max((x - ox) * ux + (y - oy) * uy for x, y in coords)


def swing_zones(opening: dict, walls: list) -> list[Polygon]:
    """
    The two quarter-circles a door leaf could sweep, one per side.

    Both, because hinge side is not something a `D750` block records. See the
    module docstring: reporting a door as blocked when the leaf simply goes the
    other way would make this feature noise.
    """
    index = opening.get("wall")
    if index is None or index >= len(walls):
        return []
    wall = walls[index]

    ax, ay = wall["a"]["x"], wall["a"]["y"]
    bx, by = wall["b"]["x"], wall["b"]["y"]
    length = math.hypot(bx - ax, by - ay)
    if length < 1e-9:
        return []
    dx, dy = (bx - ax) / length, (by - ay) / length

    t = opening["along"]
    cx, cy = ax + dx * t, ay + dy * t
    leaf = opening["width"]
    half = wall.get("thickness", 0.2) / 2

    zones = []
    for sign in (1, -1):
        nx, ny = -dy * sign, dx * sign
        # A square approximating the quarter-circle sweep. Squarer than the real
        # arc, which errs toward reporting a clash — the safe direction for a
        # check whose job is to raise a question, not settle one.
        hx, hy = cx + nx * half, cy + ny * half
        zones.append(
            Polygon([
                (hx - dx * leaf / 2, hy - dy * leaf / 2),
                (hx + dx * leaf / 2, hy + dy * leaf / 2),
                (hx + dx * leaf / 2 + nx * leaf, hy + dy * leaf / 2 + ny * leaf),
                (hx - dx * leaf / 2 + nx * leaf, hy - dy * leaf / 2 + ny * leaf),
            ])
        )
    return zones


def wall_bands(walls: list) -> list[Polygon]:
    """Every wall as the solid band it occupies."""
    bands = []
    for w in walls:
        if not w.get("paired"):
            continue
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        length = math.hypot(bx - ax, by - ay)
        if length < 1e-9:
            continue
        dx, dy = (bx - ax) / length, (by - ay) / length
        t = w.get("thickness", 0.2) / 2
        nx, ny = -dy * t, dx * t
        bands.append(Polygon([
            (ax + nx, ay + ny), (bx + nx, by + ny),
            (bx - nx, by - ny), (ax - nx, ay - ny),
        ]))
    return bands


# ---------------------------------------------------------------------------
# The checks
# ---------------------------------------------------------------------------


def check(model: dict, dims: dict) -> list[Issue]:
    """Every geometric fact worth a second look. Ordered worst first."""
    elements = model.get("elements", {})
    walls = elements.get("walls", [])
    spaces = elements.get("spaces", [])
    openings = elements.get("openings", [])
    # ── Check one floor against its own walls ────────────────────────────────
    # `elements.fixtures` covers every storey; `walls` and `spaces` cover the
    # primary one. Every check below pairs a fixture with a wall, a door swing
    # or a room, so a fixture from another floor would be measured against
    # geometry it has never been near — and two beds stacked at the same (x, y)
    # on different floors would read as a 100% overlap.
    #
    # So this filters to the storey the geometry belongs to. Fixtures on other
    # floors go unchecked, which is a stated gap rather than a silent one:
    # checking them needs per-storey walls in the model, and `elements` carries
    # one storey's by design because that is what the plan drawing draws.
    primary = (model.get("storeys") or {}).get("primary", 0)
    fixtures = [
        f for f in elements.get("fixtures", [])
        if f.get("label") == "fixture" and f.get("storey", primary) == primary
    ]

    issues: list[Issue] = []

    placed: list[tuple[dict, Polygon]] = []
    for f in fixtures:
        poly = fixture_footprint(f, dims)
        if poly is not None and poly.is_valid and not poly.is_empty:
            placed.append((f, poly))

    solids = unary_union([p for _, p in placed]) if placed else None
    bands = unary_union(wall_bands(walls)) if walls else None

    room_of = {}
    for space in spaces:
        try:
            room_of[space["index"]] = (Polygon(space["loop"]), space)
        except Exception:
            continue

    def which_room(poly):
        point = poly.representative_point()
        for index, (shape, space) in room_of.items():
            if shape.contains(point):
                return index, space.get("name")
        return None, None

    # ---- Doors with nowhere to open ---------------------------------------
    for n, opening in enumerate(openings):
        if opening.get("kind") != "door":
            continue
        zones = swing_zones(opening, walls)
        if len(zones) != 2 or solids is None:
            continue

        blocked = []
        for zone in zones:
            hit = zone.intersection(solids)
            share = hit.area / zone.area if zone.area else 0.0
            blocked.append(share)

        if min(blocked) > 0.12:
            room, name = which_room(zones[0])
            issues.append(Issue(
                kind="swing-blocked", severity="blocking",
                message=(
                    f"A {opening['width']:.2f} m door has furniture behind it on "
                    f"both sides — {min(blocked):.0%} of the swing is obstructed "
                    "whichever way the leaf hangs."
                ),
                room=room, room_name=name,
                measured=round(min(blocked), 3), wanted=0.0,
                at=tuple(zones[0].centroid.coords)[0],
                items=[f"opening-{n}"],
            ))

    # ---- Two things in the same place --------------------------------------
    for i in range(len(placed)):
        fi, pi = placed[i]
        for j in range(i + 1, len(placed)):
            fj, pj = placed[j]
            if not pi.intersects(pj):
                continue
            shared = pi.intersection(pj).area
            smaller = min(pi.area, pj.area) or 1.0
            if shared <= OVERLAP_TOLERANCE or shared / smaller < OVERLAP_SHARE:
                continue
            room, name = which_room(pi)
            issues.append(Issue(
                kind="overlap", severity="blocking",
                message=(
                    f"{fi.get('item')} and {fj.get('item')} overlap by "
                    f"{shared:.2f} m² — {shared / smaller:.0%} of the smaller one."
                ),
                room=room, room_name=name,
                items=[str(fi.get("item")), str(fj.get("item"))],
                measured=round(shared, 3),
                at=tuple(pi.intersection(pj).centroid.coords)[0],
            ))

    # ---- Furniture standing in a wall --------------------------------------
    # Usually a reconstruction fault rather than a design one, which is why it
    # is reported as a note: it tells you to look at the import, not the layout.
    if bands is not None:
        for fixture, poly in placed:
            hit = poly.intersection(bands)
            if hit.is_empty:
                continue
            share = hit.area / poly.area if poly.area else 0.0
            if share < 0.25:
                continue
            room, name = which_room(poly)
            issues.append(Issue(
                kind="in-wall", severity="note",
                message=(
                    f"{fixture.get('item')} sits {share:.0%} inside a wall. "
                    "Usually the import placed it, not the architect."
                ),
                room=room, room_name=name,
                items=[str(fixture.get("item"))],
                measured=round(share, 3),
                at=tuple(poly.centroid.coords)[0],
            ))

    # ---- Not enough room to use it -----------------------------------------
    for fixture, poly in placed:
        candidates = approach_candidates(fixture, dims)
        if not candidates:
            continue

        best_depth, need, face = -1.0, 0.0, ""
        for zone, direction, origin, want, which in candidates:
            blockers = [p for f, p in placed if p is not poly and p.intersects(zone)]
            if bands is not None and bands.intersects(zone):
                blockers.append(bands.intersection(zone))
            depth = usable_depth(zone, direction, origin, blockers)
            if depth > best_depth:
                best_depth, need, face = depth, want, which

        if best_depth >= need - 0.01:
            continue

        room, name = which_room(poly)
        issues.append(Issue(
            kind="tight-approach",
            severity="blocking" if best_depth < need * 0.4 else "tight",
            message=(
                f"{fixture.get('item')} has about {best_depth * 1000:.0f} mm clear at "
                f"its {face}; {need * 1000:.0f} mm is the working figure this check used."
            ),
            room=room, room_name=name,
            items=[str(fixture.get("item"))],
            measured=round(best_depth, 3), wanted=need,
            at=tuple(poly.centroid.coords)[0],
        ))

    # ---- Rooms with no way in ----------------------------------------------
    served: set[int] = set()
    for opening in openings:
        for zone in swing_zones(opening, walls):
            index, _ = which_room(zone)
            if index is not None:
                served.add(index)

    if openings:
        for index, (shape, space) in room_of.items():
            if index in served or space.get("area", 0) < 2.0:
                continue
            if space.get("kind") == "outdoor":
                continue
            issues.append(Issue(
                kind="no-door", severity="tight",
                message=(
                    f"No door opens into this {space.get('area', 0):.1f} m² space. "
                    "Either the opening was missed on import, or there is no way in."
                ),
                room=index, room_name=space.get("name"),
                at=tuple(shape.representative_point().coords)[0],
            ))

    order = {"blocking": 0, "tight": 1, "note": 2}
    issues.sort(key=lambda i: (order.get(i.severity, 3), -(i.measured or 0)))
    return issues


def summarise(issues: list[Issue]) -> dict:
    """
    Counts, and deliberately no verdict.

    There is no `ok` field and no score. A caller wanting to render a green tick
    has to invent it, and inventing it is the decision this refuses to make.
    """
    by_kind: dict[str, int] = {}
    for issue in issues:
        by_kind[issue.kind] = by_kind.get(issue.kind, 0) + 1
    return {
        "total": len(issues),
        "blocking": sum(1 for i in issues if i.severity == "blocking"),
        "tight": sum(1 for i in issues if i.severity == "tight"),
        "notes": sum(1 for i in issues if i.severity == "note"),
        "byKind": by_kind,
        "basis": (
            "Geometric measurements against conventional working figures. "
            "Not a compliance check and not a professional opinion."
        ),
    }
