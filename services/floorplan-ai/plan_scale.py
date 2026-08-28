"""
How big is this drawing, when the drawing does not say?

── The hole this fills ─────────────────────────────────────────────────────────
`main.py` gets `PlanScale` from exactly one place: `labels.infer_scale`, which
reads the sizes the architect PRINTED inside the rooms — "BEDROOM 12'-0 x 10'-6"
— and lets every labelled room vote. It is the right primary method and nothing
here replaces it.

But a great many plans print nothing. A marketing sheet, a scanned brochure
page, a WhatsApp photo of a drawing, a deck slide. For all of those
`scale` comes back `None`, and everything downstream is unitless: no areas, no
bill of quantities, no compliance predicate, and furniture that cannot be
checked for fit because there is nothing to fit it against.

This module supplies a scale for those plans, from the drawing itself.

── The idea, and the one thing that makes it work ──────────────────────────────
Measure something in the drawing whose real size you already know, and the scale
falls out. That is an old surveyor's trick and it is not the hard part.

The hard part is choosing WHAT to measure, and the rule is narrower than it
first looks:

    A ruler must be LOW-VARIANCE, not merely known-size.

A sofa is a known size — the catalogue says 2.1 m — and it is a terrible ruler,
because real sofas run from 1.5 m to 2.6 m and the error goes straight into the
scale. A brick wall is a superb ruler: a nine-inch wall is 230 mm because that
is what a brick is, everywhere, for a century. A door leaf is 900 mm because
that is what the joinery shop makes and what the code expects.

So this module rules with masonry and joinery, not with furniture. The
catalogue's dimensions are deliberately NOT imported here even though they are
available and generated (`classify/catalogue_dims.py`) — they are nominal sizes
for placing objects, not tolerances for measuring with.

── Why candidates are pooled rather than picked ────────────────────────────────
Masonry is bimodal: 230 mm structural and 115 mm partition sit in the same
drawing, and a median thickness could be either. Reading it as the wrong one is
a clean factor-of-two error that produces a completely plausible building.

`classify/units.py` documents the trap that catches this kind of reasoning: it
warns against gating candidates on the drawing's overall extent, because "a site
plan is not a building" and no size window is right for both a 4 m toilet detail
and a 40 km survey grid. That warning applies here too, so no extent window is
used.

Instead the evidence has to agree ACROSS KINDS. A thickness reading and a door
reading that land on the same scale are two independent measurements of the same
thing, and that agreement is worth far more than either alone or than any
plausibility window. When no cluster has support from two different kinds of
ruler, this refuses — the same way `labels.infer_scale` returns None rather than
trusting a lone caption.

── Trust order ─────────────────────────────────────────────────────────────────
    printed dimensions  >  inferred from rulers  >  nothing

`main.py` must call this only when `labels.infer_scale` returned None, and the
result carries `method="inferred"` so no consumer can mistake one for the other.
A measured scale and a deduced one are not the same claim.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

# ---------------------------------------------------------------------------
# Rulers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ruler:
    """Something in a drawing whose real-world size barely varies."""

    kind: str
    name: str
    metres: float
    #: How often this ruler is the right reading, roughly, in Indian
    #: residential work. Not a probability — a weight, used only to compare
    #: clusters against each other.
    #:
    #: ── Why a prior is REQUIRED here, and not a nicety ──────────────────────
    #: Discovered while testing, and it is a genuine degeneracy rather than a
    #: tuning problem. On a 12 m plan with a 230 mm wall and six 900 mm doors,
    #: the true reading is wall-230 + door-900. But 200/230 = 0.87 and
    #: 750/900 = 0.83, so wall-200 + door-750 lands on a second scale that is
    #: internally consistent, carries the SAME number of readings, and spans
    #: the same two kinds. Counting readings cannot separate them, and no
    #: amount of extra doors helps, because every extra door feeds both
    #: clusters equally.
    #:
    #: What separates them is that a nine-inch wall with 900 mm doors is the
    #: overwhelmingly common building, and a 200 mm block wall whose ONLY doors
    #: are 750 mm toilet doors is rare. That is knowledge about buildings, and
    #: it has to be stated somewhere. Here.
    prior: float = 1.0


#: Masonry thicknesses, Indian residential practice.
#:
#: 230 mm is a nine-inch brick wall — one brick laid across, the standard
#: structural/external wall. 115 mm is half-brick, the standard internal
#: partition. 150 and 200 cover block work. These are the same numbers
#: `classify/units.py` reasons about when it identifies a 0.230 m median as "a
#: nine-inch brick wall, to the millimetre".
WALL_RULERS = (
    Ruler("wall", "half-brick partition (115 mm)", 0.115, prior=0.7),
    Ruler("wall", "block partition (150 mm)", 0.150, prior=0.3),
    Ruler("wall", "block wall (200 mm)", 0.200, prior=0.3),
    Ruler("wall", "nine-inch brick (230 mm)", 0.230, prior=1.0),
)

#: Door leaf widths. 900 mm internal and 1050 mm main door are the Indian
#: residential standards the catalogue already encodes — see the header of
#: `apps/studio/src/catalogue/items.ts`, which sets internal doors at 0.9 m and
#: main doors at 1.05 m for exactly this market.
DOOR_RULERS = (
    Ruler("door", "toilet door (750 mm)", 0.750, prior=0.4),
    Ruler("door", "internal door (900 mm)", 0.900, prior=1.0),
    Ruler("door", "main door (1050 mm)", 1.050, prior=0.5),
)

#: How close two candidate scales must be to count as agreeing, as a fraction of
#: the cluster's own middle.
#:
#: 8% is chosen against what the rulers themselves permit rather than to make
#: results look tidy: plaster adds 12–20 mm to a 230 mm wall, which is 6–9%, and
#: a drawn line has width. Tighter than this and correct readings are split
#: apart by rendering; looser and a 115 mm reading starts shaking hands with a
#: 150 mm one.
AGREEMENT = 0.08

#: Distinct ruler KINDS a cluster needs before it is believed. Two means a wall
#: reading and a door reading agreed, which is the whole basis of this module.
MIN_KINDS = 2

#: How far ahead the winning cluster must be before it is trusted over a
#: competing scale, as a fraction of its own score. At 0.7, a runner-up holding
#: more than 70% of the winner's support makes the drawing ambiguous rather than
#: decided.
MIN_MARGIN = 0.7


@dataclass(frozen=True)
class Candidate:
    """One reading: if this feature is that ruler, the scale is this."""

    metres_per_unit: float
    ruler: Ruler
    measured: float


@dataclass
class InferredScale:
    metres_per_unit: float
    samples: int
    spread: float | None
    #: Always "inferred". Present so a consumer can tell this from a scale read
    #: off printed dimensions without inspecting where it came from.
    method: str = "inferred"
    #: Which rulers agreed, in words a reviewer can check against the drawing.
    agreed: list[str] = field(default_factory=list)


@dataclass
class Refusal:
    """Why no scale could be deduced. Never a silent None."""

    reason: str
    detail: str = ""
    candidates: int = 0


# ---------------------------------------------------------------------------
# Reading candidates off the drawing
# ---------------------------------------------------------------------------


def wall_candidates(thicknesses: list[float]) -> list[Candidate]:
    """
    Candidates from wall thickness.

    The MEDIAN thickness is used, not every wall: individual wall thicknesses in
    a raster detection are noisy by a pixel or two, and a hatched wall can read
    thick. The median of many walls is stable, and one stable number tested
    against four rulers is better evidence than four hundred noisy ones tested
    against four rulers, which would merely manufacture agreement.
    """
    usable = [t for t in thicknesses if t and t > 0]
    if not usable:
        return []

    middle = float(median(usable))
    return [
        Candidate(ruler.metres / middle, ruler, middle) for ruler in WALL_RULERS
    ]


def door_candidates(widths: list[float]) -> list[Candidate]:
    """
    Candidates from door opening widths.

    Unlike thickness, each opening is measured independently and they genuinely
    differ — a flat has one 1050 mm main door and several 900 mm internal ones —
    so every opening votes rather than only the median. A plan with six internal
    doors therefore lands six mutually-reinforcing readings on the same scale.
    """
    out: list[Candidate] = []
    for width in widths:
        if not width or width <= 0:
            continue
        for ruler in DOOR_RULERS:
            out.append(Candidate(ruler.metres / width, ruler, width))
    return out


# ---------------------------------------------------------------------------
# Agreement
# ---------------------------------------------------------------------------


def _cluster(candidates: list[Candidate]) -> list[list[Candidate]]:
    """
    Group candidates that agree within `AGREEMENT`.

    A plain sorted sweep. Every candidate seeds a window, so a cluster is never
    missed because of where the sweep happened to start — which a single pass
    with a running boundary does miss.

    ── Why the test is on the SPAN, not on the distance to the middle ──────────
    Measured, and it was wrong the first time. Admitting a candidate whenever it
    sits within `AGREEMENT` of the running median lets a cluster chain: each new
    reading is close to the median it just helped move, and the window walks. On
    a 12 m plan that pulled the 200 mm wall reading (10.4) into the same cluster
    as the 230 mm wall and the 900 mm doors (12.0) and reported a spread of 13%
    against an 8% agreement threshold — a cluster that by its own definition did
    not agree.

    Bounding the whole span fixes it: every member of a cluster is within
    `AGREEMENT` of every other, which is what "these readings agree" has to
    mean if `spread` is to be worth reporting.
    """
    ordered = sorted(candidates, key=lambda c: c.metres_per_unit)
    clusters: list[list[Candidate]] = []

    for i, seed in enumerate(ordered):
        window = [seed]
        for other in ordered[i + 1:]:
            values = [c.metres_per_unit for c in window] + [other.metres_per_unit]
            if (max(values) - min(values)) <= AGREEMENT * median(values):
                window.append(other)
            else:
                break
        clusters.append(window)

    return clusters


def _kinds(cluster: list[Candidate]) -> set[str]:
    return {c.ruler.kind for c in cluster}


def _score(cluster: list[Candidate]) -> float:
    """Summed prior. Common rulers agreeing counts for more than rare ones."""
    return sum(c.ruler.prior for c in cluster)


def infer_scale_from_features(
    wall_thicknesses: list[float],
    door_widths: list[float] | None = None,
    *,
    min_kinds: int = MIN_KINDS,
) -> InferredScale | Refusal:
    """
    Deduce metres-per-unit from what the drawing contains.

    Inputs are NORMALISED against image width, matching `WallSegment.thickness`
    and the rest of the detector, so the answer is directly comparable with a
    `PlanScale` from printed dimensions.

    Returns an `InferredScale`, or a `Refusal` explaining why not. It never
    returns a best guess: a wrong scale is worse than no scale, because every
    area, quantity and compliance check downstream inherits it silently and
    still looks entirely plausible — which is the exact failure
    `classify/units.py` was written to stop.
    """
    candidates = wall_candidates(wall_thicknesses or [])
    candidates += door_candidates(door_widths or [])

    if not candidates:
        return Refusal("no-features", "no wall thickness or door width to measure")

    clusters = _cluster(candidates)
    supported = [c for c in clusters if len(_kinds(c)) >= min_kinds]

    if not supported:
        best = max(clusters, key=len)
        return Refusal(
            "no-cross-kind-agreement",
            "the only readings that agreed were all "
            f"{'/'.join(sorted(_kinds(best))) or 'unknown'}; "
            f"{min_kinds} independent kinds of ruler are required",
            candidates=len(candidates),
        )

    # Score by summed prior, not by count — see the note on `Ruler.prior` for
    # the degeneracy that makes counting insufficient.
    ranked = sorted(supported, key=_score, reverse=True)
    best = ranked[0]
    ratios = sorted(c.metres_per_unit for c in best)
    middle = float(median(ratios))

    # A runner-up on a DIFFERENT scale with comparable support means the drawing
    # genuinely supports two readings. Saying so beats picking, for the same
    # reason the rest of this pipeline refuses rather than guesses.
    for other in ranked[1:]:
        other_middle = float(median([c.metres_per_unit for c in other]))
        if abs(other_middle - middle) <= AGREEMENT * middle:
            continue  # same scale, not a competitor
        if _score(other) > MIN_MARGIN * _score(best):
            return Refusal(
                "ambiguous",
                f"two scales are similarly supported: {middle:.3f} "
                f"({'/'.join(sorted(r.ruler.name for r in best))}) and "
                f"{other_middle:.3f} "
                f"({'/'.join(sorted(r.ruler.name for r in other))})",
                candidates=len(candidates),
            )
        break

    if middle <= 0:
        return Refusal("degenerate", "agreed scale is not positive")

    spread = (ratios[-1] - ratios[0]) / middle if len(ratios) > 1 else None

    return InferredScale(
        metres_per_unit=middle,
        samples=len(best),
        spread=round(spread, 4) if spread is not None else None,
        agreed=sorted({c.ruler.name for c in best}),
    )
