"""
Unit assignment: which rooms make up one dwelling.

── Why this exists ────────────────────────────────────────────────────────────
Every figure `quantify/areas.py` emits carries the caveat "the whole storey is
treated as ONE unit". True for a villa; meaningless for an apartment floor
plate, where RERA carpet is a PER-FLAT number and a storey figure is nobody's
flat. The missing piece is not measurement — it is grouping: which rooms
belong together.

── The rule: a dwelling is what a front door encloses ─────────────────────────
Rooms connected by internal doors form one unit; the connection that crosses a
STAIR or LIFT is the front door, and the stair core itself belongs to nobody.
So:

  1. Every door connects the two rooms it stands between — found by probing
     half a wall-thickness past each face of the host wall at the door's
     position, the same both-faces test the area statement uses for
     partitions. A door with a room on one side only (an entrance from
     outside, a balcony door whose far side is outdoor) contributes no edge.
  2. Rooms whose name or kind says stair/lift are COMMON, and edges through
     them are cut — two flats sharing a landing must not merge.
  3. Connected components of what remains are the units.
  4. One refinement pass: a circulation room whose doors reach two or more
     DIFFERENT components is itself common — a shared corridor looks exactly
     like an in-unit hallway until the components on its far sides are known,
     which is why this cannot be a name test up front. (An in-unit Flur
     connects rooms of ONE component and stays in the flat.)
  5. Balconies and verandahs attach to the unit their door opens from; an
     outdoor space with no door stays unassigned rather than guessed.

── What it refuses to do ──────────────────────────────────────────────────────
No unit is invented for a room no door reaches: an enclosed shaft or a room
whose door the drawing never carried ends up `unassigned`, and the caller sees
that count. Assigning it to the nearest flat would silently move statutory
area between owners.
"""

from __future__ import annotations

import math

from quantify.schedules import _is_outdoor

#: Rooms that are the building's, not any dwelling's. Name evidence first;
#: `circulation` kind alone is NOT here — an in-unit hallway is circulation
#: too, and the refinement pass separates the two by topology, not label.
COMMON_WORDS = ("stair", "treppe", "lift", "aufzug", "elevator", "escalator",
                "shaft", "schacht", "machine room")


def _polygon_of(space: dict):
    from shapely.geometry import Polygon

    loop = space.get("loop") or []
    if len(loop) < 3:
        return None
    poly = Polygon([(float(p[0]), float(p[1])) for p in loop])
    if not poly.is_valid:
        poly = poly.buffer(0)
    return None if poly.is_empty else poly


def _is_common(space: dict) -> bool:
    name = str(space.get("name") or "").lower()
    return any(w in name for w in COMMON_WORDS)


def _door_position(opening: dict, wall: dict) -> tuple[float, float, float, float, float] | None:
    """(x, y, perp_x, perp_y, thickness) at the door's point on its wall."""
    a, b = wall.get("a") or {}, wall.get("b") or {}
    ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
    bx, by = float(b.get("x", 0)), float(b.get("y", 0))
    length = math.hypot(bx - ax, by - ay)
    if length < 1e-6:
        return None
    dx, dy = (bx - ax) / length, (by - ay) / length
    along = min(max(float(opening.get("along", 0.0)), 0.0), length)
    return (ax + dx * along, ay + dy * along, -dy, dx,
            float(wall.get("thickness") or 0.1))


def _rooms_beside(x, y, px, py, thickness, polys) -> set[int]:
    """Space indices found half a thickness past each face of the wall."""
    from shapely.geometry import Point

    reach = thickness / 2 + 0.05
    found = set()
    for sign in (1.0, -1.0):
        probe = Point(x + px * reach * sign, y + py * reach * sign)
        for index, poly in polys.items():
            if poly is not None and poly.contains(probe):
                found.add(index)
                break
    return found


def assign_units(model: dict) -> list[dict]:
    """
    One entry per storey block: unit membership, commons, and the leftovers.

    Room references are LOCAL indices into that storey's `spaces` list — the
    same convention `boundedBy` uses, for the same reason.
    """
    from solve.storeys import element_blocks

    out = []
    for tag, elements in element_blocks(model):
        spaces = elements.get("spaces", [])
        walls = elements.get("walls", [])
        openings = elements.get("openings", [])

        polys = {i: _polygon_of(s) for i, s in enumerate(spaces)}
        indoor = {i for i, s in enumerate(spaces) if not _is_outdoor(s)}
        outdoor = {i for i in range(len(spaces))} - indoor
        common = {i for i in indoor if _is_common(spaces[i])}

        # Door edges, including door→outdoor (kept aside for balcony attach).
        edges: list[tuple[int, int]] = []
        balcony_links: list[tuple[int, int]] = []
        for opening in openings:
            if str(opening.get("kind") or "").lower() != "door":
                continue
            host = opening.get("wall")
            if not (isinstance(host, int) and 0 <= host < len(walls)):
                continue
            position = _door_position(opening, walls[host])
            if position is None:
                continue
            beside = _rooms_beside(*position, polys)
            if len(beside) != 2:
                continue
            first, second = sorted(beside)
            if first in outdoor or second in outdoor:
                inner = second if first in outdoor else first
                outer = first if first in outdoor else second
                balcony_links.append((outer, inner))
                continue
            edges.append((first, second))

        def components(cut: set[int]) -> dict[int, int]:
            parent = {i: i for i in indoor - cut}

            def find(i):
                while parent[i] != i:
                    parent[i] = parent[parent[i]]
                    i = parent[i]
                return i

            for first, second in edges:
                if first in cut or second in cut:
                    continue
                if first in parent and second in parent:
                    root_a, root_b = find(first), find(second)
                    if root_a != root_b:
                        parent[root_a] = root_b
            return {i: find(i) for i in parent}

        roots = components(common)

        # Refinement: a circulation room bridging two units is a shared
        # corridor — but by the time it can be tested it has already MERGED
        # them through its own doors, so looking at its neighbours' roots in
        # the intact graph shows one component and proves nothing. The test
        # that works is the articulation form: CUT the candidate, recompute,
        # and ask whether its door-neighbours now fall in different
        # components. The trap in that form alone: an in-unit hallway is ALSO
        # an articulation point — bedroom, bath and living may reach each
        # other only through it, and cutting it shatters one flat into
        # per-room "units". What separates the two cases is what the cut
        # leaves behind: a BUILDING corridor leaves whole dwellings on its
        # sides (several rooms each, kitchens and baths among them); an
        # in-unit hall leaves single rooms. So a side only counts as a
        # dwelling if it has at least two rooms, one of them not itself
        # circulation — and promotion needs two such sides. A floor of
        # one-room studios defeats this and is a documented limit, not a
        # surprise.
        promoted = set()
        for i in sorted(indoor - common):
            if str(spaces[i].get("kind", "")).lower() != "circulation":
                continue
            cut_roots = components(common | {i})
            neighbours = {
                j
                for first, second in edges
                for j in ((second,) if first == i else (first,) if second == i else ())
                if j in cut_roots
            }
            members_of: dict[int, list[int]] = {}
            for j, root in cut_roots.items():
                members_of.setdefault(root, []).append(j)
            dwellings = 0
            for root in {cut_roots[j] for j in neighbours}:
                members = members_of.get(root, [])
                solid = any(
                    str(spaces[m].get("kind", "")).lower() != "circulation"
                    for m in members
                )
                if len(members) >= 2 and solid:
                    dwellings += 1
            if dwellings >= 2:
                promoted.add(i)
        if promoted:
            common |= promoted
            roots = components(common)

        by_root: dict[int, list[int]] = {}
        for i, root in roots.items():
            by_root.setdefault(root, []).append(i)

        # A dwelling is entered through a door. A room no door reaches — an
        # enclosed shaft, a store the drawing forgot — is its own singleton
        # component, and emitting it as a "unit" would put statutory area
        # under a front door that does not exist. Door-touched means ANY
        # door: one to a common corridor (cut from the graph, but still a
        # door) keeps a one-room studio a unit.
        door_touched = {i for pair in edges for i in pair}
        door_touched |= {inner for _outer, inner in balcony_links}

        units = []
        for number, members in enumerate(
            sorted(
                (m for m in by_root.values() if any(i in door_touched for i in m)),
                key=lambda m: (-len(m), m),
            ),
            start=1,
        ):
            attached = sorted(
                outer for outer, inner in balcony_links if inner in members
            )
            units.append({
                "unit": number,
                "rooms": sorted(members),
                "balconies": attached,
                "named": [spaces[i].get("name") for i in sorted(members)
                          if spaces[i].get("name")],
            })

        reachable = {i for unit in units for i in unit["rooms"]}
        attached_outdoor = {i for unit in units for i in unit["balconies"]}
        out.append({
            **({"storeyTitle": tag.get("title")} if tag else {}),
            "units": units,
            "common": sorted(common),
            "unassigned": sorted(
                (indoor - common - reachable)
                | (outdoor - attached_outdoor)
            ),
        })
    return out


def unit_model(model: dict, storey: int, unit: dict) -> dict:
    """
    A single dwelling as a model `quantify/areas.py` can read unchanged.

    The composition trick that makes per-flat RERA figures free: keep the
    storey's WALL list intact and filter only the SPACES to the unit's rooms
    (plus its balconies). `area_statement`'s partition probe then tests
    "indoor room of THIS unit on both faces" — so a wall between two flats,
    or between a flat and the corridor, has unit rooms on one side only and
    is treated as external, which is exactly what RERA §2(k) prescribes for
    walls that are not internal to the apartment (the excluded-or-half
    convention question only arises for the shared ones, and exclusion is
    the recorded default).
    """
    from solve.storeys import element_blocks

    blocks = list(element_blocks(model))
    tag, elements = blocks[storey]
    keep = set(unit["rooms"]) | set(unit["balconies"])
    return {
        "elements": {
            "walls": elements.get("walls", []),
            "spaces": [
                s for i, s in enumerate(elements.get("spaces", [])) if i in keep
            ],
            "openings": elements.get("openings", []),
        }
    }
