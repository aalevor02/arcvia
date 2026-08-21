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

#: Mortar as a fraction of masonry volume, for a 10 mm bed.
#:
#: The conventional take-off figure. Real consumption depends on the block and
#: the mason; 0.30 is the number Indian estimating tables use for brickwork in
#: cement mortar and it is stated here so it can be argued with.
MORTAR_FRACTION = 0.30

#: Cement mortar 1:6 — bags of cement and cubic metres of sand per m3 of mortar.
CEMENT_BAGS_PER_M3_MORTAR = 4.5
SAND_M3_PER_M3_MORTAR = 0.9

#: Plaster, both faces, 12 mm internal.
PLASTER_THICKNESS = 0.012

#: A red clay brick with its mortar bed occupies this much. 9x4x3 inch nominal.
BRICK_VOLUME_M3 = 0.2413 * 0.1143 * 0.0889


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

        return {
            "band": self.band,
            "total": round(self.total, 2),
            "currency": "INR",
            "bySection": {k: round(v, 2) for k, v in sorted(by_section.items())},
            "lines": [line.as_dict() for line in self.lines],
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


def _wall_volumes(model: dict, height: float) -> tuple[float, float, float]:
    """Masonry volume, wall face area, and total run — net of openings."""
    walls = model.get("elements", {}).get("walls", [])
    openings = model.get("elements", {}).get("openings", [])

    volume = 0.0
    face_area = 0.0
    run = 0.0

    for wall in walls:
        a, b = wall["a"], wall["b"]
        length = ((b["x"] - a["x"]) ** 2 + (b["y"] - a["y"]) ** 2) ** 0.5
        thickness = float(wall.get("thickness", 0.23))
        run += length
        volume += length * thickness * height
        # Two faces per wall, for plaster and paint.
        face_area += 2 * length * height

    hole_area = 0.0
    hole_volume = 0.0
    for opening in openings:
        width = float(opening.get("width", 0))
        opening_height = float(opening.get("height", 2.1))
        thickness = float(opening.get("thickness", 0.23))
        hole_area += width * opening_height
        hole_volume += width * opening_height * thickness

    return (
        max(volume - hole_volume, 0.0),
        max(face_area - 2 * hole_area, 0.0),
        run,
    )


def build(
    model: dict,
    library: RateLibrary,
    height: float = 2.7,
    band: str = "base",
    masonry: str = "brick",
) -> Costing:
    """Quantities from the reconstruction, priced against the library."""
    costing = Costing(band=band)

    def add(section, description, quantity, unit, rule, *terms, tier=None, note=""):
        rate = library.find(*terms, tier=tier)
        line = Line(section, description, quantity, unit, rate, rule, note=note)
        if rate and quantity > 0:
            line.amount = rate.cost(quantity, band)
            costing.lines.append(line)
        else:
            line.note = note or ("no rate matched" if not rate else "zero quantity")
            costing.unpriced.append(line)
        return line

    volume, face_area, run = _wall_volumes(model, height)
    rooms = model.get("elements", {}).get("spaces", [])
    openings = model.get("elements", {}).get("openings", [])

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

    # ---- Masonry ------------------------------------------------------------
    masonry_volume = volume * (1 - MORTAR_FRACTION)

    if masonry == "brick":
        add(
            "Masonry", "Red clay brickwork",
            masonry_volume / BRICK_VOLUME_M3, "piece",
            f"wall volume {volume:.1f} m3, less {MORTAR_FRACTION:.0%} mortar, "
            f"divided by brick volume {BRICK_VOLUME_M3:.5f} m3",
            "red clay brick",
        )
    else:
        add(
            "Masonry", "AAC block work",
            masonry_volume / (0.6 * 0.2 * 0.2), "piece",
            f"wall volume {volume:.1f} m3, less {MORTAR_FRACTION:.0%} mortar, "
            "divided by 600x200x200 block volume",
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
        "m sand",
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
