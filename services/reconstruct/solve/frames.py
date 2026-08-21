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

── Why the gutter alone is not enough ───────────────────────────────────────
That paragraph used to end "the gutter is forgiving: anything from about 2 m to
8 m gives the same answer, because the gap between plans is tens of metres and
the gap within a plan is under one". It was written from sheets where that held.
It is false, and the villa is the counter-example.

`DOWN VILLA -WD 22-1-24.dxf` draws the two storeys of one villa **2.477 m
apart** — not tens of metres. Worse, the gutter is added to *both* boxes, so the
effective merge distance is twice its value: at the default 3.0 m, anything
within 6.0 m merges. Every value in the range the docstring called safe merges
these two plans, and a gutter small enough to separate them (< 1.238 m) is
smaller than gaps that occur inside a single drawing.

The measured consequence: one 505 m2 "villa" that is really two 250 m2 storeys
stacked on one slab, 901 m of wall, and a bill of quantities for a building that
does not exist.

**No single gutter value can both keep a plan whole and separate two plans.**
So there is a second criterion, and it is not a tuned constant.

── The second criterion: a channel no wall crosses ──────────────────────────
Project every wall in a frame onto an axis and merge the intervals. A gap in
that projection is a band that **no wall crosses anywhere along the sheet** —
which is what a draughtsman's gutter between two drawings is, and what almost
nothing inside a single drawing is.

The distinction that makes this safe, and the reason it is a projection rather
than a search for empty rectangles: a courtyard, a corridor, an open-plan void —
none of them produce a gap, because walls elsewhere at the same y fill the band.
Only a strip with nothing across the *entire* width produces one, and a
connected plan with a perimeter cannot have one at all.

**Read that last clause carefully, because it is conditional and the condition
is not guaranteed.** It holds only while the perimeter is actually present in
`walls` — and `walls` is whatever survived the layer filter at `cli.py`, which
is a choice made per drawing and is documented as silently wrong-able. On a
sheet whose exterior is drawn as unpaired single lines (the villa is one), a
layer selection that keeps the partitions and drops the exterior leaves an input
that is *effectively* partitions-only without anyone having decided it should
be. So the limit below is reachable through layer selection, not only through
unusual buildings. Credit to a second pair of eyes for that one; it was stated
here as unconditional and it is not.

Two guards stop it over-splitting a partitions-only plan, which is the one shape
that can have a real projection gap:

  * both sides must hold at least `min_walls` walls, and
  * neither side may be a sliver of the parent's extent.

The first is what saves the villa's upper storey. It has a 7.73 m gap in x that
looks exactly like a gutter — and is one stray 0.8 m callout line sitting off to
the right. Splitting there leaves 1 wall on one side, so it is refused.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from shapely.geometry import box
from shapely.strtree import STRtree

#: Walls whose expanded boxes touch belong to the same drawing. Larger than any
#: room, far smaller than the white space between plans on a sheet.
DEFAULT_GUTTER = 3.0

#: A cluster with fewer walls than this is a title block, a north arrow, or a
#: detail callout, not a plan.
MIN_WALLS = 8

#: A frame is cut again at an empty projection band at least this wide.
#:
#: Measured, not chosen: the villa's two storeys are 2.477 m apart, and the
#: widest band inside either of them that survives the `min_walls` guard is far
#: under a metre. 1.5 m sits between the two with room on both sides. It is the
#: floor on a *gutter*, not a tuning knob for how eagerly to split — the guards
#: below do that work.
MIN_CHANNEL = 1.5

#: Neither side of a cut may be narrower than this, in METRES.
#:
#: ── Why this is absolute and not a fraction of the parent ──────────────────
#: It was `0.15 * parent extent`, and that is the wrong shape. A ratio makes the
#: bar for keeping a building whole depend on **how big its neighbour is**.
#: Measured: a 200 x 150 m site plan beside a real 20 x 25 m villa, 3 m clear,
#: 24 paired walls each side — the fraction refuses the cut and returns ONE
#: frame of 48 walls spanning the lot. `min_walls` passes throughout; the ratio
#: alone rejects it. The villa has to reach 20 x 30 m to survive being drawn
#: next to that site plan, which is not a property of the villa.
#:
#: Worse, the frame then reports its origin as "component" — "I looked and there
#: was nothing to cut" — which is the opposite of what happened.
#:
#: 2.0 m absolute keeps what the fraction was for: measured, 0.30 m dimension
#: ticks are still refused, while a 3 m detail and a 25 m villa are both cut
#: free. A drawing narrower than 2 m is not a drawing.
MIN_SIDE_EXTENT = 2.0


@dataclass
class Frame:
    index: int
    wall_indices: list[int]
    bbox: tuple[float, float, float, float]

    #: Every cut that produced this frame, outermost first — the frame's whole
    #: ancestry, not just the last thing that happened to it.
    #:
    #: ── Why this is a list, and why each entry carries a side ───────────────
    #: The first version of this was one string, overwritten at each level of
    #: the recursion. A frame cut twice reported only its most recent cut, and
    #: both children of a cut got the *identical* string — so nothing could say
    #: which half of the sheet a frame was. That is fine for a log line and
    #: useless for the thing that reads it next: storey registration has to know
    #: that two frames came from the same cut and which side each sat on.
    #:
    #: `side` is "low"/"high" along the cut axis, not "upper"/"lower" storey.
    #: **Where a plan sits on a sheet does not say which floor it is** — a
    #: draughtsman may put the first floor above or below the ground floor, and
    #: getting that backwards puts the lawn upstairs. The sheet position is
    #: evidence; it is not the answer.
    cuts: list[dict] = field(default_factory=list)

    #: What the drawing CALLS this frame — 'Ground Floor Plan'. Set by the
    #: caller, which is the only thing that has the sheet text; `frames.py` is
    #: pure geometry and stays that way.
    #:
    #: ── Measured, and it is the reason `cuts` says low/high ────────────────
    #: On the villa, the frame HIGHER on the sheet is titled 'Lower Ground Floor
    #: Plan' and the frame LOWER on the sheet is 'Ground Floor Plan'. Sheet
    #: position is INVERTED against storey order on that drawing. Anything that
    #: ordered storeys by where they sit on the paper would have put the ground
    #: floor above the lower ground floor — the lawn upstairs.
    #:
    #: So: geometry says which frames belong together; only the title says which
    #: one is underneath.
    title: str | None = None

    @property
    def origin(self) -> str:
        """
        How this frame came to be its own frame, in words.

        Derived rather than stored so it cannot drift from `cuts`. Carried into
        the model summary because a sheet silently becoming two plans is exactly
        the kind of change that should never be silent — the failure this file
        guards against looked like a correct reconstruction of a wrong building.
        """
        if not self.cuts:
            return "component"
        return "; ".join(
            f"cut at {c['axis']}={c['at']:.2f} across a {c['gap']:.2f} m "
            f"channel, {c['side']} side"
            for c in self.cuts
        )

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
            "origin": self.origin,
            "title": self.title,
            # The machine-readable form of the same thing. `origin` is for a
            # person reading a log; this is for the storey-registration step,
            # which needs to know that two frames share a cut and which side of
            # it each was on.
            "cuts": self.cuts,
        }


#: A backstop, and nothing else. It is NOT a limit on how many drawings a sheet
#: may hold.
#:
#: ── Why it used to be 4, and why 4 was wrong ───────────────────────────────
#: The comment said "four allows a 4x4 grid, which is more than any real drawing
#: set has needed". Both halves are false. `_split` takes the WIDEST channel at
#: each level, which is greedy and has no relation to balance, so the depth a
#: sheet needs is data-dependent up to n-1 — not ceil(log2 n). Depth 4
#: guarantees "at most 16 pieces", never "16 pieces": measured, five plans in a
#: row give five frames and **six give five**, with frames[0] holding TWO
#: BUILDINGS across a 34 m span. A 4x4 grid gives 11 frames, not 16.
#:
#: And the truncation is byte-identical to completion. The frame reports four
#: tidy cuts; nothing anywhere says the recursion ran out.
#:
#: Raising it is safe because **the cap was never doing the protective work.**
#: Termination is already guaranteed without it: a cut requires `min_walls` on
#: both sides and loses nothing, so every level strictly reduces the member
#: count by at least `min_walls`. Verified by an independent pass — at depth 64
#: a single plan still gives 1 frame, a plan plus a stray still gives 1, and a
#: sub-MIN_CHANNEL pair still gives 1. The over-split guards hold the line
#: alone; this only ever stopped legitimate cuts.
MAX_SPLIT_DEPTH = 64


def _span_on(wall, axis: str) -> tuple[float, float]:
    """One wall's extent along an axis, low end first."""
    if axis == "x":
        return min(wall.ax, wall.bx), max(wall.ax, wall.bx)
    return min(wall.ay, wall.by), max(wall.ay, wall.by)


def _widest_channel(walls, members, axis, min_walls, min_channel):
    """
    The widest band along `axis` that no wall crosses and that cuts `members`
    cleanly in two, as `(gap, cut, near, far)` — or None if there is no such
    band, which is the answer for a single drawing.
    """
    merged: list[list[float]] = []
    for lo, hi in sorted(_span_on(walls[i], axis) for i in members):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
            merged[-1][2] += 1
        else:
            merged.append([lo, hi, 1])   # lo, hi, how many walls support it

    # ── Islands of linework lying INSIDE a gutter ───────────────────────────
    # One line in the wrong place used to suppress a cut completely, and there
    # was no way to find out. Measured on the real villa: 2.38 m of line at
    # x=100, sitting wholly inside the 2.48 m channel between the two storeys
    # and touching neither plan, put both storeys back on one slab — the 505 m2
    # / 901 m building that does not exist, reinstated by 2.4 m of linework.
    #
    # The tell you would reach for does not exist. That frame's origin read
    # "cut at x=114.22 across a 5.55 m channel, low side", NOT "component": it
    # WAS cut, just not on the axis that mattered. `origin` can only describe
    # cuts that happened and can never mention one that was suppressed, so any
    # guard keyed on origin == "component" misses this entirely.
    #
    # So: an interval carrying less than a drawing's worth of wall, with less
    # than a channel's clearance on BOTH sides, is linework in a gutter rather
    # than a drawing in its own right. Drop it and let the gap either side join
    # up. The support count is what makes this safe — a genuinely small drawing
    # separated by real gutters keeps them, so it is kept.
    #
    # This is the same reasoning already applied to the 7.73 m x-gap, from the
    # other side: a lone line is not evidence that a channel exists, and it is
    # equally not evidence that one does not.
    kept: list[list[float]] = []
    for k, island in enumerate(merged):
        if 0 < k < len(merged) - 1 and island[2] < min_walls:
            before = island[0] - merged[k - 1][1]
            after = merged[k + 1][0] - island[1]
            if before < min_channel and after < min_channel:
                continue
        kept.append(island)
    merged = kept

    extent = merged[-1][1] - merged[0][0]
    if extent <= 0:
        return None

    best = None
    for k in range(len(merged) - 1):
        gap = merged[k + 1][0] - merged[k][1]
        if gap < min_channel:
            continue

        cut = (merged[k][1] + merged[k + 1][0]) / 2

        # Dropping an island means its walls now straddle the cut, so sides are
        # assigned by midpoint rather than by containment.
        near, far, straddling = [], [], 0
        for i in members:
            lo, hi = _span_on(walls[i], axis)
            if hi <= cut:
                near.append(i)
            elif lo >= cut:
                far.append(i)
            else:
                straddling += 1
                (near if (lo + hi) / 2 < cut else far).append(i)

        # Nothing may be lost. A wall that fell into neither list would vanish
        # from every frame, silently — a plan quietly missing one wall is the
        # exact failure this whole file exists to prevent.
        if len(near) + len(far) != len(members):
            continue

        # Only ORPHAN linework may cross. If a drawing's worth of wall spans the
        # band, it is not a gutter and the island pass has overreached.
        if straddling >= min_walls:
            continue

        # A drawing needs enough linework to be a drawing. This is the guard
        # that saves the villa's upper storey, which has a 7.73 m gap in x that
        # is one stray callout line sitting off to the right — a textbook
        # gutter by width, and 1 wall on the far side.
        if len(near) < min_walls or len(far) < min_walls:
            continue

        near_extent = merged[k][1] - merged[0][0]
        far_extent = merged[-1][1] - merged[k + 1][0]
        if min(near_extent, far_extent) < MIN_SIDE_EXTENT:
            continue

        if best is None or gap > best[0]:
            best = (gap, cut, near, far)

    return best


def _split(walls, members, min_walls, min_channel, cuts=(), depth=0):
    """
    Cut one cluster into the drawings it really contains, recursively.

    Returns `[(indices, cuts)]`, where `cuts` is the ordered ancestry of that
    piece — outermost cut first. The ancestry ACCUMULATES down the recursion
    rather than being replaced at each level; see `Frame.cuts` for why that
    matters to the step that reads it.
    """
    if depth >= MAX_SPLIT_DEPTH:
        return [(members, list(cuts))]

    best, best_axis = None, None
    for axis in ("x", "y"):
        found = _widest_channel(walls, members, axis, min_walls, min_channel)
        # Widest wins across both axes. A sheet laid out in a grid has channels
        # on both, and taking the widest first means the outer division is found
        # before the inner one — which keeps the recursion shallow and, more
        # usefully, makes the reported reason match how a person would describe
        # the sheet.
        if found is not None and (best is None or found[0] > best[0]):
            best, best_axis = found, axis

    if best is None:
        return [(members, list(cuts))]

    gap, cut, near, far = best

    def descend(side: str) -> list:
        record = list(cuts) + [{
            "axis": best_axis,
            "at": round(cut, 2),
            "gap": round(gap, 2),
            "side": side,
        }]
        members_of = near if side == "low" else far
        return _split(walls, members_of, min_walls, min_channel, record, depth + 1)

    return descend("low") + descend("high")


def segment_frames(walls, gutter: float = DEFAULT_GUTTER,
                   min_walls: int = MIN_WALLS,
                   min_channel: float = MIN_CHANNEL) -> list[Frame]:
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
        # The gutter got us clusters of linework. It cannot tell a cluster that
        # is one drawing from a cluster that is two drawings a couple of metres
        # apart, because it merges anything within twice its own value. Cut each
        # cluster again on channels no wall crosses — see the module docstring.
        for piece, cuts in _split(walls, members, min_walls, min_channel):
            if len(piece) < min_walls:
                continue
            xs = [c for i in piece for c in (walls[i].ax, walls[i].bx)]
            ys = [c for i in piece for c in (walls[i].ay, walls[i].by)]
            frames.append(
                Frame(
                    index=0,
                    wall_indices=piece,
                    bbox=(min(xs), min(ys), max(xs), max(ys)),
                    cuts=cuts,
                )
            )

    # Wall count first — deliberately, and it is load-bearing. On the real villa
    # sheet the compound wall is 8 walls over a 28 m span and ranks LAST because
    # count is primary; ranking by area or by wall length promotes it over real
    # plans. The rest of the key only breaks ties, which count alone leaves to
    # DXF entity order — a frame index that changes when the architect redraws
    # something unrelated is not an identity.
    frames.sort(key=lambda f: (-len(f.wall_indices), -f.span, f.bbox[0], f.bbox[1]))
    for n, frame in enumerate(frames):
        frame.index = n
    return frames
