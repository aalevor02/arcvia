"""
Separating the buildings on a site.

── Three scales of separation, three different criteria ──────────────────────
`solve/frames.py` separates the DRAWINGS on a sheet, and it does it on
emptiness: a draughtsman leaves white space between plans, so a channel that no
wall crosses anywhere along the sheet is a gutter. `quantify/dwellings.py`
separates the DWELLINGS inside a building, and it does it on the door graph: a
flat is what a front door encloses.

Neither separates the BUILDINGS on a site plan, and the site sheet is exactly
where both of them fail.

Emptiness cannot do it, because a site plan is precisely the drawing where the
buildings are NOT held apart by white space. Roads, plot boundaries, compound
walls and level lines run continuously between them, so there is no channel to
find and the frame splitter correctly returns ONE frame spanning the whole
estate. That is not a bug in `frames.py`; it is the right answer to the
question that module asks.

The door graph cannot do it either, because it starts from the rooms of one
building already being grouped — which is the question being asked here.

── The criterion: the rooms of one building share their walls ────────────────
A building's rooms TILE. Two adjacent rooms are separated by one partition and
BOTH are bounded by it, so `Space.bounded_by` already links them; a room off a
corridor reaches its neighbours through the corridor's own walls. Two villas
standing on a site share no wall at all — that is what makes them two villas
rather than one semi-detached pair, and where they DO share a party wall the
right answer really is one structure, which `dwellings.py` then splits by door.

So: union the rooms that share a bounding wall, and the connected components
are the buildings.

There is no distance anywhere in that rule, and therefore nothing to tune.
That matters more here than it usually would. `frames.py` records at length how
no single gutter value can both keep a plan whole and separate two plans, and a
site plan has a far wider spread of genuine gaps than a sheet does — a villa
and its own porch may sit closer together than two rooms at opposite ends of
one villa.

── What this refuses to do ───────────────────────────────────────────────────
A wall that bounds no room is attributed to NO building. On a site sheet that
is most of the linework — on `SITE PLAN FOR 3D` it is the long boundary
diagonal, the roads and the large plot rectangles — and it is reported as site
linework, with its length, rather than dropped silently or quietly added to the
nearest building's bill of quantities. A wall nobody can attribute is evidence
about the drawing, not a rounding error.

This module measures and groups. It does not decide that a scope IS a site:
that judgement belongs with the other gradings in `solve/verify.py`, which is
the one place that already knows what a plausible building looks like.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class Building:
    """One connected group of rooms, and the walls that bound them."""

    index: int
    space_indices: list[int] = field(default_factory=list)
    wall_indices: list[int] = field(default_factory=list)
    bbox: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    #: Finished-face floor area, m2 — the same basis the room schedule totals,
    #: so a per-building figure and a whole-model figure cannot disagree about
    #: what a room is.
    area: float = 0.0
    named: int = 0

    @property
    def span(self) -> float:
        x0, y0, x1, y1 = self.bbox
        return max(x1 - x0, y1 - y0)

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "rooms": len(self.space_indices),
            "named": self.named,
            "walls": len(self.wall_indices),
            "area": round(self.area, 2),
            "span": round(self.span, 2),
            "bbox": [round(v, 3) for v in self.bbox],
            "spaceIndices": list(self.space_indices),
            "wallIndices": list(self.wall_indices),
        }


@dataclass
class Segmentation:
    """What one scope's rooms and walls turned out to be."""

    buildings: list[Building] = field(default_factory=list)
    #: Walls bounding no room at all. Named rather than counted, because the
    #: caller has to be able to look at them.
    site_wall_indices: list[int] = field(default_factory=list)
    site_wall_length: float = 0.0

    @property
    def count(self) -> int:
        return len(self.buildings)

    def as_dict(self) -> dict:
        return {
            "buildings": [b.as_dict() for b in self.buildings],
            "count": self.count,
            "siteWalls": len(self.site_wall_indices),
            "siteWallLength": round(self.site_wall_length, 2),
        }


def segment_site(walls, spaces) -> Segmentation:
    """
    Group rooms into buildings by the walls they share.

    Returned largest-first by floor area, so `buildings[0]` is the main
    structure on the site. Area rather than room count is deliberate, and it is
    the OPPOSITE of the choice `frames.py` makes for frames: there, count is
    primary because a compound wall is a few long walls and has to rank last.
    Here every candidate is already a closed group of ROOMS, so what separates
    a villa from a bin store is how much floor it has — and a villa subdivided
    into many small service rooms must not outrank a larger one drawn open-plan.
    """
    if not spaces:
        return Segmentation(
            site_wall_length=_total_length(walls, range(len(walls))),
            site_wall_indices=list(range(len(walls))),
        )

    # Which rooms does each wall bound? A wall bounding two rooms is the
    # evidence that those two rooms belong to one building.
    rooms_on_wall: dict[int, list[int]] = {}
    for si, space in enumerate(spaces):
        for wi in _bounded_by(space):
            rooms_on_wall.setdefault(wi, []).append(si)

    parent = list(range(len(spaces)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for members in rooms_on_wall.values():
        for other in members[1:]:
            union(members[0], other)

    groups: dict[int, list[int]] = {}
    for si in range(len(spaces)):
        groups.setdefault(find(si), []).append(si)

    buildings: list[Building] = []
    attributed: set[int] = set()
    for members in groups.values():
        wall_indices = sorted({wi for si in members for wi in _bounded_by(spaces[si])})
        attributed.update(wall_indices)
        xs: list[float] = []
        ys: list[float] = []
        area = 0.0
        named = 0
        for si in members:
            space = spaces[si]
            for px, py in _loop(space):
                xs.append(px)
                ys.append(py)
            area += _area(space)
            if _name(space):
                named += 1
        buildings.append(Building(
            index=0,
            space_indices=sorted(members),
            wall_indices=wall_indices,
            bbox=(min(xs), min(ys), max(xs), max(ys)) if xs else (0.0, 0.0, 0.0, 0.0),
            area=area,
            named=named,
        ))

    # Area first; the rest of the key only breaks ties, and it breaks them on
    # geometry rather than on the order the rooms happened to leave the solver.
    # A building index that moves when the drawing is redrawn somewhere else is
    # not an identity — the same reasoning `frames.py` gives for frame order.
    buildings.sort(key=lambda b: (-b.area, -len(b.space_indices), b.bbox[0], b.bbox[1]))
    for n, building in enumerate(buildings):
        building.index = n

    site_walls = [i for i in range(len(walls)) if i not in attributed]
    return Segmentation(
        buildings=buildings,
        site_wall_indices=site_walls,
        site_wall_length=_total_length(walls, site_walls),
    )


# ── Reading a space or a wall in either shape it arrives in ──────────────────
# `solve` runs on the dataclasses; the API, the tests and everything downstream
# of `building.json` run on dicts. Accepting both costs six small helpers here
# and saves every caller a conversion — and a conversion is exactly where a
# `boundedBy` silently becomes an empty list, which would put every room in a
# building of its own without anything raising.

def _bounded_by(space) -> list[int]:
    if isinstance(space, dict):
        return list(space.get("boundedBy") or [])
    return list(getattr(space, "bounded_by", None) or [])


def _loop(space) -> list[tuple[float, float]]:
    raw = space.get("loop") if isinstance(space, dict) else getattr(space, "loop", None)
    return [(float(p[0]), float(p[1])) for p in (raw or [])]


def _area(space) -> float:
    if isinstance(space, dict):
        return float(space.get("area") or 0.0)
    return float(getattr(space, "area", 0.0) or 0.0)


def _name(space) -> str:
    if isinstance(space, dict):
        return (space.get("name") or "").strip()
    return (getattr(space, "name", None) or "").strip()


def _wall_ends(wall) -> tuple[float, float, float, float]:
    if isinstance(wall, dict):
        a, b = wall.get("a") or {}, wall.get("b") or {}
        return (float(a.get("x", 0.0)), float(a.get("y", 0.0)),
                float(b.get("x", 0.0)), float(b.get("y", 0.0)))
    return (float(wall.ax), float(wall.ay), float(wall.bx), float(wall.by))


def _total_length(walls, indices) -> float:
    total = 0.0
    for i in indices:
        ax, ay, bx, by = _wall_ends(walls[i])
        total += math.hypot(bx - ax, by - ay)
    return total
