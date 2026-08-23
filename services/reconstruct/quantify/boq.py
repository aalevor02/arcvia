"""
A bill of quantities from the model, priced.

── Why this is worth more than it looks ────────────────────────────────────────
A practice does this by hand today, off the same drawing, in a spreadsheet with
no dates on it. Every number below already exists in `building.json` — wall
lengths, thicknesses, room areas, opening sizes — because the reconstruction had
to measure them to build the geometry. Nothing new is extracted. This is
arithmetic over data already stored, which is why it is days of work rather than
weeks, and why no visualisation competitor offers it: none of them has the
geometry to derive it from.

── What it deliberately does not do ────────────────────────────────────────────
It is not a structural take-off. There is no reinforcement schedule, because the
model has no beams, columns or slabs designed — only walls, floors and openings.
Steel appears here only where a quantity follows from what *is* modelled (lintels
over openings), and the report says so rather than quietly omitting the largest
line in a real BOQ.

Every derived quantity states its own rule in the output. A number a quantity
surveyor cannot check is a number they will not use.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from .rates import RateLibrary, Rate

#: The brick the rate library actually prices, and the bed it is laid on.
#:
#: ── Why both figures are derived from these rather than asserted ────────────
#: The first version carried MORTAR_FRACTION = 0.30 *and* a brick volume of
#: 9.5 x 4.5 x 3.5 inches — a brick with its mortar bed already included. So the
#: count divided a volume that had already had 30% taken out for mortar by a
#: unit that also contained mortar, and deducted it twice. The brick count came
#: out about a quarter low, and nothing about it looked wrong: it is a large
#: number nobody has an instinct for, in a bill full of large numbers.
#:
#: Two constants that have to agree about the same physical fact will eventually
#: stop agreeing. Deriving both from the brick and the bed makes that impossible
#: — change either dimension and the count and the mortar volume move together.
#:
#: 9 x 4 x 3 inches is what `Red Clay Brick` in the library is specified as.
BRICK_NOMINAL_M = (0.2286, 0.1016, 0.0762)
MORTAR_BED_M = 0.010

_BRICK_ONLY_M3 = BRICK_NOMINAL_M[0] * BRICK_NOMINAL_M[1] * BRICK_NOMINAL_M[2]
_BRICK_UNIT_M3 = (
    (BRICK_NOMINAL_M[0] + MORTAR_BED_M)
    * (BRICK_NOMINAL_M[1] + MORTAR_BED_M)
    * (BRICK_NOMINAL_M[2] + MORTAR_BED_M)
)

#: How much of a cubic metre of brickwork is mortar. ~23% for a 10 mm bed on
#: this brick — close to the 0.30 the tables quote for larger beds, and derived
#: rather than quoted so it always matches the brick above.
MORTAR_FRACTION = 1 - (_BRICK_ONLY_M3 / _BRICK_UNIT_M3)

#: Cement mortar 1:6 — bags of cement and cubic metres of sand per m3 of mortar.
CEMENT_BAGS_PER_M3_MORTAR = 4.5
SAND_M3_PER_M3_MORTAR = 0.9

#: Plaster, both faces, 12 mm internal.
PLASTER_THICKNESS = 0.012

#: Metres of wall per square metre of floor, outside which a bill is marked.
#:
#: ── An independent measurement, which is why it is worth having ─────────────
#: Wall run and floor area are derived separately — one from the wall graph, one
#: from the room polygons — so comparing them checks the reconstruction against
#: itself using nothing the arithmetic here depends on. Indian residential sits
#: around 0.8-1.2; the band is wider because an unusually cellular or unusually
#: open plan is atypical, not wrong.
#:
#: It found the fault it was written for before it existed. The villa read 1.82
#: with two storeys merged and the perimeter double-counted, and 1.21 once both
#: were fixed — the ratio moved when neither the geometry nor the prices did.
#:
#: The same band and the same basis as `solve/verify.py`'s `wall-run-per-area`,
#: on purpose. Two checks of one quantity that disagree about what is normal are
#: worse than either alone. This one is not redundant with it: the engine's is a
#: note on the shape, and this is a stamp that travels on the bill.
WALL_RUN_BAND = (0.6, 1.6)

#: Bulk densities, tonnes per cubic metre, for converting a measured volume into
#: a rate quoted by weight.
#:
#: ── Why this exists at all ──────────────────────────────────────────────────
#: Sand is quantified in m3 because that is what a mortar ratio gives you, and
#: sold in tonnes because that is what a lorry weighs. The bill was multiplying
#: a volume by a per-tonne rate and reporting the result as money — an error of
#: the density, about 1.6x, in the direction of undercharging.
#:
#: Nothing detected it because both numbers were individually right. The
#: quantity was a correct volume, the rate was a correct price, and neither
#: knew what the other was measured in.
BULK_DENSITY_T_PER_M3 = {
    "sand": 1.60,
    "aggregate": 1.50,
    "stone": 1.60,
    "earth": 1.55,
}

#: Conversions between the units this bill produces and the units rates are
#: quoted in. Keyed (from, to).
UNIT_CONVERSIONS: dict[tuple[str, str], float] = {
    ("m²", "sq ft"): 10.7639,
    ("sq ft", "m²"): 1 / 10.7639,
    ("m", "rmt"): 1.0,
    ("rmt", "m"): 1.0,
    ("metre", "rmt"): 1.0,
    ("m³", "cft"): 35.3147,
    ("cft", "m³"): 1 / 35.3147,
}



@dataclass
class Line:
    """One priced line, with the rule that produced the quantity."""

    section: str
    description: str
    quantity: float
    unit: str
    rate: Rate | None
    rule: str
    amount: float = 0.0
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "section": self.section,
            "description": self.description,
            "quantity": round(self.quantity, 3),
            "unit": self.unit,
            "rateId": self.rate.id if self.rate else None,
            "rate": round(self.rate.base, 2) if self.rate else None,
            "rateUnit": self.rate.unit if self.rate else None,
            "rateDate": self.rate.rate_date.isoformat() if self.rate and self.rate.rate_date else None,
            "amount": round(self.amount, 2),
            "rule": self.rule,
            "note": self.note,
        }


@dataclass
class Costing:
    lines: list[Line] = field(default_factory=list)
    unpriced: list[Line] = field(default_factory=list)
    band: str = "base"

    #: Set when the model's scale was not confirmed by more than one source.
    #:
    #: ── A model is a shape; a schedule is a claim ───────────────────────────
    #: The distinction is not mine — it came from the session that owns the
    #: reconstruction engine, and it settles where scale confidence belongs.
    #:
    #: A GLB at the wrong scale is a shape you can look at and say "that is not
    #: seven metres". A bill of quantities at the wrong scale is a number
    #: somebody orders bricks against. So the geometry is allowed through with a
    #: warning and every figure that asserts a dimension is stamped here.
    #:
    #: Refusing outright was considered and rejected for a better reason than
    #: convenience: most drawings print few dimensions an OCR can read — both
    #: Avarana plans yielded exactly one — so a hard block would teach users to
    #: pass a hand-typed scale, which has no provenance at all. A marked
    #: estimate beats an unmarked assertion.
    provisional: bool = False
    provisional_reason: str = ""

    #: EVERY reason, not just the first.
    #:
    #: ── What a single reason string was hiding ──────────────────────────────
    #: `provisional_reason` is set with `or`, so the first cause to fire wins and
    #: the rest never reach the surface. That was fine with two causes and is not
    #: with five: the villa is simultaneously one storey of eight AND has 42% of
    #: its wall run unmeasured, and a reader was shown only the first. Fixing one
    #: and re-running would then reveal a second problem that had been there all
    #: along, which reads like a new fault and is not.
    #:
    #: The single string stays as the headline so nothing downstream breaks, and
    #: every cause is listed here. Same principle as `unpriced` and
    #: `undetermined`: a thing that was found must not be invisible because
    #: something else was found first.
    provisional_reasons: list[str] = field(default_factory=list)

    #: Metres of wall whose thickness was DEFAULTED, not measured. Priced at
    #: nothing and reported in metres — see `_wall_volumes`.
    unmeasured_run: float = 0.0

    #: Metres excluded as too thin to be built at all. Reported so the exclusion
    #: is visible rather than being a quiet subtraction.
    unbuildable_run: float = 0.0

    #: Metres of wall per m2 of floor. Reported whether or not it is in band,
    #: because a reader checking a bill wants the number, not only the verdict.
    #: None when there was no enclosed floor area to divide by. NOT 0.0 — that
    #: reads as a measured ratio of zero and hides a check that never ran.
    wall_run_per_area: float | None = None

    @property
    def total(self) -> float:
        return sum(line.amount for line in self.lines)

    def oldest_rate_days(self, today: date | None = None) -> int | None:
        ages = [
            line.rate.age_days(today)
            for line in self.lines
            if line.rate and line.rate.age_days(today) is not None
        ]
        return max(ages) if ages else None

    def as_dict(self, today: date | None = None) -> dict:
        by_section: dict[str, float] = {}
        for line in self.lines:
            by_section[line.section] = by_section.get(line.section, 0.0) + line.amount

        stamped = [
            {**line.as_dict(), "provisional": self.provisional} for line in self.lines
        ]

        return {
            "band": self.band,
            # Stamped on the envelope AND on every line. A total gets copied
            # into an email; a line gets copied into a purchase order. Marking
            # only the envelope means the mark is lost at exactly the point the
            # number becomes an instruction to a supplier.
            "provisional": self.provisional,
            "provisionalReason": self.provisional_reason,
            "provisionalReasons": self.provisional_reasons,
            "wallRunPerArea": self.wall_run_per_area,
            "unmeasuredRun": self.unmeasured_run,
            "unbuildableRun": self.unbuildable_run,
            "total": round(self.total, 2),
            "currency": "INR",
            "bySection": {k: round(v, 2) for k, v in sorted(by_section.items())},
            "lines": stamped,
            # Never dropped. A BOQ that silently omits what it could not price
            # is a BOQ that is quietly too cheap, and the omission is invisible
            # precisely where it matters most.
            "unpriced": [line.as_dict() for line in self.unpriced],
            "oldestRateDays": self.oldest_rate_days(today),
            "caveats": [
                "Walls, floors and openings only. No structural take-off: the model "
                "has no designed beams, columns or slabs, so reinforcement is absent "
                "except for lintels over openings.",
                "Quantities are gross of openings only where stated. Every line "
                "carries the rule that produced it.",
                "Rates are Hyderabad market references with wastage and GST applied. "
                "Check `oldestRateDays` before quoting.",
            ],
        }



def _building_elements(model: dict) -> dict:
    """
    The WHOLE building's walls, spaces and openings — every storey.

    A bill of quantities that reads `elements.*` directly prices the primary
    storey only, which on a two-storey villa is a bill for half the masonry a
    client will be charged for. Storey blocks concatenate here; on a
    single-storey model this is `model["elements"]` unchanged. Fixtures are
    deliberately absent — nothing in this module reads them.
    """
    from solve.storeys import element_blocks

    walls, spaces, openings = [], [], []
    for _tag, elements in element_blocks(model):
        # An opening hosts on a wall BY INDEX into its own storey's list, so
        # concatenation must carry the offset or every upper-storey door
        # re-hosts onto a ground-floor wall. (`boundedBy` on spaces has the
        # same local meaning; nothing in this module reads it, and a consumer
        # that does must work per block, not on this concatenation.)
        offset = len(walls)
        walls.extend(elements.get("walls", []))
        spaces.extend(elements.get("spaces", []))
        for opening in elements.get("openings", []):
            host = opening.get("wall")
            if isinstance(host, int) and offset:
                opening = {**opening, "wall": host + offset}
            openings.append(opening)
    return {"walls": walls, "spaces": spaces, "openings": openings}

def _flag(costing: "Costing", reason: str) -> None:
    """
    Mark the bill provisional and RECORD the reason alongside any others.

    Every caller used `costing.provisional_reason = costing.provisional_reason or
    (...)`, which keeps the first cause and silently discards the rest. With five
    causes that is a bill reporting a fifth of what is wrong with it.
    """
    costing.provisional = True
    if reason not in costing.provisional_reasons:
        costing.provisional_reasons.append(reason)
    if not costing.provisional_reason:
        costing.provisional_reason = reason


def _reconcile(
    quantity: float, unit: str, rate_unit: str, terms: tuple[str, ...]
) -> tuple[float | None, str]:
    """
    The quantity expressed in the rate's unit, or None if it cannot be.

    Returns the converted quantity and a note describing the conversion, so the
    line's own rule records it. A conversion that happens invisibly is only
    marginally better than the mismatch it replaced — a quantity surveyor
    checking a bill needs to see that 29.8 m3 became 47.7 t and why.
    """
    if not rate_unit or unit == rate_unit:
        return quantity, ""

    factor = UNIT_CONVERSIONS.get((unit, rate_unit))
    if factor:
        return quantity * factor, f"{quantity:.2f} {unit} -> {rate_unit} x{factor:.4f}"

    # Volume to weight, which needs to know what the material is. Taken from the
    # search terms rather than a parameter: the caller already said "m-sand", and
    # asking it to say "sand" again is a second place for the two to disagree.
    if unit in ("m³", "m3") and rate_unit == "tonne":
        haystack = " ".join(terms).lower()
        for material, density in BULK_DENSITY_T_PER_M3.items():
            if material in haystack:
                return (
                    quantity * density,
                    f"{quantity:.2f} m3 -> {quantity * density:.2f} t "
                    f"at {density} t/m3",
                )

    return None, ""


#: The thickness `hypothesise/pair.py` assigns when it could NOT measure one,
#: and the confidence it stamps alongside. A wall carrying both was never
#: measured; it was defaulted.
#:
#: ── Why both, and never either alone ────────────────────────────────────────
#: Measured on the villa, the two populations are cleanly separable and only
#: jointly:
#:
#:     thickness 0.1150  confidence 0.40  paired False   35 walls   defaulted
#:     thickness 0.1150  confidence 1.00  paired True     8 walls   really 115 mm
#:
#: Excluding on thickness alone throws away eight genuinely measured 115 mm
#: partitions. Excluding on the `paired` flag alone is worse: it is a statement
#: about how the reading went, not about whether the number is real, and 40 m of
#: unpaired run has since been confirmed as masonry face by the drawing's own
#: hatch. The pair is the evidence; either half on its own is a proxy.
UNMEASURED_THICKNESS = 0.115
UNMEASURED_CONFIDENCE = 0.5

#: Below this, in metres, nothing is built. 100 mm is the thinnest stud
#: partition, and `ingest/raster.py` already reasons from the same figure.
#:
#: What this excludes, measured: nine paired segments between 45 mm and 95 mm,
#: 12.13 m and 2.235 m3, worth INR 22,960. One is a 6.53 m member at 66 mm on
#: A5 FALSE CEILING — a shadow gap or cornice profile that paired cleanly and
#: became a wall. They carry confidence 1.0, so they are not low-confidence
#: readings; they are high-confidence readings of something that is not a wall.
MIN_BUILDABLE_THICKNESS = 0.10

#: Share of total wall run that may carry a defaulted thickness before the bill
#: is stamped provisional for it. See where it is applied for why 5%.
UNMEASURED_RUN_TRIP = 0.05


@dataclass
class WallTake:
    """What the wall graph yields, split by what can be justified."""

    #: Priced. Thickness measured off two faces and thick enough to build.
    volume: float = 0.0
    face_area: float = 0.0
    run: float = 0.0

    #: Reported in METRES and priced at zero — see `_wall_volumes`.
    unmeasured_run: float = 0.0
    #: Excluded as unbuildable, reported so the exclusion is visible.
    unbuildable_run: float = 0.0
    unbuildable_volume: float = 0.0

    @property
    def total_run(self) -> float:
        return self.run + self.unmeasured_run + self.unbuildable_run


def _unmeasured(wall: dict) -> bool:
    """Was this wall's thickness defaulted rather than measured?"""
    thickness = float(wall.get("thickness", 0.23))
    confidence = float(wall.get("confidence", 1.0))
    return (
        abs(thickness - UNMEASURED_THICKNESS) < 1e-6
        and confidence <= UNMEASURED_CONFIDENCE
    )


def _wall_volumes(model: dict, height: float) -> WallTake:
    """
    Masonry volume, wall face area, and run — net of openings, split by evidence.

    ── Why a defaulted thickness must not become money ────────────────────────
    `pair.py` assigns 0.115 m when it cannot find a wall's second face. That is a
    placeholder so the geometry has something to extrude. Multiplying it by a
    length, a height and a rate turns it into a rupee figure indistinguishable
    from one derived from a measurement, and on this villa it is 42% of the run.

    Three sessions and seven investigating agents spent a day deciding whether
    those metres should be billed thicker or not at all, and the answer is that
    the question is unanswerable from the drawing: of 127.87 m, roughly 52 m is a
    sheet border and a swimming pool, 40 m is confirmed masonry face by the
    drawing's own hatch, and 36 m remains genuinely unknown after six independent
    discriminators were measured and all six failed.

    So this stops answering it. Defaulted walls leave the money entirely and are
    reported as METRES OF RUN with no price, which is the one honest statement
    available: "there are 127.87 m of wall here whose thickness nobody measured".
    A quantity surveyor can act on that. They cannot act on a total that has
    quietly averaged a guess into it.

    This is the fourth instance of one principle in this module and its
    neighbours — `unpriced` for lines with no rate, `undetermined` for daylight
    with no window, `None` for a ratio with no floor area, and now run with no
    measured thickness. Each began as a number that looked computed and was not.
    """
    building = _building_elements(model)
    walls = building["walls"]
    openings = building["openings"]

    take = WallTake()

    for wall in walls:
        a, b = wall["a"], wall["b"]
        length = ((b["x"] - a["x"]) ** 2 + (b["y"] - a["y"]) ** 2) ** 0.5
        thickness = float(wall.get("thickness", 0.23))

        # Charge on the billable length, not the built length.
        #
        # ── Two lengths that are both correct ───────────────────────────────
        # `add_perimeter` derives the building envelope, and on a drawing whose
        # exterior is unpaired single lines that ring IS the outer boundary —
        # remove it and the rooms stop closing. So the geometry needs the whole
        # ring, and most of it lies on top of walls that were already there.
        # Measured on the villa: 341.4 m derived, 310.8 m of it within a wall
        # thickness of a real wall. Coincident walls render on top of each
        # other, so nothing about the model looks wrong — and half the masonry
        # in the bill was for wall that gets built once.
        #
        # `duplicate` is per segment and 0.0 for anything actually drawn, so a
        # model predating the fix costs exactly as it did before.
        duplicate = float(wall.get("duplicate", 0.0))
        billable = max(length - duplicate, 0.0)

        # Sorted before it is counted. A wall that fails either test contributes
        # its LENGTH to the report and nothing at all to the money — no volume,
        # no face area, so no brick, mortar, plaster or paint follows from it.
        if _unmeasured(wall):
            take.unmeasured_run += billable
            continue

        if thickness < MIN_BUILDABLE_THICKNESS:
            take.unbuildable_run += billable
            take.unbuildable_volume += billable * thickness * height
            continue

        take.run += billable
        take.volume += billable * thickness * height
        # Two faces per wall, for plaster and paint.
        take.face_area += 2 * billable * height

    hole_area = 0.0
    hole_volume = 0.0
    for opening in openings:
        width = float(opening.get("width", 0))
        opening_height = float(opening.get("height", 2.1))
        thickness = float(opening.get("thickness", 0.23))
        hole_area += width * opening_height
        hole_volume += width * opening_height * thickness

    take.volume = max(take.volume - hole_volume, 0.0)
    take.face_area = max(take.face_area - 2 * hole_area, 0.0)
    return take


def build(
    model: dict,
    library: RateLibrary,
    height: float = 2.7,
    band: str = "base",
    masonry: str = "brick",
) -> Costing:
    """Quantities from the reconstruction, priced against the library."""
    costing = Costing(band=band)

    # Scale confidence travels with the model, so the schedule inherits it
    # without the caller having to remember to pass it. A raster import states
    # it; a DXF has no `scale.trustworthy` key and is trusted, because a CAD
    # drawing's units come from the file rather than from reading a photograph.
    # The two intake paths disagree about what `scale` is: the DXF path stores a
    # bare float (metres per drawing unit, taken from the file header), the
    # raster path a dict carrying its own confidence. Reading it as a dict
    # unconditionally raises on every DXF model — which would have made this
    # check fire exclusively on the path that needs it least.
    scale = model.get("scale")
    scale = scale if isinstance(scale, dict) else {}

    if scale.get("trustworthy") is False:
        _flag(costing, (
            scale.get("warning")
            or "The model's scale was not confirmed against a second source."
        ))

    # A model built from more than one storey on a single slab doubles every
    # quantity below, and nothing in the arithmetic can notice. Detected by the
    # reconstruction's own frame segmentation; surfaced here because this is
    # where the doubling turns into an order for twice the bricks.
    # This bill covers ONE drawing on the sheet.
    #
    # ── Why that needs saying out loud ──────────────────────────────────────
    # The frame segmenter used to merge a villa's two storeys, drawn 2.48 m
    # apart, into a single flat building — which made every quantity here about
    # double. That is fixed: the sheet now resolves into separate frames and one
    # of them is reconstructed.
    #
    # The fix moves the danger rather than removing it. A bill built from frame
    # 0 of 8 is a bill for one storey of a two-storey house, and it is *correct*
    # — correctly half of what the client is going to build. Nothing in the
    # arithmetic can tell, because a single storey costed accurately looks
    # exactly like a whole building costed accurately. Somebody quotes half a
    # house and finds out on site.
    frames = model.get("frames")
    used = model.get("frameUsed")
    index = used.get("index") if isinstance(used, dict) else used

    if isinstance(frames, list) and len(frames) > 1:
        origin = (frames[index].get("origin") if isinstance(index, int)
                  and 0 <= index < len(frames) and isinstance(frames[index], dict)
                  else None)
        _flag(costing, (
            f"This is drawing {(index if isinstance(index, int) else 0) + 1} of "
            f"{len(frames)} on the sheet"
            + (f" ({origin})" if origin else "")
            + ". If the others are further storeys of the same building, this "
            "bill covers one of them."
        ))

    def add(section, description, quantity, unit, rule, *terms, tier=None, note=""):
        rate = library.find(*terms, tier=tier)
        line = Line(section, description, quantity, unit, rate, rule, note=note)

        if not rate:
            line.note = note or "no rate matched"
            costing.unpriced.append(line)
            return line
        if quantity <= 0:
            line.note = note or "zero quantity"
            costing.unpriced.append(line)
            return line

        # The quantity and the rate must be in the same unit, and until now
        # nothing checked.
        #
        # ── The silent multiplication this closes ───────────────────────────
        # Mortar sand was quantified in m3, because that is what a mix ratio
        # gives you, and priced against a rate quoted per tonne, because that is
        # how sand is sold. The bill multiplied the two and printed the result
        # as rupees. Both numbers were individually correct — a correct volume
        # and a correct price — and neither carried what it was measured in, so
        # the product was wrong by the density and looked like money.
        #
        # Converting where a conversion exists and REFUSING where one does not
        # is the point. A line that cannot be reconciled goes to `unpriced`,
        # which the report prints, rather than being quietly priced in the wrong
        # unit — the difference between a bill that is short and a bill that
        # says it is incomplete.
        priced_quantity, conversion = _reconcile(quantity, unit, rate.unit, terms)
        if priced_quantity is None:
            line.note = (
                f"quantity is in {unit} but the rate is per {rate.unit}, "
                "and no conversion is defined"
            )
            costing.unpriced.append(line)
            return line

        line.amount = rate.cost(priced_quantity, band)
        if conversion:
            line.rule = f"{line.rule}; {conversion}"
        costing.lines.append(line)
        return line

    take = _wall_volumes(model, height)
    volume, face_area, run = take.volume, take.face_area, take.run
    costing.unmeasured_run = round(take.unmeasured_run, 2)
    costing.unbuildable_run = round(take.unbuildable_run, 2)

    # THE STAMP IS THE DELIVERABLE HERE, NOT THE TOTAL.
    #
    # ── Why a share of run rather than a share of money ─────────────────────
    # Defaulted walls contribute nothing to the total, so measuring their
    # importance in rupees would report zero however much of the building they
    # are. Run is the quantity that still exists when the price does not.
    #
    # On the villa this fires at 42% — 127.87 m of 305.15 m has no measured
    # thickness. The honest headline for that model is not a corrected figure;
    # it is "two fifths of the wall run was never measured", which tells the
    # reader the bill is a floor rather than an estimate.
    #
    # 5% because a handful of stranded faces is normal on any drawing and does
    # not change how a bill should be read, while anything approaching a tenth
    # does.
    if take.total_run > 0:
        share = take.unmeasured_run / take.total_run
        if share > UNMEASURED_RUN_TRIP:
            _flag(costing, (
                f"{take.unmeasured_run:.1f} m of {take.total_run:.1f} m of wall "
                f"({share:.0%}) has no measured thickness — the reader could not "
                "find a second face, so a default was used. Those metres are "
                "reported and NOT priced, which makes this total a floor rather "
                "than an estimate. The drawing has to be checked before quoting."
            ))
    building = _building_elements(model)
    rooms = building["spaces"]
    openings = building["openings"]

    # Ground is not floor.
    #
    # ── The error this prevents ─────────────────────────────────────────────
    # Costed naively, the villa's four LAWN spaces and two OFFICE PATIOs came to
    # 93 m2 of vitrified floor tiling. Tiling the lawn is not a rounding error;
    # it is a line a quantity surveyor spots in five seconds, and it discredits
    # every other number on the sheet.
    #
    # `classify_room` already separates them — the reconstruction has to know
    # what a room is in order to furnish it — so this was a question already
    # answered and simply not asked. Paved outdoor space is still floored, in
    # something that survives rain; soft landscape is not floored at all, and
    # its area is reported rather than dropped so nobody wonders where it went.
    soft = ("lawn", "garden", "green", "court")

    interior_area = 0.0
    paved_area = 0.0
    landscape_area = 0.0

    for room in rooms:
        area = float(room.get("area", 0))
        name = (room.get("name") or "").lower()

        if room.get("kind") == "outdoor":
            if any(word in name for word in soft):
                landscape_area += area
            else:
                paved_area += area
        else:
            interior_area += area

    floor_area = interior_area

    # The shape check, before anything is priced.
    #
    # Deliberately last of the three provisional tests, so a model that is both
    # off-scale and oddly proportioned reports the scale — which is the cause a
    # user can act on, where the ratio is only ever a symptom.
    # Every enclosed region, INCLUDING the soft landscape the bill excludes.
    #
    # The costing drops the lawn because nobody tiles a lawn. The ratio must not,
    # because the wall run in the numerator still contains the compound and site
    # walls that go round it — and dividing a site-inclusive numerator by a
    # site-excluding denominator inflates the figure for a correct model. It read
    # 1.94 that way against the engine's 1.21 on the same building, which is a
    # check disagreeing with itself rather than finding anything.
    #
    # Same basis as `solve/verify.py`, so the two numbers are comparable. A
    # metric is only worth a band if everyone computing it computes it the same.
    enclosed = interior_area + paved_area + landscape_area

    if enclosed <= 0:
        # THE CHECK DID NOT RUN, WHICH IS NOT THE SAME AS PASSING IT.
        #
        # ── Why this stopped being hypothetical ─────────────────────────────
        # This branch used to set the ratio to 0.0 and say nothing. A reader
        # then sees `wallRunPerArea: 0.0` and cannot tell "this building has no
        # wall per square metre" from "there was no square metre to divide by".
        # The band test is correctly guarded so it never fires a false
        # out-of-band — but silence plus a plausible-looking zero reads as a
        # check that ran and passed.
        #
        # It is the same defect as every other one found on 2026-08-22: a value
        # meaning "not computed" wearing a measurement's clothes. `unpriced`
        # solved it for lines and `undetermined` for daylight; this is the third
        # instance and it is the one guarding the bill's only independent check.
        #
        # A model with no enclosed region is about to become common rather than
        # pathological: a session working the reconstruction is adding a
        # plausibility guard that refuses a derived perimeter which does not
        # contain the rooms it claims to enclose, and on this drawing that ring
        # encloses 40% of the interior floor. When it is refused, spaces stop
        # closing, and a bill still prices — INR 1,115,165 of it, measured — with
        # its shape check silently absent.
        costing.wall_run_per_area = None
        _flag(costing, (
            "No enclosed floor area, so the wall-run-per-area check could not "
            "run. This bill has no independent check on its wall quantities — "
            "the one measurement that would catch walls counted twice is "
            "missing, not passing."
        ))
    else:
        ratio = run / enclosed
        if not (WALL_RUN_BAND[0] <= ratio <= WALL_RUN_BAND[1]):
            _flag(costing, (
                f"This model has {ratio:.2f} m of wall per m2 of floor, outside "
                f"the {WALL_RUN_BAND[0]}-{WALL_RUN_BAND[1]} a building normally "
                "sits in. Either the plan is unusually cellular, or walls are "
                "being counted more than once — check the wall run before "
                "ordering against this."
            ))
        costing.wall_run_per_area = round(ratio, 3)

    # ---- Masonry ------------------------------------------------------------
    if masonry == "brick":
        # Divides the WHOLE wall volume, because the unit already carries its
        # own share of the bed. Taking the mortar out first and then dividing by
        # a unit that includes it is the double deduction described above.
        add(
            "Masonry", "Red clay brickwork",
            volume / _BRICK_UNIT_M3, "piece",
            f"wall volume {volume:.1f} m3 divided by one brick plus its "
            f"{MORTAR_BED_M * 1000:.0f} mm bed ({_BRICK_UNIT_M3:.5f} m3), "
            f"= {1 / _BRICK_UNIT_M3:.0f} bricks/m3",
            "red clay brick",
        )
    else:
        block_unit = (0.6 + MORTAR_BED_M) * (0.2 + MORTAR_BED_M) * (0.2 + MORTAR_BED_M)
        add(
            "Masonry", "AAC block work",
            volume / block_unit, "piece",
            f"wall volume {volume:.1f} m3 divided by one 600x200x200 block plus "
            f"its bed ({block_unit:.5f} m3)",
            "aac block", "600",
        )

    mortar_volume = volume * MORTAR_FRACTION
    add(
        "Masonry", "Cement for mortar (1:6)",
        mortar_volume * CEMENT_BAGS_PER_M3_MORTAR, "bag",
        f"mortar {mortar_volume:.2f} m3 x {CEMENT_BAGS_PER_M3_MORTAR} bags/m3",
        "opc cement", "43",
    )
    add(
        "Masonry", "Sand for mortar",
        mortar_volume * SAND_M3_PER_M3_MORTAR, "m³",
        f"mortar {mortar_volume:.2f} m3 x {SAND_M3_PER_M3_MORTAR} m3/m3",
        # "m sand" matched "Coarse Aggregate | 20 mm | Sand, Aggregate & Earth"
        # under the old substring search, because the joined haystack read
        # "...20 mm sand, aggregate...". The library's material is "M-Sand".
        "m-sand",
    )

    # ---- Finishes -----------------------------------------------------------
    plaster_volume = face_area * PLASTER_THICKNESS
    add(
        "Finishes", "Cement plaster, both faces 12 mm",
        plaster_volume * CEMENT_BAGS_PER_M3_MORTAR, "bag",
        f"face area {face_area:.1f} m2 x {PLASTER_THICKNESS * 1000:.0f} mm "
        f"x {CEMENT_BAGS_PER_M3_MORTAR} bags/m3",
        "opc cement", "43",
    )
    # Plaster needs sand as well as cement, and the bill priced only the cement.
    # A 1:6 plaster mix is 6 parts sand to 1 of cement by volume; omitting it
    # made every plastered wall cheaper than it can be built, silently, because
    # a missing line looks exactly like a line that costs nothing.
    add(
        "Finishes", "Sand for plaster",
        plaster_volume * SAND_M3_PER_M3_MORTAR, "m³",
        f"plaster {plaster_volume:.2f} m3 x {SAND_M3_PER_M3_MORTAR} m3/m3",
        "p-sand",
    )
    add(
        "Finishes", "Interior emulsion, two coats",
        # Coverage is per litre per coat; 10 m2/litre/coat is the conventional
        # figure for emulsion on plaster.
        face_area * 2 / 10.0, "litre",
        f"face area {face_area:.1f} m2, two coats at 10 m2/litre/coat",
        "interior emulsion",
    )
    add(
        "Finishes", "Vitrified floor tiling",
        floor_area * 10.7639, "sq ft",
        f"interior room area {floor_area:.1f} m2 converted to sq ft",
        "vitrified tile",
    )

    if paved_area:
        # Kota is the default for a covered terrace or patio in this market:
        # cheap, rides thermal movement, and does not become a skating rink wet.
        add(
            "Finishes", "Outdoor paving, covered areas",
            paved_area * 10.7639, "sq ft",
            f"paved outdoor area {paved_area:.1f} m2 (verandah, patio, balcony)",
            "kota stone",
        )

    if landscape_area:
        # Deliberately a line with no rate rather than no line. The area exists
        # on the drawing and somebody has to decide what happens to it; leaving
        # it out entirely makes the BOQ look complete when it is not.
        costing.unpriced.append(
            Line(
                "Landscape", "Soft landscape — not costed", landscape_area, "m²",
                None,
                f"{landscape_area:.1f} m2 of lawn/garden. Turf, planting and "
                "irrigation are a separate trade and are not in this library.",
                note="excluded on purpose",
            )
        )

    # ---- Openings -----------------------------------------------------------
    doors = [o for o in openings if str(o.get("kind", "")).lower().startswith("door")]
    windows = [o for o in openings if str(o.get("kind", "")).lower().startswith("window")]

    if doors:
        add(
            "Openings", "Door shutters",
            float(len(doors)), "piece",
            f"{len(doors)} door openings hosted on walls",
            "flush door",
        )
    if windows:
        window_area = sum(
            float(o.get("width", 0)) * float(o.get("height", 1.2)) for o in windows
        )
        add(
            "Openings", "Window units",
            window_area * 10.7639, "sq ft",
            f"{len(windows)} windows totalling {window_area:.1f} m2",
            "upvc window",
        )

    return costing
