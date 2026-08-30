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
import design
import plan_scale
import labels as text_labels
import json

import assign
import segment as classify_pass
import pdfbackend
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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
    #: What the adjudicator judged this line to be.
    #:
    #: A balcony parapet and an interior partition are the same two lines on
    #: a drawing, and nothing downstream could tell them apart -- so a
    #: railing was built as a full-height wall and a client walked onto a
    #: balcony boxed in by masonry. The verdict used to live only in a note,
    #: which no consumer could branch on. It rides on the wall now.
    #:
    #: "wall" is the default and the safe answer: an unjudged line is a
    #: wall, exactly as before.
    kind: Literal["wall", "railing", "boundary"] = "wall"


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
    # Where the number came from. "measured" means the architect printed the
    # dimensions and we read them; "inferred" means nothing was printed and the
    # scale was deduced from features of known size (see `plan_scale.py`).
    #
    # Defaulted so every existing consumer sees the shape it always saw — but a
    # deduced scale and a measured one are NOT the same claim, and anything
    # quoting an area or a quantity should be able to say which it had.
    method: Literal["measured", "inferred"] = "measured"
    # For an inferred scale, which rulers agreed — so a reviewer can check the
    # claim against the drawing instead of taking it on trust.
    agreed: list[str] = Field(default_factory=list)


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

#: A failure rate at or above this is worth surfacing even while the service
#: is answering. A fifth of a deck coming back empty is a broken deck to the
#: person reading it, however healthy the last call looked.
FAILURE_RATE_LIMIT = 0.2

#: Below this many calls a rate is noise rather than a trend.
FAILURE_RATE_MIN_CALLS = 10

#: A run of consecutive failures this long is a dead window rather than
#: degradation, however good the overall rate looks. Five, because this pass
#: runs once per deck page and five blank pages in a row is a reader's
#: complaint whether or not the other ninety-five worked.
FAILURE_RUN_LIMIT = 5


def adjudicator_liveness() -> str | None:
    """Whether the configured vision model actually ANSWERS, not just whether
    it is named. None when there is nothing to report; otherwise a short
    human-readable reason.

    This exists because of a real outage. On 2026-08-26T09:00:00Z NVIDIA
    retired `nvidia/nemotron-nano-12b-v2-vl`, the model this service was pinned
    to. Every call began returning HTTP 410 Gone. `adjudicate.py` fails open by
    contract -- a dead adjudicator must never take the detector down with it --
    so each failure was recorded as "a crop went unanswered; its proposal
    stands" and the run completed successfully with the heuristic's proposals
    untouched. `/health` reported `"adjudicator": "nvidia:nemotron-nano-12b-v2-vl"`
    throughout, because naming a model is not the same as reaching it.

    The symptom was not an error. It was the AI silently changing nothing.

    Inferred from traffic rather than probed. `services/api` proxies this
    endpoint to the studio on every poll, so a liveness check that issues its
    own vision call bills once per poll -- the cost scales with how often
    somebody leaves a tab open, which is the wrong thing for it to scale with.
    Counting answers is free and catches a mid-run retirement on the first
    plan that runs after it, which is precisely the case that bit us.

    The price of being free is that a service nobody has used yet has no
    evidence either way, and it says so. It does NOT report healthy. Asserting
    capability from configuration is the exact defect this function exists to
    catch, and inventing a clean bill of health with zero calls behind it would
    be committing it one level up.
    """
    if not adjudicate_pass.available():
        # Nothing is configured, `adjudicator` above is already null, and an
        # absent adjudicator is a deployment choice rather than a fault.
        return None

    stats = adjudicate_pass.usage()
    started = stats.get("calls_started", 0)
    answered = stats.get("calls_answered", 0)
    failed = stats.get("calls_failed", 0)
    reason = stats.get("last_failure") or "no reason recorded"

    if started == 0:
        return "unverified: no vision call has been made since this service started"

    if answered == 0:
        return f"dead: {started} vision call(s) made, none answered - last: {reason}"

    # "Is it working now", read from the most recent call rather than from the
    # cumulative counts. Those counters live as long as the process, so a single
    # transient timeout hours ago would otherwise pin this to "degraded" for the
    # rest of its life and train everyone to ignore the field.
    if stats.get("last_call_failed"):
        return (
            f"degraded: the most recent vision call failed "
            f"({failed} of {started} so far) - last: {reason}"
        )

    # ...but "the last call worked" is not the same as "it is working", and
    # reading only the last call was wrong in a way that showed up in use: a
    # deck read finished with 35 failures in 79 calls -- 44% of the user's
    # pages silently empty -- and this reported healthy, because call 79
    # happened to succeed. That is the same defect as the health check it
    # replaced, one level in: a signal that cannot see a sustained fault.
    #
    # So the RATE is reported too, once there are enough calls for a rate to
    # mean anything. Ten is the floor because 1-of-2 is noise, not a trend.
    # A contiguous run is reported before the rate, because it is the more
    # specific complaint: an evenly-degrading service and a dead window can
    # share a rate, and only one of them means a identifiable block of a
    # reader's deck came back empty.
    worst_run = stats.get("worst_failure_run", 0)
    if worst_run >= FAILURE_RUN_LIMIT:
        return (
            f"unreliable: {worst_run} vision calls failed in a row at worst "
            f"({failed} of {started} overall) - last failure: {reason}"
        )

    if started >= FAILURE_RATE_MIN_CALLS:
        rate = failed / started
        if rate >= FAILURE_RATE_LIMIT:
            return (
                f"unreliable: {failed} of {started} vision calls failed "
                f"({rate:.0%}) though the last one worked - last failure: {reason}"
            )

    # Answering, at an unremarkable rate.
    return None


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
        # Whether the trained classifier is deciding WHAT. Absent weights
        # is a deployment choice, not a fault, so this reports rather than
        # warns -- but a reader must be able to tell which pass set `kind`.
        "classifier": classify_pass.describe(),
        "adjudicator": adjudicate_pass.name(),
        # Counts and token totals only. Never expose the credential itself.
        "vision_usage": adjudicate_pass.usage(),
        # Whether that model ANSWERS, not merely whether it is named. Null
        # when there is nothing to report; a reason string otherwise. A pinned
        # hosted model can be retired underneath a running service, and this
        # one was -- see adjudicator_liveness().
        "adjudicator_liveness": adjudicator_liveness(),
        # The same model reads deck renders into DesignSpecs (/design).
        "reads_design": design.available(),
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

    # ── What each pass is for ──────────────────────────────────────────────
    # WHERE always comes from the heuristic above. Line extraction is solved in
    # classical CV, and the session that trained the detector measured the
    # decomposition rather than arguing it: feeding the model the heuristic's
    # own segments and asking only "what is this" beat the live product on all
    # five acceptance regions for 1.8% of wall density, while a model asked to
    # produce geometry lost recall badly.
    #
    # So this is a PASS, not a backend. It needs no FLOORPLAN_BACKEND value,
    # which is deliberate: a third exclusive mode would force a choice between
    # the classifier and the adjudicator when the point is that they do
    # different jobs. It runs whenever weights are configured.
    model_notes: list[str] = []
    model_owns_railings = False
    if classify_pass.available():
        # Measured on the owner's deck: 18 of 55 proposals read under 5%
        # Wall and were dropped, all three railings survived (a railing
        # reads ~0% Wall by design, so order matters), and SIX of six
        # window candidates stayed reachable — the dropped proposals
        # carried none. That last figure is the one that mattered: the
        # window pass only accepts a window within 4% of a proposed wall,
        # so a wrongly dropped wall costs a window that cannot be recovered.
        walls, model_notes = classify_pass.classify_walls(
            image, walls, drop_furniture=True,
        )
        model_owns_railings = True

    # A vision model second-guesses the proposals against the picture itself —
    # the heuristic keeps deciding WHERE, the model only ever decides WHAT.
    # Opt-in by key, fail-open by contract: without a key, or on any network
    # or parsing failure, the result is exactly what the heuristic said.
    notes: list[str] = []
    if adjudicate_pass.available():
        walls, objects, rooms, notes = adjudicate_pass.adjudicate(
            image, walls, objects, rooms, Detection,
            owns_railings=not model_owns_railings,
            owns_furniture=not model_owns_railings,
        )
    # The classifier's notes first: they describe the walls the adjudicator's
    # notes then talk about.
    notes = model_notes + notes

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


@app.post("/assign")
async def assign_endpoint(
    plan: UploadFile = File(...),
    render: UploadFile = File(...),
    rooms: str = Form(...),
    render_page: int = Form(0),
    render_index: int = Form(0),
) -> dict:
    """
    Propose which room on the plan a render shows.

    Only for renders a caption could not place -- ambiguous ones ("Bed" fitting
    two bedrooms) and unmatched ones ("Guest Suite" against a drawing that says
    "Bedroom-3"). The caption path is free and resolves the majority; this costs
    a vision call, so the caller decides when it is worth one.

    `rooms` is the JSON list of Room objects /detect already returned. Passing
    them back rather than re-detecting keeps the numbering the caller sees and
    the numbering the model is shown identical -- re-running detection here
    could renumber, and then a correct answer would point at the wrong room.
    """
    if not assign.available():
        raise HTTPException(
            status_code=503,
            detail="Room assignment needs a vision model. Set NVIDIA_API_KEY "
                   "(or OPENAI_API_KEY) for services/floorplan-ai.",
        )

    try:
        candidates = json.loads(rooms)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=400, detail=f"rooms is not JSON: {error}") from error
    if not isinstance(candidates, list) or not candidates:
        raise HTTPException(status_code=400, detail="rooms must be a non-empty list.")

    images = []
    for upload, label in ((plan, "plan"), (render, "render")):
        raw = await upload.read()
        if not raw:
            raise HTTPException(status_code=400, detail=f"The {label} upload is empty.")
        # A deck render is a page of a PDF the caller already stored. Extracting
        # it here rather than making the caller re-upload pixels is the same
        # bargain /design strikes, and keeps the two endpoints interchangeable
        # from the panel's point of view.
        if label == "render" and render_page > 0:
            if not deck.available():
                raise HTTPException(status_code=503, detail="PDF reading is not installed.")
            try:
                raw = deck.extract(raw, page=render_page, index=render_index, long_edge=1600)
            except IndexError as error:
                raise HTTPException(status_code=404, detail=str(error)) from error
            except Exception as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise HTTPException(status_code=400, detail=f"Could not read the {label} image.")
        if image.shape[0] * image.shape[1] > MAX_PIXELS:
            raise HTTPException(status_code=413, detail=f"The {label} image is too large.")
        images.append(image)

    proposal = assign.assign_render(images[0], candidates, images[1])
    if proposal is None:
        # 200, not an error: "I cannot tell which room this is" is a real and
        # useful answer, and the caller's next move is to ask a person either
        # way. A 4xx here would read as a broken request.
        return {"proposal": None, "model": assign.name()}
    return {"proposal": proposal, "model": proposal["model"]}


@app.post("/design")
async def design_endpoint(
    file: UploadFile = File(...),
    page: int = 0,
    index: int = 0,
    room: str | None = None,
) -> dict:
    """
    Read the DESIGN out of a render: materials, colours, furnishing, style.

    Two input shapes, one round trip each:
      - an image upload (page=0): the file IS the render;
      - a PDF upload with page/index: the render is extracted here, so the
        caller that already stored the deck never re-uploads pixels.

    The palette is MEASURED here (deck.py's k-means) and handed to the vision
    model as ground truth to assign, not invent — see design.py. `room` is the
    deck caption's hint, when the caller has one.
    """
    if not design.available():
        raise HTTPException(
            status_code=503,
            detail="The design reader is not configured. Set OPENAI_API_KEY "
                   "(or NVIDIA_API_KEY/FLOORPLAN_ADJUDICATOR_KEY) for services/floorplan-ai.",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")

    if page > 0:
        if not deck.available():
            raise HTTPException(status_code=503, detail="PDF reading is not installed.")
        try:
            raw = deck.extract(raw, page=page, index=index, long_edge=1600)
        except IndexError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not read that image.")
    if image.shape[0] * image.shape[1] > MAX_PIXELS:
        raise HTTPException(status_code=413, detail="Image is too large.")

    spec = design.read_design(image, deck.palette(image), room_hint=room)
    if spec is None:
        # Unanswered model and not-a-render land here together; both mean the
        # caller has no spec to apply, and the message says what to try.
        raise HTTPException(
            status_code=422,
            detail="No design could be read from that image — it may not be "
                   "a render, or the vision model did not answer.",
        )
    return spec


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

    # TWO INDEPENDENT DOOR SIGNALS, failing in different places, which is the
    # whole reason for having both. A gap is an absence and cannot be seen where
    # the tracer ran one wall straight through the doorway; an arc is a mark and
    # cannot be seen where the draughtsman drew no swing. Measured on the
    # owner's 1.png against an enumerated ground truth, gaps found 2 of 7
    # doorways and arcs found 2 more, with no false positive on either side.
    openings = detect_openings(best.walls)
    for arc in detect_swing_arcs(image, best.walls, best.scale):
        if not any(_same_opening(arc, found) for found in openings):
            openings.append(arc)
    # THIRD SIGNAL, and it is last because it is the weakest evidence of the
    # three: a gap is an absence, an arc is a mark made on purpose, and a
    # thinning is an inference from how the wall is drawn. Anything the first
    # two already found keeps their reading of it.
    for glazed in detect_glazed_openings(image, best.walls, best.rooms, best.scale):
        if not any(_same_opening(glazed, found) for found in openings):
            openings.append(glazed)

    return best.walls, openings, best.rooms, best.scale or deduce_scale(
        best.walls, openings
    )


def _same_opening(one: Detection, other: Detection) -> bool:
    """One doorway found twice, once as a gap and once as an arc.

    The reach is HALF THE NARROWER opening, not a whole span. A first version
    used the widest span of either and it silently swallowed the entire arc
    pass: on 1.png the bedroom-2 and toilet-02 doors sit 75 and 79 px from the
    nearest gap -- different doorways in different walls -- and a reach of one
    1.57 m span reported both as already known. Measured, the real duplicate is
    6 px apart and the nearest distinct pair is 75, so half the narrower span
    separates them with an order of magnitude to spare.
    """
    span = lambda box: max(box[2], box[3])  # noqa: E731
    reach = 0.5 * min(span(one.bbox), span(other.bbox))
    return math.hypot(
        (one.bbox[0] + one.bbox[2] / 2) - (other.bbox[0] + other.bbox[2] / 2),
        (one.bbox[1] + one.bbox[3] / 2) - (other.bbox[1] + other.bbox[3] / 2),
    ) <= reach


def deduce_scale(
    walls: list[WallSegment], openings: list[Detection]
) -> PlanScale | None:
    """
    A scale for plans that printed no dimensions.

    Strictly a fallback: it runs only when `text_labels.infer_scale` found no
    printed room sizes to read, so a measured scale is never displaced by a
    deduced one. That ordering is the same `measured > header > extent` rule
    `classify/units.py` documents for the CAD side.

    Without this, a plan with no captions — a brochure page, a scan, a photo of
    a drawing — comes back with `scale=None`, and everything downstream is
    unitless: no areas, no quantities, no compliance check, and furniture that
    cannot be checked for fit because there is nothing to fit it against.

    Returns None when the drawing does not support a confident answer, which is
    most of what `plan_scale` spends its effort on. A wrong scale is worse than
    no scale: every area and quantity inherits it silently and still looks
    entirely plausible.
    """
    thicknesses = [wall.thickness for wall in walls if wall.thickness]
    # An opening's span along the wall is its long side; which axis that is
    # depends on whether the wall runs horizontally or vertically.
    widths = [max(o.bbox[2], o.bbox[3]) for o in openings if len(o.bbox) >= 4]

    got = plan_scale.infer_scale_from_features(thicknesses, widths)
    if not isinstance(got, plan_scale.InferredScale):
        return None

    return PlanScale(
        metres_per_unit=round(got.metres_per_unit, 4),
        samples=got.samples,
        spread=got.spread,
        method="inferred",
        agreed=got.agreed,
    )


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


def _fit_circle(points: np.ndarray):
    """Algebraic circle fit. Returns (cx, cy, r, rms residual in px) or None."""
    x = points[:, 0].astype(np.float64)
    y = points[:, 1].astype(np.float64)
    design = np.column_stack([x, y, np.ones(len(x))])
    try:
        sol, *_ = np.linalg.lstsq(design, x * x + y * y, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy = sol[0] / 2, sol[1] / 2
    r_squared = sol[2] + cx * cx + cy * cy
    if r_squared <= 0:
        return None
    r = math.sqrt(r_squared)
    return cx, cy, r, float(np.sqrt(np.mean((np.hypot(x - cx, y - cy) - r) ** 2)))


def _sweep_degrees(points: np.ndarray, cx: float, cy: float) -> float:
    """Degrees of turn the points cover, tolerant of the wrap at 180."""
    angles = np.sort(np.degrees(np.arctan2(points[:, 1] - cy, points[:, 0] - cx)))
    if len(angles) < 2:
        return 0.0
    return 360.0 - float(np.diff(np.concatenate([angles, [angles[0] + 360]])).max())


def _ink_fraction(grey: np.ndarray, ax: float, ay: float, bx: float, by: float) -> float:
    """How much of the line from a to b is drawn on.

    Sampled across a narrow BAND rather than a single ray. The centre comes from
    a circle fit and is good only to a few pixels, while a drawn leaf can be a
    ONE-pixel column -- measured on 1.png, the bedroom-2 leaf occupies x = 573
    exactly, with x = 576 already blank.

    The hinge corner is skipped: the wall meets the arc there, so the first few
    samples are ink whichever way the door faces.
    """
    height, width = grey.shape[:2]
    length = math.hypot(bx - ax, by - ay)
    if length <= 0:
        return 0.0
    nx, ny = -(by - ay) / length, (bx - ax) / length

    samples, drawn = 0, 0
    steps = 24
    for step in range(3, steps - 1):
        t = step / steps
        px, py = ax + (bx - ax) * t, ay + (by - ay) * t
        samples += 1
        for offset in (-2, -1, 0, 1, 2):
            x = int(round(px + nx * offset))
            y = int(round(py + ny * offset))
            if 0 <= y < height and 0 <= x < width and grey[y, x] < 150:
                drawn += 1
                break
    return drawn / samples if samples else 0.0


def _door_from_arc(
    grey: np.ndarray, strokes: np.ndarray, arc: dict
) -> tuple[float, float] | None:
    """The direction the doorway lies in, as a unit vector, or None.

    A swing is drawn as the leaf in its OPEN position plus the arc round to
    closed, so one direction from the hinge has a line drawn along it and the
    perpendicular one is the empty opening. Measured on 1.png, all three doors
    read leaf 1.00 against doorway 0.00.

    The four axis directions are probed rather than the arc's own endpoints. The
    contour is a FRAGMENT of the sweep -- 37 to 51 degrees of the 90 the door
    turns, broken by the text and walls it runs into -- so its ends reach
    neither the leaf nor the opening. Axis alignment is the same assumption
    `detect_openings` makes when it splits the world into horizontal and
    vertical.

    An earlier version chose the end nearest a wall and got both doors it found
    BACKWARDS, reporting the leaf's own line as the opening: the leaf lies
    against a wall too.
    """
    compass = {0: (1.0, 0.0), 90: (0.0, 1.0), 180: (-1.0, 0.0), 270: (0.0, -1.0)}
    reach = lambda source, dx, dy: _ink_fraction(  # noqa: E731
        source, arc["cx"], arc["cy"],
        arc["cx"] + dx * arc["r"], arc["cy"] + dy * arc["r"],
    )
    # THE LEAF IS LOOKED FOR IN THE STROKES, NOT THE DRAWING. A leaf is a drawn
    # line and survives the thin-ink step; a WALL is a filled mass and is
    # removed by it. Measured on 3.png, the toilet-3 door read its own wall as
    # the leaf in the raw image (1.00 downward) and put the doorway out into
    # blank paper at right angles to the building. In the strokes that same
    # direction reads 0.20 and the real leaf reads 1.00.
    strokes_at = {angle: reach(strokes, dx, dy) for angle, (dx, dy) in compass.items()}
    probes = {angle: reach(grey, dx, dy) for angle, (dx, dy) in compass.items()}

    leaf = max(strokes_at, key=strokes_at.__getitem__)
    # A door open at 90 degrees closes ACROSS the wall it hangs in, so the
    # opening is perpendicular to the leaf -- the emptier of the two.
    doorway = min(((leaf + 90) % 360, (leaf + 270) % 360), key=probes.__getitem__)

    # Both tests. Without a drawn leaf this is some other arc; without a clear
    # opening the "doorway" runs through ink, which a doorway does not.
    # The opening is judged on the DRAWING, because a doorway has to be empty of
    # everything, wall included -- not merely empty of strokes.
    if strokes_at[leaf] < 0.4 or probes[doorway] > 0.35:
        return None
    return compass[doorway]


def _arc_runs(points: np.ndarray):
    """The whole stroke, and then pieces of it.

    A door is drawn as a leaf AND a sweep, and where they touch -- which is
    every cleanly drawn door, and every vector export -- they trace as ONE
    contour. That contour is a straight line joined to a curve, and it fits no
    circle at all: measured on a drawn fixture, the joined stroke fits at 8.38
    px rms and covers 262 degrees, so it fails every test the arc has to pass.
    The arc is still in there; it is just not the whole of what was traced.

    The pieces are windows rather than a split at a corner, because the corner
    is not always where the geometry changes: a contour walks OUT along one side
    of the leaf, round the sweep, and BACK along the other side, so the arc is a
    contiguous run somewhere in the middle rather than a labelled section.

    The whole stroke comes first, so a clean arc costs one fit.
    """
    yield points
    if len(points) < 120:
        return
    for pieces in (2, 3, 4):
        window = len(points) // pieces
        if window < 40:
            break
        for start in range(0, len(points) - window + 1, max(window // 2, 1)):
            yield points[start:start + window]


def detect_swing_arcs(
    image: np.ndarray,
    walls: list[WallSegment],
    scale: PlanScale | None,
) -> list[Detection]:
    """
    Doors from the swing arc the draughtsman drew.

    ── Why this exists beside detect_openings ──────────────────────────────────
    `detect_openings` looks for a GAP between two collinear walls, and a gap is
    an ABSENCE. Measured on the owner's 1.png against an enumerated ground truth
    (realdecks/avarana-cottage3-1png.doors-groundtruth.md), that method cannot
    reach most doors on that sheet -- and not for the reason it first appeared:

        LIFT door    (x 778, y 488-547)    ONE wall at x 778 runs y 449 to 672
        BED-1 slider (x 340-532, y 1030)   ONE wall runs x 270 to 910 at y 1032
        BED-2 slider (x 562-757, y 1030)   the SAME wall, through both sliders

    The walls either side are not missing. The tracer runs ONE continuous wall
    straight through the doorway, so there are not two segments to find a gap
    between. No threshold on the opening code can fix that, and loosening the
    collinearity tolerance cannot either, because one segment cannot pair with
    itself.

    An arc is the opposite kind of evidence. It is not an absence: it is a mark
    made on purpose that says door here, hinged here, this wide. Three
    properties separate it from every other curve on a furnished plan, and each
    was measured before this was written:

      1. THIN. Walls and furniture are filled masses; the arc is one stroke.
         Opening with a 7 px disc keeps whatever the disc fits inside, and
         subtracting that leaves line work.
      2. Its radius is a DOOR WIDTH, 0.6 to 1.3 m. Not a general circle.
      3. It FITS A CIRCLE ALMOST EXACTLY, and this is what does the real work.
         On 1.png the arcs sit on their circle at 0.24, 0.24 and 0.25 px rms
         while the WC bowl -- an oval, the obvious false positive, and the only
         one that ever appeared -- fits at 1.87 px. Seven times worse.

    Strokes are collected across a range of darkness thresholds because the arcs
    on one sheet are not equally dark: at 130 this finds the toilet door and
    misses the lobby door, and at 135 the reverse.

    ── What it does not do ─────────────────────────────────────────────────────
    It finds nothing for a door drawn without a swing -- a lift door, a sliding
    door -- and on 1.png that is three of the seven doorways. Those need the
    wall tracer to stop bridging them, which is a different repair.

    No wall is required here, deliberately. The wall list is incomplete, which
    is the whole reason this pass exists, so demanding a host from it would
    discard the doors it was written to recover. The studio makes that check at
    the point it matters, cutting only where a wall actually crosses the
    opening, so an arc with nothing behind it costs nothing.
    """
    if image is None:
        return []

    height, width = image.shape[:2]
    if scale and scale.metres_per_unit:
        metres_per_px = scale.metres_per_unit / max(width, 1)
        r_min, r_max = 0.6 / metres_per_px, 1.3 / metres_per_px
    else:
        # No scale yet -- `deduce_scale` runs after this. Fall back to the same
        # kind of image-relative band `detect_openings` uses for its spans.
        r_min, r_max = 0.03 * width, 0.15 * width

    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))

    candidates: list[dict] = []
    for threshold in range(105, 181, 5):
        ink = (grey < threshold).astype(np.uint8) * 255
        strokes = cv2.subtract(ink, cv2.morphologyEx(ink, cv2.MORPH_OPEN, disc))
        contours, _ = cv2.findContours(strokes, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            whole = contour.reshape(-1, 2)
            if len(whole) < 40:
                continue
            for points in _arc_runs(whole):
                fit = _fit_circle(points)
                if fit is None:
                    continue
                cx, cy, r, rms = fit
                if not (r_min <= r <= r_max):
                    continue
                # 0.6 px sits more than twice clear of the measured arcs (0.25)
                # and three times clear of the oval, the only false positive
                # ever seen on a real sheet.
                if rms > 0.6:
                    continue
                if not (30 <= _sweep_degrees(points, cx, cy) <= 130):
                    continue
                candidates.append({"cx": cx, "cy": cy, "r": r, "rms": rms})
                break

    # One stroke has an inner and an outer contour and is found again at every
    # threshold it survives, so a single door yields many candidates. They are
    # GROUPED rather than reduced to one, because the best-FITTING candidate is
    # not always the best-POSITIONED one: on 1.png the bedroom-2 door's
    # lowest-residual fit sits five pixels off, and the leaf it must find is a
    # single-pixel column. Those five pixels were the difference between reading
    # that leaf at 1.00 and at 0.00, and so between finding the door and not.
    candidates.sort(key=lambda c: c["rms"])
    clusters: list[list[dict]] = []
    for arc in candidates:
        for cluster in clusters:
            head = cluster[0]
            if (math.hypot(arc["cx"] - head["cx"], arc["cy"] - head["cy"]) < 0.3 * head["r"]
                    and abs(arc["r"] - head["r"]) < 0.3 * head["r"]):
                cluster.append(arc)
                break
        else:
            clusters.append([arc])

    # One mid-threshold stroke image, used to tell a drawn leaf from a wall.
    mid = (grey < 150).astype(np.uint8) * 255
    leaf_strokes = np.where(
        cv2.subtract(mid, cv2.morphologyEx(mid, cv2.MORPH_OPEN, disc)) > 0, 0, 255
    ).astype(np.uint8)

    thicknesses = sorted(wall.thickness for wall in walls if wall.thickness)
    thick_px = max(
        (thicknesses[len(thicknesses) // 2] if thicknesses else 0.0) * height, 3.0
    )

    detections: list[Detection] = []
    for cluster in clusters:
        for arc in cluster:
            direction = _door_from_arc(grey, leaf_strokes, arc)
            if direction is None:
                continue

            end_x = arc["cx"] + direction[0] * arc["r"]
            end_y = arc["cy"] + direction[1] * arc["r"]
            if direction[1] == 0:
                x0, x1 = sorted((arc["cx"], end_x))
                bbox = [x0 / width, (arc["cy"] - thick_px / 2) / height,
                        (x1 - x0) / width, thick_px / height]
            else:
                y0, y1 = sorted((arc["cy"], end_y))
                bbox = [(arc["cx"] - thick_px / 2) / width, y0 / height,
                        thick_px / width, (y1 - y0) / height]

            detections.append(
                Detection(
                    label="opening",
                    bbox=[round(float(v), 4) for v in bbox],
                    # Higher than the 0.6 a gap gets. A gap might be a doorway
                    # or a missing wall; an arc was drawn to mean a door.
                    confidence=0.85,
                    attaches_to="wall",
                )
            )
            break

    return detections


def _ink_runs_across(
    ink: np.ndarray, cx: int, cy: int, horizontal: bool, reach: int, spread: int = 6
) -> int:
    """How many separate strokes lie ACROSS the wall here.

    The discriminator that makes this pass usable. A wall that is merely thinner
    reads as ONE run; glazing is drawn as two or more lines with white between
    them, and a door leaf inside its frame the same. Measured on 1.png:

        BED-1 slider  3      an unnamed thin section  1
        BED-2 slider  3      another                  1
        LIFT door     5      another                  1

    Every true opening at 3 or more, every false one at exactly 1, with nothing
    in between.
    """
    height, width = ink.shape[:2]
    counts = []
    # Sampled ALONG the opening, at fractions of its own length. A fixed few
    # pixels either side of the centre all land on the same spot, and on a
    # slider that spot is the MULLION -- solid, one run, and the whole opening
    # is thrown away. Found on a drawn fixture with a central post.
    step = max(spread // 3, 2)
    for offset in (-3 * step, -step, 0, step, 3 * step):
        if horizontal:
            x = cx + offset
            if not (0 <= x < width):
                continue
            line = ink[max(0, cy - reach):min(height, cy + reach), x]
        else:
            y = cy + offset
            if not (0 <= y < height):
                continue
            line = ink[y, max(0, cx - reach):min(width, cx + reach)]
        runs, previous = 0, 0
        for value in line:
            if value and not previous:
                runs += 1
            previous = int(value)
        counts.append(runs)
    return int(np.median(counts)) if counts else 0


def detect_glazed_openings(
    image: np.ndarray,
    walls: list[WallSegment],
    rooms: list[Room],
    scale: PlanScale | None,
) -> list[Detection]:
    """
    Openings that are drawn as a THINNING of the wall rather than a gap in it.

    ── The third signal, and why two were not enough ───────────────────────────
    `detect_openings` finds a gap between collinear walls; `detect_swing_arcs`
    finds a drawn swing. Measured against an enumerated ground truth
    (realdecks/avarana-cottage3-1png.doors-groundtruth.md) the two together
    reach 4 of the 7 doorways on that sheet. The three they miss are a lift door
    and two 2.9 m glazed sliding doors, and neither method can ever see them:

      - There is no gap. This was checked on the INK, not on the tracer's
        output, after a first explanation blamed the tracer and was wrong:
            verandah wall, horizontal ink at y 1032:  ONE solid run, x 270..910
            lift wall,     vertical ink at x 778:     ONE solid run, y 449..672
        The drawing genuinely has continuous ink there.
      - There is no swing. A lift door and a slider do not have one to draw.

    What IS there is a thinning. Ink measured across the wall:

        verandah wall   solid 18-19 px    SLIDER 1  7    SLIDER 2  7
        lift wall       solid 17-21 px    LIFT DOOR 7

    A consistent 2.5 to 3x thinning, bounded by solid piers, because that is how
    an architect draws glazing and a lift car door.

    ── Why the obvious version of this must not ship ──────────────────────────
    Thinning alone finds all three and is nowhere near precise enough to cut
    geometry with. Measured before any of it was written into the reader:

        thinned sections bounded by piers                    3 of 14 correct
        and requiring the two sides to be different spaces   3 of 8 correct

    Five phantom holes a sheet, each of which is a HOLE THROUGH A WALL. Three
    further tests earn their place, each measured rather than guessed:

      1. STROKES ACROSS THE WALL. See `_ink_runs_across`: true openings read 3,
         3 and 5, and every false one reads exactly 1. This is what separates
         glazing from a wall that happens to be thinner.
      2. FRAGMENTS ARE MERGED FIRST. A mullion is drawn solid, so one slider
         arrives as several thin runs. Unmerged, the BED-2 slider measured 1.76 m
         against a true 2.94 m -- 40% short -- and its far fragment looked like a
         separate false positive.
      3. BOTH SIDES MUST BE A NAMED SPACE, AND DIFFERENT ONES. An opening is a
         way THROUGH the building. This also keeps windows out by construction:
         an exterior window has open ground on one side and no region there, so
         it never qualifies. Windows are deliberately not converted to geometry
         -- the vision pass returned 5, 5, 5, 4 and 3 over five reads of one file
         -- and this pass must not smuggle them in through the back door.
    """
    if image is None or not walls or not rooms:
        return []

    height, width = image.shape[:2]
    metres_per_px = (
        scale.metres_per_unit / max(width, 1)
        if scale and scale.metres_per_unit
        else 1.0 / max(width, 1)
    )
    ink = (cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) < 150).astype(np.uint8)

    polygons = [
        (
            room.name,
            np.array([[p.x * width, p.y * height] for p in room.polygon], np.float32),
        )
        for room in rooms
        if room.kind in ("room", "outdoor") and len(room.polygon) >= 3
    ]

    def space_at(x: float, y: float) -> str | None:
        for index, (name, polygon) in enumerate(polygons):
            if cv2.pointPolygonTest(polygon, (float(x), float(y)), False) >= 0:
                return name or f"#{index}"
        return None

    # A mullion, a frame post, a door stile: solid, and narrow. Runs either side
    # of one are the same opening.
    mullion = max(int(round(0.3 / metres_per_px)), 3)

    detections: list[Detection] = []
    for wall in walls:
        x0, y0 = wall.start.x * width, wall.start.y * height
        x1, y1 = wall.end.x * width, wall.end.y * height
        horizontal = abs(x1 - x0) >= abs(y1 - y0)

        low, high = (
            (int(min(x0, x1)), int(max(x0, x1)))
            if horizontal
            else (int(min(y0, y1)), int(max(y0, y1)))
        )
        if high - low < 40:
            continue

        # TIGHT TO THE WALL. Three thicknesses reaches past it and measures
        # whatever is beside it -- a wardrobe elevation, a planter, the border of
        # a lift car. That inflates the "solid" baseline and then the wall ITSELF
        # reads as a thinning: measured on 1.png, two of the three false
        # positives were solid wall with furniture imagery drawn alongside it.
        band = max(int(round(wall.thickness * width * 1.6)), 10)
        fixed = int(round((y0 + y1) / 2 if horizontal else (x0 + x1) / 2))
        near = max(0, fixed - band // 2)
        far = min(height if horizontal else width, fixed + band // 2)
        strip = (
            ink[near:far, low:high].sum(axis=0)
            if horizontal
            else ink[low:high, near:far].sum(axis=1)
        )
        if len(strip) < 40:
            continue

        # The 80th percentile, not the median. A wall that is MOSTLY glazing --
        # the verandah wall is 60% slider -- has a median equal to its glazing,
        # and then nothing reads as thin at all.
        solid = float(np.percentile(strip, 80))
        if solid < 8:
            continue

        thin = strip < solid * 0.55
        runs: list[list[int]] = []
        start = None
        for index, is_thin in enumerate(thin):
            if is_thin and start is None:
                start = index
            if not is_thin and start is not None:
                runs.append([start, index])
                start = None
        if start is not None:
            runs.append([start, len(thin)])

        merged: list[list[int]] = []
        for run in runs:
            if merged and run[0] - merged[-1][1] <= mullion:
                merged[-1][1] = run[1]
            else:
                merged.append(run)

        for begin, end in merged:
            # Solid wall at both ends. Without a pier either side this is not an
            # opening in a wall, it is where the wall stops.
            if begin <= 3 or end >= len(thin) - 3:
                continue
            span = (end - begin) * metres_per_px
            if not (0.6 <= span <= 4.0):
                continue

            centre = low + (begin + end) / 2
            cx, cy = (centre, fixed) if horizontal else (fixed, centre)
            # Reach just across the WALL, not across the band the thickness was
            # measured in. The band is three wall thicknesses, and a probe that
            # long leaves the wall entirely and counts whatever it meets on the
            # far side -- which turned four false positives into passes.
            across = int(solid * 1.5) + 2
            if _ink_runs_across(
                ink, int(cx), int(cy), horizontal, across, spread=(end - begin) // 3
            ) < 2:
                continue

            reach = band
            if horizontal:
                sides = (space_at(cx, fixed - reach), space_at(cx, fixed + reach))
            else:
                sides = (space_at(fixed - reach, cy), space_at(fixed + reach, cy))
            if sides[0] is None or sides[1] is None or sides[0] == sides[1]:
                continue

            thick_px = max(band / 3.0, 3.0)
            if horizontal:
                bbox = [
                    (low + begin) / width,
                    (fixed - thick_px / 2) / height,
                    (end - begin) / width,
                    thick_px / height,
                ]
            else:
                bbox = [
                    (fixed - thick_px / 2) / width,
                    (low + begin) / height,
                    thick_px / width,
                    (end - begin) / height,
                ]

            detections.append(
                Detection(
                    label="opening",
                    bbox=[round(float(v), 4) for v in bbox],
                    # Below an arc, which was drawn to mean a door, and above a
                    # bare gap, which might be a missing wall.
                    confidence=0.7,
                    attaches_to="wall",
                )
            )

    return detections


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
        # Group by the wall's fixed coordinate so only genuinely collinear
        # segments are compared, then order along the running axis.
        #
        # The tolerance is A WALL THICKNESS, not a constant. A fixed 0.005 was
        # used here and, measured on the acceptance deck where the median
        # thickness is 0.0061, that is 0.8 of a wall -- so two halves of one
        # doorway whose centrelines differ by a single thickness were never
        # compared. The effect was total rather than partial: at that tolerance
        # the horizontal walls produced ZERO pairable groups, so no horizontal
        # doorway could be found at all, and both openings this returned were
        # vertical.
        #
        # Every member is compared to its lane's ANCHOR, never to a running
        # mean. Single-link chaining on a moving centre silently exceeds its own
        # tolerance -- measured elsewhere in this project the same day -- and
        # anchoring bounds the whole span by construction.
        def fixed_of(wall: WallSegment) -> float:
            return wall.start.y if axis == "h" else wall.start.x

        lanes: list[list[WallSegment]] = []
        for wall in sorted(group, key=fixed_of):
            for lane in lanes:
                anchor = lane[0]
                reach = max(anchor.thickness, wall.thickness, 0.005)
                if abs(fixed_of(wall) - fixed_of(anchor)) <= reach:
                    lane.append(wall)
                    break
            else:
                lanes.append([wall])

        for segments in lanes:
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
