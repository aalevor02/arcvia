"""
What a block actually *is* on the drawing — its size, its room, its wall.

`cad.furniture()` already reports every block placement with the exact position
and rotation the architect gave it. What it cannot report is how big the thing
is, because that lives in the block *definition* rather than the placement, and
without a size the footprint signal has nothing to measure.

This adds the three measurements the classifier needs and the drawing already
contains:

  FOOTPRINT   the block definition's extents, scaled by the placement's own
              x/y scale factors. A block inserted at 0.5 is half the size, and
              reading the definition alone would call it something twice as big.
  ROOM        the nearest room label. Full room detection needs solved walls,
              which is several stages away — but the architect already printed
              the room names, and the nearest one to a sofa is almost always
              the room the sofa is in.
  AGAINST     distance from the placement to the nearest wall-layer segment.
              Being pressed against a wall is what separates a counter from a
              table, and a wardrobe from a chest of drawers.

None of this is inference. Every number is read off the file.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import ezdxf
from ezdxf import bbox, recover

#: A placement this close to wall linework counts as against it. Generous,
#: because drawings routinely leave a skim-coat gap and because the penalty for
#: a false negative (a counter scored as a free-standing table) is worse than
#: for a false positive.
AGAINST_WALL_M = 0.30

#: Room labels further away than this are not this object's room. A large villa
#: room is rarely more than ~8 m from its own label; beyond that the nearest
#: label is likely to be the next room along.
MAX_LABEL_DISTANCE_M = 9.0

#: Block definitions bigger than this are title blocks, north arrows at absurd
#: scale, or the whole drawing wrapped in a block. Not furniture.
MAX_FOOTPRINT_M = 12.0


@dataclass
class RoomLabel:
    x: float
    y: float
    text: str


def block_footprints(doc, scale: float) -> dict[str, tuple[float, float]]:
    """
    Every block definition's extents in metres, keyed by name.

    `fast=True` uses entity bounding boxes rather than flattening curves. For a
    footprint measured against catalogue nominals that is well inside the noise,
    and it is the difference between seconds and minutes on a 20,000-entity
    drawing.
    """
    out: dict[str, tuple[float, float]] = {}

    for block in doc.blocks:
        name = block.name
        # Layout blocks (*Model_Space, *Paper_Space) are not furniture.
        if name.startswith("*"):
            continue
        try:
            extents = bbox.extents(block, fast=True)
        except (ValueError, ZeroDivisionError, AttributeError):
            continue
        if not extents.has_data:
            continue

        w = abs(extents.size.x) * scale
        d = abs(extents.size.y) * scale
        if w <= 0 or d <= 0 or w > MAX_FOOTPRINT_M or d > MAX_FOOTPRINT_M:
            continue
        out[name] = (w, d)

    return out


def room_labels(doc, scale: float, origin: tuple[float, float]) -> list[RoomLabel]:
    """
    Every piece of text that looks like it names a room.

    Deliberately permissive — the classifier decides what a name means, and a
    label that turns out to be a dimension or a note simply never matches a
    room kind and contributes nothing.
    """
    ox, oy = origin
    out: list[RoomLabel] = []

    for entity in doc.modelspace().query("TEXT MTEXT"):
        try:
            raw = entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text
        except (AttributeError, ValueError):
            continue

        # MTEXT carries the draughtsman's line breaks, so a two-line label
        # arrives as "Enclosed\nBalcony" and prints straight through a report.
        # The break is layout, not content.
        text = " ".join((raw or "").split())
        # Room names are words. Anything mostly digits is a dimension or a level.
        if len(text) < 3 or len(text) > 40:
            continue
        letters = sum(c.isalpha() for c in text)
        if letters < len(text) * 0.5:
            continue

        try:
            point = entity.dxf.insert
        except AttributeError:
            continue

        out.append(
            RoomLabel(x=(point.x - ox) * scale, y=(point.y - oy) * scale, text=text)
        )

    return out


#: Text that names a DRAWING rather than a room: "GROUND FLOOR PLAN".
_PLAN_TITLE = re.compile(r"\bplans?\b", re.I)


def _char_height(entity) -> float:
    """Text height, whichever of the two names this entity type uses."""
    for attr in ("height", "char_height"):
        value = getattr(entity.dxf, attr, None)
        if value:
            return float(value)
    return 0.0


@dataclass(frozen=True)
class PlanTitle:
    """A sheet title, and how big it was drawn."""

    x: float
    y: float
    text: str
    layer: str
    char_height: float


def plan_titles(doc, scale: float, origin: tuple[float, float]) -> list[PlanTitle]:
    """
    Every piece of text that names a drawing on the sheet.

    ── Why this is separate from `room_labels` and must stay separate ────────
    The drawing already says which storey each plan is. `DOWN VILLA` carries
    'Lower Ground Floor Plan', 'Ground Floor Plan', 'First Floor Plan',
    'Second Floor Plan', 'Mezzanine Floor Plan' and 'Roof Plan' as plain TEXT.
    That is the answer to the hardest question in storey registration, written
    down by the architect, for free.

    `room_labels` returns all of them unchanged — they pass its length and
    letter filters comfortably. **`cli.py` then deletes every one**, because it
    keeps only labels where `classify_room(text) != "unknown"`, and a floor-plan
    title is not a room kind. Nine titles on the villa, all discarded.

    The obvious fix — teaching `classify_room` about floor names — is wrong and
    was tried. `classify_room("TERRACE PLAN")` ALREADY returns `outdoor` and
    `"OFFICE PATIO (BELOW)"` returns `study`, which is how a sheet title and a
    void marker ended up in the villa's room list as rooms. Widening that
    function puts more sheet furniture into the building. Level classification
    is a different question asked of the same text, so it gets its own function.

    `char_height` is kept because `room_labels` discards it and the legend test
    needs it: titles in a text-style sample block sit ~2 character heights
    apart, real titles ~75 apart. Measuring separation in character heights
    rather than metres matters because the unit inference is wrong on four of
    the seven drawings in this corpus — and distance and character height scale
    together, so the ratio survives an error that a metre threshold would not.
    """
    ox, oy = origin
    out: list[PlanTitle] = []

    for entity in doc.modelspace().query("TEXT MTEXT"):
        try:
            raw = entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text
        except (AttributeError, ValueError):
            continue

        text = " ".join((raw or "").split())
        # A title is a title, not a note that happens to mention a plan.
        if not text or len(text) > 60 or not _PLAN_TITLE.search(text):
            continue

        try:
            point = entity.dxf.insert
        except AttributeError:
            continue

        # Layer names do NOT identify titles, and this was measured: the villa's
        # two real plan titles sit on `A6 SANITARY WARE`, and 'SECOND FLOOR
        # PLAN' sits on `tx`. Across the corpus a layer literally called `title`
        # carries only a third of them. Same rule as walls — the name
        # pre-selects and never decides.
        out.append(
            PlanTitle(
                x=(point.x - ox) * scale,
                y=(point.y - oy) * scale,
                text=text,
                layer=str(getattr(entity.dxf, "layer", "") or ""),
                # TEXT calls it `height`; MTEXT calls it `char_height`. Reading
                # only one gives 0.0 for the other, and a zero here does not
                # raise — it makes every separation infinite in character
                # heights, so the legend test silently passes everything.
                char_height=_char_height(entity) * scale,
            )
        )

    return out


def nearest_room(x: float, y: float, labels: list[RoomLabel]) -> str | None:
    """The closest room label, or None if the closest is implausibly far."""
    best: str | None = None
    best_d = MAX_LABEL_DISTANCE_M

    for label in labels:
        d = math.hypot(label.x - x, label.y - y)
        if d < best_d:
            best_d, best = d, label.text

    return best


def _point_segment_distance(px, py, x1, y1, x2, y2) -> float:
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def wall_proximity(
    x: float, y: float, wall_segments, scale: float, origin: tuple[float, float]
) -> float:
    """
    Distance in metres from a point to the nearest wall segment.

    Linear over the segment list. That is fine for a survey over a few hundred
    placements, and the pairing stage — which runs this kind of query hundreds
    of thousands of times — gets the STRtree index instead.
    """
    ox, oy = origin
    best = float("inf")

    for seg in wall_segments:
        d = _point_segment_distance(
            x, y,
            (seg.x1 - ox) * scale, (seg.y1 - oy) * scale,
            (seg.x2 - ox) * scale, (seg.y2 - oy) * scale,
        )
        if d < best:
            best = d
            if best < 0.01:
                break

    return best


def open_dxf(path: str):
    """Open a DXF the forgiving way. Real drawings are rarely clean."""
    doc, auditor = recover.readfile(path)
    return doc, auditor


__all__ = [
    "AGAINST_WALL_M",
    "RoomLabel",
    "block_footprints",
    "nearest_room",
    "open_dxf",
    "room_labels",
    "wall_proximity",
]
