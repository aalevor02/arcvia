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
MIN_LABELLED_GAP = 0.45
MAX_LABELLED_GAP = 3.2
LABEL_RADIUS = 4.0
COLLINEAR_TOLERANCE = 0.18


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


def _label_kind(text: str) -> str:
    lowered = (text or '').lower()
    return 'window' if 'window' in lowered or 'ventana' in lowered else 'door'


def _gap_candidate(label, first, second):
    '''Return the labelled gap between two axis-aligned wall runs, if any.'''
    first_horizontal = abs(first.bx - first.ax) >= abs(first.by - first.ay)
    second_horizontal = abs(second.bx - second.ax) >= abs(second.by - second.ay)
    if first_horizontal != second_horizontal:
        return None

    if first_horizontal:
        line_a = (first.ay + first.by) / 2
        line_b = (second.ay + second.by) / 2
        if abs(line_a - line_b) > COLLINEAR_TOLERANCE:
            return None
        ends_a = (min(first.ax, first.bx), max(first.ax, first.bx))
        ends_b = (min(second.ax, second.bx), max(second.ax, second.bx))
        if ends_a[1] <= ends_b[0]:
            gap_a, gap_b = ends_a[1], ends_b[0]
        elif ends_b[1] <= ends_a[0]:
            gap_a, gap_b = ends_b[1], ends_a[0]
        else:
            return None
        gap = gap_b - gap_a
        midpoint = ((gap_a + gap_b) / 2, (line_a + line_b) / 2)
        merged = (min(ends_a[0], ends_b[0]), midpoint[1], max(ends_a[1], ends_b[1]), midpoint[1])
    else:
        line_a = (first.ax + first.bx) / 2
        line_b = (second.ax + second.bx) / 2
        if abs(line_a - line_b) > COLLINEAR_TOLERANCE:
            return None
        ends_a = (min(first.ay, first.by), max(first.ay, first.by))
        ends_b = (min(second.ay, second.by), max(second.ay, second.by))
        if ends_a[1] <= ends_b[0]:
            gap_a, gap_b = ends_a[1], ends_b[0]
        elif ends_b[1] <= ends_a[0]:
            gap_a, gap_b = ends_b[1], ends_a[0]
        else:
            return None
        gap = gap_b - gap_a
        midpoint = ((line_a + line_b) / 2, (gap_a + gap_b) / 2)
        merged = (midpoint[0], min(ends_a[0], ends_b[0]), midpoint[0], max(ends_a[1], ends_b[1]))

    if not MIN_LABELLED_GAP <= gap <= MAX_LABELLED_GAP:
        return None
    label_distance = math.hypot(label.x - midpoint[0], label.y - midpoint[1])
    if label_distance > LABEL_RADIUS:
        return None
    return label_distance, gap, midpoint, merged


def from_text_labels(labels, walls) -> tuple[list, list[Opening], int]:
    '''Close explicitly labelled wall gaps and retain each span as an opening.'''
    walls = list(walls)
    pending: list[tuple[str, float, float, float, float]] = []

    # Resolve the most spatially specific labels first. Text in this DWG is
    # centred beside, not on, the opening; the ambiguous middle note must not
    # steal the left gap from a later label that only fits that gap.
    def nearest_gap(label):
        distances = [
            found[0]
            for i, first in enumerate(walls)
            for second in walls[i + 1:]
            if (found := _gap_candidate(label, first, second)) is not None
        ]
        return min(distances, default=float('inf'))

    for label in sorted(labels, key=nearest_gap):
        best = None
        for i, first in enumerate(walls):
            for j in range(i + 1, len(walls)):
                found = _gap_candidate(label, first, walls[j])
                if found is not None and (best is None or found[0] < best[0][0]):
                    best = (found, i, j)

        kind = _label_kind(label.text)
        if best is None:
            pending.append((kind, label.x, label.y, 1.2 if kind == 'window' else 1.8, 0.72))
            continue

        (_distance, gap, midpoint, merged), i, j = best
        first, second = walls[i], walls[j]
        replacement = type(first)(
            ax=merged[0], ay=merged[1], bx=merged[2], by=merged[3],
            thickness=max(first.thickness, second.thickness),
            paired=first.paired or second.paired,
            confidence=min(first.confidence, second.confidence, 0.88),
            layer='<bridged:labelled-opening>',
        )
        walls = [wall for k, wall in enumerate(walls) if k not in (i, j)]
        walls.append(replacement)
        pending.append((kind, midpoint[0], midpoint[1], gap, 0.96))

    openings: list[Opening] = []
    unhosted = 0
    for kind, px, py, width, confidence in pending:
        index, along = host(px, py, walls, radius=LABEL_RADIUS)
        if index is None or walls[index].length < width + 2 * END_MARGIN:
            unhosted += 1
            continue
        along = max(END_MARGIN + width / 2, min(
            walls[index].length - END_MARGIN - width / 2, along,
        ))
        openings.append(Opening(
            kind=kind, wall=index, along=along, width=width,
            height=DOOR_HEIGHT if kind == 'door' else WINDOW_HEIGHT,
            sill=DOOR_SILL if kind == 'door' else WINDOW_SILL,
            source='textLabel', confidence=confidence,
        ))

    return walls, openings, unhosted


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
