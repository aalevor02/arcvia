"""
The area statement: carpet areas with their legal definitions attached.

── Why this exists ────────────────────────────────────────────────────────────
Every area this engine has ever printed was one number per room, definition
unstated. In the Indian market that is not a cosmetic gap: RERA obliges a
promoter to sell by carpet area and to compensate shortfalls, and authorities
entertain complaints on misstated area — an unlabelled figure is a legal
liability wearing a friendly font. Worse, TWO different "carpet areas" are in
force and they do not match:

  * **RERA 2016 §2(k)** — net usable floor area EXCLUDING external walls,
    service shafts, exclusive balcony/verandah and open terrace, but
    **INCLUDING internal partition walls**. Kitchens, baths, WCs and in-unit
    passages stay in. This is the number in sale agreements and RERA filings.
  * **IS 3861:2002 cl. 5** — the engineering/valuation carpet (CPWD, PWD,
    banks). Net of ALL walls, and it also EXCLUDES kitchen, pantry, bathroom,
    lavatory, store, verandah, corridor/passage, entrance hall/porch and
    staircase. Materially smaller than RERA carpet for the same unit.

A report that does not name its definition is wrong for someone. So every
figure emitted here carries `{definition, valueM2, valueSqft, conventions}` —
the audit trail that separates a surveyor's statement from a rendering toy.
Full clause-level notes: `A:\\Research\\BIM\\knowledge\\10-indian-codes-and-
area-measurement.md`.

── What it refuses to do ──────────────────────────────────────────────────────
No built-up, super built-up or saleable figures. IS 3861 explicitly disallows
the "super built-up" term and RERA forbids selling by it; both are marketing
numbers whose loading factor comes from the developer, not from geometry.
Emitting them from a model would launder a negotiation into a measurement.

No plinth area yet either — IS 3861 cl. 4 measures over wall OUTER faces with
balcony-protection weightings the detector cannot see; a figure built on
guessed protection would carry more assumption than measurement.

── How the geometry maps to the definitions ───────────────────────────────────
`Space.area` is the finished-face polygon (room inset to the inner wall
faces) — exactly the per-room term both definitions start from. The partition
term RERA adds comes from `Space.boundedBy`: a wall referenced by TWO OR MORE
indoor rooms of the storey has indoor rooms on both faces, which is the
statute's "internal partition wall"; a wall referenced by one indoor room has
outdoors, a shaft or nothing known on its far side and is treated as external
(contributing zero, as §2(k) requires). Its footprint is the centreline
buffered by half the MEASURED thickness, unioned so T-junctions are not
counted twice, then clipped to the union of the gross room polygons so the
strip cannot spill into the body of a crossing external wall.

`boundedBy` indexes walls WITHIN ITS OWN STOREY BLOCK — this module works
per `element_blocks` block for exactly the reason `boq._building_elements`
warns about, and never on a concatenated wall list.
"""

from __future__ import annotations

from quantify.schedules import _is_outdoor

#: IS 3861 cl. 3.1 reports areas to 0.01 m2; sq ft is the marketing unit.
SQFT_PER_M2 = 10.7639

#: RERA §2(k) line items that are excluded from carpet but reported beside it.
#: "Exclusive balcony or verandah area" and "exclusive open terrace area" are
#: the Act's own phrases — they are separate figures, never folded in.
BALCONY_WORDS = ("balcony", "verandah", "veranda", "deck", "sitout", "sit-out",
                 "sit out")
TERRACE_WORDS = ("terrace",)

#: IS 3861:2002 cl. 5.2 exclusions, as this model's vocabulary. Kinds first
#: (the classifier's word), then name words for rooms the classifier missed.
IS_EXCLUDED_KINDS = ("bathroom", "kitchen", "circulation")
IS_EXCLUDED_WORDS = ("bath", "shower", "lavatory", "wc", "toilet", "kitchen",
                     "pantry", "store", "verandah", "veranda", "corridor",
                     "passage", "entrance", "porch", "stair", "mumty", "lift",
                     "shaft", "duct", "lobby", "foyer")


def _named(space: dict) -> str:
    return str(space.get("name") or "").lower()


def _is_balcony(space: dict) -> bool:
    return any(w in _named(space) for w in BALCONY_WORDS)


def _is_terrace(space: dict) -> bool:
    return any(w in _named(space) for w in TERRACE_WORDS)


def _is_excluded_by_is3861(space: dict) -> bool:
    if str(space.get("kind", "")).lower() in IS_EXCLUDED_KINDS:
        return True
    return any(w in _named(space) for w in IS_EXCLUDED_WORDS)


def _partition_area(indoor: list[dict], walls: list[dict]) -> tuple[float, int, bool]:
    """
    (union area of internal-partition footprints, partition count, attributed).

    Returns attributed=False when no space carries `boundedBy` — an older
    model, or rooms that never closed. The caller reports the RERA figure as
    understated rather than quietly emitting rooms-only and calling it §2(k).
    """
    import math

    from shapely.geometry import LineString, Point, Polygon
    from shapely.ops import unary_union

    if not any(space.get("boundedBy") for space in indoor):
        return 0.0, 0, False

    counts: dict[int, int] = {}
    for space in indoor:
        for index in space.get("boundedBy") or ():
            counts[index] = counts.get(index, 0) + 1

    gross = []
    for space in indoor:
        loop = space.get("loop") or []
        if len(loop) >= 3:
            poly = Polygon([(float(p[0]), float(p[1])) for p in loop])
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_empty:
                gross.append(poly)

    strips = []
    partitions = 0
    for index, rooms in counts.items():
        if rooms < 2 or not (0 <= index < len(walls)):
            continue
        wall = walls[index]
        a, b = wall.get("a") or {}, wall.get("b") or {}
        ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
        bx, by = float(b.get("x", 0)), float(b.get("y", 0))
        length = math.hypot(bx - ax, by - ay)
        thickness = float(wall.get("thickness") or 0.0)
        if length < 1e-6 or thickness <= 0:
            continue

        # Being bounded by two indoor rooms is NOT enough: two rooms abutting
        # the same ENVELOPE piece side by side both reference it, and calling
        # that a partition adds external wall into a §2(k) figure. The statute
        # says "internal partition" = indoor on BOTH FACES, and that is
        # directly testable: probe half a thickness past each face at the
        # wall's midpoint and ask whether each probe lands in an indoor room.
        # Measured on the villa: 93 candidates by reference-counting, 51 with
        # this gate — the difference was 12.8 m2 of envelope wall that would
        # have been laundered into a statutory carpet figure.
        px, py = -(by - ay) / length, (bx - ax) / length
        reach = thickness / 2 + 0.05
        mx, my = (ax + bx) / 2, (ay + by) / 2
        sides = 0
        for sign in (1.0, -1.0):
            probe = Point(mx + px * reach * sign, my + py * reach * sign)
            if any(poly.contains(probe) for poly in gross):
                sides += 1
        if sides < 2:
            continue

        partitions += 1
        # cap_style=2 (flat): the strip ends at the wall's own ends rather
        # than growing half-discs into whatever the wall butts against.
        strips.append(
            LineString([(ax, ay), (bx, by)]).buffer(thickness / 2, cap_style=2)
        )

    if not strips:
        return 0.0, partitions, True

    union = unary_union(strips)
    if gross:
        # Adjacent gross polygons meet ON the shared centreline, so their
        # union covers the partition strip between them; clipping trims only
        # the junction ends that stick into external wall bodies.
        union = union.intersection(unary_union(gross))
    return float(union.area), partitions, True


def _figure(definition: str, label: str, m2: float, note: str = "") -> dict:
    row = {
        "definition": definition,
        "label": label,
        "valueM2": round(m2, 2),           # IS 3861 cl. 3.1 discipline
        "valueSqft": round(m2 * SQFT_PER_M2, 1),
    }
    if note:
        row["note"] = note
    return row


def area_statement(model: dict) -> dict:
    """Per-storey carpet areas under both definitions, with the audit trail."""
    from solve.storeys import element_blocks

    storeys = []
    for tag, elements in element_blocks(model):
        spaces = elements.get("spaces", [])
        walls = elements.get("walls", [])

        indoor = [s for s in spaces if not _is_outdoor(s)]
        outdoor = [s for s in spaces if _is_outdoor(s)]
        balconies = [s for s in outdoor if _is_balcony(s)]
        terraces = [s for s in outdoor if _is_terrace(s) and not _is_balcony(s)]
        site = [s for s in outdoor if s not in balconies and s not in terraces]

        rooms_m2 = sum(float(s.get("area") or 0.0) for s in indoor)
        partitions_m2, partitions, attributed = _partition_area(indoor, walls)

        is_included = [s for s in indoor if not _is_excluded_by_is3861(s)]
        is_m2 = sum(float(s.get("area") or 0.0) for s in is_included)

        unverified = [
            s for s in is_included
            if not s.get("name") and str(s.get("kind", "unknown")).lower() == "unknown"
        ]
        unverified_m2 = sum(float(s.get("area") or 0.0) for s in unverified)

        figures = [
            _figure(
                "RERA_2k", "RERA carpet area", rooms_m2 + partitions_m2,
                "" if attributed else
                "UNDERSTATED: this model carries no wall attribution, so the "
                "internal-partition term §2(k) includes could not be added.",
            ),
            _figure("IS3861_carpet", "IS 3861 carpet area", is_m2),
            _figure("exclusive_balcony_verandah", "Exclusive balcony/verandah",
                    sum(float(s.get("area") or 0.0) for s in balconies)),
            _figure("exclusive_open_terrace", "Exclusive open terrace",
                    sum(float(s.get("area") or 0.0) for s in terraces)),
        ]

        caveats = [
            "RERA §2(k) carpet and IS 3861 carpet are different quantities by "
            "construction — RERA includes internal partition walls and in-unit "
            "kitchens/baths, IS 3861 excludes both. Never quote one as the other.",
            "The whole storey is treated as ONE unit; a multi-unit floor plate "
            "needs unit assignment before these figures mean anything per flat.",
        ]
        if unverified:
            caveats.append(
                f"{len(unverified)} unnamed, unclassified rooms "
                f"({unverified_m2:.2f} m2) are counted INTO the IS 3861 figure. "
                "cl. 5.2's exclusions (kitchen, bath, store, passage...) cannot "
                "be verified on a room the drawing does not name."
            )

        # The mirror risk: a room EXCLUDED from the IS figure on the strength
        # of one label. The villa's "FOYER" is 127.8 m2 with kind
        # `circulation` — excluded as an entrance hall under cl. 5.2, when a
        # hall that size is almost certainly the living space. The exclusion
        # is applied as the definitions require, but a reader must see that
        # one label moved more than half the figure.
        excluded = [s for s in indoor if _is_excluded_by_is3861(s)]
        if excluded and rooms_m2 > 1:
            biggest = max(excluded, key=lambda s: float(s.get("area") or 0.0))
            biggest_m2 = float(biggest.get("area") or 0.0)
            if biggest_m2 > 0.25 * rooms_m2:
                caveats.append(
                    f"'{biggest.get('name') or '(unnamed)'}' "
                    f"({biggest_m2:.2f} m2, kind {biggest.get('kind')}) is "
                    "excluded from the IS 3861 figure by its label alone, and "
                    f"it is {biggest_m2 / rooms_m2:.0%} of the indoor floor. "
                    "If that label mislabels a living space, the IS figure is "
                    "badly low — check the label before quoting it."
                )
        if site:
            site_m2 = sum(float(s.get("area") or 0.0) for s in site)
            caveats.append(
                f"{len(site)} outdoor site spaces ({site_m2:.2f} m2 — lawns, "
                "pools, courts) appear in NO figure: they are neither carpet "
                "nor an exclusive-use line item."
            )

        storeys.append({
            **({"storeyTitle": tag.get("title")} if tag else {}),
            "figures": figures,
            "conventions": {
                # Recorded per the doc-10 output contract: an auditor must be
                # able to see WHICH reading of the silent clauses was applied.
                "unit": "whole storey as one unit",
                "interUnitWall": "not-applicable (single unit)",
                "roomAreas": "finished-face polygons (inner wall faces)",
                "partitionWalls": (
                    f"{partitions} walls with indoor rooms on both faces, "
                    "footprint = measured centreline x measured thickness"
                    if attributed else "unavailable (no wall attribution)"
                ),
            },
            "caveats": caveats,
        })

    result = {"storeys": storeys}
    if len(storeys) > 1:
        totals = {}
        for storey in storeys:
            for figure in storey["figures"]:
                totals[figure["definition"]] = (
                    totals.get(figure["definition"], 0.0) + figure["valueM2"]
                )
        result["building"] = {
            "figures": [
                _figure(definition, f"{definition} (all storeys)", m2)
                for definition, m2 in totals.items()
            ],
            "caveats": [
                "Storey figures summed on the assumption that every storey "
                "belongs to the same unit (a villa). Wrong for apartments."
            ],
        }
    return result


def as_text(statement: dict) -> str:
    """The statement as plain text, matching the schedule renderers."""
    out = ["AREA STATEMENT"]
    for storey in statement["storeys"]:
        if storey.get("storeyTitle"):
            out.append(f"  [{storey['storeyTitle']}]")
        for figure in storey["figures"]:
            line = (f"  {figure['label']:28s} {figure['valueM2']:9.2f} m2 "
                    f"{figure['valueSqft']:10.1f} sqft   ({figure['definition']})")
            out.append(line)
            if figure.get("note"):
                out.append(f"    ! {figure['note']}")
        for key, value in storey["conventions"].items():
            out.append(f"    - {key}: {value}")
        for caveat in storey["caveats"]:
            out.append(f"  ! {caveat}")
    for figure in statement.get("building", {}).get("figures", []):
        out.append(f"  BUILDING {figure['label']:24s} {figure['valueM2']:9.2f} m2")
    for caveat in statement.get("building", {}).get("caveats", []):
        out.append(f"  ! {caveat}")
    return "\n".join(out)
