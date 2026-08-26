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

import re
from dataclasses import dataclass, field

from solve.site import segment_site

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

#: Below this share of a sheet's walls reaching a frame, say so.
#:
#: **CHOSEN, not measured**, and deliberately loose. A sheet legitimately
#: carries a title block, a north arrow, a key and a detail callout, and none of
#: those should reach a frame — so some loss is correct and a tight threshold
#: would cry wolf on every real drawing. The villa loses 19% to exactly that and
#: is fine. What this is watching for is the order of magnitude where a WING of
#: the building has been dropped, which is a bill of quantities for less
#: building than the client drew.
FRAMING_COVERAGE_MIN = 0.70

#: A gap in the room projection wider than this means the "building" is two.
#:
#: Room faces are interior-disjoint and share edges exactly, so a real
#: building's rooms TILE and its projection has no gap at all — measured 0.00 m
#: on both axes of the correct villa, against 2.48 m on the merged pair. The
#: only work this number does is clear floating-point noise, so a metre is
#: generous rather than fitted.
MIN_BUILDING_GAP = 1.0


def separated_room_groups(spaces) -> tuple[float, float] | None:
    """Largest empty projection band separating rooms, as (gap, extent)."""
    if len(spaces) < 2:
        return None

    for axis in (0, 1):
        spans = sorted(
            (min(p[axis] for p in s.loop), max(p[axis] for p in s.loop))
            for s in spaces if len(s.loop) >= 3
        )
        if len(spans) < 2:
            continue
        merged: list[list[float]] = []
        for lo_, hi_ in spans:
            if merged and lo_ <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], hi_)
            else:
                merged.append([lo_, hi_])

        extent = merged[-1][1] - merged[0][0]
        gap = max(
            (merged[i + 1][0] - merged[i][1] for i in range(len(merged) - 1)),
            default=0.0,
        )
        if gap > MIN_BUILDING_GAP and extent > 0:
            return gap, extent
    return None

#: Interior walls in residential construction. Outside this, the unit is wrong
#: or the pairing matched two unrelated lines.
PLAUSIBLE_THICKNESS = (0.05, 0.60)

#: A title that says the drawing is a SITE LAYOUT rather than a building.
#:
#: The qualifier carries the meaning, not the word "plan": `GROUND FLOOR PLAN`
#: and `SITE PLAN` differ only in what precedes it. `BLOCK - A FINAL CONCEPT
#: PLANS` is a real title in this corpus and must NOT match — hence the
#: requirement that the qualifier be immediately followed by plan/layout, which
#: it is not there.
#:
#: Names only. This decides nothing and changes no verdict; it explains one.
_SITE_TITLE = re.compile(
    r"\b(site|master|layout|key|location|block)\s+(plan|layout)\b", re.I,
)


def is_site_layout_title(title: str | None) -> bool:
    """
    Does this drawing's own title say it is a site layout, not a building?

    Used to EXPLAIN a finding, never to produce one. A site layout draws
    building footprints, plots, roads and levels; it carries no doors, because
    doors are not what it is for. So `openings-present` firing on one is a
    statement about which FRAME was chosen, not about opening detection — and a
    day went into reading it the other way on `SITE PLAN FOR 3D` while the
    title said `REVISED SITE PLAN` throughout.

    Deliberately NOT wired into frame ranking. Demoting a frame for its title
    would change frame selection across the whole corpus on the strength of one
    sheet, and a title is evidence rather than an answer — the same rule walls
    and plan titles already follow in this engine.
    """
    return bool(_SITE_TITLE.search(title or ""))

#: How many of a site's buildings to name in the finding before summarising the
#: rest. Presentation only — the full list always reaches `building.json`, and
#: nothing decides anything on this number. Six fits a terminal line-wrap; a
#: site sheet that yields forty would otherwise print a finding nobody reads.
BUILDINGS_LISTED = 6


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
    walls_dropped: int = 0,
    walls_before_framing: int = 0,
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

            # ── The numerator can now be split, so it is ────────────────────
            # This used to report TWO ratios and say why it could not choose:
            # the band was calibrated against a denominator including
            # everything the solver called a room, and on this villa 50.5% of
            # that is lawn, pool, patio and balcony — so 1.21 read as a
            # comfortable pass while the indoor figure was 2.53. Swapping in an
            # indoor-only denominator against an all-walls numerator would have
            # been a ratio between two different buildings, which is the exact
            # mismatch this check exists to catch.
            #
            # `Space.bounded_by` is populated now, so the numerator splits to
            # match the denominator and there is one honest ratio: indoor wall
            # against indoor floor. A wall counts as indoor if it bounds at
            # least one indoor room — a party wall between a bedroom and a
            # terrace is the bedroom's wall, and somebody builds and plasters it.
            #
            # The all-in figure stays in the message. It is what the band was
            # calibrated on, and a reader comparing against older output needs
            # to see both to know why they differ.
            indoor_walls = {
                i for s in spaces if not _is_outdoor(s)
                for i in getattr(s, "bounded_by", ())
            }
            outdoor_share = (1 - indoor_floor / floor) if floor else 0.0
            detail = ""

            if indoor_walls and indoor_floor > 1:
                indoor_billable = sum(
                    walls[i].length - getattr(walls[i], "duplicate", 0.0)
                    for i in indoor_walls if i < len(walls)
                )
                ratio = indoor_billable / indoor_floor
                level = "info" if lo <= ratio <= hi else "warning"
                detail = (f" — indoor wall against indoor floor"
                          f"; {billable / floor:.2f} counting the site, "
                          f"{outdoor_share * 100:.0f}% of which is outdoor")
            elif outdoor_share > 0.05 and indoor_floor > 1:
                # No attribution available: an older model, or one whose rooms
                # did not close. Fall back to reporting both and saying so,
                # rather than silently ratioing mismatched halves.
                detail = (f" ({billable / indoor_floor:.2f} against indoor floor "
                          f"alone; {outdoor_share * 100:.0f}% of the floor here "
                          "is outdoor; walls not attributed)")

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

    # ---- Is this one building, or two drawings called one? -----------------
    # The villa's two storeys were merged into a single flat model — 901 m of
    # wall, 505 m2 of floor, a Rs 3.25M bill for a building that does not
    # exist — and it PASSED THIS GATE. Every check here was satisfied because
    # each one was true of the merged pair: the walls paired, the thickness was
    # right, the span was plausible, the rooms enclosed.
    #
    # `solve/frames.py` now separates them, so this should never fire on the
    # villa again. It is defence in depth: framing is one heuristic and this is
    # a different question asked of the answer.
    #
    # The test is the same one framing uses, on rooms rather than walls: project
    # the room polygons onto each axis and look for a band no room crosses. A
    # building's rooms are contiguous in projection — a courtyard does not
    # create a gap, because rooms elsewhere at the same coordinate fill it. Two
    # plans on a sheet do.
    # Two rooms are enough. The guard was 4, on the reasoning that a building
    # needs several rooms before its shape means anything — but with an ABSOLUTE
    # gap test that reasoning does not hold: rooms of one building tile, so two
    # that do not touch are already two drawings, and requiring four only made
    # the check unable to fire on the smallest case it should catch.
    separated = separated_room_groups(spaces)
    if separated is not None:
        gap, extent = separated
        # An absolute gap, NOT a share of the extent. The first version of
        # this required the gap to exceed a quarter of the plan's extent and
        # missed the motivating case: 2.48 m across 32.67 m is only 7.6%.
        # Polygonized rooms tile a real building, so its projection has no
        # empty band; the metre threshold only clears floating-point noise.
        v.checks.append(Check(
            "one-building", "warning",
            f"the rooms fall into two groups {gap:.2f} m apart across "
            f"{extent:.2f} m of plan, with nothing between them. This is "
            "usually two drawings on one sheet reconstructed as one "
            "building — every quantity would then be for both.",
            round(gap / extent, 3),
        ))

    # ---- One building, or a site holding several? --------------------------
    # `one-building` above asks whether the rooms PROJECT into two groups, and
    # that is the right question for a sheet: two plans drawn side by side leave
    # a band no room crosses. It is the wrong question for a SITE, where the
    # villas are spread across the plot on both axes and their projections
    # interleave — so it stays silent on exactly the drawing that needs it most.
    #
    # `solve/site.py` asks a different question of the same model: which rooms
    # share a wall. The rooms of one building tile and therefore share; two
    # villas standing on a plot share nothing at all.
    #
    # Measured 2026-08-26 against four real drawings that verify clean today —
    # PLANS_FOR_3D, DOWN VILLA and two client uploads — every one returns
    # exactly ONE building. So this cannot fire on a model the engine already
    # accepts, which is the property that makes it safe to make blocking.
    #
    # Blocking, because a model presented as a building that is really six is
    # wrong in a way no downstream reader can detect: the floor area, the wall
    # run and the priced bill are all summed across structures that were never
    # one building, and each figure looks perfectly ordinary. Naming the
    # buildings is what makes it actionable rather than merely correct.
    #
    # ── Which components COUNT, and why it is names rather than size ────────
    # Measured 2026-08-26 on frame 2 of the site sheet, and it is the reason
    # this clause exists at all: that frame segments into 13 components, and 12
    # of them are the SAME repeated symbol — one room, exactly four walls, no
    # name, 1.78-2.00 m2, 3.33 m across. Blocking a real drawing because a
    # parking bay is stamped twelve times is a false positive, and it is the
    # one this check would otherwise have shipped.
    #
    # The discriminator is the drawing's own labelling, not magnitude. A size
    # or area floor would be a constant invented here, and `frames.py` is a long
    # argument about why constants like that do not survive the next drawing;
    # 3.33 m already clears `PLAUSIBLE_SPAN`, so span could not have done it.
    # `solve/layerscan.py` learned the same lesson and states it as a rule:
    # optimise NAMED rooms, not room count. A draughtsman names the rooms of
    # the buildings; nobody names a hatch rectangle.
    #
    # This fails in the safe direction. A genuine second building whose rooms
    # the drawing never names is a false NEGATIVE — the model verifies and the
    # reviewer is not stopped — and every component is still reported in
    # `model.site.buildings` for them to see. The opposite error stops real work
    # on a real drawing, which is worse.
    if spaces and walls:
        seg = segment_site(walls, spaces)
        named_buildings = [b for b in seg.buildings if b.named]
        if len(named_buildings) >= 2:
            listed = named_buildings[:BUILDINGS_LISTED]
            listing = "; ".join(
                f"#{b.index} {len(b.space_indices)} rooms, {b.area:.1f} m2, "
                f"{b.span:.1f} m across"
                for b in listed
            )
            rest = len(named_buildings) - len(listed)
            unnamed = seg.count - len(named_buildings)
            v.checks.append(Check(
                "site-scope", "blocking",
                f"This scope holds {len(named_buildings)} separate buildings — "
                "no two of them share a wall, so it is a site, not a building, "
                "and every quantity here is summed across all of them. Rebuild "
                f"one with --building N. {listing}"
                + (f"; and {rest} more" if rest > 0 else "")
                + (f". A further {unnamed} unnamed fragment(s) were found and "
                   "are not counted as buildings" if unnamed else "") + ".",
                len(named_buildings),
            ))
        else:
            # Said on the way past even when it passes, and it carries two
            # quantities rather than a bare "fine".
            #
            # The linework bounding NO room is the first: on a villa that is a
            # few stray metres, on a site sheet it is the roads, the plot lines
            # and the compound wall, and watching it grow is the earliest sign
            # that a scope has stopped being one building.
            #
            # The unnamed fragments are the second, and they are reported
            # precisely BECAUSE they were discounted above. A check that
            # silently drops what it decided not to count teaches the reader
            # that nothing was there.
            fragments = seg.count - len(named_buildings)
            v.checks.append(Check(
                "site-scope", "info",
                f"one building; {len(seg.site_wall_indices)} walls "
                f"({seg.site_wall_length:.1f} m) bound no room"
                + (f"; {fragments} unnamed fragment(s) not counted as buildings"
                   if fragments else ""),
                max(len(named_buildings), 1),
            ))

    # ---- How much linework never reached a frame ---------------------------
    # This check cannot compute its own quantity, and that is the point.
    #
    # `MIN_WALLS = 4` here is BELOW the framing floor of 8 in `solve/frames.py`,
    # so the wall-count check above is structurally unable to fire on framing
    # loss while any frame survives — the walls are dropped before `check()` is
    # ever handed a wall list, so from here they simply never existed. Raising
    # the constant would not help: the real quantity is walls LOST, and only the
    # caller can see it.
    #
    # So it is passed in. `cli.py` already computes it, and on the villa it is
    # 40 of 216 walls — 19% of the sheet's linework reaching no frame at all,
    # a number that previously existed nowhere.
    #
    # Usually correct to drop: title blocks, north arrows, stray callouts. The
    # dangerous case is a MISFIRED drop — a guard house that pairs to five
    # walls, or a layer choice that fragments a partitions-only plan — which
    # produces a bill of quantities for less building than the client drew, with
    # nothing anywhere that moves. Reported always, warned past a threshold,
    # never blocking: a sheet legitimately carrying a title block and a north
    # arrow should not fail.
    # `walls_before_framing` is passed rather than derived as
    # `total + walls_dropped`, and the difference is not pedantry: `total` is the
    # wall list AFTER per-frame layer re-selection and `add_perimeter`, which is
    # a different SET from the one framing chose between. Deriving the
    # denominator gave 24% here against the 19% the caller reports for the same
    # quantity — two numbers for one thing, which is the shared-basis trap this
    # file exists to catch, reintroduced by a check written to catch it.
    if walls_dropped > 0 and walls_before_framing > 0:
        framed = walls_before_framing
        coverage = (framed - walls_dropped) / framed
        level = "info" if coverage >= FRAMING_COVERAGE_MIN else "warning"
        v.checks.append(Check(
            "framing-coverage", level,
            f"{walls_dropped} of {framed} walls ({(1 - coverage) * 100:.0f}%) "
            f"reached no frame"
            + ("" if level == "info" else
               f" — past {(1 - FRAMING_COVERAGE_MIN) * 100:.0f}%. Usually a title "
               "block or a north arrow; if it is a wing of the building, the "
               "quantities are for less building than the drawing shows."),
            round(coverage, 3),
        ))

    return v
