"""
Which unit is this drawing in? Ask the walls, not the extents.

── The failure this exists to stop ─────────────────────────────────────────────
`LATEST DRAWINGS - SITE PLAN & ALL VILLAS` reconstructs as a 12.3 m building with
56 paired walls whose median thickness is 0.065 m. Nothing errors. Verify passes.
The rooms come back as eleven spaces totalling 54.73 m², one of them named
`VILLA DRAWINGS` — a title block read as a room — and a bill of quantities can be
produced from all of it that looks entirely plausible.

The drawing is in metres. At metres it is a 1,234 m site carrying 675 paired
walls with a median thickness of **0.230 m** — a nine-inch brick wall, to the
millimetre.

── Why the reader gets it wrong, and why the fix is not in the reader ──────────
`vendor/cad_kernel.py` already contains the right idea: `infer_scale_from_walls`
works the unit out from how thick the walls are, and the module comment states
the trust order plainly — **measured > header > extent**.

Then `_PLAUSIBLE = (3.0, 400.0)` gates every candidate on the drawing's overall
size, at three separate places. A 1,234 m sheet exceeds it, so *metres is never
offered as a candidate at all* — the right answer is filtered out before
measurement gets a vote, which inverts the very order the file documents.

The file even anticipates this: *"the other is a site plan on a survey grid 45 km
from the origin, where the overall size says nothing about the building inside
it."* Quite. **A site plan is not a building**, and an extent window calibrated
on buildings cannot judge one.

The fix does not belong in that file — it is vendored byte-for-byte for a parity
test — and it does not belong in a wider window either, because no window is
right for both a 4 m toilet detail and a 40 km survey grid. It belongs here, in
the thing that already knows what a wall is.

── What this measures ──────────────────────────────────────────────────────────
Pairing yield, and it is a remarkably clean signal.

A drawn wall is two parallel lines. `pair_faces` matches them when they sit
within `MAX_WALL_THICKNESS` **in metres** — so at the wrong scale the two faces
of a wall are either kilometres apart or microns apart, and almost nothing pairs.
At the right scale nearly everything does, and the thicknesses land on the
handful of values masons actually build.

Measured on `LATEST DRAWINGS`, same segments, only the scale changed:

    millimetres      1.2 m       15 paired    median 0.063 m
    centimetres     12.3 m       56 paired    median 0.065 m   <- what shipped
    inches          31.4 m      132 paired    median 0.092 m
    decimetres     123.5 m      287 paired    median 0.165 m
    feet           376.3 m      449 paired    median 0.070 m
    metres       1,234.5 m      675 paired    median 0.230 m   <- 0 mm off a 9in wall

That is not a close call, and it needs no extent window to see.

── What it deliberately does not do ────────────────────────────────────────────
It does not decide. It ranks, and reports a margin, because **margin and not
score is this engine's ask-a-human signal** — the same rule layer selection
follows. A drawing whose top two candidates are close is a drawing where somebody
should look, and saying so is worth more than a confident guess that builds the
villa a thousand times too small.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from hypothesise.pair import (
    MAX_WALL_THICKNESS,
    MIN_WALL_THICKNESS,
    Face,
    pair_faces,
)

#: Every unit a CAD file is plausibly authored in, and what one source unit is
#: worth in metres. No extent filter — that is the whole point.
CANDIDATES: tuple[tuple[str, float], ...] = (
    ("millimetres", 0.001),
    ("centimetres", 0.01),
    ("inches", 0.0254),
    ("feet", 0.3048),
    ("metres", 1.0),
)

#: Pairing every face at six scales is six times the work, and the answer does
#: not get better past a few thousand. `cad_kernel.infer_scale_from_walls` samples
#: at 4000 for the same reason.
SAMPLE = 4000

#: The thicknesses masons actually build, in metres.
#:
#: ── Why nominals and not a range ────────────────────────────────────────────
#: The first version of this counted walls inside the PAIRING band, 0.04 to
#: 0.50 m. That band exists to decide what may pair, not what is a wall, and
#: 40 mm is not a wall. It made the test almost useless: on all seven real
#: drawings metres beat feet by only 1.3-2.4x, because a 0.23 m wall read as
#: feet is 0.070 m and a band that wide accepts it happily. Everything was
#: refused for want of margin.
#:
#: Masonry comes in sizes. A four-and-a-half brick is 0.115 m, a nine-inch is
#: 0.229, blocks come at 0.100 / 0.150 / 0.200, and a 0.300 wall is an external
#: cavity or a retaining wall. A scale that lands the drawing's thicknesses ON
#: those numbers is the right scale; one that scatters them between is not.
#: Same reasoning as the rest of this engine — measure the thing the trade
#: actually does, rather than pick a threshold.
NOMINAL_THICKNESS: tuple[float, ...] = (0.100, 0.115, 0.150, 0.200, 0.229, 0.300)

#: How far off a nominal a wall may be and still count as that nominal.
#: Generous, because centrelines are measured across paired ink and drawings are
#: not surveys — but far tighter than the 12x spread of the old band.
NOMINAL_TOLERANCE = 0.020

#: Below this many walls landing on a nominal at the winning scale, the signal
#: is not a signal. A drawing with almost no measurable walls cannot tell you
#: its own unit, and should say so rather than pick the least-bad of five bad
#: answers.
MIN_EVIDENCE = 12


def _on_nominal(thickness: float) -> bool:
    """Is this a thickness somebody would actually build?"""
    return any(abs(thickness - n) <= NOMINAL_TOLERANCE for n in NOMINAL_THICKNESS)

#: The winner must beat the runner-up by this factor. Below it, the drawing is
#: ambiguous and a human decides — this is the engine's standing rule that
#: margin, not score, is what asks for help.
DECISIVE_MARGIN = 3.0


@dataclass
class UnitScore:
    label: str
    scale: float
    extent: float
    paired: int             # walls whose thickness is one a mason would build
    median_thickness: float

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "scale": self.scale,
            "extent": round(self.extent, 2),
            "paired": self.paired,
            "medianThickness": round(self.median_thickness, 4),
        }


@dataclass
class UnitVerdict:
    """A ranking, a margin, and whether that margin is good enough."""

    scores: list[UnitScore] = field(default_factory=list)
    decided: bool = False
    reason: str = ""

    @property
    def best(self) -> UnitScore | None:
        return self.scores[0] if self.scores else None

    @property
    def margin(self) -> float:
        """Winner over runner-up. Infinite when only one candidate scored."""
        if len(self.scores) < 2:
            return float("inf") if self.scores else 0.0
        runner_up = self.scores[1].paired
        return self.scores[0].paired / runner_up if runner_up else float("inf")

    def as_dict(self) -> dict:
        return {
            "decidedBy": "wallThickness",
            "decided": self.decided,
            "reason": self.reason,
            "margin": None if self.margin == float("inf") else round(self.margin, 2),
            "scale": self.best.scale if self.best else None,
            "unit": self.best.label if self.best else None,
            "candidates": [s.as_dict() for s in self.scores],
        }


def rank_units(segments, origin: tuple[float, float],
               sample: int = SAMPLE) -> UnitVerdict:
    """
    Score every candidate unit by how many real walls it produces.

    `segments` are the raw wall-layer segments as the kernel read them, in
    SOURCE units — this must run before any scale has been applied, because
    applying one is the question being asked.
    """
    ox, oy = origin
    raw = list(segments)[:sample]
    if not raw:
        return UnitVerdict(reason="no wall-layer linework to measure")

    scores: list[UnitScore] = []
    for label, scale in CANDIDATES:
        faces = [
            Face(ax=(s.x1 - ox) * scale, ay=(s.y1 - oy) * scale,
                 bx=(s.x2 - ox) * scale, by=(s.y2 - oy) * scale, layer=s.layer)
            for s in raw
        ]
        xs = [c for f in faces for c in (f.ax, f.bx)]
        ys = [c for f in faces for c in (f.ay, f.by)]
        extent = max(max(xs) - min(xs), max(ys) - min(ys)) if xs else 0.0

        # Only walls a mason would build, and only at a size one is sold in. A
        # "pair" 3 mm apart is two coincident lines; one 2 m apart is two
        # different walls that happened to be parallel; one at 0.070 m is a
        # 0.23 m wall being read as feet. All three pair, and none of them is
        # evidence of a unit.
        thicknesses = sorted(
            w.thickness for w in pair_faces(faces)
            if w.paired
            and MIN_WALL_THICKNESS <= w.thickness <= MAX_WALL_THICKNESS
            and _on_nominal(w.thickness)
        )
        scores.append(UnitScore(
            label=label,
            scale=scale,
            extent=extent,
            paired=len(thicknesses),
            median_thickness=thicknesses[len(thicknesses) // 2] if thicknesses else 0.0,
        ))

    scores.sort(key=lambda s: -s.paired)
    verdict = UnitVerdict(scores=scores)

    best = verdict.best
    if not best or best.paired < MIN_EVIDENCE:
        verdict.reason = (
            f"only {best.paired if best else 0} plausible wall(s) at the best "
            f"scale — this drawing cannot tell you its own unit"
        )
        return verdict

    if verdict.margin < DECISIVE_MARGIN:
        verdict.reason = (
            f"{best.label} ({best.paired} walls) barely beats "
            f"{scores[1].label} ({scores[1].paired}) — margin "
            f"{verdict.margin:.1f}x, under {DECISIVE_MARGIN}x. Ask."
        )
        return verdict

    verdict.decided = True
    verdict.reason = (
        f"{best.paired} walls pair at {best.label}, median {best.median_thickness:.3f} m, "
        f"{verdict.margin:.0f}x the runner-up ({scores[1].label}, {scores[1].paired})"
    )
    return verdict
