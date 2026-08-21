"""
Doors and windows, and the walls they belong to.

── An opening is not a thing in space, it is a thing in a wall ───────────────
A door drawn at coordinates (12.4, 8.1) is useless on its own. What the geometry
needs is *which wall* and *how far along it* — because that is what survives a
wall moving, and because a hole has to be cut somewhere.

So every opening is projected onto a host wall and stored as `(wall, along,
width)`. An opening that finds no host is reported rather than dropped: an
unhosted door means either the wall detection missed a wall or the door is on a
different frame, and both are worth knowing. Silently discarding it produces a
building whose rooms have no way in.

── Where they come from ──────────────────────────────────────────────────────
Two emitters here, both reading what the drawing already says:

  SIZED BLOCKS   `D750`, `W1200`, `D-900`. The commonest blocks in any drawing
                 by a wide margin — one real plan has 88 placements of `D750`
                 alone — and the number is not decoration, it is the leaf width
                 in millimetres. Exact position and rotation come free.

  OPENING LAYERS Linework on a layer whose name mentions doors or windows,
                 clustered and measured. Coarser, and the fallback for drawings
                 that draw their openings rather than blocking them.

A third emitter — collinear gaps in wall runs — belongs here too and is the
right answer for scans. It needs the detector, so it is not in this pass.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: Defaults where the drawing does not say. Standard residential.
DOOR_HEIGHT = 2.1
DOOR_SILL = 0.0
WINDOW_HEIGHT = 1.2
WINDOW_SILL = 0.9

#: How far an opening may sit from a wall centreline and still be hosted on it.
#: Generous: a door block is inserted on the wall face or the hinge point rather
#: than the centre, so half a wall thickness of offset is normal.
HOST_RADIUS = 0.9

#: An opening must sit within the wall, not off its end.
END_MARGIN = 0.02


@dataclass
class Opening:
    kind: str              # 'door' | 'window'
    wall: int              # index into the wall list
    along: float           # metres from wall.a
    width: float
    height: float
    sill: float
    source: str            # which emitter produced it
    confidence: float = 0.8

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "wall": self.wall,
            "along": round(self.along, 4),
            "width": round(self.width, 4),
            "height": round(self.height, 3),
            "sill": round(self.sill, 3),
            "source": self.source,
            "confidence": round(self.confidence, 3),
        }


def _project(px: float, py: float, wall) -> tuple[float, float]:
    """(distance along the wall, perpendicular offset from it)."""
    dx, dy = wall.bx - wall.ax, wall.by - wall.ay
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return 0.0, float("inf")
    dx, dy = dx / length, dy / length
    ox, oy = px - wall.ax, py - wall.ay
    along = ox * dx + oy * dy
    perp = abs(-ox * dy + oy * dx)
    # Off the end of the wall is not "on the wall", however close in the
    # perpendicular sense — that is how a door lands on the wall behind it.
    if along < -HOST_RADIUS or along > length + HOST_RADIUS:
        return along, float("inf")
    return along, perp


def host(px: float, py: float, walls, radius: float = HOST_RADIUS):
    """The wall an opening at this point belongs to, and how far along it."""
    best_index, best_along, best_perp = None, 0.0, radius
    for i, wall in enumerate(walls):
        along, perp = _project(px, py, wall)
        if perp < best_perp:
            best_index, best_along, best_perp = i, along, perp
    return best_index, best_along


def from_sized_blocks(placements, walls, guess_item) -> tuple[list[Opening], int]:
    """
    Openings from `D750` / `W1200` style block names.

    Returns the openings and how many could not be hosted — the second number is
    the one worth watching, because it counts doors that exist on the drawing
    and will not exist in the model.
    """
    out: list[Opening] = []
    unhosted = 0

    for placement in placements:
        # This emitter owns its own pattern rather than deferring to the kernel.
        # `D900` is a door whatever else can be said about it, and making that
        # depend on a second component's opinion means a drawing whose block
        # names the kernel happens not to recognise loses every one of its doors.
        name_width = _width_from_name(placement["block"])
        if name_width is not None:
            item = "door" if placement["block"].strip()[:1].lower() == "d" else "window"
        else:
            item = guess_item(placement["block"]) if guess_item else None
        if item not in ("door", "window"):
            continue

        px = placement["position"]["x"]
        py = placement["position"]["y"]
        index, along = host(px, py, walls)
        if index is None:
            unhosted += 1
            continue

        wall = walls[index]
        # The block name carries the leaf width in millimetres. Trust it over
        # any measurement: it is what the architect specified.
        width = name_width or (0.9 if item == "door" else 1.2)

        # Clamp rather than reject. A door 3 cm past the end of a wall is a
        # trimming artefact, not a different door.
        along = max(END_MARGIN + width / 2, min(wall.length - END_MARGIN - width / 2, along))
        if wall.length < width + 2 * END_MARGIN:
            unhosted += 1
            continue

        out.append(
            Opening(
                kind=item,
                wall=index,
                along=along,
                width=width,
                height=DOOR_HEIGHT if item == "door" else WINDOW_HEIGHT,
                sill=DOOR_SILL if item == "door" else WINDOW_SILL,
                source="blockSized",
                confidence=0.92,
            )
        )

    return out, unhosted


def _width_from_name(block: str) -> float | None:
    import re

    match = re.match(r"^([dw])[\s\-_]?(\d{3,4})$", (block or "").strip(), re.I)
    if not match:
        return None
    mm = int(match.group(2))
    return mm / 1000 if 500 <= mm <= 3000 else None


def dedupe(openings: list[Opening], tolerance: float = 0.25) -> list[Opening]:
    """
    One hole per opening.

    Emitters overlap by design — a `D750` block and the door-layer linework
    describe the same door — and cutting the same hole twice leaves a sliver of
    wall between two coincident cuts.
    """
    kept: list[Opening] = []
    for opening in sorted(openings, key=lambda o: -o.confidence):
        clash = any(
            k.wall == opening.wall and abs(k.along - opening.along) < tolerance
            for k in kept
        )
        if not clash:
            kept.append(opening)
    return kept


def summarise(openings: list[Opening], unhosted: int) -> dict:
    return {
        "total": len(openings),
        "doors": sum(1 for o in openings if o.kind == "door"),
        "windows": sum(1 for o in openings if o.kind == "window"),
        "unassigned": unhosted,
        "bySource": {
            s: sum(1 for o in openings if o.source == s)
            for s in {o.source for o in openings}
        },
    }
