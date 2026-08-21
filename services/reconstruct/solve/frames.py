"""
Separating the drawings on a sheet.

── The problem, measured ─────────────────────────────────────────────────────
An architect's DXF is a *sheet*, not a building. One real file named "DOWN VILLA"
spans 1,525 m: the villa, its site plan, the compound wall, and whatever else was
pasted alongside. Another, "ALL PLANS", holds five villa types at once.

Reconstructing that as one building produces geometry that is technically correct
and completely useless — a wall graph with no closed cycles, so no rooms; a floor
area summed across five buildings; a camera solver framing empty space between
them. Worse, every one of those failures looks like a bug somewhere else.

So this runs first, and everything downstream operates on exactly one frame.

── How ───────────────────────────────────────────────────────────────────────
Connected components over wall bounding boxes expanded by a gutter. Two walls in
the same building are, at most, a room apart; two walls in different drawings on
a sheet are separated by the white space a draughtsman leaves between them, which
is far larger.

Deliberately *not* clustering on midpoints. A long compound wall's midpoint can
sit in the gap between two plans and stitch them together — the same trap
`detectionQuality.ts` records, where midpoint clustering merged drawings that
extents kept apart.

The gutter is the only parameter and it is forgiving: anything from about 2 m to
8 m gives the same answer on real sheets, because the gap between plans is tens
of metres and the gap within a plan is under one.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely.geometry import box
from shapely.strtree import STRtree

#: Walls whose expanded boxes touch belong to the same drawing. Larger than any
#: room, far smaller than the white space between plans on a sheet.
DEFAULT_GUTTER = 3.0

#: A cluster with fewer walls than this is a title block, a north arrow, or a
#: detail callout, not a plan.
MIN_WALLS = 8


@dataclass
class Frame:
    index: int
    wall_indices: list[int]
    bbox: tuple[float, float, float, float]

    @property
    def width(self) -> float:
        return self.bbox[2] - self.bbox[0]

    @property
    def height(self) -> float:
        return self.bbox[3] - self.bbox[1]

    @property
    def span(self) -> float:
        return max(self.width, self.height)

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "walls": len(self.wall_indices),
            "bbox": [round(v, 2) for v in self.bbox],
            "span": round(self.span, 2),
        }


def segment_frames(walls, gutter: float = DEFAULT_GUTTER,
                   min_walls: int = MIN_WALLS) -> list[Frame]:
    """
    Group walls into the separate drawings they belong to.

    Returned largest-first by wall count, so `frames[0]` is the main plan on the
    sheet — which is the right default and, importantly, a *stated* one rather
    than whichever drawing happened to be first in the file.
    """
    if not walls:
        return []

    boxes = []
    for w in walls:
        x0, x1 = sorted((w.ax, w.bx))
        y0, y1 = sorted((w.ay, w.by))
        boxes.append(box(x0 - gutter, y0 - gutter, x1 + gutter, y1 + gutter))

    tree = STRtree(boxes)

    # Union-find over touching expanded boxes.
    parent = list(range(len(walls)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i, geom in enumerate(boxes):
        for j in tree.query(geom):
            j = int(j)
            if j != i:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(len(walls)):
        groups.setdefault(find(i), []).append(i)

    frames: list[Frame] = []
    for members in groups.values():
        if len(members) < min_walls:
            continue
        xs = [c for i in members for c in (walls[i].ax, walls[i].bx)]
        ys = [c for i in members for c in (walls[i].ay, walls[i].by)]
        frames.append(
            Frame(index=0, wall_indices=members, bbox=(min(xs), min(ys), max(xs), max(ys)))
        )

    frames.sort(key=lambda f: -len(f.wall_indices))
    for n, frame in enumerate(frames):
        frame.index = n
    return frames
