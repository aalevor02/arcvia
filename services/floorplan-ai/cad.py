"""
Reading walls out of a CAD drawing.

── Why this beats tracing ──────────────────────────────────────────────────────
Tracing a raster plan means calibrating a scale against a dimension somebody
typed, then drawing over pixels. A DXF already *is* the geometry: exact
coordinates, real units, in the file. Importing it skips calibration, skips
tracing, and skips the wall detector's entire failure surface.

── Why layers cannot be guessed ────────────────────────────────────────────────
There is no convention. One real project — five villa types, seven drawings from
the same practice — put walls on `walls`, `A1 WALLS`, `NEW WALLS` and `Wall`,
and openings on `doors & windows`, `A4 DOOR WIN`, `door`, `WINDOW` and
`WINDOW1`. A hard-coded list works for exactly the drawing it was written
against.

So this reports what is *in* the file — every layer, how much linework each
holds, how big it is — and lets the caller choose. The name heuristic only
pre-selects; it never decides.

── Units ───────────────────────────────────────────────────────────────────────
`$INSUNITS` is supposed to say. It frequently lies, or is unset, and a drawing
in millimetres read as metres produces a building a kilometre across. So the
header is a hint and the extents are the check: buildings are metres to tens of
metres, and anything else is a unit error rather than a very large house.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import ezdxf
from ezdxf import recover


# ---- Units -------------------------------------------------------------------

# $INSUNITS values that matter for building drawings.
_INSUNITS = {1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1.0, 21: 1.0}

#: A building's longest dimension, in metres. Anything outside this is a unit
#: error — a 500 m villa and a 0.02 m villa are both the same mistake.
_PLAUSIBLE = (3.0, 400.0)


def infer_scale_from_walls(segments: list, sample: int = 4000) -> tuple[float, str] | None:
    """
    Work out the drawing's unit from how thick its walls are.

    ── Why neither the header nor the extents will do ──────────────────────────
    `$INSUNITS` is routinely wrong. One real drawing declares 4 — millimetres —
    and is authored in metres; trusting it builds the villa a thousand times too
    small, and the flag gives no hint that it is lying.

    Extents are no better. A sheet may hold a site plan, a title block and four
    floor plans, plotted on a survey grid 45 km from the origin. Its overall
    size says nothing about the unit of the building inside it.

    ── What is actually invariant ──────────────────────────────────────────────
    Wall thickness. Architects draw walls as two parallel face lines, and the
    gap between them is a real physical dimension that has barely changed in a
    century: 100 mm for a stud partition, 230 mm for a nine-inch brick wall,
    350 mm for a cavity. Whatever the drawing's units, the *modal* gap between
    parallel wall faces is one of those numbers.

    So: measure the commonest perpendicular gap between parallel wall lines,
    then pick the unit that maps it into the range a wall can physically be.
    That is a measurement of the building rather than a claim about the file.

    Returns None when there is not enough parallel linework to be confident,
    which is the honest answer for a drawing of single-line walls.
    """
    # Bucketed by direction, so only genuinely parallel lines are compared.
    # 64 buckets over 180 degrees is under three degrees each — tight enough
    # that a wall is not compared against a diagonal, loose enough to tolerate
    # the drift in hand-drafted linework.
    buckets: dict[int, list] = {}

    for seg in segments[:sample]:
        dx, dy = seg.x2 - seg.x1, seg.y2 - seg.y1
        length = math.hypot(dx, dy)
        if length <= 0:
            continue

        angle = math.degrees(math.atan2(dy, dx)) % 180.0
        buckets.setdefault(int(angle / 180.0 * 64), []).append((seg, dx / length, dy / length, length))

    gaps: list[float] = []

    for group in buckets.values():
        if len(group) < 2:
            continue

        # Perpendicular offset of each line from the origin, along this
        # bucket's normal. Two faces of one wall differ by its thickness.
        ux, uy = group[0][1], group[0][2]
        nx, ny = -uy, ux

        offsets = sorted((seg.x1 * nx + seg.y1 * ny, length) for seg, _, _, length in group)

        for (a, la), (b, lb) in zip(offsets, offsets[1:]):
            gap = b - a
            if gap <= 0:
                continue
            # Only pairs of *substantial* lines. A wall face runs the length of
            # a room; the short gap between a dimension tick and its neighbour
            # is not a wall.
            if min(la, lb) < gap * 3:
                continue
            gaps.append(gap)

    if len(gaps) < 20:
        return None

    # The mode, found by histogram rather than by sorting: wall thickness is a
    # spike in an otherwise smooth distribution of every other gap in the
    # drawing, and the spike is what carries the signal.
    smallest = min(gaps)
    if smallest <= 0:
        return None

    bins: dict[int, int] = {}
    step = smallest / 4 or 1e-9
    for gap in gaps:
        bins[int(gap / step)] = bins.get(int(gap / step), 0) + 1

    modal = (max(bins, key=bins.get) + 0.5) * step

    # Which unit puts that gap inside the range a wall can physically occupy?
    for scale, name in ((1.0, "m"), (0.001, "mm"), (0.01, "cm"), (0.0254, "in"), (0.3048, "ft")):
        if 0.07 <= modal * scale <= 0.45:
            return scale, f"wall thickness ({modal * scale:.3f} m)"

    return None


def _scale_from_extent(extent: float) -> tuple[float, str]:
    """
    Infer the drawing's unit from how big it is.

    Used when the header is missing or produces something absurd. A plan is a
    building, and buildings occupy a narrow, known range of real sizes, so the
    only unit that lands the extent inside that range is almost certainly the
    right one.
    """
    for scale, name in ((0.001, "mm"), (0.01, "cm"), (1.0, "m"), (0.0254, "in"), (0.3048, "ft")):
        if _PLAUSIBLE[0] <= extent * scale <= _PLAUSIBLE[1]:
            return scale, name
    return 1.0, "unknown"


# ---- Layer classification ----------------------------------------------------

_WALL_HINT = re.compile(r"\bwall|\bwal\b|^a-?wall|masonry|brick|partition", re.I)
_OPENING_HINT = re.compile(
    r"door|window|win\b|opening|glaz|puerta|ventana|pueryventa",
    re.I,
)
_IGNORE_HINT = re.compile(
    r"dim|text|title|hatch|furn|grid|axis|centre|center|survey|contour|"
    r"north|scale|legend|annot|leader|defpoints",
    re.I,
)


def classify(layer: str) -> str:
    """A guess at what a layer holds, from its name alone."""
    if _IGNORE_HINT.search(layer):
        return "ignore"
    if _WALL_HINT.search(layer):
        return "wall"
    if _OPENING_HINT.search(layer):
        return "opening"
    return "other"


# ---- Extraction ---------------------------------------------------------------

@dataclass
class Segment:
    x1: float
    y1: float
    x2: float
    y2: float
    layer: str

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)


@dataclass
class LayerReport:
    name: str
    segments: int = 0
    total_length: float = 0.0
    guess: str = "other"
    samples: list = field(default_factory=list)


def _explode(entity, layer: str) -> list[Segment]:
    """
    Reduce one entity to straight segments.

    Only the entity types that carry wall linework. Arcs and circles are
    deliberately skipped rather than approximated: a curved wall imported as a
    dozen chords produces a dozen wall records that the plan editor then has to
    be dragged through one at a time, which is worse than leaving it to be
    drawn.
    """
    kind = entity.dxftype()

    if kind == "LINE":
        start, end = entity.dxf.start, entity.dxf.end
        return [Segment(start.x, start.y, end.x, end.y, layer)]

    if kind in ("LWPOLYLINE", "POLYLINE"):
        try:
            points = [(p[0], p[1]) for p in entity.get_points("xy")]
        except (AttributeError, TypeError):
            points = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]

        if getattr(entity, "closed", False) or entity.dxf.get("flags", 0) & 1:
            points = points + points[:1]

        return [
            Segment(a[0], a[1], b[0], b[1], layer)
            for a, b in zip(points, points[1:])
        ]

    return []


def read(path: str) -> dict:
    """
    Open a DXF and report what it contains.

    `recover` rather than `readfile`: drawings that have been round-tripped
    through a dozen tools are routinely malformed in ways AutoCAD tolerates and
    a strict reader does not, and refusing a file the architect can open in
    their own software is not a defensible answer.
    """
    try:
        doc, auditor = recover.readfile(path)
    except (IOError, ezdxf.DXFStructureError) as exc:
        raise ValueError(f"That file could not be read as a DXF: {exc}") from exc

    msp = doc.modelspace()

    layers: dict[str, LayerReport] = {}
    segments: list[Segment] = []

    for entity in msp:
        layer = str(entity.dxf.layer)
        pieces = _explode(entity, layer)
        if not pieces:
            continue

        report = layers.setdefault(layer, LayerReport(name=layer, guess=classify(layer)))
        for piece in pieces:
            if piece.length <= 0:
                continue
            report.segments += 1
            report.total_length += piece.length
            segments.append(piece)

    if not segments:
        raise ValueError("That drawing contains no lines or polylines in model space.")

    # Extents from the geometry, not the header: $EXTMIN/$EXTMAX are stale in
    # any drawing that has been edited without a regen, which is most of them.
    xs = [v for s in segments for v in (s.x1, s.x2)]
    ys = [v for s in segments for v in (s.y1, s.y2)]
    extent_raw = max(max(xs) - min(xs), max(ys) - min(ys))
    extent = extent_raw

    # Order of trust: measured, then header, then size.
    #
    # The measurement comes first because it is the only one derived from the
    # building rather than asserted about the file — and the assertions are
    # demonstrably unreliable. One drawing here declares millimetres, is
    # authored in metres, and passes a sanity check on its extents either way.
    wall_scale = infer_scale_from_walls(
        [s for s in segments if classify(s.layer) == "wall"] or segments
    )

    header_units = _INSUNITS.get(int(doc.header.get("$INSUNITS", 0) or 0))

    if wall_scale:
        scale, unit = wall_scale
    elif header_units and _PLAUSIBLE[0] <= extent * header_units <= _PLAUSIBLE[1]:
        scale, unit = header_units, "header"
    else:
        scale, unit = _scale_from_extent(extent)

    # Every unit that could plausibly be right, with what the drawing measures
    # under each.
    #
    # ── Why this is offered rather than decided ─────────────────────────────
    # Two real drawings from one practice defeat every automatic rule tried
    # here. One declares `$INSUNITS=4` — millimetres — and is authored in
    # metres, so the header is wrong and its extents are plausible either way.
    # The other is a site plan on a survey grid 45 km from the origin, where the
    # overall size says nothing about the building inside it.
    #
    # A wrong unit is not a subtle defect: it builds the villa a thousand times
    # too small, and every downstream number — areas, clearances, the room
    # schedule — is quietly wrong. Given a choice between guessing confidently
    # and asking once, asking is the only defensible option, and the studio
    # already asks exactly this question when calibrating a traced plan.
    candidates = []
    for factor, label in ((1.0, "metres"), (0.001, "millimetres"), (0.01, "centimetres"),
                          (0.0254, "inches"), (0.3048, "feet")):
        size = extent_raw * factor
        if _PLAUSIBLE[0] <= size <= _PLAUSIBLE[1]:
            candidates.append({
                "scale": factor,
                "label": label,
                "extent": round(size, 2),
                "suggested": factor == scale,
            })

    return {
        "layers": sorted(
            (
                {
                    "name": r.name,
                    "segments": r.segments,
                    "length": round(r.total_length * scale, 2),
                    "guess": r.guess,
                }
                for r in layers.values()
            ),
            key=lambda r: -r["segments"],
        ),
        "scale": scale,
        "unit": unit,
        "extent": round(extent_raw * scale, 2),
        "scaleCandidates": candidates,
        "audit": len(auditor.errors),
        "_segments": segments,
        "_origin": (min(xs), min(ys)),
    }


def walls_from(reading: dict, chosen: list[str], min_length: float = 0.3) -> list[dict]:
    """
    Wall segments from the chosen layers, in metres, at the origin.

    Short segments are dropped. CAD walls are drawn as pairs of parallel lines
    joined by short end caps, and those caps are not walls — importing them adds
    a stub at every wall end, each of which the editor then treats as a real
    thing to snap to.

    Coordinates are moved to the origin because a survey drawing is routinely
    plotted in a national grid, hundreds of kilometres from zero. The plan
    editor works in metres near the origin, and a building at eastings 512000
    is off-screen and unfindable.
    """
    picked = set(chosen)
    scale = reading["scale"]
    ox, oy = reading["_origin"]

    out = []
    for segment in reading["_segments"]:
        if segment.layer not in picked:
            continue
        if segment.length * scale < min_length:
            continue

        out.append(
            {
                "a": {"x": round((segment.x1 - ox) * scale, 4), "y": round((segment.y1 - oy) * scale, 4)},
                "b": {"x": round((segment.x2 - ox) * scale, 4), "y": round((segment.y2 - oy) * scale, 4)},
                "layer": segment.layer,
            }
        )
    return out


# ---- Furniture ----------------------------------------------------------------

#: Block-name fragments that map onto catalogue items.
#:
#: Architects abbreviate ruthlessly and inconsistently — one real drawing uses
#: `SI SOFA`, `3 ST SOFA`, `C TAB`, `SID TAB 1`, `D750`, `Tltw`. Alongside those
#: sit `A$C00566C6E`, `VXCBX`, `dfgfg` and `tytyt`, which mean nothing to anyone.
#:
#: So this is a best guess over a messy vocabulary, not a lookup table. What
#: makes it worth having anyway is leverage: a block is *placed* many times —
#: 28 sofas, 88 doors — so recognising one name places dozens of objects, and
#: the names it cannot read become a short list somebody maps once.
_BLOCK_HINTS = [
    # Common Spanish drawing vocabulary. The supplied two-storey house uses
    # PUERTA blocks on a PUERYVENTA layer; treating them as furniture produced
    # showers and dropped every door from the building.
    (("puerta",), "door"),
    (("ventana",), "window"),
    # Longest and most specific first: "3 ST SOFA" must not be caught by "sofa"
    # before it has a chance to match the three-seater.
    (("3 st sofa", "3st sofa", "3 seat", "sofa 3"), "sofa-3"),
    (("2 st sofa", "2 seat", "loveseat"), "sofa-2"),
    (("si sofa", "sig sf", "single sofa", "armchair", "arm chair"), "armchair"),
    (("sofa", "settee", "couch"), "sofa-3"),
    (("c tab", "coffee tab", "ctable"), "coffee-table"),
    (("sid tab", "side tab", "end tab"), "side-table"),
    (("din tab", "dining tab", "dining table", "d table"), "dining-table-6"),
    (("king bed", "bed king"), "bed-king"),
    (("queen bed", "double bed", "bed 1", "bed1", "d bed"), "bed-queen"),
    (("single bed", "s bed"), "bed-single"),
    (("bed",), "bed-queen"),
    (("bed side", "bedside", "night stand", "nightstand", "n tab"), "bedside"),
    (("wardrobe", "ward", "closet", "almirah"), "wardrobe"),
    (("book", "shelf", "shelv"), "bookshelf"),
    (("tv unit", "tv cab", "media"), "tv-unit"),
    (("tv", "television"), "tv"),
    (("dress", "chest", "drawer"), "chest"),
    (("wc", "toilet", "tltw", "closet pan", "ewc"), "wc"),
    (("wash basin", "basin", "wb", "lavatory"), "basin"),
    (("bath tub", "bathtub", "tub"), "bathtub"),
    (("shower", "cubicle"), "shower"),
    (("plant", "pot", "shrub", "tree"), "plant"),
    (("chair", "ch "), "dining-chair"),
    (("stove", "hob", "cook"), "hob"),
    (("fridge", "refrig"), "fridge"),
    (("sink",), "sink-unit"),
    (("mirror",), "mirror"),
    (("rug", "carpet"), "rug"),
    (("curtain", "drape"), "curtain"),
]

#: Names that carry no meaning and should not be guessed at.
#:
#: AutoCAD's anonymous blocks (`A$C…`) and the keyboard-mash names that survive
#: in every production drawing. Offering a guess for `dfgfg` would be worse than
#: admitting ignorance, because a wrong guess gets accepted without thought.
_MEANINGLESS = re.compile(
    r"^a\$c[0-9a-f]+$"  # AutoCAD anonymous blocks
    r"|^[a-z]{1,3}\d*$"  # two or three letters and a number: ewa, TC, 70
    r"|^([a-z])\1{2,}",  # the same letter three times: a keyboard held down
    re.I,
)


#: A door or window named by its width: `D750`, `W1200`, `D-900`.
#:
#: Worth handling before anything else because these are the most numerous
#: blocks in any drawing by a wide margin — one real plan has 88 placements of
#: `D750` alone, more than the next three blocks combined — and because the
#: number is not decoration. It is the leaf width in millimetres, which is
#: exactly the dimension the catalogue wants.
_SIZED_OPENING = re.compile(r"^([dw])[\s\-_]?(\d{3,4})$", re.I)


def guess_item(block: str) -> str | None:
    """The catalogue item a block name probably refers to, or None."""
    name = block.strip().lower()
    if not name:
        return None

    # Ahead of the meaningless check, which would otherwise reject `D750` as
    # "a letter and some digits" — the shape it shares with genuine noise.
    sized = _SIZED_OPENING.match(name)
    if sized:
        width_mm = int(sized.group(2))
        if 500 <= width_mm <= 3000:
            return "door" if sized.group(1).lower() == "d" else "window"

    if _MEANINGLESS.match(name):
        return None

    for fragments, item in _BLOCK_HINTS:
        if any(fragment in name for fragment in fragments):
            return item
    return None


def furniture(path: str, reading: dict, ignore_layers: list | None = None) -> dict:
    """
    Every block placement in the drawing, positioned and guessed at.

    ── Why this is worth far more than recognising furniture in an image ───────
    A block reference carries an exact position, rotation and scale, put there
    by the architect. There is nothing to detect and nothing to infer: the sofa
    is where the drawing says the sofa is. Image recognition on a floor plan is
    guessing at a picture of the same information, badly.

    The mapping is the only uncertain part, and it is uncertain in a way that
    costs almost nothing: one name maps to many placements, so a handful of
    decisions places hundreds of objects, and anything unmapped stays out of the
    scene rather than becoming a wrong object.
    """
    doc, _ = recover.readfile(path)
    msp = doc.modelspace()

    scale = reading["scale"]
    ox, oy = reading["_origin"]
    skip = set(ignore_layers or [])

    placements: list[dict] = []
    blocks: dict[str, dict] = {}

    for insert in msp.query("INSERT"):
        name = str(insert.dxf.name)
        layer = str(insert.dxf.layer)
        if layer in skip:
            continue

        summary = blocks.setdefault(
            name,
            {"name": name, "count": 0, "item": guess_item(name), "layer": layer},
        )
        summary["count"] += 1

        point = insert.dxf.insert
        placements.append(
            {
                "block": name,
                "layer": layer,
                "position": {
                    "x": round((point.x - ox) * scale, 4),
                    "y": round((point.y - oy) * scale, 4),
                },
                # DXF rotation is degrees counter-clockwise; the plan model uses
                # radians in the same direction, so this is a unit change only.
                "rotation": round(math.radians(float(insert.dxf.rotation or 0.0)), 5),
            }
        )

    return {
        "blocks": sorted(blocks.values(), key=lambda b: -b["count"]),
        "placements": placements,
        "recognised": sum(1 for p in placements if blocks[p["block"]]["item"]),
    }
