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
Three emitters here, all reading what the drawing already says:

  SIZED BLOCKS   `D750`, `W1200`, `D-900`. The commonest blocks in any drawing
                 by a wide margin — one real plan has 88 placements of `D750`
                 alone — and the number is not decoration, it is the leaf width
                 in millimetres. Exact position and rotation come free.
                 `from_sized_blocks`.

  TEXT LABELS    A `D750` written beside a gap in a wall run rather than
                 blocked. `from_text_labels`.

  OPENING LAYERS Linework on a layer whose name mentions doors or windows,
                 projected onto the wall it hosts on and merged. Coarser,
                 because the drawing states no width — it is measured off the
                 lines. `from_opening_layers`.

This list was wrong until 2026-08-26 and it is worth saying how, because the
error cost real time. It named SIZED BLOCKS and OPENING LAYERS, and said both
read what the drawing says. There was no opening-layer emitter anywhere in the
codebase — no function, no call site, nothing referencing one — and the second
emitter that did exist, `from_text_labels`, was not in the list at all. So a
reader concluded that a drawing which draws its openings on a door layer was
handled, and it was not: `SITE PLAN FOR 3D` carries 45 lines on `WINDOW1` and
produced no windows. Documentation that describes a capability nobody built is
worse than none, because it is trusted.

A fourth emitter — collinear gaps in wall runs — belongs here too and is the
right answer for scans. It needs the detector, so it is not in this pass.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace

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


def _nearest_wall_distance(px: float, py: float, walls) -> float | None:
    """Euclidean distance to the nearest finite wall segment."""
    best = float("inf")
    for wall in walls:
        dx, dy = wall.bx - wall.ax, wall.by - wall.ay
        length_sq = dx * dx + dy * dy
        if length_sq < 1e-12:
            distance = math.hypot(px - wall.ax, py - wall.ay)
        else:
            t = max(0.0, min(1.0, ((px - wall.ax) * dx + (py - wall.ay) * dy) / length_sq))
            distance = math.hypot(px - (wall.ax + t * dx), py - (wall.ay + t * dy))
        best = min(best, distance)
    return None if math.isinf(best) else best


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


def _end_gap_candidate(label, walls):
    """
    A doorway drawn flush against a crossing wall.

    `_gap_candidate` sees a gap between two walls in ONE run. A door beside a
    corner leaves a different shape: wall A stops a door's width short of a
    PERPENDICULAR wall B, and there is no second collinear wall for the gap
    rule to find — so the label fell through to a default-width opening and
    the doorway stayed a breach in the room graph. Measured on the Revit-22
    ground-truth fixture (test/fixtures/plangraph/), this was the dominant
    remaining leak: rooms merged across corner doorways into 50-120 m2 blobs
    that only closed at all because the derived perimeter happened to wander
    through them.

    The candidate: extend one wall's END along its own axis until it crosses
    a perpendicular wall's path; the clear run from the end to that wall's
    face is the doorway. Same gap band and label radius as the collinear
    rule, so a label cannot claim a corner gap it could not have claimed in
    the collinear form.

    Returns (label_distance, wall_index, end, hit_point, gap) or None.
    """
    best = None
    for i, wall in enumerate(walls):
        length = wall.length
        if length < 1e-9:
            continue
        dx, dy = (wall.bx - wall.ax) / length, (wall.by - wall.ay) / length
        for end in ("a", "b"):
            if end == "a":
                ex, ey, ddx, ddy = wall.ax, wall.ay, -dx, -dy
            else:
                ex, ey, ddx, ddy = wall.bx, wall.by, dx, dy

            # The label sits beside the prospective gap: at or just beyond
            # this end, near the wall's own line. A label behind the end or
            # far off-axis is annotating something else.
            lx, ly = label.x - ex, label.y - ey
            along_out = lx * ddx + ly * ddy
            beside = abs(-lx * ddy + ly * ddx)
            if not (-0.5 <= along_out <= MAX_LABELLED_GAP) or beside > 1.5:
                continue

            for j, other in enumerate(walls):
                if j == i:
                    continue
                on = other.length
                if on < 1e-9:
                    continue
                odx, ody = (other.bx - other.ax) / on, (other.by - other.ay) / on
                # Crossings only. A parallel wall ahead is the collinear
                # case, and it is already handled — reaching it from here
                # would bridge the same gap twice with two geometries.
                if abs(odx * ddx + ody * ddy) > 0.7:
                    continue
                denom = ddx * ody - ddy * odx
                if abs(denom) < 1e-9:
                    continue
                rx, ry = other.ax - ex, other.ay - ey
                t = (rx * ody - ry * odx) / denom     # metres along the extension
                u = (rx * ddy - ry * ddx) / denom     # metres along the other wall
                gap = t - other.thickness / 2         # clear doorway width
                if not (MIN_LABELLED_GAP <= gap <= MAX_LABELLED_GAP):
                    continue
                if u < -COLLINEAR_TOLERANCE or u > on + COLLINEAR_TOLERANCE:
                    continue
                mid = (ex + ddx * t / 2, ey + ddy * t / 2)
                label_distance = math.hypot(label.x - mid[0], label.y - mid[1])
                if label_distance > LABEL_RADIUS:
                    continue
                candidate = (label_distance, i, end, (ex + ddx * t, ey + ddy * t), gap)
                if best is None or label_distance < best[0]:
                    best = candidate
    return best


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
            # Doors only: a window is never a breach in the room graph, so a
            # wrong extension for one risks geometry to fix nothing.
            extension = _end_gap_candidate(label, walls) if kind == 'door' else None
            if extension is not None:
                _dist, i, end, hit, gap = extension
                wall = walls[i]
                ex, ey = (wall.ax, wall.ay) if end == 'a' else (wall.bx, wall.by)
                if end == 'a':
                    walls[i] = replace(wall, ax=hit[0], ay=hit[1])
                else:
                    walls[i] = replace(wall, bx=hit[0], by=hit[1])
                # The wall now reaches the crossing wall's centreline, so the
                # corner joins and the room closes; the doorway itself is kept
                # as an opening centred on the clear gap, and solidify cuts it
                # back out. Extension to the centreline, opening over the
                # clear width: the sliver inside the crossing wall's own
                # thickness is the jamb, and it stays solid.
                run = math.hypot(hit[0] - ex, hit[1] - ey) or 1.0
                mx = ex + (hit[0] - ex) / run * (gap / 2)
                my = ey + (hit[1] - ey) / run * (gap / 2)
                pending.append((kind, mx, my, gap, 0.9))
                continue
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


def from_sized_blocks(
    placements, walls, guess_item, issues: list[dict] | None = None,
) -> tuple[list[Opening], int]:
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
        # The block name carries the leaf width in millimetres. Trust it over
        # any measurement: it is what the architect specified.
        width = name_width or (0.9 if item == "door" else 1.2)
        index, along = host(px, py, walls)
        if index is None:
            unhosted += 1
            if issues is not None:
                issues.append({
                    "source": "blockSized",
                    "block": placement["block"],
                    "kind": item,
                    "position": {"x": round(px, 4), "y": round(py, 4)},
                    "width": round(width, 4),
                    "rotation": round(float(placement.get("rotation", 0.0)), 6),
                    "reason": "no-wall-within-host-radius",
                    "hostRadius": HOST_RADIUS,
                    "nearestWallDistance": (
                        round(distance, 4)
                        if (distance := _nearest_wall_distance(px, py, walls)) is not None
                        else None
                    ),
                })
            continue

        wall = walls[index]
        # Clamp rather than reject. A door 3 cm past the end of a wall is a
        # trimming artefact, not a different door.
        along = max(END_MARGIN + width / 2, min(wall.length - END_MARGIN - width / 2, along))
        if wall.length < width + 2 * END_MARGIN:
            unhosted += 1
            if issues is not None:
                issues.append({
                    "source": "blockSized",
                    "block": placement["block"],
                    "kind": item,
                    "position": {"x": round(px, 4), "y": round(py, 4)},
                    "width": round(width, 4),
                    "rotation": round(float(placement.get("rotation", 0.0)), 6),
                    "reason": "host-wall-too-short",
                    "hostWall": index,
                    "hostWallLength": round(wall.length, 4),
                    "nearestWallDistance": round(_nearest_wall_distance(px, py, walls) or 0.0, 4),
                })
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


#: A layer whose NAME says it carries openings.
#:
#: The name pre-selects and never decides, which is the same rule walls and
#: plan titles already follow here — what decides is whether the linework on it
#: runs along a wall.
_OPENING_LAYER = re.compile(r"door|window|shutter|ventilator|glaz", re.I)
#: Only what `_OPENING_LAYER` above already admits. An abbreviation here that
#: the gate does not carry is dead code shaped like a feature — `\bdr\b` sat
#: here briefly and could never fire, because a layer called `DR` never reaches
#: this line. `DR` is deliberately not admitted: it is as often "drawing" or
#: "drain" as it is "door", and the gate must not open on a coin toss.
_DOOR_WORD = re.compile(r"door", re.I)
#: `WIN` as a whole word counts. `A4 DOOR WIN` is a real layer name in this
#: corpus — `classify/elements.py` records it too — and reading it as a door
#: layer because only the word "door" spelt itself out in full would take a
#: layer that says it holds both kinds and silently call all of it doors.
#: Bounded, so it cannot fire on `WINDING` or a block called `TWIN`.
_WINDOW_WORD = re.compile(r"window|\bwin\b|glaz", re.I)

#: How far a segment's direction may differ from its host wall's and still be
#: read as running ALONG that wall, in degrees.
#:
#: This is what separates a window's glazing lines from the tick that crosses
#: the opening, and it is a geometric test rather than a length threshold on
#: purpose. Measured on `SITE PLAN FOR 3D`: each of the 15 window symbols on
#: `WINDOW1` is two 2.00 m lines running along the wall, 0.23 m apart — which
#: is the wall's own thickness — plus one 0.60 m line across it. A minimum-width
#: rule would have had to separate 0.60 from 2.00 by size and would then reject
#: every genuine 600 mm ventilator; the angle separates them by what they ARE.
#:
#: Generous at 20 degrees because a drawn symbol is not always square to its
#: wall, and because the alternative reading — a line at 45 degrees to a wall is
#: a glazing line — is not available at any tolerance below 45.
PARALLEL_TOLERANCE_DEG = 20.0


def is_opening_layer(layer: str) -> bool:
    """
    Does this layer's name claim to hold openings, whichever kind?

    Separate from `opening_layer_kind` so a caller can select the linework
    BEFORE the kind is decided. Selecting on the kind instead would drop a
    layer naming both doors and windows on the floor silently — the emitter
    would never see it and so could never record that it refused it, and the
    reviewer would be told nothing rather than told why.
    """
    return bool(_OPENING_LAYER.search(layer or ""))


def opening_layer_kind(layer: str) -> str | None:
    """
    'door', 'window', or None — and None ALSO for a layer naming both.

    A layer called `A4 DOOR WIN` carries both kinds and its name cannot say
    which any one segment is. Guessing from the width was considered and
    refused: a 900 mm opening is a door in one drawing and a window in the
    next, so the guess would be right often enough to be trusted and wrong
    often enough to matter. The caller records the refusal instead, and a
    reviewer who knows the drawing can split the layer.
    """
    if not _OPENING_LAYER.search(layer or ""):
        return None
    door, window = bool(_DOOR_WORD.search(layer)), bool(_WINDOW_WORD.search(layer))
    if door and window:
        return None
    return "door" if door else "window"


def host_along(segment, walls, radius: float = HOST_RADIUS):
    """
    The nearest wall this SEGMENT runs along, or (None, ...) if there is none.

    ── Why orientation has to be part of choosing the wall ────────────────────
    `host()` answers a different question and answers it correctly: given a
    POINT, which wall is nearest. A block placement is a point and has no
    direction to offer, so that is all there is to go on.

    A segment does have a direction, and leaving it out of the choice was
    measured to be wrong. First cut of this emitter hosted the segment's
    midpoint with `host()` and only afterwards asked whether the result ran
    along the chosen wall. On `SITE PLAN FOR 3D` frame 2 — 15 window symbols,
    each a 2.00 m glazing run plus a 0.60 m tick across it — that produced 13
    windows of 0.60 m and 5 of 2.00 m, against a truth of 15 of 2.00 m. In a
    dense run of walls the nearest wall to a symbol's midpoint is frequently a
    PERPENDICULAR partition, and against that wall the tick looks like a
    glazing line and the glazing line looks like a tick. Every judgement after
    the wrong host is then confidently backwards.

    So parallelism filters the candidates instead of grading the winner. The
    segment's own direction is evidence about which wall it belongs to, and it
    is the only evidence that distinguishes these two cases at all.
    """
    best_index, best_along, best_perp = None, 0.0, radius
    for i, wall in enumerate(walls):
        if not _runs_along(segment, wall):
            continue
        along, perp = _project(
            (segment.ax + segment.bx) / 2, (segment.ay + segment.by) / 2, wall,
        )
        if perp < best_perp:
            best_index, best_along, best_perp = i, along, perp
    return best_index, best_along


def _along_range(segment, wall) -> tuple[float, float]:
    """Where a segment starts and ends, measured along its host wall."""
    lo, _ = _project(segment.ax, segment.ay, wall)
    hi, _ = _project(segment.bx, segment.by, wall)
    return (lo, hi) if lo <= hi else (hi, lo)


class _RunLabel:
    """A stand-in label at an opening run's midpoint.

    `_gap_candidate` asks a label only for `.x` and `.y`, so the run's own
    midpoint can play the part. The evidence is at least as good as a text
    label's: a `D750` written beside a gap says an opening is there, and a
    2 m window run drawn IN the gap says the same thing with geometry.
    """

    __slots__ = ("x", "y")

    def __init__(self, x: float, y: float):
        self.x, self.y = x, y


def bridge_opening_runs(segments, walls, issues: list[dict] | None = None):
    """
    Close a wall gap that an opening's own linework is sitting in.

    ── The shape this exists for, measured ────────────────────────────────────
    An opening is often drawn as a GAP in the wall run rather than as a symbol
    over a continuous wall. On `SITE PLAN FOR 3D` frame 2 a window runs
    x=2690.13 from y=237.95 to y=239.95, and the wall linework has a stub
    ending at y=237.95 and another starting at y=239.95 — collinear with it,
    touching both endpoints exactly. The window IS the gap.

    Nothing downstream could host it. There is no wall at the opening's
    midpoint by construction, and every host test here works from the midpoint.
    The wall above is 5.71 m long and begins 1.00 m from that midpoint, which
    loses to `HOST_RADIUS` of 0.9 by ten centimetres — so the failure looked
    like a tolerance and was not one. Widening the radius would have hosted the
    window on a wall it does not sit in.

    ── Why this runs before the rooms are solved ──────────────────────────────
    Bridging changes GEOMETRY, and `detect_spaces`, the wall statistics and the
    bill all read that geometry. `from_text_labels` already bridges and already
    runs before room detection for exactly this reason; this is placed beside
    it. Bridging later — from inside the emitter, where it would have been
    convenient — would leave the rooms solved against a wall run that no longer
    exists, and every artefact would look correct on its own.

    Returns the walls (a new list) and the bridges made.
    """
    walls = list(walls)
    bridged: list[dict] = []

    # Longest first. A window's own 2 m run should claim the gap before a 0.6 m
    # ventilator elsewhere gets a chance at it, and once a gap is closed the
    # shorter runs simply host on the merged wall instead of bridging again.
    ordered = sorted(
        (s for s in segments if opening_layer_kind(getattr(s, "layer", "") or "")),
        key=lambda s: -math.hypot(s.bx - s.ax, s.by - s.ay),
    )

    for segment in ordered:
        if host_along(segment, walls)[0] is not None:
            continue                      # its wall is intact; nothing to close

        run = math.hypot(segment.bx - segment.ax, segment.by - segment.ay)
        label = _RunLabel((segment.ax + segment.bx) / 2,
                          (segment.ay + segment.by) / 2)

        best = None
        for i, first in enumerate(walls):
            for j in range(i + 1, len(walls)):
                found = _gap_candidate(label, first, walls[j])
                if found is not None and (best is None or found[0] < best[0][0]):
                    best = (found, i, j)
        if best is None:
            continue

        (distance, gap, midpoint, merged), i, j = best
        first, second = walls[i], walls[j]

        # The gap has to be the one this run is lying in, not merely the
        # nearest gap in the drawing. A run is drawn on a wall FACE while the
        # gap is measured between CENTRELINES, so the two differ by up to a
        # wall thickness — 2.00 against 2.116 on the measured case — and by no
        # more than that. Without this a 0.60 m ventilator would happily close
        # a 2 m doorway several metres away and report it as its own.
        slack = max(first.thickness, second.thickness)
        if not (run - slack <= gap <= run + slack):
            if issues is not None:
                issues.append({
                    "source": "openingLayer",
                    "reason": "gap-does-not-match-run",
                    "position": {"x": round(label.x, 4), "y": round(label.y, 4)},
                    "runLength": round(run, 4),
                    "gap": round(gap, 4),
                })
            continue

        replacement = type(first)(
            ax=merged[0], ay=merged[1], bx=merged[2], by=merged[3],
            thickness=max(first.thickness, second.thickness),
            paired=first.paired or second.paired,
            confidence=min(first.confidence, second.confidence, 0.88),
            layer="<bridged:opening-linework>",
        )
        walls = [w for k, w in enumerate(walls) if k not in (i, j)]
        walls.append(replacement)
        bridged.append({
            "position": {"x": round(midpoint[0], 4), "y": round(midpoint[1], 4)},
            "gap": round(gap, 4),
            "runLength": round(run, 4),
            "labelDistance": round(distance, 4),
        })

    return walls, bridged


def from_opening_layers(
    segments, walls, issues: list[dict] | None = None,
) -> tuple[list[Opening], int]:
    """
    Openings from linework on a layer whose name mentions doors or windows.

    The third emitter, and the one for drawings that DRAW their openings rather
    than blocking them. Coarser than `from_sized_blocks`, because the drawing
    states no width — the width is measured off the linework instead of read
    off a block name.

    ── How a scatter of lines becomes one opening ─────────────────────────────
    Project every segment onto the wall it hosts on, then merge the ranges that
    overlap. A window drawn as two parallel glazing lines 0.23 m apart projects
    both of them onto the SAME 2.00 m stretch of the same wall, so they merge
    without any clustering rule about how close two lines have to be — the wall
    does that work, and it is the one piece of geometry both lines already agree
    about.

    That is also why this does not cluster in free space first. Two windows on
    opposite faces of one 0.23 m partition are 0.23 m apart and would merge
    under any proximity rule loose enough to join a single window's own lines;
    projected, they land on the same wall at DIFFERENT positions and stay two.

    Returns the openings and the count that could not be hosted, the same
    contract as the other emitters.
    """
    out: list[Opening] = []
    unhosted = 0
    runs: dict[tuple[int, str], list[list[float]]] = {}

    for segment in segments:
        layer = getattr(segment, "layer", "") or ""
        # Before the kind test, because a refusal needs somewhere to point at
        # just as much as an acceptance does. Every issue this module raises
        # carries a position: `cli.py` copies it into `registeredPosition`
        # unguarded, so one without a position does not degrade the review
        # payload, it ends the build.
        mx, my = (segment.ax + segment.bx) / 2, (segment.ay + segment.by) / 2

        kind = opening_layer_kind(layer)
        if kind is None:
            if _OPENING_LAYER.search(layer) and issues is not None:
                issues.append({
                    "source": "openingLayer",
                    "layer": layer,
                    "position": {"x": round(mx, 4), "y": round(my, 4)},
                    "reason": "layer-names-both-door-and-window",
                })
            continue
        index, _ = host_along(segment, walls)
        if index is None:
            # No wall near enough that this segment runs along. Two different
            # things land here and they are told apart by whether ANY wall was
            # close: a genuine opening whose wall was never reconstructed, and
            # linework that only crosses walls — the tick through an opening,
            # a hinge arc's chord, a dimension witness line.
            #
            # Only the first is counted as unhosted. The second is not an
            # opening that was lost; it was never an opening run. Both are
            # recorded, so a drawing whose symbols this misreads shows up as a
            # pile of refusals rather than as silence.
            near = _nearest_wall_distance(mx, my, walls)
            crossing = near is not None and near <= HOST_RADIUS
            if not crossing:
                unhosted += 1
            if issues is not None:
                issues.append({
                    "source": "openingLayer",
                    "layer": layer,
                    "kind": kind,
                    "position": {"x": round(mx, 4), "y": round(my, 4)},
                    "reason": ("crosses-walls-but-runs-along-none" if crossing
                               else "no-wall-within-host-radius"),
                    "hostRadius": HOST_RADIUS,
                    "nearestWallDistance": round(near, 4) if near is not None else None,
                })
            continue

        wall = walls[index]
        runs.setdefault((index, kind), []).append(list(_along_range(segment, wall)))

    def _point_on(wall, distance: float) -> dict:
        """A point this far along a wall, for a refusal that has no segment.

        Every opening issue carries a position — `cli.py` reads it unguarded
        when it builds the review payload, and the two refusals below are
        raised against a MERGED run rather than one segment, so they have no
        position of their own to hand over. Computing one from the wall keeps
        the contract the other emitters already meet; omitting it raised a
        KeyError in `reconstruct` the first time a run was too wide.
        """
        length = wall.length or 1.0
        ux, uy = (wall.bx - wall.ax) / length, (wall.by - wall.ay) / length
        return {"x": round(wall.ax + ux * distance, 4),
                "y": round(wall.ay + uy * distance, 4)}

    for (index, kind), ranges in runs.items():
        wall = walls[index]
        ranges.sort()
        merged: list[list[float]] = []
        for lo, hi in ranges:
            if merged and lo <= merged[-1][1] + COLLINEAR_TOLERANCE:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])

        for lo, hi in merged:
            width = hi - lo
            if not MIN_LABELLED_GAP <= width <= MAX_LABELLED_GAP:
                # The same plausibility band the text-label emitter uses, and
                # deliberately shared rather than re-chosen: two emitters
                # disagreeing about what width is a believable opening is how a
                # drawing ends up with a door the schedule will not accept.
                if issues is not None:
                    issues.append({
                        "source": "openingLayer",
                        "kind": kind,
                        "reason": "implausible-width",
                        "position": _point_on(wall, (lo + hi) / 2),
                        "width": round(width, 4),
                        "band": [MIN_LABELLED_GAP, MAX_LABELLED_GAP],
                        "hostWall": index,
                    })
                continue
            if wall.length < width + 2 * END_MARGIN:
                # A run wider than the wall it landed on is not an opening in
                # that wall. `from_sized_blocks` has always refused this and
                # this emitter did not, which mattered more here than there:
                # linework hosts by the run's MIDPOINT, so a 2.00 m run whose
                # wall is interrupted can settle on a 0.52 m stub beside the
                # gap. The clamp below would then "place" a 2 m window on a
                # 0.5 m wall, at a position outside the wall entirely, and
                # nothing downstream would question it.
                if issues is not None:
                    issues.append({
                        "source": "openingLayer",
                        "kind": kind,
                        "reason": "host-wall-too-short",
                        "position": _point_on(wall, (lo + hi) / 2),
                        "width": round(width, 4),
                        "hostWall": index,
                        "hostWallLength": round(wall.length, 4),
                    })
                continue
            along = max(END_MARGIN + width / 2,
                        min(wall.length - END_MARGIN - width / 2, (lo + hi) / 2))
            out.append(Opening(
                kind=kind,
                wall=index,
                along=along,
                width=width,
                height=DOOR_HEIGHT if kind == "door" else WINDOW_HEIGHT,
                sill=DOOR_SILL if kind == "door" else WINDOW_SILL,
                source="openingLayer",
                # Below the 0.92 a sized block earns. That block name is the
                # architect stating a width; this is a width measured off two
                # lines that might be a symbol's outline rather than its leaf.
                confidence=0.7,
            ))

    return out, unhosted


def _runs_along(segment, wall) -> bool:
    """Is this segment parallel to its host wall, within tolerance?"""
    sx, sy = segment.bx - segment.ax, segment.by - segment.ay
    wx, wy = wall.bx - wall.ax, wall.by - wall.ay
    if (sx or sy) == 0 or (wx or wy) == 0:
        return False
    seg_len, wall_len = math.hypot(sx, sy), math.hypot(wx, wy)
    if seg_len == 0 or wall_len == 0:
        return False
    # |cos| so that direction does not matter — a line drawn right-to-left is
    # the same line.
    cos = abs((sx * wx + sy * wy) / (seg_len * wall_len))
    return cos >= math.cos(math.radians(PARALLEL_TOLERANCE_DEG))


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
