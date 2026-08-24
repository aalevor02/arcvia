"""
Floor-plan detection service.

Takes an architectural floor-plan image and returns the symbols it finds —
walls, doors, windows and fixtures — as normalised coordinates the studio can
turn into geometry.

This is the piece marketed as "AI". Concretely it is an object detector over
drawing symbols, not a language model. Two backends are supported:

  * `heuristic` (default) — classical computer vision. Morphological line
    extraction for walls, template matching for symbols. No model weights, no
    GPU, no per-call cost, runs anywhere. Accuracy is decent on clean CAD
    exports and poor on scans.

  * `yolo` — a trained YOLO detector, if you have weights. Much better on
    messy input. Set FLOORPLAN_MODEL to the weights path to enable.

Starting on the heuristic backend is deliberate: it makes the whole product
runnable end-to-end today, and it gives you a baseline to measure a trained
model against. Collect real customer plans through this, and those become the
training set for the model that replaces it.

Run:  uvicorn main:app --port 8090
"""

from __future__ import annotations

import io
import math
import os
import re
from typing import Literal, NamedTuple

import cv2
import numpy as np

import adjudicate as adjudicate_pass
import deck
import labels as text_labels
import pdfbackend
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BACKEND: Literal["heuristic", "yolo"] = os.environ.get("FLOORPLAN_BACKEND", "heuristic")  # type: ignore[assignment]
MODEL_PATH = os.environ.get("FLOORPLAN_MODEL", "")
MAX_PIXELS = 40_000_000  # ~40MP; refuse decompression bombs

WALL_CLASSES = ("door", "window", "commode")
FLOOR_CLASSES = ("bed", "chair", "dining_table", "sofa", "cabinet")

app = FastAPI(title="Arcvia floor-plan detection", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get(
            "ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:4321"
        ).split(",")
        if o.strip()
    ],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Response shapes
# --------------------------------------------------------------------------

class Point(BaseModel):
    x: float  # normalised 0..1 across image width
    y: float  # normalised 0..1 down image height


class WallSegment(BaseModel):
    start: Point
    end: Point
    thickness: float  # normalised against image width
    confidence: float


class Detection(BaseModel):
    label: str
    bbox: list[float]  # [x, y, w, h], all normalised
    confidence: float
    attaches_to: Literal["wall", "floor"]


class Room(BaseModel):
    """
    An area the walls enclose.

    Reported alongside the walls rather than left for the caller to work out,
    because the detector has to find these anyway in order to know which strokes
    are walls at all — and because "we found 92 walls and no rooms" is the exact
    shape of a failed import.
    """

    polygon: list[Point]
    area: float  # fraction of the building's footprint
    # Whatever the drawing calls this space. None when the plan is unlabelled or
    # OCR is not installed — an unnamed room is still a room.
    name: str | None = None
    # What sort of thing this area is.
    #
    #   room     a space inside the building
    #   fitting  joinery the drawing labelled — a wardrobe, a dresser
    #   outdoor  ground: a lawn, a pool, a planting bed
    #
    # None of these can be told apart by shape. All three are areas shut in by
    # lines, which is why the labels matter so much: a pool edge and a bedroom
    # wall are the same drawing, and only the words say which is which.
    kind: Literal["room", "fitting", "outdoor"] = "room"
    # The size printed inside it, in metres, if one was printed.
    size: list[float] | None = None
    # Other room names found inside the same outline. A non-empty list means two
    # or more spaces were read as one — through an open plan or a doorway the
    # seal could not bridge — and is worth saying out loud, because the fix is a
    # wall the user can draw in seconds and nobody else can guess.
    also: list[str] = []


class PlanScale(BaseModel):
    """
    How big the drawing is in the world.

    `metres_per_unit` converts a normalised x-distance — 1.0 being the full
    width of the image — into metres. Read off the room sizes the architect
    printed on the plan rather than asked of the user.
    """

    metres_per_unit: float
    samples: int
    # Disagreement between those samples. Past a few percent something is wrong
    # with the sheet, and the caller should say so rather than pick one. None
    # from a single room, which has nothing to disagree with.
    spread: float | None


class DetectionResult(BaseModel):
    backend: str
    width: int
    height: int
    walls: list[WallSegment]
    objects: list[Detection]
    rooms: list[Room]
    scale: PlanScale | None
    # Surfaced so the UI can say "check these" instead of implying certainty.
    low_confidence: bool
    # What the adjudication pass did, in words a reviewer can act on —
    # "dropped 4 proposed wall(s) — bed (85%)". Empty without an adjudicator,
    # so existing consumers see the shape they always saw.
    notes: list[str] = []


# --------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "backend": BACKEND,
        "model_loaded": bool(MODEL_PATH) and BACKEND == "yolo",
        # Both are optional extras, and both change what the service can do
        # rather than merely how well it does it, so the caller is told.
        "reads_text": text_labels.available(),
        "reads_pdf": deck.available(),
        # WHICH reader, not just whether there is one. Two backends that both
        # work will still disagree about a difficult deck, so a bug report that
        # does not say which one produced the output is a bug report that costs
        # an extra round trip. Anything other than "permissive" here means a
        # human deliberately selected it — see requirements-dev.txt.
        "pdf_backend": pdfbackend.backend_name(),
        # The vision model that second-guesses proposals, or null when none is
        # configured. Named so a bug report says which model judged the plan.
        "adjudicator": adjudicate_pass.name(),
    }


@app.post("/detect", response_model=DetectionResult)
async def detect(file: UploadFile = File(...)) -> DetectionResult:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")

    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not read that image.")

    height, width = image.shape[:2]
    if width * height > MAX_PIXELS:
        raise HTTPException(status_code=413, detail="Image is too large.")

    if BACKEND == "yolo":
        walls, objects, rooms, scale = detect_yolo(image)
    else:
        walls, objects, rooms, scale = detect_heuristic(image)

    # A vision model second-guesses the proposals against the picture itself —
    # the heuristic keeps deciding WHERE, the model only ever decides WHAT.
    # Opt-in by key, fail-open by contract: without a key, or on any network
    # or parsing failure, the result is exactly what the heuristic said.
    notes: list[str] = []
    if adjudicate_pass.available():
        walls, objects, rooms, notes = adjudicate_pass.adjudicate(
            image, walls, objects, rooms, Detection,
        )

    confidences = [w.confidence for w in walls] + [o.confidence for o in objects]
    mean_confidence = float(np.mean(confidences)) if confidences else 0.0

    return DetectionResult(
        backend=BACKEND,
        width=width,
        height=height,
        walls=walls,
        objects=objects,
        rooms=rooms,
        scale=scale,
        notes=notes,
        # No enclosed rooms is the signal that matters. A detector pointed at a
        # brochure returns plenty of confident straight lines and not one room,
        # so wall count and mean confidence both read as success on exactly the
        # input that has failed.
        low_confidence=mean_confidence < 0.55 or not walls or not rooms,
    )


class Sheet(BaseModel):
    """One image inside an uploaded document, and what the document says it is."""

    page: int
    index: int
    kind: str  # plan | elevation | render | board | other
    caption: str
    floor: str | None
    room: str | None
    width: int
    height: int
    share: float
    # Dominant colours, most-used first, for renders only. The finishes an
    # architect chose live in these, and a room built in the deck's own palette
    # looks like the deck.
    palette: list[str]


class DocumentOutline(BaseModel):
    pages: int
    sheets: list[Sheet]


@app.post("/document", response_model=DocumentOutline)
async def document(file: UploadFile = File(...)) -> DocumentOutline:
    """
    What is in this PDF.

    Returns a description, not the contents. A deck holds twenty-odd 4K images
    and shipping them all back so the caller can decide it wanted two of them
    would be a waste measured in tens of megabytes — so this answers "what is
    here", and `/document/page` fetches the ones that turn out to matter.
    """
    if not deck.available():
        raise HTTPException(status_code=503, detail="PDF reading is not installed.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")

    try:
        sheets = deck.outline(raw)
    except Exception as error:
        raise HTTPException(
            status_code=400, detail=f"That file could not be read as a PDF. {error}"
        ) from error

    return DocumentOutline(
        pages=max((sheet.page for sheet in sheets), default=0),
        sheets=[Sheet(**sheet._asdict()) for sheet in sheets],
    )


@app.post("/document/page")
async def document_page(
    file: UploadFile = File(...),
    page: int = 1,
    index: int = 0,
    long_edge: int = 2400,
) -> Response:
    """One image out of the document, at a workable size."""
    if not deck.available():
        raise HTTPException(status_code=503, detail="PDF reading is not installed.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")

    try:
        image = deck.extract(raw, page=page, index=index, long_edge=long_edge)
    except IndexError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return Response(content=image, media_type="image/png")


# --------------------------------------------------------------------------
# Heuristic backend
# --------------------------------------------------------------------------

def detect_heuristic(
    image: np.ndarray,
) -> tuple[list[WallSegment], list[Detection], list[Room], PlanScale | None]:
    """
    Find the rooms first, and let the walls follow from them.

    ── Why not classify each line ──────────────────────────────────────────────
    The obvious pipeline — extract every long straight stroke, then decide which
    ones are walls — cannot work on a furnished presentation plan, and it took a
    drawing full of extruded beds to see why. Nothing local to a stroke settles
    the question. A double bed is 2 m long and a partition wall is 3 m; both are
    drawn four pixels wide at brochure resolution; both are dark. Length, weight,
    colour and pixel texture were all measured on a real plan, and none of them
    separates the two.

    What separates them is not a property of the line. It is what the line
    *does*. A wall bounds a room; a bed sits inside one. So the reading runs the
    other way round: seal the doorways, flood the enclosed regions, and keep only
    the strokes lying on a region's edge. Furniture is then rejected not because
    it looks like furniture, but because there is nothing behind it — and the
    same rule quietly discards stair treads, hatching and the site boundary
    without a special case for any of them.
    """
    height, width = image.shape[:2]
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Read the sheet before looking at it. What the architect wrote settles
    # questions the pixels cannot — which region is a wardrobe rather than a
    # room, and how many metres a pixel is worth.
    annotations = text_labels.read_labels(image)

    # Kernel length scales with the image so the same code works on a 900px
    # sketch and an 8000px plot.
    h_len = max(20, width // 40)
    v_len = max(20, height // 40)

    # Two ways of separating ink from paper, because no single one works on both
    # kinds of input this receives.
    #
    #   adaptive — right for a *scan*, where lighting is uneven across the sheet
    #     and a global cut loses whole regions.
    #
    #   dark cut — right for a *flat render*, where a wall drawn as solid poche
    #     has a local mean that is itself dark, so adaptive thresholding sees
    #     only its thin edges and can miss the building altogether.
    #
    # The cut is Otsu's, taken over the pixels below the image mean rather than
    # the whole image: two thirds of a plan is white paper, so plain Otsu splits
    # paper from everything-else and keeps the lot. Restricted to the dark half
    # it lands between wall fill and furniture instead.
    adaptive = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 10
    )

    ink = grey[grey < grey.mean()]
    if ink.size > 0:
        cut, _ = cv2.threshold(ink, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        dark = ((grey < cut).astype(np.uint8)) * 255
    else:
        dark = adaptive

    # Whichever reading closes the most rooms *the architect named*.
    #
    # Two simpler rules were tried and both were gameable, in opposite
    # directions. Scoring by enclosed area rewards missing a partition, because
    # two rooms merged into one cover more of the sheet than either alone.
    # Scoring by room count rewards the reverse — a reading that shatters the
    # plan into slivers of bed, terrace and paving beats one that read the
    # building correctly.
    #
    # Named rooms cannot be gamed either way, because the names are not ours.
    # A slice of a terrace has no name; a bedroom does. Counting how many of the
    # drawing's own labels ended up in a region of their own asks the only
    # question that matters — did this reading find the rooms? — and the answer
    # comes from the drawing rather than from a proxy we invented.
    #
    # Area remains the tie-break, and carries an unlabelled drawing on its own.
    readings = [
        read_binary(adaptive, width, height, h_len, v_len, annotations),
        read_binary(dark, width, height, h_len, v_len, annotations),
    ]
    best = max(
        readings,
        key=lambda reading: (
            sum(1 for room in reading.rooms if room.kind == "room" and room.name),
            reading.enclosed,
        ),
    )

    return best.walls, detect_openings(best.walls), best.rooms, best.scale


class Reading(NamedTuple):
    """One interpretation of a drawing, and how much of it it managed to close."""

    walls: list[WallSegment]
    rooms: list[Room]
    enclosed: float  # room area as a fraction of the building's footprint
    scale: PlanScale | None


def read_binary(
    binary: np.ndarray,
    width: int,
    height: int,
    h_len: int,
    v_len: int,
    annotations: list[text_labels.Label] | None = None,
) -> Reading:
    """Read one binarised image all the way through to walls and rooms."""
    horizontal = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (h_len, 1))
    )
    vertical = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_len))
    )

    candidates = reject_text_strokes(
        walls_from_lines(horizontal, vertical, width, height, h_len, v_len)
    )
    labels, room_ids, footprint = enclosed_regions(horizontal, vertical, h_len, v_len)

    if room_ids:
        regions = room_polygons(labels, room_ids, width, height, footprint)
        regions, scale = name_regions(regions, annotations or [], width, height)

        # Only rooms bound walls. A wardrobe's sides are joinery, and keeping
        # them would put a stud partition around every cupboard in the model.
        walls = keep_room_boundaries(
            candidates,
            labels,
            [room_ids[i] for i, r in enumerate(regions) if r.kind == "room"],
            width,
            height,
        )

        # Fittings are returned rather than dropped, and that reverses the whole
        # point of finding them. They were identified in order to keep them out
        # of the walls — but a fitting *is* the plan's own drawing of a piece of
        # furniture, with its footprint, its size and often its name. Discarding
        # them threw away the answer to "put the furniture in for me" at the
        # exact moment it had been worked out.
        rooms = regions
        enclosed = sum(room.area for room in regions if room.kind == "room")
    else:
        # Nothing closed. That is either a fragment of a plan or not a plan at
        # all, and the boundary rule has no opinion either way, because it has
        # no boundaries to consult. Fall back to judging strokes by their
        # weight, which is weaker but is not nothing.
        walls = reject_thin_strokes(candidates)
        rooms = []
        enclosed = 0.0
        scale = None

    return Reading(merge_collinear(merge_parallel(walls)), rooms, enclosed, scale)


# A doorway is a gap in a wall about three times the shortest run we are willing
# to call a wall at all — one scale constant rather than two that can drift
# apart.
DOORWAY = 3

# How much of the building's footprint a region must cover to be a room. A
# 1.5 m shower in a 12 m villa is around 1.5%; the slivers between stair treads
# are an order of magnitude below that.
MIN_ROOM_AREA = 0.005


def enclosed_regions(
    horizontal: np.ndarray, vertical: np.ndarray, h_len: int, v_len: int
) -> tuple[np.ndarray, list[int], float]:
    """
    The regions the walls shut in.

    Doorways are sealed *along* each wall's own direction — a horizontal kernel
    on the horizontal strokes, a vertical one on the vertical. A square kernel
    is the obvious choice and does work, but it fattens every wall in both
    directions at once and swallows narrow rooms whole. Closing directionally
    bridges the gap in a wall without touching its thickness.
    """
    sealed = cv2.bitwise_or(
        cv2.morphologyEx(
            horizontal,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (h_len * DOORWAY, 1)),
        ),
        cv2.morphologyEx(
            vertical,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_len * DOORWAY)),
        ),
    )

    ink = cv2.findNonZero(sealed)
    if ink is None:
        return np.zeros(sealed.shape, np.int32), [], 0.0

    # Measured against the building rather than the sheet, so a plan floated in
    # a wide margin is held to the same standard as one that fills the page.
    _, _, plan_w, plan_h = cv2.boundingRect(ink)
    footprint = float(plan_w * plan_h)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        cv2.bitwise_not(sealed), connectivity=4
    )

    # Anything reaching the edge of the sheet is the world outside the building,
    # however convincingly room-shaped it looks.
    outside = (
        set(labels[0, :].tolist())
        | set(labels[-1, :].tolist())
        | set(labels[:, 0].tolist())
        | set(labels[:, -1].tolist())
    )
    room_ids = [
        i
        for i in range(1, count)
        if i not in outside and stats[i, cv2.CC_STAT_AREA] > footprint * MIN_ROOM_AREA
    ]
    return labels, room_ids, footprint


def keep_room_boundaries(
    walls: list[WallSegment],
    labels: np.ndarray,
    room_ids: list[int],
    width: int,
    height: int,
) -> list[WallSegment]:
    """
    Keep the strokes that sit on the edge of a room.

    Only each region's *outer* contour counts. A bed drawn inside a bedroom
    punches a hole in that region and the region wraps around it, so the bed has
    room pixels on every side of it and still is not part of the room's outline
    — which is exactly the distinction being drawn.
    """
    if not walls:
        return walls

    # Reach far enough to cover a wall's half-thickness, since the region stops
    # at the wall's inner face while the detected segment runs down its middle.
    reach = int(np.percentile([wall.thickness * width for wall in walls], 90)) + 4

    edges = np.zeros(labels.shape, np.uint8)
    for room_id in room_ids:
        contours, _ = cv2.findContours(
            (labels == room_id).astype(np.uint8),
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        cv2.drawContours(edges, contours, -1, 255, reach * 2)

    return [wall for wall in walls if on_boundary(wall, edges, width, height)]


def on_boundary(wall: WallSegment, edges: np.ndarray, width: int, height: int) -> bool:
    """
    Does most of this segment run along a room edge?

    Most, not all: a wall commonly overshoots the room it bounds at a corner or
    a doorway reveal, and demanding every sample would throw away good walls for
    the sake of their last few pixels.
    """
    x0, y0 = wall.start.x * width, wall.start.y * height
    x1, y1 = wall.end.x * width, wall.end.y * height
    steps = max(4, int(_span(wall) * max(width, height) / 4))

    hits = 0
    for step in range(steps + 1):
        along = step / steps
        y = min(height - 1, max(0, int(y0 + (y1 - y0) * along)))
        x = min(width - 1, max(0, int(x0 + (x1 - x0) * along)))
        hits += edges[y, x] > 0

    return hits / (steps + 1) >= 0.6


def room_polygons(
    labels: np.ndarray,
    room_ids: list[int],
    width: int,
    height: int,
    footprint: float,
) -> list[Room]:
    """Each enclosed region as a simplified polygon in normalised coordinates."""
    rooms: list[Room] = []
    for room_id in room_ids:
        mask = (labels == room_id).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        outline = max(contours, key=cv2.contourArea)

        # Simplify to about half a wall thickness, which drops the raster's
        # staircasing without rounding off a genuine alcove.
        simple = cv2.approxPolyDP(outline, 0.004 * max(width, height), True)
        if len(simple) < 3:
            continue

        rooms.append(
            Room(
                polygon=[
                    Point(x=float(p[0][0]) / width, y=float(p[0][1]) / height)
                    for p in simple
                ],
                area=(
                    round(float(cv2.contourArea(outline)) / footprint, 4)
                    if footprint
                    else 0.0
                ),
            )
        )
    return rooms


def name_regions(
    regions: list[Room],
    annotations: list[text_labels.Label],
    width: int,
    height: int,
) -> tuple[list[Room], PlanScale | None]:
    """
    Give each region the name the architect printed inside it, and read the
    drawing's scale off the sizes printed beside those names.

    Three things fall out of one pass, which is why they are done together:

      * A region holding the word WARDROBE is joinery, not a room. This is the
        only reliable answer to the problem that sank every earlier attempt —
        a bed and a partition wall are the same length, the same weight and the
        same colour, and no measurement tells them apart. The drawing simply
        says which is which.

      * A region holding SHOWER is a room, and now has a name a render can be
        matched to later without anyone picking from a list.

      * A region holding "7'0"X5'9"" states its own size, and comparing that
        against its size in pixels gives the scale. Every labelled room votes.
    """
    if not annotations:
        return regions, None

    named: list[Room] = []
    measurements: list[tuple[float, tuple[float, float]]] = []

    for region in regions:
        polygon = [(point.x, point.y) for point in region.polygon]
        within = [label for label in annotations if text_labels.inside(label, polygon)]

        name = None
        kind = "room"
        size = None
        anchor = None
        also: list[str] = []

        # Where a doorway or an open plan left several spaces joined, the region
        # holds several room names at once. The one nearest the middle is the
        # best answer to "what is this"; the rest are not noise but the clearest
        # possible evidence that the region is a merge, so they are reported
        # instead of discarded.
        centre_x = sum(point.x for point in region.polygon) / len(region.polygon)
        centre_y = sum(point.y for point in region.polygon) / len(region.polygon)

        room_labels = [l for l in within if text_labels.classify(l.text) == "room"]

        # Which of several names is *the* name: the biggest space wins, judged
        # by the size printed beside each. A region holding a bedroom, a study
        # and a toilet is mostly bedroom, and calling it Toilet because that
        # caption happens to sit nearer the centroid would be perverse.
        # Centrality only breaks ties among names with no size to compare.
        def prominence(label):
            sizes = [
                text_labels.parse_dimension(other.text)
                for other in within
                if abs(other.y - label.y) < 0.04 and abs(other.x - label.x) < 0.12
            ]
            areas = [dims[0] * dims[1] for dims in sizes if dims]
            return (
                max(areas) if areas else 0.0,
                -((label.x - centre_x) ** 2 + (label.y - centre_y) ** 2),
            )

        room_labels.sort(key=prominence, reverse=True)

        outdoors = [l for l in within if text_labels.classify(l.text) == "outdoor"]

        if outdoors:
            # Ground beats everything, including a room name that strayed inside
            # the same outline. A terrace that has swallowed the lawn beside it
            # is still not somewhere to put a floor.
            name, kind, anchor = tidy(outdoors[0].text), "outdoor", outdoors[0]
        elif room_labels:
            name, kind, anchor = tidy(room_labels[0].text), "room", room_labels[0]
            also = [tidy(l.text) for l in room_labels[1:]]
        else:
            fittings = [l for l in within if text_labels.classify(l.text) == "fitting"]
            if fittings:
                name, kind, anchor = tidy(fittings[0].text), "fitting", fittings[0]

        # The size that belongs to this room is the one printed *under its
        # name*, not merely the first one falling inside its outline. Regions
        # routinely swallow a neighbour's caption — where a doorway left two
        # rooms joined, or where an unlabelled alcove sits inside a bedroom —
        # and pairing by proximity to the name is how a reader tells which
        # caption goes with which space.
        printed = [
            (label, text_labels.parse_dimension(label.text))
            for label in within
        ]
        printed = [(label, dims) for label, dims in printed if dims]

        # A caption also has to be the right *shape* for the space it sits in.
        # OCR loses a prime often enough that 8'10" comes back as 810', and the
        # result is a plausible number in an impossible proportion. Checking it
        # against the outline costs nothing and turns a wrong answer into no
        # answer, which is the better of the two by a distance when the number
        # ends up on a client's drawing.
        xs = [point.x * width for point in region.polygon]
        ys = [point.y * height for point in region.polygon]
        long_side = max(max(xs) - min(xs), max(ys) - min(ys))
        short_side = min(max(xs) - min(xs), max(ys) - min(ys))
        drawn_ratio = long_side / short_side if short_side else 0

        def plausible(dims):
            printed_ratio = max(dims) / min(dims) if min(dims) else 0
            if not printed_ratio or not drawn_ratio:
                return False
            return 0.5 <= drawn_ratio / printed_ratio <= 2.0

        printed = [(label, dims) for label, dims in printed if plausible(dims)]
        if printed:
            if anchor is not None:
                printed.sort(
                    key=lambda pair: (pair[0].x - anchor.x) ** 2
                    + (pair[0].y - anchor.y) ** 2
                )
            label, dims = printed[0]
            size = [round(dims[0], 2), round(dims[1], 2)]

        # Voting on the scale asks more of a caption than merely reporting it:
        # the proportions have to match closely, not just plausibly. A room that
        # has quietly merged with its neighbour still carries a readable size,
        # and letting that pair vote would drag the scale off by however much
        # the two rooms differ.
        if size and kind == "room" and drawn_ratio:
            printed_ratio = max(size) / min(size) if min(size) else 0
            if printed_ratio and 0.8 <= drawn_ratio / printed_ratio <= 1.25:
                # Measured in units of the image's width on both axes, so the
                # returned scale has one meaning rather than two.
                measurements.append((long_side / width, (size[0], size[1])))

        named.append(
            region.model_copy(
                update={"name": name, "kind": kind, "size": size, "also": also}
            )
        )

    rooms_named = [room for room in named if room.kind == "room" and room.name]

    # An unlabelled region on a drawing where everything else is labelled, and
    # smaller than the smallest thing that *was* named a room, is furniture the
    # architect did not bother to caption — a bed, most often. Held to both
    # tests because either alone is wrong: plenty of good plans carry no labels
    # at all, and plenty of real rooms are small.
    if len(rooms_named) >= 3:
        floor = min(room.area for room in rooms_named)
        named = [
            room
            if room.name or room.area >= floor
            else room.model_copy(update={"kind": "fitting"})
            for room in named
        ]

    # And an unlabelled region well outside the building is not part of it.
    #
    # ── The failure this fixes ──────────────────────────────────────────────
    # A villa plan draws its site as carefully as its rooms: a pool, planting
    # beds, landscape steps, a paved court. Every one of those is an area shut
    # in by lines, so the room-first reader keeps their edges as walls — and a
    # client opens a model of a house wrapped in masonry that traces the
    # swimming pool.
    #
    # The named rooms say where the building is. Taking their extent and
    # discarding unlabelled regions that fall outside it uses the one thing on
    # the drawing that is unambiguous about the boundary between house and
    # ground: the architect's own room names.
    #
    # Applied only when the drawing is labelled enough for that extent to mean
    # something, and never to a region that carries a name — a named room
    # outside the others is an outbuilding, not a mistake.
    if len(rooms_named) >= 3:
        xs = [point.x for room in rooms_named for point in room.polygon]
        ys = [point.y for room in rooms_named for point in room.polygon]
        # A generous margin: external walls, a porch and a stair all sit outside
        # the rooms they serve, and none of them is site.
        margin_x = (max(xs) - min(xs)) * 0.12
        margin_y = (max(ys) - min(ys)) * 0.12
        bounds = (min(xs) - margin_x, min(ys) - margin_y,
                  max(xs) + margin_x, max(ys) + margin_y)

        named = [
            room
            if room.name or room.kind != "room" or within_bounds(room, bounds)
            else room.model_copy(update={"kind": "outdoor"})
            for room in named
        ]

    scale = text_labels.infer_scale(measurements)
    return named, (
        PlanScale(
            metres_per_unit=round(scale.metres_per_unit, 4),
            samples=scale.samples,
            spread=scale.spread,
        )
        if scale
        else None
    )


def within_bounds(room: Room, bounds: tuple[float, float, float, float]) -> bool:
    """Is most of this region inside the building's extent?"""
    low_x, low_y, high_x, high_y = bounds
    inside = sum(
        1
        for point in room.polygon
        if low_x <= point.x <= high_x and low_y <= point.y <= high_y
    )
    return inside >= len(room.polygon) * 0.6


def tidy(text: str) -> str:
    """`WALK - IN` and `BEDROOM- 1` as a person would write them."""
    cleaned = re.sub(r"\s*-\s*", "-", text.strip())
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.title()


def walls_from_lines(
    horizontal: np.ndarray,
    vertical: np.ndarray,
    width: int,
    height: int,
    h_len: int,
    v_len: int,
) -> list[WallSegment]:
    """Every long axis-aligned run in the drawing, walls and furniture alike."""
    walls: list[WallSegment] = []
    for mask, axis in ((horizontal, "h"), (vertical, "v")):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            length = w if axis == "h" else h
            thickness = h if axis == "h" else w

            if length < (h_len if axis == "h" else v_len):
                continue
            # A "wall" thicker than it is long is a filled region, not a wall.
            if thickness > length * 0.5:
                continue

            if axis == "h":
                start, end = (x, y + h / 2), (x + w, y + h / 2)
            else:
                start, end = (x + w / 2, y), (x + w / 2, y + h)

            # Longer runs are more confidently walls, saturating at 1/8 of the
            # image dimension so a very long wall does not score above 0.95.
            span = length / (width if axis == "h" else height)
            confidence = float(min(0.95, 0.45 + span * 4))

            walls.append(
                WallSegment(
                    start=Point(x=start[0] / width, y=start[1] / height),
                    end=Point(x=end[0] / width, y=end[1] / height),
                    thickness=thickness / width,
                    confidence=round(confidence, 3),
                )
            )
    return walls


def _span(wall: WallSegment) -> float:
    """Normalised length of a segment."""
    return math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y)


def reject_thin_strokes(walls: list[WallSegment]) -> list[WallSegment]:
    """
    Drop furniture outlines that are the right length to pass for walls.

    ── The problem ─────────────────────────────────────────────────────────────
    Length alone does not separate a wall from a bed. A double bed is 2 m, a
    three-seater sofa 2.1 m, a kitchen run 3 m — all comfortably longer than the
    minimum a wall has to clear. On a furnished presentation plan the result is
    a building whose beds and sofas have been extruded into walls, which is
    exactly what a client sees and cannot explain.

    ── What actually separates them ────────────────────────────────────────────
    Weight of line. Architects draw walls heavy — often poché, filled solid —
    and furniture with a thin outline, precisely so a reader can tell structure
    from contents at a glance. That convention is near universal, and morphology
    already measures it: every candidate carries the thickness of its stroke.

    The reference comes from the longest segments in the drawing, because those
    are always external walls. Nothing else in a floor plan runs the full width
    of the building — there is no three-metre sofa in a four-metre room. So the
    longest tenth defines what "wall weight" means for *this* drawing, at
    whatever resolution it happened to be scanned, and anything markedly thinner
    is contents rather than structure.
    """
    if len(walls) < 8:
        return walls

    longest = sorted(walls, key=_span, reverse=True)
    reference = longest[: max(3, len(longest) // 10)]

    weights = sorted(w.thickness for w in reference)
    typical = weights[len(weights) // 2]
    if typical <= 0:
        return walls

    # Just over half. Generous on purpose: a partition is genuinely thinner than
    # an external wall, and losing real internal walls to catch furniture is the
    # worse trade — a missing partition is visible and easily drawn in, whereas
    # a sofa extruded into a wall is baffling and hard to even describe.
    floor_weight = typical * 0.55
    kept = [w for w in walls if w.thickness >= floor_weight]

    # If that would discard almost everything, this drawing has no weight
    # convention to read — a single-line CAD export, say — and the filter has
    # nothing to say about it. Passing it through unchanged beats returning an
    # empty plan for a drawing that was perfectly fine.
    return kept if len(kept) >= len(walls) * 0.25 else walls


def reject_text_strokes(walls: list[WallSegment]) -> list[WallSegment]:
    """
    Drop segments that are lettering rather than structure.

    Every real floor plan carries room labels, dimension text and legends. The
    vertical stroke of a capital B or D is a short, thin, perfectly straight run
    — indistinguishable from a wall to morphology alone, and it *will* be picked
    up on any plan a customer actually uploads.

    What separates them is stroke weight. Walls on a given sheet are drawn at
    one consistent line weight, and it is heavier than the text. So: take the
    median thickness of everything found, and reject anything meaningfully
    thinner than the dominant weight.

    Using the median rather than the mean matters — on a text-heavy plan the
    letters can outnumber the walls, and a mean would be dragged down to the
    text weight and reject the walls instead.
    """
    if len(walls) < 3:
        return walls

    thicknesses = sorted(w.thickness for w in walls)
    median = thicknesses[len(thicknesses) // 2]

    # A plan drawn at a single weight has a tight distribution; 60% of median is
    # loose enough to keep genuine thin partitions and tight enough to lose text.
    floor = median * 0.6

    kept = [w for w in walls if w.thickness >= floor]

    # If that rejected almost everything, the assumption did not hold for this
    # drawing (e.g. mixed weights). Better to return the unfiltered set than an
    # empty one.
    return kept if len(kept) >= max(2, len(walls) * 0.15) else walls


def merge_collinear(
    walls: list[WallSegment], tolerance: float = 0.004
) -> list[WallSegment]:
    """Morphology fragments a wall into pieces where furniture overlaps it."""
    merged: list[WallSegment] = []

    for wall in sorted(walls, key=lambda w: (w.start.y, w.start.x)):
        joined = False
        for i, existing in enumerate(merged):
            same_row = abs(existing.start.y - wall.start.y) < tolerance and abs(
                existing.end.y - wall.end.y
            ) < tolerance
            same_col = abs(existing.start.x - wall.start.x) < tolerance and abs(
                existing.end.x - wall.end.x
            ) < tolerance

            if same_row and wall.start.x <= existing.end.x + tolerance * 3:
                merged[i] = existing.model_copy(
                    update={"end": Point(x=max(existing.end.x, wall.end.x), y=existing.end.y)}
                )
                joined = True
                break
            if same_col and wall.start.y <= existing.end.y + tolerance * 3:
                merged[i] = existing.model_copy(
                    update={"end": Point(x=existing.end.x, y=max(existing.end.y, wall.end.y))}
                )
                joined = True
                break

        if not joined:
            merged.append(wall)

    return merged


# Two parallel runs closer together than this are two readings of one wall.
# Expressed against the drawing, it is roughly 18 cm on a 12 m building —
# narrower than any gap a genuine pair of separate walls would leave, and wider
# than the spacing of a hatch.
WALL_BAND = 0.015


def merge_parallel(
    walls: list[WallSegment], tolerance: float = WALL_BAND
) -> list[WallSegment]:
    """
    Collapse the several lines a hatched wall is drawn with into one wall.

    Architects hatch walls rather than fill them solid at larger scales, and
    morphology reads every stroke of the hatch as a run of its own. One wall
    arrives as five parallel lines a few pixels apart, and the model built from
    them has five walls where the building has one.

    Merging them is not only tidying. The band those strokes span *is* the
    wall's thickness — something no single stroke ever said.
    """
    kept: list[WallSegment] = []

    for horizontal in (True, False):
        group = [
            wall
            for wall in walls
            if (abs(wall.end.y - wall.start.y) <= abs(wall.end.x - wall.start.x))
            is horizontal
        ]

        def across(wall: WallSegment) -> tuple[float, float]:
            """Position across the wall, and extent along it."""
            if horizontal:
                return (wall.start.y + wall.end.y) / 2, wall.start.x
            return (wall.start.x + wall.end.x) / 2, wall.start.y

        def along(wall: WallSegment) -> tuple[float, float]:
            values = (
                (wall.start.x, wall.end.x) if horizontal else (wall.start.y, wall.end.y)
            )
            return min(values), max(values)

        bands: list[dict] = []
        for wall in sorted(group, key=lambda w: across(w)[0]):
            offset, _ = across(wall)
            low, high = along(wall)

            for band in bands:
                if offset - band["far"] > tolerance:
                    continue
                # Two walls facing each other across a corridor are parallel and
                # far apart; two readings of one wall are parallel and overlap
                # almost entirely. Requiring real overlap is what tells them
                # apart.
                shared = min(high, band["high"]) - max(low, band["low"])
                if shared < 0.5 * min(high - low, band["high"] - band["low"]):
                    continue

                band["near"] = min(band["near"], offset)
                band["far"] = max(band["far"], offset)
                band["low"] = min(band["low"], low)
                band["high"] = max(band["high"], high)
                band["members"].append(wall)
                break
            else:
                bands.append(
                    {
                        "near": offset,
                        "far": offset,
                        "low": low,
                        "high": high,
                        "members": [wall],
                    }
                )

        for band in bands:
            middle = (band["near"] + band["far"]) / 2
            widest = max(wall.thickness for wall in band["members"])
            # The band's own spread, plus the thickness of its widest stroke:
            # the hatch runs from the near face to the far one, and each stroke
            # has width of its own beyond the centreline it was measured on.
            thickness = (band["far"] - band["near"]) + widest

            if horizontal:
                start = Point(x=band["low"], y=middle)
                end = Point(x=band["high"], y=middle)
            else:
                start = Point(x=middle, y=band["low"])
                end = Point(x=middle, y=band["high"])

            kept.append(
                WallSegment(
                    start=start,
                    end=end,
                    thickness=thickness,
                    confidence=max(wall.confidence for wall in band["members"]),
                )
            )

    return kept


def detect_openings(walls: list[WallSegment]) -> list[Detection]:
    """
    Find openings by looking for gaps between collinear walls.

    The first version of this used morphology — close the wall mask to bridge
    gaps, XOR against the original to isolate what got bridged. That works only
    when the closing kernel is wider than the gap, which means guessing a
    doorway width up front. Too small and it finds nothing; too large and it
    swallows corners and room labels.

    The wall pass already gives us the answer for free. A doorway does not
    thin a wall — it *interrupts* it, so morphology returns the wall as two
    separate collinear segments with a hole between them. Pairing those up finds
    openings directly, with no kernel to tune and no dependence on image
    resolution.

    A run of exactly 0.9m in a 3-4m room lands around 3-25% of the image
    dimension, which is the window used below.
    """
    detections: list[Detection] = []

    horizontal = [w for w in walls if abs(w.end.y - w.start.y) < abs(w.end.x - w.start.x)]
    vertical = [w for w in walls if w not in horizontal]

    for group, axis in ((horizontal, "h"), (vertical, "v")):
        # Bucket by the wall's fixed coordinate so only genuinely collinear
        # segments are compared, then order along the running axis.
        buckets: dict[int, list[WallSegment]] = {}
        for wall in group:
            fixed = wall.start.y if axis == "h" else wall.start.x
            buckets.setdefault(round(fixed * 200), []).append(wall)

        for segments in buckets.values():
            if len(segments) < 2:
                continue

            segments.sort(key=lambda w: w.start.x if axis == "h" else w.start.y)

            for first, second in zip(segments, segments[1:]):
                if axis == "h":
                    gap_start, gap_end = first.end.x, second.start.x
                    fixed = first.start.y
                else:
                    gap_start, gap_end = first.end.y, second.start.y
                    fixed = first.start.x

                span = gap_end - gap_start
                # 3%-25% of the image: narrower is a drafting artefact, wider is
                # an open-plan boundary rather than a door.
                if not (0.03 <= span <= 0.25):
                    continue

                thickness = max(first.thickness, second.thickness)
                if axis == "h":
                    bbox = [gap_start, fixed - thickness / 2, span, thickness]
                else:
                    bbox = [fixed - thickness / 2, gap_start, thickness, span]

                detections.append(
                    Detection(
                        label="opening",
                        bbox=[round(v, 4) for v in bbox],
                        # We are confident there is an opening; we genuinely do
                        # not know whether it is a door or a window.
                        confidence=0.6,
                        attaches_to="wall",
                    )
                )

    return detections[:200]


# --------------------------------------------------------------------------
# YOLO backend
# --------------------------------------------------------------------------

_model = None


def detect_yolo(
    image: np.ndarray,
) -> tuple[list[WallSegment], list[Detection], list[Room], PlanScale | None]:
    """
    Trained detector. Requires `ultralytics` and a weights file.

    Walls still come from the heuristic pass — line extraction is a solved
    problem in classical CV and a detector adds nothing there. The model earns
    its place on the symbols, which is where morphology is weakest.
    """
    global _model

    if _model is None:
        if not MODEL_PATH:
            raise HTTPException(
                status_code=503,
                detail="FLOORPLAN_BACKEND=yolo but FLOORPLAN_MODEL is not set.",
            )
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:
            raise HTTPException(
                status_code=503, detail="ultralytics is not installed."
            ) from exc
        _model = YOLO(MODEL_PATH)

    height, width = image.shape[:2]
    walls, _, rooms, scale = detect_heuristic(image)

    objects: list[Detection] = []
    for result in _model.predict(image, verbose=False, conf=0.35):
        for box in result.boxes:
            label = _model.names[int(box.cls)]
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            objects.append(
                Detection(
                    label=label,
                    bbox=[
                        x1 / width,
                        y1 / height,
                        (x2 - x1) / width,
                        (y2 - y1) / height,
                    ],
                    confidence=round(float(box.conf), 3),
                    attaches_to="wall" if label in WALL_CLASSES else "floor",
                )
            )

    return walls, objects, rooms, scale
