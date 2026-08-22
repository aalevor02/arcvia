"""
Room and opening schedules from the model.

── Why these are worth having ─────────────────────────────────────────────────
A practice types both of these by hand off the same drawing, into a spreadsheet
nobody can regenerate. Every figure below is already in `building.json`, because
the reconstruction had to measure it to build the geometry — so like the bill of
quantities, this is arithmetic over data that already exists rather than a new
extraction.

── What they refuse to do ─────────────────────────────────────────────────────
Neither invents a name, a size, or a count. A room the reader could not name is
listed as unnamed rather than as "Room 7", because a schedule that numbers what
it could not read looks exactly like one that read it. Ten of the villa's
twenty-three spaces are unnamed, and a reader needs to know that before using
the areas.

Both schedules also separate INDOOR from OUTDOOR, for the same reason the bill
does: costed naively, the villa's lawns came to 93 m2 of vitrified tiling.
Anything that totals a building's floor area without saying which part is garden
will eventually be read as the building.
"""

from __future__ import annotations

import math
from collections import defaultdict

#: Space kinds that are not inside the building. Mirrors the bill's own split so
#: an area totalled here and costed there cannot disagree about what a room is.
OUTDOOR_KINDS = ("outdoor",)
OUTDOOR_WORDS = ("lawn", "garden", "patio", "deck", "terrace", "balcony",
                 "court", "pool", "barbeque", "barbecue", "driveway", "parking")

#: Sill height below which an opening is a door rather than a window, when the
#: model does not say. Only used as a fallback — `kind` is believed first.
DOOR_SILL_MAX = 0.05


def _is_outdoor(space: dict) -> bool:
    if str(space.get("kind", "")).lower() in OUTDOOR_KINDS:
        return True
    name = str(space.get("name") or "").lower()
    return any(word in name for word in OUTDOOR_WORDS)


def _polygon(space: dict) -> list[tuple[float, float]]:
    """A space's boundary, in either spelling the pipeline has used."""
    loop = space.get("loop")
    if loop:
        return [(float(p[0]), float(p[1])) for p in loop if len(p) >= 2]
    return [(float(p["x"]), float(p["y"])) for p in space.get("polygon", [])]


def _perimeter(polygon: list[tuple[float, float]]) -> float:
    total = 0.0
    for i in range(len(polygon)):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % len(polygon)]
        total += math.hypot(x1 - x0, y1 - y0)
    return total


def room_schedule(model: dict) -> dict:
    """
    Every enclosed space, with its area and what it is.

    Areas are taken from the model rather than recomputed. `area` is the solved
    polygon; `grossArea` is that polygon before partitions are deducted, which is
    the figure an agent quotes and a surveyor does not — both are reported
    because the difference is exactly the sort of thing an argument is about.
    """
    spaces = model.get("elements", {}).get("spaces", [])

    rows = []
    for space in spaces:
        polygon = _polygon(space)
        area = float(space.get("area") or 0.0)
        outdoor = _is_outdoor(space)

        rows.append({
            "index": space.get("index"),
            "name": space.get("name"),
            # Explicit rather than implied by a null name. A reader scanning a
            # column of names needs the gaps to be visible as gaps.
            "named": bool(space.get("name")),
            "kind": space.get("kind") or "unknown",
            "location": "outdoor" if outdoor else "indoor",
            "area": round(area, 2),
            "grossArea": round(float(space.get("grossArea") or 0.0), 2),
            "perimeter": round(
                float(space.get("perimeter") or (_perimeter(polygon) if polygon else 0.0)), 2
            ),
            "vertices": len(polygon),
        })

    rows.sort(key=lambda r: (r["location"], -r["area"]))

    indoor = [r for r in rows if r["location"] == "indoor"]
    outdoor = [r for r in rows if r["location"] == "outdoor"]
    unnamed = [r for r in rows if not r["named"]]

    return {
        "rooms": rows,
        "totals": {
            "rooms": len(rows),
            "indoor": len(indoor),
            "outdoor": len(outdoor),
            "indoorArea": round(sum(r["area"] for r in indoor), 2),
            "outdoorArea": round(sum(r["area"] for r in outdoor), 2),
            # Deliberately NOT a single "total area". The one number a reader
            # would take from that is the building's size, and it would be wrong
            # by however much garden the site has.
        },
        "caveats": _room_caveats(rows, unnamed),
    }


def _room_caveats(rows: list[dict], unnamed: list[dict]) -> list[str]:
    caveats = []
    if unnamed:
        area = sum(r["area"] for r in unnamed)
        caveats.append(
            f"{len(unnamed)} of {len(rows)} spaces carry no name in the drawing "
            f"({area:.1f} m2). They are listed as unnamed rather than numbered, "
            "because a schedule that numbers what it could not read looks exactly "
            "like one that read it."
        )
    unknown = [r for r in rows if r["kind"] == "unknown"]
    if unknown:
        caveats.append(
            f"{len(unknown)} spaces could not be classified, so their indoor or "
            "outdoor placement is inferred from the polygon alone."
        )
    caveats.append(
        "Indoor and outdoor areas are reported separately and never summed. A "
        "single total would be read as the building's size and would include "
        "any garden on the site."
    )
    return caveats


def opening_schedule(model: dict) -> dict:
    """
    Doors and windows, grouped into types the way a joinery schedule is read.

    ── Why grouping is the whole job ──────────────────────────────────────────
    A list of eight openings is data. "D1 — 750 x 2100 — 8 off" is a schedule:
    it is what gets ordered, and it is how a duplicate or a rogue size shows up.
    The villa's eight openings are all identical, which is itself the finding —
    they come from one block definition, so the drawing specifies one door type.
    """
    elements = model.get("elements", {})
    openings = elements.get("openings", [])
    walls = elements.get("walls", [])

    groups: dict[tuple, list[dict]] = defaultdict(list)
    orphans = []

    for opening in openings:
        index = opening.get("wall")
        if not (isinstance(index, int) and 0 <= index < len(walls)):
            # Reported, not dropped. An opening whose wall is missing is a
            # reading fault worth seeing; silently losing it makes the door
            # count too low and nothing says why.
            orphans.append(opening)
            continue

        width = round(float(opening.get("width", 0.0)), 3)
        height = round(float(opening.get("height", 0.0)), 3)
        sill = round(float(opening.get("sill", 0.0)), 3)
        kind = str(opening.get("kind") or "").lower()
        if not kind:
            kind = "door" if sill <= DOOR_SILL_MAX else "window"

        groups[(kind, width, height, sill)].append(opening)

    rows = []
    marks = defaultdict(int)
    for (kind, width, height, sill), members in sorted(
        groups.items(), key=lambda kv: (kv[0][0], -kv[0][1] * kv[0][2])
    ):
        prefix = {"door": "D", "window": "W"}.get(kind, "O")
        marks[prefix] += 1
        confidences = [float(m.get("confidence", 0.0)) for m in members]
        sources = sorted({str(m.get("source") or "unknown") for m in members})

        rows.append({
            "mark": f"{prefix}{marks[prefix]}",
            "kind": kind,
            "widthMm": int(round(width * 1000)),
            "heightMm": int(round(height * 1000)),
            "sillMm": int(round(sill * 1000)),
            "quantity": len(members),
            "areaEach": round(width * height, 3),
            "areaTotal": round(width * height * len(members), 3),
            "lowestConfidence": round(min(confidences), 2) if confidences else None,
            "source": ", ".join(sources),
        })

    doors = sum(r["quantity"] for r in rows if r["kind"] == "door")
    windows = sum(r["quantity"] for r in rows if r["kind"] == "window")

    return {
        "openings": rows,
        "totals": {
            "types": len(rows),
            "doors": doors,
            "windows": windows,
            "orphaned": len(orphans),
        },
        "caveats": _opening_caveats(rows, doors, windows, orphans, model),
    }


def _opening_caveats(rows, doors, windows, orphans, model) -> list[str]:
    caveats = []

    # THE ONE THAT MATTERS ON THIS MODEL. An empty window section reads as "this
    # schedule has no window section" rather than "this building has no windows",
    # and the second is a claim somebody has to check.
    if windows == 0:
        spaces = len(model.get("elements", {}).get("spaces", []))
        caveats.append(
            f"NO WINDOWS. Every opening read from this drawing is a door, across "
            f"{spaces} spaces. Either the drawing places none on this storey, or "
            "the reader did not find them — the schedule cannot tell which, and "
            "the difference matters before anybody orders joinery."
        )
    if doors == 0 and windows == 0:
        caveats.append("No openings at all were read from this drawing.")

    if len(rows) == 1 and rows[0]["quantity"] > 1:
        caveats.append(
            f"Every opening is the same size ({rows[0]['widthMm']} x "
            f"{rows[0]['heightMm']} mm). That is consistent with one block "
            "definition used throughout, which is normal, but it also means no "
            "opening in this schedule was measured independently of the others."
        )

    if orphans:
        caveats.append(
            f"{len(orphans)} openings reference a wall that is not in the model "
            "and are counted in `orphaned` rather than scheduled."
        )

    caveats.append(
        "Sizes are as drawn, not as manufactured. A schedule for ordering needs "
        "structural opening sizes, which depend on frame and tolerance."
    )
    return caveats


def as_text(rooms: dict, openings: dict) -> str:
    """Both schedules as plain text, for the CLI and for pasting into an email."""
    out = []

    out.append("ROOM SCHEDULE")
    out.append(f"  {'name':24s} {'kind':12s} {'area':>9} {'gross':>9} {'perim':>8}")
    for row in rooms["rooms"]:
        name = row["name"] or "(unnamed)"
        out.append(
            f"  {name[:24]:24s} {row['kind'][:12]:12s} "
            f"{row['area']:9.2f} {row['grossArea']:9.2f} {row['perimeter']:8.2f}"
        )
    totals = rooms["totals"]
    out.append(
        f"  {'':24s} {'INDOOR':12s} {totals['indoorArea']:9.2f} m2 "
        f"across {totals['indoor']} spaces"
    )
    out.append(
        f"  {'':24s} {'OUTDOOR':12s} {totals['outdoorArea']:9.2f} m2 "
        f"across {totals['outdoor']} spaces"
    )

    out.append("")
    out.append("OPENING SCHEDULE")
    if openings["openings"]:
        out.append(f"  {'mark':6s} {'kind':8s} {'size (mm)':>14} {'sill':>6} {'qty':>4}")
        for row in openings["openings"]:
            size = f"{row['widthMm']} x {row['heightMm']}"
            out.append(
                f"  {row['mark']:6s} {row['kind']:8s} {size:>14} "
                f"{row['sillMm']:6d} {row['quantity']:4d}"
            )
    else:
        out.append("  (none read from this drawing)")

    for caveat in rooms["caveats"] + openings["caveats"]:
        out.append(f"  ! {caveat}")

    return "\n".join(out)
