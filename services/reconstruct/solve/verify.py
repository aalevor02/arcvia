"""
The gate between extraction and everything expensive.

── Why this exists ───────────────────────────────────────────────────────────
Every failure mode in this pipeline produces *a building*. Not an error — a
building. Read a drawing at the wrong unit and you get a villa 4 cm across that
renders beautifully. Miss the partition walls and you get one 300 m² room where
there should be eight. Filter every segment out by length and you get zero walls
and a valid, empty GLB.

Measured on this project: two real drawings carrying thousands of wall segments
each reconstructed to **zero walls** and reported success, because `$INSUNITS`
declared millimetres for a drawing authored in something else and every segment
then fell below the minimum length. Nothing threw. The GLB was well-formed.

So the rule is: a result that contradicts its own input is an error, not a
result. This runs before anything is rendered, baked or shown, and its job is to
be loud.

── What it can and cannot say ────────────────────────────────────────────────
It cannot tell you the model is right. It can tell you the model is impossible,
which is a much easier question and catches every failure listed above. Checks
are ranked: `blocking` stops the pipeline, `warning` is worth a human's glance,
and everything else is reported as measurement.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: A building that yields fewer walls than this from real wall linework has not
#: been reconstructed, whatever else it has done. Four is the floor because four
#: is what it takes to enclose anything — a single room is a legitimate model,
#: and a threshold that rejects one would reject the smallest true positive.
MIN_WALLS = 4

#: If the input carried this many wall-layer segments, the output cannot
#: reasonably be empty. This is the check that catches a unit error.
SUSPICIOUS_INPUT_SEGMENTS = 100

#: Below this fraction of walls pairing successfully, the model is mostly
#: single lines — railings and annotation — rather than walls.
MIN_PAIRED_FRACTION = 0.30

#: A plausible building's longest plan dimension, metres.
PLAUSIBLE_SPAN = (3.0, 400.0)

#: Wall run per m2 of floor. Indian residential sits near 0.8-1.2; the band is
#: widened to 0.6-1.6 so an unusually cellular or unusually open plan is not
#: flagged for being unusual. Outside it, something is being double-counted or
#: something is not closing.
WALL_RUN_BAND = (0.6, 1.6)

#: Interior walls in residential construction. Outside this, the unit is wrong
#: or the pairing matched two unrelated lines.
PLAUSIBLE_THICKNESS = (0.05, 0.60)


@dataclass
class Check:
    name: str
    level: str          # 'blocking' | 'warning' | 'info'
    message: str
    value: object = None


@dataclass
class Verdict:
    checks: list[Check] = field(default_factory=list)

    @property
    def blocking(self) -> list[Check]:
        return [c for c in self.checks if c.level == "blocking"]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.level == "warning"]

    @property
    def ok(self) -> bool:
        return not self.blocking

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "blocking": len(self.blocking),
            "warnings": len(self.warnings),
            "checks": [
                {"name": c.name, "level": c.level, "message": c.message, "value": c.value}
                for c in self.checks
            ],
        }


def check(
    *,
    input_segments: int,
    walls,
    spaces,
    openings,
    unhosted: int,
    scale_candidates: list | None = None,
) -> Verdict:
    """Grade a reconstruction against what went into it."""
    v = Verdict()
    total = len(walls)
    paired = sum(1 for w in walls if w.paired)

    # ---- The unit check, which is the one that matters ---------------------
    if input_segments >= SUSPICIOUS_INPUT_SEGMENTS and total < MIN_WALLS:
        options = ""
        if scale_candidates:
            options = "  Candidates: " + ", ".join(
                f"{c.get('label', '?')} -> {c.get('extent', '?')} m"
                for c in scale_candidates
            )
        v.checks.append(Check(
            "walls-from-linework", "blocking",
            f"{input_segments} wall-layer segments produced only {total} walls. "
            "That is almost always a unit error: at the wrong scale every segment "
            "falls below the minimum length and is filtered out, and the result is "
            "a valid, empty building." + options,
            total,
        ))
    elif total < MIN_WALLS:
        v.checks.append(Check(
            "walls-from-linework", "blocking",
            f"Only {total} walls. There is not enough here to build.", total,
        ))

    # ---- Pairing coverage --------------------------------------------------
    if total:
        fraction = paired / total
        if fraction < MIN_PAIRED_FRACTION:
            v.checks.append(Check(
                "paired-fraction", "warning",
                f"Only {paired} of {total} walls ({fraction:.0%}) formed from a face "
                "pair. The rest are single lines, which are more often railings and "
                "annotation than walls — rooms will be under-subdivided.",
                round(fraction, 3),
            ))
        else:
            v.checks.append(Check("paired-fraction", "info",
                                  f"{paired}/{total} paired", round(fraction, 3)))

    # ---- Thickness ---------------------------------------------------------
    thicknesses = [w.thickness for w in walls if w.paired]
    if thicknesses:
        median = sorted(thicknesses)[len(thicknesses) // 2]
        lo, hi = PLAUSIBLE_THICKNESS
        level = "info" if lo <= median <= hi else "blocking"
        v.checks.append(Check(
            "median-thickness", level,
            f"Median wall thickness {median:.3f} m"
            + ("" if level == "info" else " — outside anything buildable; the unit is wrong."),
            round(median, 4),
        ))

    # ---- Span --------------------------------------------------------------
    if walls:
        xs = [c for w in walls for c in (w.ax, w.bx)]
        ys = [c for w in walls for c in (w.ay, w.by)]
        span = max(max(xs) - min(xs), max(ys) - min(ys))
        lo, hi = PLAUSIBLE_SPAN
        level = "info" if lo <= span <= hi else "blocking"
        v.checks.append(Check(
            "plan-span", level,
            f"Longest plan dimension {span:.2f} m"
            + ("" if level == "info" else " — not a building."),
            round(span, 2),
        ))

    # ---- Enclosure ---------------------------------------------------------
    if not spaces:
        v.checks.append(Check(
            "enclosure", "warning",
            "No closed cycles, so no rooms. The walls do not enclose anything — "
            "this is corner-joining or missing partitions, not room detection.",
            0,
        ))
    else:
        biggest = max(s.area for s in spaces)
        v.checks.append(Check("enclosure", "info",
                              f"{len(spaces)} rooms, largest {biggest:.1f} m2",
                              len(spaces)))
        if biggest > 150:
            v.checks.append(Check(
                "room-size", "warning",
                f"Largest room is {biggest:.1f} m2. A room that big is usually "
                "several rooms whose dividing walls were not detected.",
                round(biggest, 1),
            ))

    # ---- Wall run against floor area ---------------------------------------
    # An independent check, and that is the whole point of it. Every other test
    # here interrogates the geometry using the geometry. This compares two
    # quantities the reconstruction derives SEPARATELY — total wall length and
    # enclosed floor area — so a fault that flatters one of them shows up as a
    # ratio that does not occur in real buildings.
    #
    # It is how the villa's compounded faults were caught from the cost side:
    # 1.82 m/m2 before, 1.21 after, against a normal band of 0.8-1.2 for Indian
    # residential. Neither number looks wrong alone.
    #
    # Billable length, not total: the derived perimeter is emitted whole so the
    # rooms close, and counting the duplicated ring here would make a correct
    # model look abnormal. See hypothesise/perimeter.py.
    if spaces and walls:
        floor = sum(s.area for s in spaces)
        billable = sum(w.length - getattr(w, "duplicate", 0.0) for w in walls)
        if floor > 5:
            ratio = billable / floor
            lo, hi = WALL_RUN_BAND
            level = "info" if lo <= ratio <= hi else "warning"
            v.checks.append(Check(
                "wall-run-per-area", level,
                f"{ratio:.2f} m of wall per m2 of floor"
                + ("" if level == "info" else
                   f" — outside the {lo}-{hi} band real buildings occupy. Either "
                   "walls are being counted twice or rooms are not all closing."),
                round(ratio, 3),
            ))

    # ---- Openings ----------------------------------------------------------
    if unhosted:
        total_found = len(openings) + unhosted
        level = "warning" if unhosted < total_found / 2 else "blocking"
        v.checks.append(Check(
            "openings-hosted", level,
            f"{unhosted} of {total_found} openings could not be placed on any wall. "
            "Those doors exist on the drawing and will not exist in the model, so "
            "the rooms they serve have no way in.",
            unhosted,
        ))
    elif openings:
        v.checks.append(Check("openings-hosted", "info",
                              f"all {len(openings)} openings hosted", 0))

    return v
