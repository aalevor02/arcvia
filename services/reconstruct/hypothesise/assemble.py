"""
Multi-leaf wall assemblies: two paired walls that are really one wall.

── The failure this repairs, measured before it was written ──────────────────
An architect draws a composite wall — 240 mm structure with a 160 mm insulation
leaf on its face — as FOUR parallel lines. The shared boundary is one line, so
the sheet carries three or four lines a leaf-thickness apart, and every one of
them is honest linework.

`pair_faces` resolves tightest-pair-first, for the measured reason in its own
docstring. On an assembly that order has a consequence: the 160 mm leaf is the
tighter pair, it forms first and consumes the shared face, and the 240 mm
structural wall either never forms or forms from the two OUTER lines as a
single 400 mm wall in the wrong place. Measured on the Revit-22 apartment
ground truth (`test/fixtures/plangraph/`): 8 of its 13 exterior 240 mm
segments — 117 m of building envelope — had no paired wall within 150 mm of
their true centreline, while a 160 mm wall ran exactly one seam away. Recall
0.615, with the envelope recovered only by `add_perimeter`'s derived ring.
The NIBS office loses the same way to its 54 mm linings: rooms whose
partitions lose a face to a hugging leaf merge into their neighbours.

The repair is what the source formats themselves do. IFC stores a composite
wall as ONE wall whose thickness is the sum of an ordered material layer set
(`IfcMaterialLayerSet`); Revit's compound structure is the same idea. Two
recovered walls standing leaf-to-leaf are therefore one wall that was
detected twice, and merging them reproduces the object the architect had.

── What counts as leaf-to-leaf ───────────────────────────────────────────────
Parallel, overlapping along their shared direction, and centrelines separated
by exactly half of each thickness — i.e. their faces TOUCH. The seam tolerance
is tight (15 mm) on purpose: a brick-cavity-block wall drawn with a 50 mm air
gap is genuinely two leaves either side of a cavity, and folding the cavity
into masonry would overstate every quantity taken off the model. A cavity
assembly stays two walls until somebody measures a reason otherwise.

Runs AFTER pairing (it consumes measured pairs) and BEFORE opening bridging
and corner joining, so the bridge and the corners see the assembled wall.

── Status (2026-08-26): NOT wired, and the interaction is now understood ─────
Three rounds of measurement against the ground-truth fixtures:

  * Merging alone finds nothing to merge — after tightest-pair resolution an
    assembly is one paired leaf plus one orphaned face, never two paired
    leaves. Hence `reclaim_leaves`.
  * With reclaim+merge the Revit-22 envelope comes out as clean 0.40 m
    assemblies and thickness outliers fall 0.41 → 0.03 — but solved rooms
    fell hard, for TWO separate reasons, one of which was not this module's
    fault at all: `detect_spaces`' envelope filter was deleting any room that
    surrounds a free-standing core (fixed there — see MAX_ISLANDS), because
    only the wandering derived ring had been wiring islands into boundaries.
  * After the island fix, scored ONE-TO-ONE against ground truth (raw solved
    counts flatter the baseline — its extras are courtyard fakes and splits):
    kit 16/18 → 16/18, nibs 46/60 → 46/60, revit22 22/28 → 20/28. The merge
    variants (weighted-centre vs thicker-leaf centreline vs span handling)
    all land within a room of each other, so the axis shift is NOT the
    remaining problem; the two lost rooms sit against the envelope where the
    baseline's ring supplied a boundary this pass removes.

── Where this stands (2026-08-26, fourth round). Still unwired, ONE room out ──
The centreline-moving version was refuted outright: it cost six rooms on the
Revit-22 fixture (one-to-one 22/28 → 16/28). That refutation named the fix,
and the fix was then built: `Wall.offset` (see hypothesise/pair.py and
test/test_offset.py) carries the body's displacement so the AXIS never moves,
exactly as IFC's OffsetFromReferenceLine does. Rewritten against it, this
pass now measures:

    kit-institute   16/18 matched, unchanged      thickness outliers 0.000
    nibs-office     48/60 matched, unchanged      thickness outliers 0.000
    revit22         21/28 matched (baseline 22)   thickness outliers 0.365 -> 0.000

So the cost is down from six rooms to one, and composite thickness is now
exactly right. Two defects were found and fixed getting here, both worth
keeping in mind because both were THIS module violating its own rules:
  * `reclaim_leaves` used to re-emit the orphan at the leaf's centreline —
    moving an axis, the very sin the offset field exists to end. It cost a
    bathroom whose boundary line was re-emitted 12 cm away while the corner
    joins still pointed at the old position.
  * a stray line inside a CAVITY was being read as a leaf spanning it,
    handing `merge_assemblies` a bridge across the air gap its own docstring
    refuses to fold. Guarded now: a reclaimed leaf may not run into a wall
    that is already paired.

The last room is a genuine remainder, not a mystery — wire this only when the
fixture suite shows one-to-one parity on all three, and keep the villa A/B
identical. Everything needed to finish it is in test/test_plangraph.py.
"""

from __future__ import annotations

import math
from dataclasses import replace

from hypothesise.pair import (
    ANGLE_TOLERANCE_DEG,
    MAX_WALL_THICKNESS,
    MIN_LENGTH,
    MIN_WALL_THICKNESS,
    Wall,
)

#: How far apart two leaves' faces may sit and still be one assembly. Covers
#: drafting slop on a shared boundary line; deliberately smaller than any
#: real cavity (50 mm+), see the module docstring.
SEAM_TOLERANCE = 0.015

#: Leaves must run together for at least this much of the shorter one.
#: An insulation leaf legitimately runs past its wall's end at a corner
#: (it wraps), so full mutual overlap is the wrong ask; but a wall that
#: merely brushes another's end is a junction, not a leaf.
MIN_OVERLAP_SHARE = 0.5


def _merge_pair(a: Wall, b: Wall) -> Wall | None:
    """
    The single assembled wall two leaves make, or None if they are not leaves.

    ── The axis does not move. Ever. ────────────────────────────────────────
    The first version of this put the merged centreline at the thickness-
    weighted centre of the combined section, and it measured NET NEGATIVE on
    rooms (the refutation record below): the axis is what the room graph, the
    label bridges and the corner joins were all built against, and moving it
    laterally tears every one of those coincidences. So the merged wall keeps
    the THICKER leaf's axis line — where pairing measured a wall — and the
    body's true position is carried in `Wall.offset`, exactly as IFC's
    OffsetFromReferenceLine carries a layer set beside its reference line.
    Only solidify and the plan's poché read it; the topology never does.

    The arithmetic is done on body-edge INTERVALS in the base's frame, not on
    axis distances, so a leaf that already carries an offset (a three-leaf
    assembly, merged pairwise) composes exactly instead of drifting.
    """
    base, other = (a, b) if a.thickness >= b.thickness else (b, a)

    bdx, bdy = base.bx - base.ax, base.by - base.ay
    bn = math.hypot(bdx, bdy)
    odx, ody = other.bx - other.ax, other.by - other.ay
    on = math.hypot(odx, ody)
    if bn < 1e-9 or on < 1e-9:
        return None
    bdx, bdy = bdx / bn, bdy / bn

    dot = (odx / on) * bdx + (ody / on) * bdy
    if abs(dot) < math.cos(math.radians(ANGLE_TOLERANCE_DEG)):
        return None
    # The other wall's own offset is expressed along ITS left normal, which
    # points the opposite way when the two walls were drawn head-to-tail.
    sign = 1.0 if dot >= 0 else -1.0

    # Base frame: along = distance down base's direction from base's start,
    # across = signed distance along base's LEFT normal (-bdy, bdx).
    def frame(x: float, y: float) -> tuple[float, float]:
        ox, oy = x - base.ax, y - base.ay
        return ox * bdx + oy * bdy, -ox * bdy + oy * bdx

    o1_along, o1_across = frame(other.ax, other.ay)
    o2_along, o2_across = frame(other.bx, other.by)

    # Body-edge intervals across the section.
    base_centre = base.offset
    other_centre = (o1_across + o2_across) / 2 + other.offset * sign
    base_edges = (base_centre - base.thickness / 2,
                  base_centre + base.thickness / 2)
    other_edges = (other_centre - other.thickness / 2,
                   other_centre + other.thickness / 2)

    # Leaf-to-leaf means the two BODIES touch: the gap between the nearer
    # pair of edges is the seam.
    seam = max(base_edges[0], other_edges[0]) - min(base_edges[1], other_edges[1])
    if seam > SEAM_TOLERANCE or -seam > min(a.thickness, b.thickness) / 2:
        return None

    o_lo, o_hi = sorted((o1_along, o2_along))
    overlap = min(bn, o_hi) - max(0.0, o_lo)
    if overlap < max(MIN_LENGTH, MIN_OVERLAP_SHARE * min(bn, on)):
        return None

    # A leaf legitimately wraps a corner by about a wall thickness — not by
    # metres. Extending the merged span to the full union let one long leaf
    # drag an assembly across a junction it had no business crossing.
    wrap = 2 * max(a.thickness, b.thickness)
    lo = max(min(0.0, o_lo), -wrap)
    hi = min(max(bn, o_hi), bn + wrap)
    low_edge = min(base_edges[0], other_edges[0])
    high_edge = max(base_edges[1], other_edges[1])

    return replace(
        base,
        ax=base.ax + bdx * lo, ay=base.ay + bdy * lo,
        bx=base.ax + bdx * hi, by=base.ay + bdy * hi,
        thickness=high_edge - low_edge,
        offset=(high_edge + low_edge) / 2,
        confidence=min(a.confidence, b.confidence),
        duplicate=a.duplicate + b.duplicate,
    )


def reclaim_leaves(walls: list[Wall]) -> list[Wall]:
    """
    Recover the leaf whose face the tightest-pair order consumed.

    ── Why merging alone found nothing to merge ──────────────────────────────
    A composite wall's shared boundary is drawn ONCE, so a 240+160 assembly is
    three lines, not four. `pair_faces` resolves tightest-pair-first: the
    160 mm pair forms, consumes the shared line, and the 240 mm wall's other
    face is left as a single UNPAIRED line flagged as a probable railing.
    After pairing there are never two paired leaves standing seam-to-seam —
    there is one paired leaf and one orphaned face. Measured on the Revit-22
    fixture: every one of the 8 lost envelope segments had exactly this shape.

    So: an unpaired line running parallel to a paired wall, overlapping it
    along its run, at a distance from the wall's NEAR FACE that is itself a
    buildable thickness, is read back as the far face of a second leaf. The
    leaf is emitted as a paired wall butted seam-to-seam against the first —
    which is precisely the shape `merge_assemblies` consumes. Call this first,
    then merge.

    Guards, each against a real mis-read:
      * implied thickness within the pairing stage's own admissible band —
        a balcony railing a metre from the facade implies a 0.9 m leaf and
        is refused;
      * overlap of at least half the orphan's length — a line that merely
        crosses the wall's end is a junction;
      * same source layer — an assembly's leaves are drawn on the wall layer;
      * the NEAREST qualifying paired wall wins, so the orphan cannot reach
        across a corridor to a wall further away than the one beside it.
    """
    out = [replace(w) for w in walls]

    for i, orphan in enumerate(out):
        if orphan.paired:
            continue
        best: tuple[float, int, float] | None = None   # (t2, host index, offset sign)

        odx, ody = orphan.bx - orphan.ax, orphan.by - orphan.ay
        on = math.hypot(odx, ody)
        if on < MIN_LENGTH:
            continue
        odx, ody = odx / on, ody / on

        for j, host in enumerate(out):
            if i == j or not host.paired or host.layer != orphan.layer:
                continue
            hdx, hdy = host.bx - host.ax, host.by - host.ay
            hn = math.hypot(hdx, hdy)
            if hn < 1e-9:
                continue
            hdx, hdy = hdx / hn, hdy / hn
            if abs(odx * hdx + ody * hdy) < math.cos(
                math.radians(ANGLE_TOLERANCE_DEG)
            ):
                continue

            # Orphan midpoint in the host's frame.
            mx, my = (orphan.ax + orphan.bx) / 2, (orphan.ay + orphan.by) / 2
            along = (mx - host.ax) * hdx + (my - host.ay) * hdy
            off = -(mx - host.ax) * hdy + (my - host.ay) * hdx

            o1 = (orphan.ax - host.ax) * hdx + (orphan.ay - host.ay) * hdy
            o2 = (orphan.bx - host.ax) * hdx + (orphan.by - host.ay) * hdy
            lo, hi = sorted((o1, o2))
            overlap = min(hn, hi) - max(0.0, lo)
            if overlap < max(MIN_LENGTH, 0.5 * on):
                continue

            t2 = abs(off) - host.thickness / 2
            if not (MIN_WALL_THICKNESS <= t2 <= MAX_WALL_THICKNESS):
                continue

            # ── The cavity guard, which this pass was quietly defeating ─────
            # `merge_assemblies` refuses to fold a cavity into masonry (its
            # docstring says why: it would overstate every quantity). But a
            # cavity wall drawn as four lines pairs into TWO walls with air
            # between them, and if a fifth stray line sits in that air this
            # pass would read it as a leaf spanning the cavity — handing
            # merge_assemblies a bridge and letting the very merge the guard
            # exists to prevent go through. Measured on the Revit-22 fixture:
            # a 0.115 leaf at y=4.95 and a 0.160 leaf at y=5.27 became one
            # 0.400 m "wall", moving a room boundary and costing the Bad/WC.
            #
            # So: the proposed leaf body must not run into a wall that is
            # ALREADY paired. If it does, the far side is somebody else's
            # measured wall and the space between them is air.
            leaf_lo = host.thickness / 2
            leaf_hi = host.thickness / 2 + t2
            blocked = False
            for k, third in enumerate(out):
                if k in (i, j) or not third.paired:
                    continue
                tdx, tdy = third.bx - third.ax, third.by - third.ay
                tn = math.hypot(tdx, tdy)
                if tn < 1e-9:
                    continue
                if abs((tdx / tn) * hdx + (tdy / tn) * hdy) < math.cos(
                    math.radians(ANGLE_TOLERANCE_DEG)
                ):
                    continue
                tmx, tmy = (third.ax + third.bx) / 2, (third.ay + third.by) / 2
                t_off = (-(tmx - host.ax) * hdy + (tmy - host.ay) * hdx) * (
                    1.0 if off >= 0 else -1.0
                )
                t_lo, t_hi = t_off - third.thickness / 2, t_off + third.thickness / 2
                # Overlap along the host, so a parallel wall elsewhere on the
                # plan cannot veto this leaf.
                t1 = (third.ax - host.ax) * hdx + (third.ay - host.ay) * hdy
                t2_ = (third.bx - host.ax) * hdx + (third.by - host.ay) * hdy
                if min(hn, max(t1, t2_)) - max(0.0, min(t1, t2_)) < MIN_LENGTH:
                    continue
                if t_hi > leaf_lo + SEAM_TOLERANCE and t_lo < leaf_hi - SEAM_TOLERANCE:
                    blocked = True
                    break
            if blocked:
                continue

            if best is None or t2 < best[0]:
                best = (t2, j, math.copysign(1.0, off))

        if best is not None:
            t2, j, sign = best
            host = out[j]
            hdx, hdy = host.bx - host.ax, host.by - host.ay
            hn = math.hypot(hdx, hdy)
            hdx, hdy = hdx / hn, hdy / hn

            # ── The line stays exactly where it was drawn ───────────────────
            # The first version rebuilt the orphan at the leaf's centreline —
            # i.e. it MOVED the axis, the same mistake the offset schema was
            # introduced to end, and it cost a measured room: an unpaired line
            # bounding a bathroom at y=4.949 was re-emitted 12 cm away at
            # y=5.069, the corner joins still pointed at the old position, and
            # the cycle broke. An orphan is a line the draughtsman drew at a
            # known place; what reclaiming ADDS is the knowledge that material
            # lies between it and the host, and material is what `offset`
            # carries. So: same endpoints, thickness = the implied leaf, body
            # displaced HALF a leaf toward the host.
            px, py = -hdy * sign, hdx * sign        # host -> orphan direction
            odx, ody = orphan.bx - orphan.ax, orphan.by - orphan.ay
            onx, ony = -ody / on, odx / on          # orphan's own left normal
            offset = (-px * t2 / 2) * onx + (-py * t2 / 2) * ony

            out[i] = replace(
                orphan,
                thickness=t2,
                offset=orphan.offset + offset,
                paired=True,
                # Reclaimed, not measured twice: one of its faces is inferred
                # from the host's, so it never outranks a directly-paired wall.
                confidence=min(orphan.confidence, host.confidence) * 0.9,
            )

    return out


def merge_assemblies(walls: list[Wall]) -> list[Wall]:
    """
    Collapse leaf-to-leaf walls into single assembled walls.

    Greedy and iterative: a three-leaf assembly (structure + lining + render)
    merges pairwise until nothing changes. Only PAIRED walls participate — an
    unpaired single line is a railing or annotation with a defaulted
    thickness, and gluing one onto a real wall would move the real wall's
    centreline by half a guess.

    Emits survivors in their original order (merged walls take the position of
    their first constituent) for the same reason `pair_faces` does: the wall
    list is indexed by everything downstream.
    """
    out = [replace(w) for w in walls]
    merged_away: set[int] = set()

    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            if i in merged_away or not out[i].paired:
                continue
            for j in range(i + 1, len(out)):
                if j in merged_away or not out[j].paired:
                    continue
                combined = _merge_pair(out[i], out[j])
                if combined is not None:
                    out[i] = combined
                    merged_away.add(j)
                    changed = True

    return [w for k, w in enumerate(out) if k not in merged_away]
