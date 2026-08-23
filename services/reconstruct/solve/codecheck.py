"""
Measured against a rulebook the architect owns.

── The boundary with clearance.py, honoured from the other side ─────────────
`clearance.py` measures against conventional working figures and deliberately
cites nothing. Its docstring reserved this file: code compliance as a separate
feature whose rulebook is jurisdiction-specific DATA, authored and owned by the
customer's architect, with a citation per rule. That is exactly what this is.
The thresholds live in a JSON file (`data/rulebooks/`), never in this module —
disagreeing with a figure means editing data, not code.

What has NOT changed across the boundary: every finding is still a measured
fact beside the figure a named rule carries, and there is still no verdict.
"Bedroom 2 measures 7.9 m²; the rule carries 9.5 m² (NBC 2016 …)" is
information. "Bedroom 2 is non-compliant" is an opinion that carries liability,
and no field in this module's output will render one.

── Coverage is part of the answer ────────────────────────────────────────────
A compliance report that silently skipped half the rooms reads as a clean bill.
So every rule accounts for what it could NOT check — the room whose kind the
classifier did not recognise, the ventilation rule on a model whose importer
records no windows — with a reason beside each. The skip list is not debug
output; it is the half of the report that tells the architect where the tool
ran out of evidence.

── The two width measurements, and why they differ ───────────────────────────
A ROOM's width is the diameter of the largest circle its finished face can
contain (GEOS maximum inscribed circle). That matches what the code means: an
L-shaped bedroom passes if its main body is wide enough, and a 6 m x 2 m sliver
fails however generous its area.

A CORRIDOR is the opposite problem: the inscribed circle finds its widest
pocket, and the number that matters is the narrowest pinch you must walk
through. So corridor width is measured by erosion-connectivity: shrink the
finished face inward by r and ask whether the doors that open into it still
fall in one connected piece. The largest r that keeps them connected gives
width 2r — the widest person, trolley or stretcher the passage actually admits
between its doors. A corridor with fewer than two doors has no journey to
measure, and falls back to the inscribed diameter with its basis stated.

── Rooms are measured on the finished face ───────────────────────────────────
`Space.loop` runs along wall CENTRELINES (see solve/spaces.py), so a width
measured on it flatters every room by about a wall thickness — the difference
between a 2.4 m rule passing and failing on a 2.3 m room. Faces are inset by
half the mean thickness of their bounding walls before anything is measured,
the same derivation spaces.py uses for the finished area.
"""

from __future__ import annotations

import json
import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from shapely import maximum_inscribed_circle
from shapely.geometry import Point, Polygon

#: Metrics this engine can measure. A rulebook naming anything else is refused
#: on load — a new rule kind sailing through unmeasured would read as passing.
KNOWN_METRICS = {
    "room-area",
    "room-width",
    "corridor-width",
    "exit-door-width",
    "internal-door-width",
    "egress-reach",
    "ventilation-ratio",
}

#: How far a door probe stands off the wall centreline, beyond half the wall's
#: thickness. Deep enough to clear corner-join noise, shallow enough to land
#: inside a 0.9 m corridor.
PROBE_DEPTH = 0.15

#: Fallback wall thickness where a model records none. One brick, plastered.
DEFAULT_THICKNESS = 0.23


@dataclass
class Finding:
    """One measured shortfall against one cited rule. Never a verdict."""

    rule: str
    cite: str
    message: str
    room: int | None = None
    room_name: str | None = None
    measured: float | None = None
    required: float | None = None
    at: tuple[float, float] | None = None
    items: list[str] = field(default_factory=list)
    # Which floor, on a multi-storey building. None where it does not arise.
    storey: int | None = None
    storey_title: str | None = None

    def as_dict(self) -> dict:
        return {
            "rule": self.rule,
            "cite": self.cite,
            "message": self.message,
            "room": self.room,
            "roomName": self.room_name,
            "measured": round(self.measured, 3) if self.measured is not None else None,
            "required": round(self.required, 3) if self.required is not None else None,
            "at": [round(v, 3) for v in self.at] if self.at else None,
            "items": self.items,
            "storey": self.storey,
            "storeyTitle": self.storey_title,
        }


class RulebookError(ValueError):
    """A rulebook this engine must not pretend to evaluate."""


def load_rulebook(path: str | Path) -> dict:
    """
    Read and validate a rulebook, refusing anything it cannot honestly run.

    Refusals are loud on purpose. A rule with an unknown metric, or without a
    citation, silently dropped would leave the report looking complete while
    checking less than the file asked — the exact failure a compliance report
    exists to prevent.
    """
    book = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(book.get("rules"), list) or not book["rules"]:
        raise RulebookError("A rulebook needs a non-empty 'rules' list.")
    seen: set[str] = set()
    for rule in book["rules"]:
        rid = rule.get("id")
        if not rid:
            raise RulebookError("Every rule needs an 'id'.")
        if rid in seen:
            raise RulebookError(f"Rule id '{rid}' appears twice.")
        seen.add(rid)
        metric = rule.get("metric")
        if metric not in KNOWN_METRICS:
            raise RulebookError(
                f"Rule '{rid}' asks for metric '{metric}', which this engine "
                f"cannot measure. It knows: {', '.join(sorted(KNOWN_METRICS))}."
            )
        if not rule.get("cite"):
            raise RulebookError(
                f"Rule '{rid}' has no citation. A figure nobody can trace to "
                "a clause is a working figure, and those belong in clearance."
            )
        if metric != "egress-reach" and not isinstance(rule.get("min"), (int, float)):
            raise RulebookError(f"Rule '{rid}' needs a numeric 'min'.")
    return book


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def _mean_thickness(walls: list) -> float:
    ts = [w.get("thickness") for w in walls if w.get("thickness")]
    return sum(ts) / len(ts) if ts else DEFAULT_THICKNESS


def finished_face(space: dict, walls: list, mean_t: float) -> Polygon | None:
    """The room as built, not as its centrelines enclose it."""
    loop = space.get("loop") or []
    if len(loop) < 3:
        return None
    poly = Polygon([(p[0], p[1]) for p in loop])
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty:
        return None
    bounded = space.get("boundedBy") or []
    ts = [
        walls[i].get("thickness", mean_t)
        for i in bounded
        if isinstance(i, int) and 0 <= i < len(walls)
    ]
    inset = (sum(ts) / len(ts) if ts else mean_t) / 2
    face = poly.buffer(-inset, join_style=2)
    if face.is_empty:
        return None
    if face.geom_type == "MultiPolygon":
        face = max(face.geoms, key=lambda g: g.area)
    return face


def inscribed_width(face: Polygon) -> float:
    """Diameter of the largest circle the face contains."""
    try:
        radius = maximum_inscribed_circle(face, tolerance=0.005).length
    except Exception:
        return 0.0
    return 2.0 * radius


def _door_probes(opening: dict, walls: list):
    """The door's midpoint, and one probe point either side of its wall."""
    index = opening.get("wall")
    if index is None or not (0 <= index < len(walls)):
        return None
    wall = walls[index]
    ax, ay = wall["a"]["x"], wall["a"]["y"]
    bx, by = wall["b"]["x"], wall["b"]["y"]
    length = math.hypot(bx - ax, by - ay)
    if length < 1e-9:
        return None
    dx, dy = (bx - ax) / length, (by - ay) / length
    t = min(max(opening.get("along", length / 2), 0.0), length)
    cx, cy = ax + dx * t, ay + dy * t
    off = wall.get("thickness", DEFAULT_THICKNESS) / 2 + PROBE_DEPTH
    return (cx, cy), [(cx - dy * off, cy + dx * off), (cx + dy * off, cy - dx * off)]


def map_openings(model: dict) -> tuple[list[dict], list[tuple[int, Polygon, dict]]]:
    """
    Every opening resolved to the space(s) it serves.

    Each entry: {n, kind, width, height, at, sides} where sides is a pair of
    (space index, space dict) or None — None meaning the probe landed in no
    detected space, which is the outside of the building (or an area the
    reconstruction failed to enclose; the two are indistinguishable here and
    the egress note says so).
    """
    elements = model.get("elements", {})
    walls = elements.get("walls", [])
    spaces = elements.get("spaces", [])
    openings = elements.get("openings", [])

    lookup: list[tuple[int, Polygon, dict]] = []
    for space in spaces:
        loop = space.get("loop") or []
        if len(loop) < 3:
            continue
        try:
            poly = Polygon([(p[0], p[1]) for p in loop])
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_empty:
                lookup.append((space["index"], poly, space))
        except Exception:
            continue

    resolved = []
    for n, opening in enumerate(openings):
        probed = _door_probes(opening, walls)
        if probed is None:
            continue
        centre, probes = probed
        sides = []
        for px, py in probes:
            hit = None
            point = Point(px, py)
            for idx, poly, space in lookup:
                if poly.contains(point):
                    hit = (idx, space)
                    break
            sides.append(hit)
        resolved.append({
            "n": n,
            "kind": opening.get("kind"),
            "width": opening.get("width") or 0.0,
            "height": opening.get("height"),
            "at": centre,
            "sides": sides,
        })
    return resolved, lookup


def _is_outside(side) -> bool:
    """No detected space, or an outdoor one — either way, open air for a door."""
    return side is None or side[1].get("kind") == "outdoor"


def corridor_width(face: Polygon, door_points: list[tuple[float, float]]) -> float:
    """
    The narrowest passage between this corridor's doors.

    Erode the face by r; the doors stay served while each door point still has
    a piece of the eroded face within reach (r plus a margin for the probe
    stand-off) AND all of them reach the SAME piece. Binary search the largest
    r that keeps that true; the passage admits width 2r.

    The margin cannot bridge to the wrong side of a pinch that has fully
    closed: components on either side of a closed pinch are metres apart, and
    the margin is centimetres.
    """
    if face.is_empty:
        return 0.0
    ceiling = inscribed_width(face) / 2
    if ceiling <= 0:
        return 0.0
    points = [Point(p) for p in door_points]

    def connected(r: float) -> bool:
        shrunk = face.buffer(-r)
        if shrunk.is_empty:
            return False
        parts = list(shrunk.geoms) if shrunk.geom_type == "MultiPolygon" else [shrunk]
        margin = r + PROBE_DEPTH + 0.25
        return any(
            all(part.distance(point) <= margin for point in points)
            for part in parts
        )

    lo, hi = 0.001, ceiling + 0.005
    if not connected(lo):
        return 0.0
    while hi - lo > 0.0025:
        mid = (lo + hi) / 2
        if connected(mid):
            lo = mid
        else:
            hi = mid
    return 2.0 * lo


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def check(model: dict, rulebook: dict) -> tuple[list[Finding], list[dict]]:
    """
    Findings, and the coverage that makes them honest.

    Returns (findings, coverage): findings are shortfalls; coverage carries one
    row per rule with how many subjects were checked, how many fell short, and
    every subject that could NOT be checked with the reason why.
    """
    elements = model.get("elements", {})
    walls = elements.get("walls", [])
    spaces = elements.get("spaces", [])
    mean_t = _mean_thickness(walls)

    openings, _lookup = map_openings(model)
    doors = [o for o in openings if o.get("kind") == "door"]
    windows = [o for o in openings if o.get("kind") == "window"]

    faces: dict[int, Polygon | None] = {}

    def face_of(space: dict) -> Polygon | None:
        idx = space["index"]
        if idx not in faces:
            try:
                faces[idx] = finished_face(space, walls, mean_t)
            except Exception:
                faces[idx] = None
        return faces[idx]

    def label(space: dict) -> str:
        return space.get("name") or f"space {space['index']}"

    def anchor(space: dict) -> tuple[float, float] | None:
        face = face_of(space)
        if face is None:
            return None
        return tuple(face.representative_point().coords)[0]

    # Doors that serve each space, by index — the corridor and egress passes
    # both need it, and it is one walk over the resolved doors.
    doors_of: dict[int, list[dict]] = {}
    for door in doors:
        for side in door["sides"]:
            if side is not None:
                doors_of.setdefault(side[0], []).append(door)

    findings: list[Finding] = []
    coverage: list[dict] = []

    # ---- Door rules are matched first-rule-wins, in file order --------------
    # A bathroom door answers to the sanitary figure, not the general one, and
    # the rulebook expresses that by putting the specific rule first.
    door_rules = [r for r in rulebook["rules"] if r["metric"] == "internal-door-width"]
    consumed_internal: set[int] = set()

    for rule in rulebook["rules"]:
        metric = rule["metric"]
        row = {"rule": rule["id"], "checked": 0, "short": 0, "skipped": []}
        coverage.append(row)
        applies = rule.get("appliesTo")

        # ---- Room dimensions -------------------------------------------------
        if metric in ("room-area", "room-width"):
            for space in spaces:
                kind = space.get("kind", "unknown")
                if applies and kind not in applies:
                    continue
                if metric == "room-area":
                    measured = space.get("area")
                    if measured is None:
                        row["skipped"].append(
                            {"subject": label(space), "reason": "no area on the space"}
                        )
                        continue
                else:
                    face = face_of(space)
                    if face is None:
                        row["skipped"].append({
                            "subject": label(space),
                            "reason": "no usable finished face for this space",
                        })
                        continue
                    measured = inscribed_width(face)
                row["checked"] += 1
                if measured >= rule["min"] - 1e-9:
                    continue
                row["short"] += 1
                unit = "m²" if metric == "room-area" else "m"
                what = "measures" if metric == "room-area" else "is"
                wide = "" if metric == "room-area" else " wide at its widest usable circle"
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"{label(space)} {what} {measured:.2f} {unit}{wide}; "
                        f"the rule carries {rule['min']:g} {unit}."
                    ),
                    room=space["index"], room_name=space.get("name"),
                    measured=measured, required=float(rule["min"]),
                    at=anchor(space),
                ))

        # ---- Corridors ---------------------------------------------------------
        elif metric == "corridor-width":
            for space in spaces:
                if applies and space.get("kind", "unknown") not in applies:
                    continue
                face = face_of(space)
                if face is None:
                    row["skipped"].append({
                        "subject": label(space),
                        "reason": "no usable finished face for this space",
                    })
                    continue
                served = doors_of.get(space["index"], [])
                if len(served) >= 2:
                    measured = corridor_width(face, [d["at"] for d in served])
                    basis = f"between its {len(served)} doors"
                else:
                    measured = inscribed_width(face)
                    basis = "at its widest point — fewer than two doors, no journey to measure"
                row["checked"] += 1
                if measured >= rule["min"] - 1e-9:
                    continue
                row["short"] += 1
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"{label(space)} passes {measured:.2f} m {basis}; "
                        f"the rule carries {rule['min']:g} m."
                    ),
                    room=space["index"], room_name=space.get("name"),
                    measured=measured, required=float(rule["min"]),
                    at=anchor(space),
                ))

        # ---- Exit doors ----------------------------------------------------------
        elif metric == "exit-door-width":
            for door in doors:
                a, b = door["sides"]
                if not (_is_outside(a) ^ _is_outside(b)):
                    continue  # interior door, or a gate with no interior side
                inside = b if _is_outside(a) else a
                row["checked"] += 1
                if door["width"] >= rule["min"] - 1e-9:
                    continue
                row["short"] += 1
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"A {door['width']:.2f} m door is the way out of "
                        f"{label(inside[1])}; the rule carries {rule['min']:g} m "
                        "for a door to the outside."
                    ),
                    room=inside[0], room_name=inside[1].get("name"),
                    measured=door["width"], required=float(rule["min"]),
                    at=door["at"], items=[f"opening-{door['n']}"],
                ))

        # ---- Internal doors: first matching rule in file order wins ---------
        elif metric == "internal-door-width":
            for door in doors:
                a, b = door["sides"]
                if _is_outside(a) or _is_outside(b):
                    continue
                if door["n"] in consumed_internal:
                    continue
                serves = {a[1].get("kind", "unknown"), b[1].get("kind", "unknown")}
                mine = door_rules.index(rule) if rule in door_rules else -1
                wanted = rule.get("servesAny")
                if wanted and not (serves & set(wanted)):
                    # Not this rule's door — a later door rule may claim it, and
                    # if none does the door goes unchecked and is accounted for
                    # by the LAST door rule's skip list.
                    if mine == len(door_rules) - 1:
                        row["skipped"].append({
                            "subject": f"opening-{door['n']}",
                            "reason": "no internal-door rule matches the rooms it serves",
                        })
                    continue
                consumed_internal.add(door["n"])
                row["checked"] += 1
                if door["width"] >= rule["min"] - 1e-9:
                    continue
                row["short"] += 1
                names = " and ".join(sorted(label(s[1]) for s in (a, b)))
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"The {door['width']:.2f} m door between {names} is under "
                        f"the {rule['min']:g} m the rule carries."
                    ),
                    room=a[0], room_name=a[1].get("name"),
                    measured=door["width"], required=float(rule["min"]),
                    at=door["at"], items=[f"opening-{door['n']}"],
                ))

        # ---- Egress: can every listed room reach the outside? ----------------
        elif metric == "egress-reach":
            if not doors:
                row["skipped"].append({
                    "subject": "every room",
                    "reason": "the model records no doors at all",
                })
                continue
            exits: set[int] = set()
            adjacency: dict[int, set[int]] = {}
            for door in doors:
                a, b = door["sides"]
                if _is_outside(a) and _is_outside(b):
                    continue
                if _is_outside(a) or _is_outside(b):
                    inside = b if _is_outside(a) else a
                    exits.add(inside[0])
                else:
                    adjacency.setdefault(a[0], set()).add(b[0])
                    adjacency.setdefault(b[0], set()).add(a[0])

            if not exits:
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        "No door on this storey opens to the outside or to an "
                        "outdoor space — egress cannot be traced. Either the "
                        "exit is on another storey (stairs are not modelled), "
                        "or the import missed the entrance door."
                    ),
                ))

            reached = set(exits)
            queue = deque(exits)
            while queue:
                here = queue.popleft()
                for other in adjacency.get(here, ()):
                    if other not in reached:
                        reached.add(other)
                        queue.append(other)

            for space in spaces:
                if applies and space.get("kind", "unknown") not in applies:
                    continue
                row["checked"] += 1
                if space["index"] in reached:
                    continue
                row["short"] += 1
                has_door = bool(doors_of.get(space["index"]))
                why = (
                    "its doors lead only to rooms that never reach an exit"
                    if has_door else "no door opens into it at all"
                )
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"{label(space)} cannot reach a door to the outside "
                        f"through the door openings on this storey — {why}."
                    ),
                    room=space["index"], room_name=space.get("name"),
                    at=anchor(space),
                ))

        # ---- Ventilation: openings to the open air vs floor area -------------
        elif metric == "ventilation-ratio":
            if not windows:
                subjects = [
                    s for s in spaces
                    if not applies or s.get("kind", "unknown") in applies
                ]
                if subjects:
                    row["skipped"].append({
                        "subject": f"all {len(subjects)} applicable rooms",
                        "reason": "the importer records no windows in this model",
                    })
                continue
            vent_area: dict[int, float] = {}
            unmeasured: set[int] = set()
            for opening in openings:
                a, b = opening["sides"]
                if not (_is_outside(a) ^ _is_outside(b)):
                    continue  # an internal window ventilates nothing
                inside = b if _is_outside(a) else a
                if not opening.get("height"):
                    unmeasured.add(inside[0])
                    continue
                vent_area[inside[0]] = (
                    vent_area.get(inside[0], 0.0)
                    + opening["width"] * opening["height"]
                )
            for space in spaces:
                if applies and space.get("kind", "unknown") not in applies:
                    continue
                area = space.get("area") or 0.0
                if area <= 0:
                    row["skipped"].append(
                        {"subject": label(space), "reason": "no area on the space"}
                    )
                    continue
                if space["index"] in unmeasured:
                    row["skipped"].append({
                        "subject": label(space),
                        "reason": "an opening to the outside has no recorded height",
                    })
                    continue
                measured = vent_area.get(space["index"], 0.0) / area
                row["checked"] += 1
                if measured >= rule["min"] - 1e-9:
                    continue
                row["short"] += 1
                findings.append(Finding(
                    rule=rule["id"], cite=rule["cite"],
                    message=(
                        f"{label(space)} opens {measured:.0%} of its floor area "
                        f"to the outside; the rule carries "
                        f"{rule['min']:.0%}."
                    ),
                    room=space["index"], room_name=space.get("name"),
                    measured=measured, required=float(rule["min"]),
                    at=anchor(space),
                ))

    findings.sort(key=lambda f: (f.rule, -(f.required or 0) + (f.measured or 0)))
    return findings, coverage


def check_building(model: dict, rulebook: dict) -> tuple[list[Finding], list[dict]]:
    """
    Every storey of the building against the rulebook, merged honestly.

    Room and door rules run per storey — a bedroom on the first floor answers
    to the same figures as one on the ground. EGRESS runs only on the storey
    the site is entered from (`storeys.primary`): the engine does not model
    stairs, so asking an upper floor to reach an exterior door would flag every
    upstairs bedroom of every house ever drawn. That is not a silent narrowing
    — the skipped storeys appear in coverage with exactly that reason.

    Coverage rows merge by rule across storeys (checked and short sum; skips
    concatenate, tagged with their floor). Findings carry storey and title.
    On a single-storey model this is `check`, exactly.
    """
    from .storeys import element_blocks

    blocks = list(element_blocks(model))
    if len(blocks) == 1 and blocks[0][0] is None:
        return check(model, rulebook)

    primary = (model.get("storeys") or {}).get("primary", 0)
    egress_rules = [r for r in rulebook["rules"] if r["metric"] == "egress-reach"]
    grounded = {**rulebook}
    upper = {**rulebook, "rules": [r for r in rulebook["rules"]
                                   if r["metric"] != "egress-reach"]}

    findings: list[Finding] = []
    merged: dict[str, dict] = {
        rule["id"]: {"rule": rule["id"], "checked": 0, "short": 0, "skipped": []}
        for rule in rulebook["rules"]
    }

    for tag, elements in blocks:
        storey = tag.get("storey", 0)
        title = tag.get("title") or f"storey {storey}"
        scoped = {"elements": elements, "storeys": {"primary": storey}}
        book = grounded if storey == primary else upper

        found, coverage = check(scoped, book)
        for finding in found:
            finding.storey = storey
            finding.storey_title = tag.get("title") or None
        findings.extend(found)

        for row in coverage:
            into = merged[row["rule"]]
            into["checked"] += row["checked"]
            into["short"] += row["short"]
            into["skipped"].extend(
                {**skip, "storey": storey, "storeyTitle": tag.get("title")}
                for skip in row["skipped"]
            )

        if storey != primary:
            for rule in egress_rules:
                merged[rule["id"]]["skipped"].append({
                    "subject": title,
                    "reason": (
                        "stairs are not modelled; egress is assessed on the "
                        "storey the site is entered from"
                    ),
                    "storey": storey,
                    "storeyTitle": tag.get("title"),
                })

    findings.sort(key=lambda f: (f.rule, -(f.required or 0) + (f.measured or 0)))
    return findings, list(merged.values())


def summarise(findings: list[Finding], coverage: list[dict], rulebook: dict) -> dict:
    """Counts and coverage. No `ok`, no score — same refusal as clearance."""
    by_rule: dict[str, int] = {}
    for finding in findings:
        by_rule[finding.rule] = by_rule.get(finding.rule, 0) + 1
    return {
        "total": len(findings),
        "byRule": by_rule,
        "checked": sum(r["checked"] for r in coverage),
        "skipped": sum(len(r["skipped"]) for r in coverage),
        "basis": (
            f"Measured against '{rulebook.get('title', 'unnamed rulebook')}' — "
            "a transcription the architect of record must verify. "
            "Not a certification, and deliberately no verdict."
        ),
    }
