"""Measurable predicates: one cited rule against real reconstructed geometry.

Each predicate reuses the geometry `solve.codecheck` already has — `map_openings`,
`finished_face`, `inscribed_width`, `corridor_width` — rather than measuring the building
a second way. Two implementations of "how wide is this room" that drift apart is a worse
outcome than one that is occasionally wrong.

THE THREE-VALUED RESULT IS THE DESIGN
--------------------------------------
Every predicate returns `PASS`, `FAIL` or `UNKNOWN`, never a bare boolean. `UNKNOWN` is
load-bearing and is reported, because the alternative — folding "could not measure" into
"passed" — is how a checker certifies buildings it never examined. A room whose face could
not be built, a door that resolved to no space, a model with no wall height: all UNKNOWN,
all counted, none silently passed.

WHERE PASS IS NOT AVAILABLE
---------------------------
`door_clear_width` can return FAIL and UNKNOWN but never PASS. The model measures the
STRUCTURAL opening; ADA §404.2.3 governs CLEAR width — door open 90°, between the door
face and the opposite stop — which is smaller by the leaf, stop and hinge (commonly
50–75 mm). Structural width bounds clear width from above, so:

    structural <  required  ->  clear width is certainly below it too   -> FAIL
    structural >= required  ->  clear width may still be below it       -> UNKNOWN

Reporting the second as a pass would certify doors that fail in reality. The predicate
declares `can_pass = False` and the bridge enforces it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from shapely.geometry import Polygon

from solve.codecheck import (
    _mean_thickness, corridor_width, finished_face, inscribed_width, map_openings,
)

PASS, FAIL, UNKNOWN = "pass", "fail", "unknown"


@dataclass
class Measurement:
    verdict: str                       # PASS | FAIL | UNKNOWN
    measured: float | None             # metres, or None when unknown
    subject: str                       # what was measured, human-readable
    room: int | None = None
    room_name: str | None = None
    at: tuple[float, float] | None = None
    reason: str = ""                   # why UNKNOWN; empty otherwise


@dataclass(frozen=True)
class Predicate:
    key: str
    document: str
    section: str
    can_pass: bool
    applies_to: tuple[str, ...] | None   # room kinds, or None for "not room-scoped"
    one_sided_because: str
    fn: Callable
    elements: tuple[str, ...] = ()       # what geometry it consumes, for reporting


# ---------------------------------------------------------------------------
def _spaces_and_walls(model: dict):
    el = model.get("elements", {}) or {}
    return el.get("walls", []) or [], el.get("spaces", []) or []


def door_clear_width(rule, model) -> list[Measurement]:
    """36 CFR 1191 §404.2.3 — doors. FAIL or UNKNOWN only; see module docstring."""
    walls, spaces = _spaces_and_walls(model)
    out: list[Measurement] = []
    try:
        openings, _ = map_openings(model)
    except Exception as e:
        return [Measurement(UNKNOWN, None, "openings", reason=f"{type(e).__name__}: {e}")]
    for o in openings:
        if o.get("kind") != "door":
            continue
        w = o.get("width")
        if not isinstance(w, (int, float)) or w <= 0:
            out.append(Measurement(UNKNOWN, None, f"door {o.get('n', '?')}",
                                   reason="no usable width on the opening"))
            continue
        sides = o.get("sides") or []
        named = next((s[1].get("name") for s in sides
                      if s and isinstance(s, tuple) and s[1].get("name")), None)
        idx = next((s[0] for s in sides if s), None)
        if w < rule.value_m:
            out.append(Measurement(FAIL, round(w, 3), f"door {o.get('n', '?')}",
                                   room=idx, room_name=named, at=o.get("at")))
        else:
            out.append(Measurement(
                UNKNOWN, round(w, 3), f"door {o.get('n', '?')}", room=idx,
                room_name=named, at=o.get("at"),
                reason="structural opening meets the figure, but the regulated "
                       "quantity is CLEAR width, which is smaller — unresolved"))
    return out


def turning_space(rule, model) -> list[Measurement]:
    """36 CFR 1191 §304.3.1 — a 1525 mm turning circle, via the inscribed circle."""
    walls, spaces = _spaces_and_walls(model)
    if not spaces:
        return [Measurement(UNKNOWN, None, "rooms", reason="model has no spaces")]
    mean_t = _mean_thickness(walls)
    out: list[Measurement] = []
    for sp in spaces:
        name = sp.get("name") or f"space {sp.get('index')}"
        try:
            face = finished_face(sp, walls, mean_t)
        except Exception:
            face = None
        if face is None or face.is_empty:
            out.append(Measurement(UNKNOWN, None, name, room=sp.get("index"),
                                   room_name=sp.get("name"),
                                   reason="finished face could not be built"))
            continue
        width = inscribed_width(face)
        at = tuple(face.representative_point().coords)[0]
        verdict = PASS if width >= rule.value_m else FAIL
        out.append(Measurement(verdict, round(width, 3), name, room=sp.get("index"),
                               room_name=sp.get("name"), at=at))
    return out


def route_clear_width(rule, model) -> list[Measurement]:
    """36 CFR 1191 §403.5.1 — clear width of an accessible route, at circulation rooms."""
    walls, spaces = _spaces_and_walls(model)
    if not spaces:
        return [Measurement(UNKNOWN, None, "rooms", reason="model has no spaces")]
    mean_t = _mean_thickness(walls)
    try:
        openings, _ = map_openings(model)
    except Exception as e:
        return [Measurement(UNKNOWN, None, "openings",
                            reason=f"{type(e).__name__}: {e}")]
    doors_of: dict[int, list] = {}
    for o in openings:
        if o.get("kind") != "door":
            continue
        for side in (o.get("sides") or []):
            if side:
                doors_of.setdefault(side[0], []).append(o)
    out: list[Measurement] = []
    for sp in spaces:
        idx = sp.get("index")
        name = sp.get("name") or f"space {idx}"
        try:
            face = finished_face(sp, walls, mean_t)
        except Exception:
            face = None
        if face is None or face.is_empty:
            out.append(Measurement(UNKNOWN, None, name, room=idx,
                                   room_name=sp.get("name"),
                                   reason="finished face could not be built"))
            continue
        pts = [o["at"] for o in doors_of.get(idx, []) if o.get("at")]
        if len(pts) < 2:
            # A route needs two ends. One door is a room, not a corridor.
            out.append(Measurement(UNKNOWN, None, name, room=idx,
                                   room_name=sp.get("name"),
                                   reason="fewer than two doors — not a through route"))
            continue
        try:
            w = corridor_width(face, pts)
        except Exception as e:
            out.append(Measurement(UNKNOWN, None, name, room=idx,
                                   room_name=sp.get("name"),
                                   reason=f"{type(e).__name__}: {e}"))
            continue
        if w is None:
            out.append(Measurement(UNKNOWN, None, name, room=idx,
                                   room_name=sp.get("name"),
                                   reason="route width not measurable"))
            continue
        verdict = PASS if w >= rule.value_m else FAIL
        out.append(Measurement(verdict, round(w, 3), name, room=idx,
                               room_name=sp.get("name"),
                               at=tuple(face.representative_point().coords)[0]))
    return out


PREDICATES: list[Predicate] = [
    Predicate(
        key="ada-door-clear-width", document="36 CFR 1191", section="404.2.3",
        can_pass=False, applies_to=None,
        one_sided_because=(
            "the model measures the STRUCTURAL opening while §404.2.3 governs CLEAR "
            "width, which is smaller by the leaf, stop and hinge — so a shortfall is "
            "provable and compliance is not"),
        fn=door_clear_width, elements=("openings", "doors", "walls"),
    ),
    Predicate(
        key="ada-turning-space", document="36 CFR 1191", section="304.3.1",
        can_pass=True,
        applies_to=("bathroom", "toilet", "sanitary", "bedroom", "living", "kitchen"),
        one_sided_because="",
        fn=turning_space, elements=("rooms", "walls"),
    ),
    Predicate(
        key="ada-route-clear-width", document="36 CFR 1191", section="403.5.1",
        can_pass=True, applies_to=("corridor", "passage", "hall", "circulation"),
        one_sided_because="",
        fn=route_clear_width, elements=("rooms", "openings", "walls"),
    ),
]
