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

#: Walls the engine derived rather than read off the drawing.
DERIVED_PERIMETER = "<derived:perimeter>"

#: Below this, a plan with several rooms is being read at the wrong unit.
#:
#: Measured across the drawings here, largest room against the unit chosen:
#:
#:     58.1 m2   DOWN VILLA            unit measured from wall thickness
#:     70.3 m2   REDDY - SITE PLAN     unit measured from wall thickness
#:     82.7 m2   SITE PLAN FOR 3D      unit measured from wall thickness
#:      6.9 m2   LATEST DRAWINGS       unit taken from the header, cm  <- wrong
#:
#: The gap is an order of magnitude, so 10 m2 is not a fine judgement. A living
#: room, a bedroom or a garage clears it in any dwelling; nothing does in a plan
#: read a hundred times too small.
MIN_LARGEST_ROOM = 10.0

#: One tiny room is a legitimate model — a single toilet, a plant enclosure, a
#: guard hut. Several tiny rooms and nothing else is a scale error. Four is
#: where a plan stops being plausibly one small structure, and it is what keeps
#: this off SITE PLAN WITH GARDEN LEVELS, which solves 2 rooms and is too thin
#: a model to judge either way.
MIN_ROOMS_TO_JUDGE_SCALE = 4

#: How much of the solved indoor floor a derived envelope must contain before
#: it is worth calling an envelope.
#:
#: ── Set on principle, because the evidence is thin and says so ───────────────
#: Measured across every drawing here that produces a ring at all:
#:
#:     0.057  REDDY - SITE PLAN FOR 3D
#:     0.299  SITE PLAN FOR 3D 16-02-24
#:     0.459  DOWN VILLA -WD 22-1-24
#:     1.000  LATEST DRAWINGS - SITE PLAN & ALL VILLAS
#:
#: One good example is not a sample to fit a threshold to, so this is not fitted
#: to it. A building envelope must contain the floor it encloses; one that
#: leaves out a tenth of it is wrong about the building's outline, and the villa
#: leaves out more than half. 0.90 states that and does not pretend to be
#: derived from four numbers.
#:
#: This warns on three of those four. That is not a mis-set band — it is the
#: finding. `add_perimeter` closes at CLOSE_RADIUS = 1.0, which bridges a
#: doorway but comes nowhere near spanning a 4-6 m room, so what it returns is
#: the wall network thickened rather than a footprint. On the villa its boundary
#: runs THROUGH the building, missing BED ROOM, SERVANT ROOM, HOME OFFICE and
#: two wet rooms by 0.5 to 1.5 m.
#:
#: Reported rather than enforced, and the ratio is emitted whether it passes or
#: fails: a quantity surveyor can act on "the envelope contains 46% of the floor
#: it encloses" and can do nothing at all with a flag. Refusing the ring instead
#: was tried and abandoned — every quantity computable at derivation time was
#: measured and none of them predict this one, because the floor it is supposed
#: to contain is precisely what the solve produces afterwards.
ENVELOPE_COVERAGE_MIN = 0.90

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


def _is_outdoor(space) -> bool:
    """
    Is this space outside the building?

    Delegates to the schedule's own test rather than repeating it. `kind` alone
    is not enough and neither is the name: this villa has an OFFICE PATIO whose
    kind is "study" and an "Enclosed Balcony" whose kind is "outdoor", so the
    two signals disagree in both directions. Classifying on kind alone puts
    27 m2 of patio inside the building.

    Delegating matters more than the rule. The bill and the room schedule split
    indoor from outdoor with this exact predicate, and an area totalled here
    against a cost computed there must not be able to disagree about what a room
    is — which is the same shared-basis failure that produced two different
    duplication measures earlier in this project.

    Imported inside the function: `solve` is the lower layer and importing
    `quantify` at module scope would invert that, for a predicate only two
    checks need.
    """
    from quantify.schedules import _is_outdoor as classify

    return classify({
        "kind": getattr(space, "kind", "") or "",
        "name": getattr(space, "name", "") or "",
    })


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
        elif len(spaces) >= MIN_ROOMS_TO_JUDGE_SCALE and biggest < MIN_LARGEST_ROOM:
            # The mirror of the check above, and it catches something the rest
            # of this file cannot see. A wrong unit shrinks the plan LINEARLY
            # but the rooms QUADRATICALLY, so a drawing read at centimetres
            # arrives looking entirely reasonable — 12.35 m across, 11 rooms,
            # 0.074 m walls, every existing check passing — while its largest
            # room is 6.87 m2 and its average is 4.98.
            #
            # Span cannot catch that: 12.35 m is an ordinary small building.
            # Thickness cannot either: 0.074 m sits inside PLAUSIBLE_THICKNESS,
            # as does the 0.092 m the same drawing yields if read as inches.
            # Area is the only one of the three where a factor of 100 becomes a
            # factor of 10,000, which is why this is worth a separate check
            # rather than a wider band on either of the others.
            v.checks.append(Check(
                "room-size", "warning",
                f"{len(spaces)} rooms and the largest is only {biggest:.1f} m2. "
                "A building with this many rooms has at least one bigger than "
                f"{MIN_LARGEST_ROOM:.0f} m2, so the drawing is probably being "
                "read at the wrong unit — every area and quantity below is then "
                "wrong by the square of that factor.",
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
        indoor_floor = sum(s.area for s in spaces if not _is_outdoor(s))
        billable = sum(w.length - getattr(w, "duplicate", 0.0) for w in walls)
        if floor > 5:
            ratio = billable / floor
            lo, hi = WALL_RUN_BAND
            level = "info" if lo <= ratio <= hi else "warning"

            # Say which floor. The band was calibrated against a denominator
            # that includes everything the solver called a room, and on this
            # villa 50.5% of that is lawn, pool, patio and balcony — so 1.21
            # reads as a comfortable pass while the indoor figure is 2.53.
            #
            # Both are reported rather than one being swapped in, because
            # neither is the whole answer: the numerator cannot be split to
            # match. Attributing wall run to the spaces it bounds needs
            # `Space.boundedBy`, which is present on every space and populated
            # on none. Until it is, an indoor-only denominator against an
            # all-walls numerator is a ratio between two different buildings —
            # exactly the mismatch this check exists to catch, introduced by
            # the fix for it.
            outdoor_share = (1 - indoor_floor / floor) if floor else 0.0
            detail = ""
            if outdoor_share > 0.05 and indoor_floor > 1:
                detail = (f" ({billable / indoor_floor:.2f} against indoor floor "
                          f"alone; {outdoor_share * 100:.0f}% of the floor here "
                          "is outdoor)")

            v.checks.append(Check(
                "wall-run-per-area", level,
                f"{ratio:.2f} m of wall per m2 of floor{detail}"
                + ("" if level == "info" else
                   f" — outside the {lo}-{hi} band real buildings occupy. Either "
                   "walls are being counted twice or rooms are not all closing."),
                round(ratio, 3),
            ))

    # ---- Does the derived envelope contain the building? --------------------
    # The ring exists to supply the outer boundary an open-plan drawing does not
    # draw, and everything downstream trusts it to be one: rooms close against
    # it, its length is priced, and it is extruded into every render. Nothing
    # checked that it went round the building.
    #
    # Faces are unioned rather than summed, so a courtyard — a legitimate hole —
    # is filled rather than counted against the envelope. Indoor floor only: a
    # correct envelope excludes the lawn, and on this villa it does, getting 7
    # of 8 outdoor labels right. It is the indoor half it fails.
    ring = [w for w in walls if getattr(w, "layer", "") == DERIVED_PERIMETER]
    indoor = [s for s in spaces if not _is_outdoor(s)]
    if ring and indoor:
        from shapely.geometry import LineString, Polygon
        from shapely.ops import polygonize, unary_union

        lines = [
            LineString([(w.ax, w.ay), (w.bx, w.by)])
            for w in ring
            if w.length > 1e-6
        ]
        faces = list(polygonize(unary_union(lines))) if lines else []

        rooms = []
        for space in indoor:
            if len(space.loop) < 3:
                continue
            poly = Polygon([(p[0], p[1]) for p in space.loop])
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_empty:
                rooms.append(poly)

        if faces and rooms:
            envelope = unary_union(faces)
            floor = unary_union(rooms)
            if floor.area > 1.0:
                covered = floor.intersection(envelope).area / floor.area
                level = "info" if covered >= ENVELOPE_COVERAGE_MIN else "warning"
                v.checks.append(Check(
                    "envelope-coverage", level,
                    f"The derived envelope contains {covered * 100:.0f}% of the "
                    f"{floor.area:.0f} m2 of indoor floor it encloses"
                    + ("" if level == "info" else
                       f" — below {ENVELOPE_COVERAGE_MIN * 100:.0f}%. Its "
                       "boundary runs through the building rather than around "
                       "it, so any quantity or classification that depends on "
                       "being inside or outside it is unsafe."),
                    round(covered, 3),
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
