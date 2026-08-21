"""
Turning drawn linework into walls.

── Why this stage exists at all ──────────────────────────────────────────────
A wall on a drawing is not a line. It is *two* lines — the faces where the wall
meets the air on either side — and the thing you want to build is the space
between them. Extruding the faces directly gives you two paper-thin walls with a
void down the middle, which looks almost right until the first door reveal.

So faces are paired, and the pair collapses to a centreline whose thickness is
*measured* rather than assumed. On a real drawing that comes back as 0.238 m for
a nine-inch brick wall — which is the number the architect drew, not one we
picked.

── And why corner-joining is not optional ────────────────────────────────────
The centreline is trimmed to where the two faces overlap. That is correct — one
face runs past a doorway the other stops at, and averaging raw endpoints invents
wall that was never drawn. But it leaves every wall about half a thickness short
at each corner, so the walls render perfectly and enclose nothing. Rooms are
derived as closed cycles, and a plan full of near-misses has no cycles at all.
`join_corners` extends each end to where it actually meets its neighbour.

── Ported, not reinvented ────────────────────────────────────────────────────
This is a faithful port of `apps/studio/src/plan/detections.ts` — same constants,
same greedy longest-first order, same maths — with one change the source itself
invites: its own comment scopes the O(n²) scan to "a few hundred segments", and a
real DWG carries thousands. The candidate query goes through an STRtree; every
decision after that is identical, which is what the golden-fixture parity test
between the two implementations is for.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

# ---- Constants, matched to detections.ts:124 --------------------------------

#: Faces further apart than this are different walls, not two sides of one.
#: Half a metre is thicker than any partition and thinner than a room.
MAX_WALL_THICKNESS = 0.5
#: Below this, two lines are the same drawn stroke rather than a wall.
MIN_WALL_THICKNESS = 0.04
#: Shorter than this and it is a dimension tick or a letter.
MIN_LENGTH = 0.35
#: How parallel two faces must be to pair.
ANGLE_TOLERANCE_DEG = 6.0
#: How far a wall end may be extended to meet a neighbour.
CORNER_TOLERANCE = 0.6
#: Two walls closer to parallel than this have no meaningful crossing — forcing
#: one puts the corner far off down the drawing.
CORNER_PARALLEL_SKIP_DEG = 25.0

#: Used when a face never finds a partner. See `paired=False` below: an unpaired
#: line is more likely a railing than a wall, and the flag is what lets a later
#: stage decide that rather than silently extruding a balcony into a sealed box.
DEFAULT_THICKNESS = 0.115


@dataclass
class Wall:
    ax: float
    ay: float
    bx: float
    by: float
    thickness: float
    paired: bool
    confidence: float
    layer: str = ""
    #: Metres of this wall that lie on top of another wall already in the model.
    #: Zero for anything read off a drawing. Non-zero only for a derived
    #: perimeter, which is emitted whole because the geometry needs the closed
    #: ring — see hypothesise/perimeter.py. Anything QUANTIFYING wall length
    #: must subtract this, or it bills the same masonry twice.
    duplicate: float = 0.0

    @property
    def length(self) -> float:
        return math.hypot(self.bx - self.ax, self.by - self.ay)

    def as_dict(self) -> dict:
        return {
            "a": {"x": round(self.ax, 4), "y": round(self.ay, 4)},
            "b": {"x": round(self.bx, 4), "y": round(self.by, 4)},
            "thickness": round(self.thickness, 4),
            "paired": self.paired,
            "confidence": round(self.confidence, 3),
            "layer": self.layer,
            "duplicate": round(self.duplicate, 4),
        }


@dataclass
class Face:
    """One drawn line, before we know what it is part of."""

    ax: float
    ay: float
    bx: float
    by: float
    layer: str = ""
    confidence: float = 1.0

    @property
    def length(self) -> float:
        return math.hypot(self.bx - self.ax, self.by - self.ay)


# ---- Vector helpers ---------------------------------------------------------


def _direction(f: Face) -> tuple[float, float]:
    dx, dy = f.bx - f.ax, f.by - f.ay
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def _is_parallel(p: Face, q: Face, tolerance_deg: float) -> bool:
    px, py = _direction(p)
    qx, qy = _direction(q)
    # Absolute value: a face drawn the other way round is still the same wall.
    return abs(px * qx + py * qy) >= math.cos(math.radians(tolerance_deg))


def _perpendicular_gap(p: Face, q: Face) -> float:
    """Distance from q's midpoint to p's infinite line."""
    mx, my = (q.ax + q.bx) / 2, (q.ay + q.by) / 2
    dx, dy = _direction(p)
    along = (mx - p.ax) * dx + (my - p.ay) * dy
    return math.hypot(mx - (p.ax + dx * along), my - (p.ay + dy * along))


def _project_range(p: Face, q: Face) -> tuple[list[float], list[float]]:
    dx, dy = _direction(p)

    def proj(x, y):
        return (x - p.ax) * dx + (y - p.ay) * dy

    return (
        sorted([proj(p.ax, p.ay), proj(p.bx, p.by)]),
        sorted([proj(q.ax, q.ay), proj(q.bx, q.by)]),
    )


def _overlap_along(p: Face, q: Face) -> float:
    pr, qr = _project_range(p, q)
    return max(0.0, min(pr[1], qr[1]) - max(pr[0], qr[0]))


def _centreline(p: Face, q: Face, gap: float) -> Wall:
    """
    Collapse two faces to the wall between them.

    Trimmed to the *overlapping* part — see the module docstring. Averaging raw
    endpoints gives a wall that is half real and half invented.
    """
    dx, dy = _direction(p)
    pr, qr = _project_range(p, q)
    start, end = max(pr[0], qr[0]), min(pr[1], qr[1])

    mx, my = (q.ax + q.bx) / 2, (q.ay + q.by) / 2
    along = (mx - p.ax) * dx + (my - p.ay) * dy
    ox, oy = mx - (p.ax + dx * along), my - (p.ay + dy * along)
    n = math.hypot(ox, oy) or 1.0
    sx, sy = (ox / n) * gap / 2, (oy / n) * gap / 2

    return Wall(
        ax=p.ax + dx * start + sx,
        ay=p.ay + dy * start + sy,
        bx=p.ax + dx * end + sx,
        by=p.ay + dy * end + sy,
        thickness=gap,
        paired=True,
        confidence=min(p.confidence, q.confidence),
        layer=p.layer,
    )


# ---- The two stages ---------------------------------------------------------


#: Two faces are the same drawn line if their directions agree this closely.
MERGE_ANGLE_DEG = 2.0
#: ...and they sit this close to each other's infinite line.
MERGE_OFFSET = 0.03
#: ...and the gap along that line is no wider than this.
#:
#: 1.5 m is deliberate: it is wider than any door or window leaf, and narrower
#: than any room. So a face interrupted by an opening rejoins, and two genuinely
#: separate walls that happen to line up across a room do not.
MERGE_GAP = 1.5


def merge_collinear(faces: list[Face]) -> list[Face]:
    """
    Reassemble a wall face that the drawing broke into pieces.

    ── Why this has to happen before the length filter ──────────────────────
    CAD linework is trimmed at every junction and every opening, so one side of
    a wall routinely arrives as five short pieces while the other side is a
    single unbroken line. Measured on a real drawing: 32% of wall-layer faces
    fell below the 0.35 m minimum and were discarded outright, and the long
    faces they should have paired with were then left with no partner.

    That failure is quiet and it compounds — unpaired walls do not enclose
    rooms, and rooms are what everything downstream is for. Merging first turns
    the fragments back into the face the architect drew, and the length filter
    then removes only what is genuinely too short to be a wall.

    Note that a face interrupted by a doorway is still ONE face. The doorway is
    not lost by merging: openings are detected separately and cut back out in
    `build/solidify.py`, which is the right order — you cannot host an opening
    on a wall that failed to form.
    """
    if not faces:
        return []

    # Group by (direction bin, perpendicular offset of the line from origin).
    # Two collinear faces share both, whichever way round they were drawn.
    buckets: dict[tuple, list[Face]] = {}
    for face in faces:
        if face.length < 1e-9:
            continue
        dx, dy = _direction(face)
        if dx < 0 or (abs(dx) < 1e-9 and dy < 0):
            dx, dy = -dx, -dy          # canonical direction
        angle = math.atan2(dy, dx)
        offset = -face.ax * dy + face.ay * dx      # signed distance to origin
        key = (
            face.layer,
            round(angle / math.radians(MERGE_ANGLE_DEG)),
            round(offset / MERGE_OFFSET),
        )
        buckets.setdefault(key, []).append(face)

    merged: list[Face] = []
    for group in buckets.values():
        if len(group) == 1:
            merged.append(group[0])
            continue

        dx, dy = _direction(group[0])
        origin = (group[0].ax, group[0].ay)

        def along(x, y):
            return (x - origin[0]) * dx + (y - origin[1]) * dy

        spans = sorted(
            (min(along(f.ax, f.ay), along(f.bx, f.by)),
             max(along(f.ax, f.ay), along(f.bx, f.by)))
            for f in group
        )

        runs: list[list[float]] = [list(spans[0])]
        for lo, hi in spans[1:]:
            if lo - runs[-1][1] <= MERGE_GAP:
                runs[-1][1] = max(runs[-1][1], hi)
            else:
                runs.append([lo, hi])

        for lo, hi in runs:
            merged.append(
                Face(
                    ax=origin[0] + dx * lo, ay=origin[1] + dy * lo,
                    bx=origin[0] + dx * hi, by=origin[1] + dy * hi,
                    layer=group[0].layer,
                    confidence=group[0].confidence,
                )
            )

    return merged


def pair_faces(faces: list[Face], merge: bool = True) -> list[Wall]:
    """
    Match faces into pairs and collapse each pair to a centreline.

    Greedy nearest-match, longest first. Two faces of one wall are dramatically
    closer to each other than to anything else, so greedy and optimal agree in
    practice; consuming the long, unambiguous walls first stops a short stub
    stealing one of their faces.
    """
    # Reassemble before filtering. Filtering first throws away the fragments
    # that would have made a long face pairable — see `merge_collinear`.
    if merge:
        faces = merge_collinear(faces)

    usable = [f for f in faces if f.length >= MIN_LENGTH]
    if not usable:
        return []

    geoms = [LineString([(f.ax, f.ay), (f.bx, f.by)]) for f in usable]
    tree = STRtree(geoms)

    order = sorted(range(len(usable)), key=lambda i: -usable[i].length)
    used: set[int] = set()
    walls: list[Wall] = []

    for i in order:
        if i in used:
            continue
        segment = usable[i]

        # Only segments whose envelope comes within a wall thickness can be the
        # other face. Everything the O(n^2) version tested and rejected on the
        # gap check is simply never visited.
        candidates = tree.query(geoms[i].buffer(MAX_WALL_THICKNESS, resolution=1))

        best_index: int | None = None
        best_gap = float("inf")

        for j in candidates:
            j = int(j)
            if j == i or j in used:
                continue
            other = usable[j]

            if not _is_parallel(segment, other, ANGLE_TOLERANCE_DEG):
                continue

            gap = _perpendicular_gap(segment, other)
            if gap < MIN_WALL_THICKNESS or gap > MAX_WALL_THICKNESS:
                continue

            # Two parallel segments at opposite ends of the building are also
            # "parallel and 0.2 m apart" in the perpendicular sense. Overlap
            # along the shared direction is what actually tells them apart.
            if _overlap_along(segment, other) < MIN_LENGTH:
                continue

            if gap < best_gap:
                best_index, best_gap = j, gap

        used.add(i)
        if best_index is not None:
            used.add(best_index)
            walls.append(_centreline(segment, usable[best_index], best_gap))
        else:
            # Kept, but flagged. A single unpaired line is usually a railing,
            # and extruding one to ceiling height turns a balcony into a sealed
            # box that blacks out the rooms behind it.
            walls.append(
                Wall(
                    ax=segment.ax, ay=segment.ay, bx=segment.bx, by=segment.by,
                    thickness=DEFAULT_THICKNESS, paired=False,
                    confidence=segment.confidence * 0.4, layer=segment.layer,
                )
            )

    return walls


def _line_intersection(w: Wall, o: Wall) -> tuple[float, float] | None:
    rx, ry = w.bx - w.ax, w.by - w.ay
    sx, sy = o.bx - o.ax, o.by - o.ay
    denom = rx * sy - ry * sx
    if abs(denom) < 1e-12:
        return None
    ox, oy = o.ax - w.ax, o.ay - w.ay
    t = (ox * sy - oy * sx) / denom
    return w.ax + rx * t, w.ay + ry * t


def _distance_to_segment(px: float, py: float, w: Wall) -> float:
    dx, dy = w.bx - w.ax, w.by - w.ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - w.ax, py - w.ay)
    t = max(0.0, min(1.0, ((px - w.ax) * dx + (py - w.ay) * dy) / length_sq))
    return math.hypot(px - (w.ax + dx * t), py - (w.ay + dy * t))


def join_corners(walls: list[Wall], tolerance: float = CORNER_TOLERANCE) -> list[Wall]:
    """
    Extend each wall end to where it actually meets its neighbour.

    Without this the walls are each about half a thickness short at every corner
    and the plan has no closed cycles, so it derives no rooms — see the module
    docstring. This is the step whose absence makes a perfect-looking drawing
    produce a building with no interior.
    """
    if not walls:
        return []

    out = [
        Wall(w.ax, w.ay, w.bx, w.by, w.thickness, w.paired, w.confidence, w.layer)
        for w in walls
    ]
    geoms = [LineString([(w.ax, w.ay), (w.bx, w.by)]) for w in out]
    tree = STRtree(geoms)

    for index, wall in enumerate(out):
        for end in ("a", "b"):
            px = wall.ax if end == "a" else wall.bx
            py = wall.ay if end == "a" else wall.by

            # The crossing must be within `tolerance` of this end AND within
            # `tolerance` of the other wall, so the other wall can be at most
            # 2 * tolerance away from the end point.
            candidates = tree.query(Point(px, py).buffer(tolerance * 2, resolution=1))

            best: tuple[float, float] | None = None
            best_reach = tolerance

            for j in candidates:
                j = int(j)
                if j == index:
                    continue
                other = out[j]

                # Only corners. Two near-parallel walls have no meaningful
                # crossing and forcing one puts the point off down the drawing.
                if _is_parallel(
                    Face(wall.ax, wall.ay, wall.bx, wall.by),
                    Face(other.ax, other.ay, other.bx, other.by),
                    CORNER_PARALLEL_SKIP_DEG,
                ):
                    continue

                crossing = _line_intersection(wall, other)
                if crossing is None:
                    continue

                reach = math.hypot(crossing[0] - px, crossing[1] - py)
                if reach > best_reach:
                    continue

                # And it has to be on, or just past, the other wall — not out in
                # space where its infinite line happens to pass.
                if _distance_to_segment(crossing[0], crossing[1], other) > tolerance:
                    continue

                best, best_reach = crossing, reach

            if best is not None:
                if end == "a":
                    wall.ax, wall.ay = best
                else:
                    wall.bx, wall.by = best

    return out


def summarise(walls: list[Wall]) -> dict:
    """What the user is being asked to accept."""
    paired = [w for w in walls if w.paired]
    thicknesses = sorted(round(w.thickness, 3) for w in paired)
    duplicated = sum(w.duplicate for w in walls)
    gross = sum(w.length for w in walls)
    return {
        "total": len(walls),
        "paired": len(paired),
        # `totalLength` is what exists as geometry. `billableLength` is what may
        # be charged for — the derived perimeter is emitted whole so the rooms
        # close, and most of it lies on walls already counted.
        "billableLength": round(gross - duplicated, 2),
        "duplicateLength": round(duplicated, 2),
        "unpaired": len(walls) - len(paired),
        "totalLength": round(sum(w.length for w in walls), 2),
        "medianThickness": thicknesses[len(thicknesses) // 2] if thicknesses else None,
        "thicknessRange": [thicknesses[0], thicknesses[-1]] if thicknesses else None,
    }
