"""
Reading what the drawing says about itself.

── Why this matters more than the linework ─────────────────────────────────────
An architect annotates a plan for a reader who cannot measure it: every room
carries its name and its size, printed right there in the middle of the space.
"SHOWER 7'0"X5'9"". That single string identifies the region *and* fixes the
drawing's scale, and a plan usually carries a dozen of them.

Everything downstream got easier once the service started reading them:

  * Rooms arrive named, so a render captioned "BEDROOM" can be attached to the
    bedroom without anyone choosing from a list.
  * Scale is derived rather than asked for. Comparing a printed size against the
    region's size in pixels gives metres-per-pixel, and a dozen rooms agreeing
    on it beats one hand-drawn calibration line.
  * Furniture identifies itself. The drawing labels a wardrobe WARDROBE, which
    settles a question no amount of pixel measurement could — the reason a bed
    outline is otherwise indistinguishable from a partition wall.

OCR runs locally through ONNX; there is no per-page cost and nothing leaves the
machine. It is optional: if the package is absent the service degrades to
unnamed rooms and a scale the user sets by hand, which is where it started.
"""

from __future__ import annotations

import re
from typing import NamedTuple

import numpy as np

try:
    from rapidocr_onnxruntime import RapidOCR

    _engine: object | None = RapidOCR()
except Exception:  # pragma: no cover - depends on the install
    _engine = None


def available() -> bool:
    return _engine is not None


class Label(NamedTuple):
    """One run of text, positioned in normalised coordinates."""

    text: str
    x: float
    y: float
    confidence: float


# Words that name a space you can stand in. Deliberately a vocabulary rather
# than a model: floor plans across the trade use a small, stable set of names,
# and a list is auditable in a way a classifier's weights are not.
ROOM_WORDS = {
    "balcony", "basement", "bath", "bathroom", "bedroom", "cellar", "corridor",
    "deck", "dining", "drawing", "dress", "dressing", "entrance", "entry",
    "family", "foyer", "garage", "gym", "hall", "kitchen", "landing",
    "laundry", "library", "lift", "living", "lobby", "lounge", "master",
    "office", "pantry", "parking", "passage", "patio", "porch", "powder",
    "puja", "shower", "sitout", "staircase", "stairs", "store", "storeroom",
    "study", "terrace", "toilet", "utility", "veranda", "verandah", "void",
    "walkin", "wash", "wc",
}

# Ground, not building.
#
# ── Why these had to be pulled out of the room list ─────────────────────────
# A lawn is an enclosed area on the drawing exactly as a bedroom is, and the
# room-first reader cannot tell them apart: both are shut in by lines, so both
# keep their boundary as walls. On a villa plan that means the pool edge, the
# planting beds and the landscape steps all come through as masonry, which is
# what the drawing looked like it was saying and emphatically not what it meant.
#
# A balcony or a verandah is deliberately *not* here. Those are part of the
# floor plate — they have a slab, a parapet and a threshold, and somebody
# touring the property walks onto them.
OUTDOOR_WORDS = {
    "court", "courtyard", "driveway", "garden", "grass", "green", "landscape",
    "lawn", "pathway", "planting", "pond", "pool", "setback", "shrub", "swimming",
    "water", "waterbody", "yard",
}

# Words that name a thing standing in a room. These are the labels that settle
# the bed-versus-wall question the pixels cannot.
FITTING_WORDS = {
    "almirah", "armchair", "art", "basin", "bed", "bench", "bookshelf",
    "cabinet", "chair", "commode", "console", "counter", "crockery", "cupboard",
    "desk", "dresser", "dummy", "fridge", "hob", "jacuzzi", "loft", "luggage",
    "mirror", "piece", "planter", "platform", "seating", "shelf", "sink",
    "sofa", "stove", "swing", "table", "tub", "tv", "unit", "vanity",
    "wardrobe", "washbasin", "washer",
}

# Annotation that names neither: levels, section marks, directions.
NOISE = re.compile(
    r"^(up|dn|down|lvl|level|ref|typ|n|s|e|w|[+\-±0-9'\"./x×\s]*)$", re.IGNORECASE
)

FOOT = 0.3048
INCH = 0.0254

# A room's side, in metres. Anything outside this is a misread rather than a
# very large cupboard, and dropping it costs nothing because the scale comes
# from a consensus of many rooms.
PLAUSIBLE_SIDE = (0.5, 40.0)


def read_labels(image: np.ndarray, long_edge: int = 3000) -> list[Label]:
    """Every run of text on the drawing, in normalised coordinates."""
    if _engine is None:
        return []

    import cv2

    height, width = image.shape[:2]
    # ── Read at a size the OCR can actually resolve, in BOTH directions ───────
    # A large sheet is downscaled — recognition gains nothing above this and the
    # seconds cost. But a SMALL image was previously left untouched, and that is
    # where room labels go unread: an 8-point caption on a 1200px plan is ten
    # pixels tall, below what any OCR resolves, so the plan came back with no
    # names, no furniture (which needs the labels) and no scale — exactly "it
    # does not detect anything on my file". So a small image is now UPSCALED to
    # the same target, capped at 3x because past that it is inventing pixels
    # rather than revealing them. Cubic on the way up, area on the way down —
    # the interpolation each direction is actually built for.
    longest = max(width, height)
    scale = long_edge / longest
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]
    elif scale > 1.05:
        factor = min(scale, 3.0)
        image = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)
        height, width = image.shape[:2]

    result, _ = _engine(image)  # type: ignore[misc]

    # A faint scan or a screenshot with a grey wash reads poorly at native
    # contrast; a second pass on a contrast-stretched greyscale copy catches
    # captions the first missed. Deduplicated by position below, so a label both
    # passes find is not counted twice — the cost is one extra OCR on the images
    # that need it and nothing on the ones that do not.
    extra = None
    if len(result or []) < 6:
        grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        stretched = cv2.normalize(grey, None, 0, 255, cv2.NORM_MINMAX)
        boosted = cv2.cvtColor(stretched, cv2.COLOR_GRAY2BGR)
        extra, _ = _engine(boosted)  # type: ignore[misc]

    result = _merge_ocr(result or [], extra or [])
    if not result:
        return []

    labels = []
    for box, text, confidence in result:
        text = text.strip()
        if not text:
            continue
        labels.append(
            Label(
                text=text,
                x=float(sum(point[0] for point in box)) / 4 / width,
                y=float(sum(point[1] for point in box)) / 4 / height,
                confidence=float(confidence),
            )
        )
    return labels


def _merge_ocr(first: list, second: list) -> list:
    """
    Combine two OCR passes, dropping a run the second found that the first
    already has at the same place. Same text within a small normalised distance
    is the same caption seen twice, not two captions — keeping both would double
    a room's vote on the scale and list its name twice.
    """
    def centre(box):
        return (
            sum(p[0] for p in box) / 4,
            sum(p[1] for p in box) / 4,
        )

    # Reduce a run to its letters and digits, so `17.9 x 12.7` and `17.9 × 12.7`
    # compare equal — the same caption read with different separators. The `×`
    # strips as punctuation but the ASCII `x` is a letter and survives, so it is
    # also removed WHEN IT SITS BETWEEN DIGITS (a dimension separator, not the x
    # in a word). Without this an OCR wobble on one prime lists a room twice and
    # doubles its scale vote.
    def key(text):
        reduced = re.sub(r"[^a-z0-9]", "", str(text).lower())
        return re.sub(r"(?<=\d)x(?=\d)", "", reduced)

    # Dedup across BOTH passes AND within each — a single pass on an upscaled
    # image can find the same caption twice on its own. Same text within roughly
    # a caption's own width is one caption; two genuinely distinct rooms with
    # identical names sit far further apart than this on any plan.
    merged: list = []
    for box, text, conf in [*first, *second]:
        cx, cy = centre(box)
        clean = key(text)
        if not clean:
            merged.append((box, text, conf))
            continue
        dup = False
        for ebox, etext, _ in merged:
            ex, ey = centre(ebox)
            if key(etext) == clean and abs(ex - cx) < 120 and abs(ey - cy) < 60:
                dup = True
                break
        if not dup:
            merged.append((box, text, conf))
    return merged


def classify(text: str) -> str:
    """`room`, `outdoor`, `fitting`, or `noise`."""
    if NOISE.match(text):
        return "noise"

    words = re.findall(r"[a-z]+", text.lower())
    if not words:
        return "noise"

    # Ground wins outright. "WATER BODY / LANDSCAPE" and "GREEN 6'0\"X11'4\"" are
    # areas on the site, and nothing else in the label changes that.
    if any(word in OUTDOOR_WORDS for word in words):
        return "outdoor"
    # A fitting word beats a room word, because compound labels run that way
    # round: "BEDROOM WARDROBE" is the wardrobe, not the bedroom.
    if any(word in FITTING_WORDS for word in words):
        return "fitting"
    if any(word in ROOM_WORDS for word in words):
        return "room"
    return "noise"


def parse_dimension(text: str) -> tuple[float, float] | None:
    """
    A printed room size in metres, from however it happens to be written.

    Plans print sizes in feet and inches, in metres, and in several typographic
    conventions for each — and OCR mangles the primes, which is the whole
    difficulty. `7'0"X5'9"` comes back intact, `19'10"X6'5"` comes back as
    `19"10"X6'5"`, and `8'10"` sometimes loses its prime and reads `810"`.

    So the marks are not trusted at all. Each side is reduced to the numbers in
    it: two numbers are feet and inches, one number with a decimal point is
    metres, one whole number is feet. What that cannot rescue — `810` — falls
    outside any plausible room size and is discarded, which costs nothing
    because the scale is a consensus across every labelled room on the sheet.
    """
    parts = re.split(r"[xX×]", text)
    if len(parts) != 2:
        return None

    sides = []
    for part in parts:
        numbers = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", part)]
        if len(numbers) >= 2:
            metres = numbers[0] * FOOT + numbers[1] * INCH
        elif len(numbers) == 1:
            metres = numbers[0] if "." in part else numbers[0] * FOOT
        else:
            return None

        if not PLAUSIBLE_SIDE[0] <= metres <= PLAUSIBLE_SIDE[1]:
            return None
        sides.append(metres)

    return sides[0], sides[1]


def inside(label: Label, polygon: list[tuple[float, float]]) -> bool:
    """Ray casting, so a label counts for the room it is printed in."""
    hit = False
    count = len(polygon)
    for i in range(count):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % count]
        if (y0 > label.y) != (y1 > label.y):
            crossing = x0 + (label.y - y0) / (y1 - y0) * (x1 - x0)
            if label.x < crossing:
                hit = not hit
    return hit


class Scale(NamedTuple):
    """Metres per normalised unit of the drawing's width, and where it came from."""

    metres_per_unit: float
    samples: int
    # How far apart the samples were, as a fraction. None from a single room,
    # where there is nothing to disagree with — reporting 0% there would claim a
    # confidence that measurement never established.
    spread: float | None


def infer_scale(measurements: list[tuple[float, tuple[float, float]]]) -> Scale | None:
    """
    Metres per unit, agreed across the labelled rooms.

    Each measurement pairs a region's size on the sheet with the size printed
    inside it. One such pair is a scale; a dozen of them are a scale you can
    trust, which is the point — a single misread dimension moves the median not
    at all, where it would have moved a lone calibration line completely.

    The spread is returned rather than hidden. Rooms that disagree by more than
    a few percent mean something is wrong — two plans at different scales on one
    sheet, most often — and the caller should say so instead of quietly picking
    one.
    """
    ratios = []
    for drawn, (side_a, side_b) in measurements:
        printed = max(side_a, side_b)
        if drawn > 0 and printed > 0:
            ratios.append(printed / drawn)

    if not ratios:
        return None

    ratios.sort()
    middle = float(np.median(ratios))
    if middle <= 0:
        return None

    if len(ratios) < 2:
        return Scale(metres_per_unit=middle, samples=len(ratios), spread=None)

    spread = float(np.percentile(ratios, 75) - np.percentile(ratios, 25)) / middle
    return Scale(metres_per_unit=middle, samples=len(ratios), spread=round(spread, 3))
