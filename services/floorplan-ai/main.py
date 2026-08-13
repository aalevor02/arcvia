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
import os
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
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


class DetectionResult(BaseModel):
    backend: str
    width: int
    height: int
    walls: list[WallSegment]
    objects: list[Detection]
    # Surfaced so the UI can say "check these" instead of implying certainty.
    low_confidence: bool


# --------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "backend": BACKEND,
        "model_loaded": bool(MODEL_PATH) and BACKEND == "yolo",
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
        walls, objects = detect_yolo(image)
    else:
        walls, objects = detect_heuristic(image)

    confidences = [w.confidence for w in walls] + [o.confidence for o in objects]
    mean_confidence = float(np.mean(confidences)) if confidences else 0.0

    return DetectionResult(
        backend=BACKEND,
        width=width,
        height=height,
        walls=walls,
        objects=objects,
        low_confidence=mean_confidence < 0.55 or not walls,
    )


# --------------------------------------------------------------------------
# Heuristic backend
# --------------------------------------------------------------------------

def detect_heuristic(image: np.ndarray) -> tuple[list[WallSegment], list[Detection]]:
    """
    Extract walls with morphology, not edge detection.

    A floor plan's walls are long, unbroken, axis-aligned strokes. Opening the
    binarised image with a long horizontal kernel deletes everything that is not
    a long horizontal run — text, dimension arrows, furniture, hatching — and
    leaves the horizontal walls. Repeat vertically. This is far more robust on
    line drawings than Canny + Hough, which happily finds "edges" along every
    piece of annotation on the sheet.
    """
    height, width = image.shape[:2]
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Adaptive threshold handles scans with uneven lighting; a global threshold
    # loses whole regions of a photographed drawing.
    binary = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 10
    )

    # Kernel length scales with the image so the same code works on a 900px
    # sketch and an 8000px plot.
    h_len = max(20, width // 40)
    v_len = max(20, height // 40)

    horizontal = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (h_len, 1))
    )
    vertical = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_len))
    )

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

    walls = reject_text_strokes(walls)
    walls = merge_collinear(walls)

    # Openings: gaps in an otherwise continuous wall run are doors and windows.
    # Without trained weights we cannot tell which, so we report them as
    # openings and let the user classify — an honest unknown beats a confident
    # wrong answer that ends up in a client presentation.
    objects = detect_openings(walls)

    return walls, objects


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


def detect_yolo(image: np.ndarray) -> tuple[list[WallSegment], list[Detection]]:
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
    walls, _ = detect_heuristic(image)

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

    return walls, objects
