"""
Reading an architect's PDF.

── What actually arrives ───────────────────────────────────────────────────────
Almost nobody sends a drawing. They send the deck they showed the client: a
27-page slide document where page 3 happens to carry two floor plans and the
other twenty-odd pages are interior renders, elevations and a mood board. Asking
such a person to "export a clean plan image" is asking them to do a job they
hired software for.

So this reads the deck as a deck. Two facts make that tractable without any
model:

  * A PDF stores its images separately from its page, at whatever resolution
    they were placed. The floor plan buried in that slide is a 4096px original,
    far better than a screenshot of the same page — the deck is a *better*
    source than what most people would have exported by hand.

  * Every image is captioned, because the deck was made to be presented.
    "GROUND FLOOR - BEDROOM (NORTH ORIENTED)" says what it is, which floor it is
    on and which room it shows. That is precisely the association a viewer would
    otherwise have to make by hand, twenty-two times.

Pixels are only consulted when the caption is silent, and then only to separate
a line drawing from a photograph, which is an easy call.
"""

from __future__ import annotations

import re
from typing import Literal, NamedTuple

import cv2
import numpy as np

import pdfbackend
import labels as text_labels

Kind = Literal["plan", "elevation", "render", "board", "other"]

# Below this share of the page an image is a logo, a north arrow or a scale bar.
MIN_PAGE_SHARE = 0.05

# Text repeating on more than this share of the pages is the deck's furniture —
# the studio name, the project title, the page footer — not a caption.
BOILERPLATE_SHARE = 0.3

# ...but only once there are enough pages for "repeating" to mean anything. On a
# three-page document a caption that happens to appear twice is still a caption.
BOILERPLATE_MIN_PAGES = 5

PLAN_WORDS = re.compile(
    r"\b(floor\s*plan|site\s*plan|layout|key\s*plan|roof\s*plan|plan)\b", re.IGNORECASE
)
ELEVATION_WORDS = re.compile(r"\b(elevation|section|facade|façade)\b", re.IGNORECASE)
BOARD_WORDS = re.compile(
    r"\b(inspiration|mood\s*board|material|palette|reference)\b", re.IGNORECASE
)
FLOOR_WORDS = re.compile(
    r"\b(basement|ground|first|second|third|fourth|upper|lower|terrace|typical|stilt|"
    r"mezzanine|attic|roof)\b",
    re.IGNORECASE,
)


def available() -> bool:  # noqa: D401 - kept for the /health report
    return pdfbackend.available()


class Sheet(NamedTuple):
    """One image on one page, and what the deck says about it."""

    page: int  # 1-based, as printed
    index: int  # which image on that page
    kind: Kind
    caption: str
    floor: str | None
    room: str | None
    width: int
    height: int
    share: float  # fraction of the page it covers
    palette: list[str]


def outline(data: bytes) -> list[Sheet]:
    """Everything worth extracting from the document, without extracting it."""
    document = pdfbackend.open_document(data)
    sheets: list[Sheet] = []
    boilerplate = repeated_text(document)

    for page in document:
        number = page.number
        page_area = abs(page.rect.width * page.rect.height) or 1.0
        blocks = [
            block for block in page.text_blocks() if normalise(block[1]) not in boilerplate
        ]

        for index, image in enumerate(page.images()):
            placed = image.rect
            share = abs(placed.width * placed.height) / page_area
            if share < MIN_PAGE_SHARE:
                continue

            caption = nearest_caption(blocks, placed)
            kind = classify_caption(caption)

            # A caption can be perfectly good and still say nothing about what
            # kind of thing this is — "Option 2" names a scheme, not a subject.
            # Before falling back to guessing from pixels, ask what else is
            # written on the page: a mood board is usually captioned "Option 2"
            # in large type and "Inspiration Board" in small.
            #
            # Only reached when the caption is silent, so a page that named
            # itself is never overruled by a stray word elsewhere on it.
            if kind is None:
                for _, text, _ in sorted(blocks, key=lambda block: -block[2]):
                    kind = classify_caption(text)
                    if kind is not None:
                        break

            pixels = None
            if kind is None:
                pixels = image.to_array()
                kind = classify_pixels(pixels)

            sheets.append(
                Sheet(
                    page=number,
                    index=index,
                    kind=kind,
                    caption=caption,
                    floor=floor_of(caption),
                    room=room_of(caption) if kind in ("render", "plan") else None,
                    width=image.width,
                    height=image.height,
                    share=round(share, 3),
                    palette=(
                        palette(pixels if pixels is not None else image.to_array())
                        if kind == "render"
                        else []
                    ),
                )
            )

    document.close()
    return sheets


def extract(data: bytes, page: int, index: int, long_edge: int = 2400) -> bytes:
    """One image out of the document, as PNG, bounded in size."""
    document = pdfbackend.open_document(data)
    try:
        images = document[page - 1].images()
        if index >= len(images):
            raise IndexError(f"Page {page} has no image {index}.")
        image = images[index].to_array()
    finally:
        document.close()

    # Downscaled with INTER_AREA rather than left at source size. A 4096px plan
    # costs the detector real time in morphology and gives nothing back: wall
    # strokes are already tens of pixels wide, and the kernels scale with the
    # image anyway.
    scale = long_edge / max(image.shape[:2])
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("Could not encode that page.")
    return encoded.tobytes()


def text_blocks(page) -> list[tuple]:
    """Each block of text on the page as (rect, text, point size)."""
    return page.text_blocks()


def normalise(text: str) -> str:
    """Text with the varying parts taken out, so repetition can be spotted."""
    return " ".join(re.findall(r"[a-z]+", text.lower()))


def repeated_text(document) -> set[str]:
    """
    The lines this deck puts on every page.

    A studio's name, the project title and the page footer appear throughout,
    and they are what makes captioning hard: slide images are full-bleed, so
    *every* block of text on the page overlaps the image, and the footer is
    usually the widest block on the sheet — which puts its centre nearest the
    middle and lets it beat the real caption on distance alone.

    Rather than a list of things to ignore, the deck is asked which of its own
    text repeats. Page numbers vary and the studio name does not, so the numbers
    are stripped before counting. A caption survives because it describes one
    page; boilerplate does not because it describes none.
    """
    pages = document.page_count
    if pages < BOILERPLATE_MIN_PAGES:
        return set()

    seen: dict[str, int] = {}
    for page in document:
        for text in {normalise(block[1]) for block in page.text_blocks()}:
            if text:
                seen[text] = seen.get(text, 0) + 1

    limit = max(3, int(pages * BOILERPLATE_SHARE))
    return {text for text, count in seen.items() if count > limit}


def nearest_caption(blocks: list[tuple], image_rect) -> str:
    """
    The text this image is captioned with.

    Largest type first, nearest second. A deck sets its captions bigger than its
    footers — 24 point against 16 in the document this was written for — and
    that ordering is close to universal, because the caption is the thing the
    presenter wants read from the back of the room.

    Distance alone was tried and is not enough on a full-bleed slide, where
    everything overlaps the image and the widest block wins. Size settles it,
    and distance only breaks ties between blocks set at the same size.
    """
    centre_x = (image_rect.x0 + image_rect.x1) / 2
    centre_y = (image_rect.y0 + image_rect.y1) / 2

    best, best_rank = "", (-1.0, float("-inf"))
    for rect, text, size in blocks:
        overlaps_x = rect.x1 > image_rect.x0 and rect.x0 < image_rect.x1
        overlaps_y = rect.y1 > image_rect.y0 and rect.y0 < image_rect.y1
        if not (overlaps_x or overlaps_y):
            continue

        distance = ((rect.x0 + rect.x1) / 2 - centre_x) ** 2 + (
            (rect.y0 + rect.y1) / 2 - centre_y
        ) ** 2
        rank = (round(size, 1), -distance)
        if rank > best_rank:
            best, best_rank = text, rank

    return best


def classify_caption(caption: str) -> Kind | None:
    """What the deck says this is, or None if it does not say."""
    if not caption:
        return None
    if BOARD_WORDS.search(caption):
        return "board"
    if ELEVATION_WORDS.search(caption):
        return "elevation"
    if PLAN_WORDS.search(caption):
        return "plan"
    if any(
        text_labels.classify(word) == "room"
        for word in re.split(r"[^A-Za-z]+", caption)
        if word
    ):
        return "render"
    return None


def classify_pixels(image: np.ndarray) -> Kind:
    """
    Line drawing or photograph, when the caption is silent.

    A plan is mostly paper: white dominates, and what is not white is a handful
    of flat greys. A render has no white to speak of and a continuous spread of
    tones. Counting near-white pixels separates the two cleanly enough that
    nothing subtler is warranted.
    """
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    paper = float((grey > 235).mean())
    return "plan" if paper > 0.45 else "render"


def floor_of(caption: str) -> str | None:
    match = FLOOR_WORDS.search(caption)
    return match.group(0).title() if match else None


def room_of(caption: str) -> str | None:
    """
    The room a render shows.

    Captions run "GROUND FLOOR - BEDROOM (NORTH ORIENTED)" or "GROUND FLOOR -
    TOILET VIEW 1", so the room name is what remains once the floor, the view
    number and any parenthesised aside are taken out. Matching against the same
    vocabulary the plan's own labels are read with is what lets a render meet
    its room later: both sides end up spelling it the same way.
    """
    text = re.sub(r"\([^)]*\)", " ", caption)
    text = re.sub(r"\bview\s*\d*\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bfloor\b", " ", text, flags=re.IGNORECASE)
    text = FLOOR_WORDS.sub(" ", text)

    words = [word for word in re.split(r"[^A-Za-z]+", text) if word]
    named = [word for word in words if text_labels.classify(word) == "room"]
    if named:
        return named[0].title()

    # "BASEMENT FLOOR - WARDROBE" is a view of the wardrobe. The vocabulary calls
    # a wardrobe a fitting rather than a room, which is right when the word is
    # printed on a plan and wrong when it is captioning a photograph of one —
    # here it is still the key that pairs this image with a place.
    fittings = [word for word in words if text_labels.classify(word) == "fitting"]
    return fittings[0].title() if fittings else None


def palette(image: np.ndarray, count: int = 5) -> list[str]:
    """
    The colours a render is built from, most-used first.

    This is what makes a render usable rather than merely viewable: the finishes
    the architect chose are in these pixels, and a room modelled in the deck's
    own palette looks like the deck. Reported as hex so it can be handed
    straight to a material without further interpretation.
    """
    small = cv2.resize(image, (96, 96), interpolation=cv2.INTER_AREA)
    pixels = small.reshape(-1, 3).astype(np.float32)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, assignment, centres = cv2.kmeans(
        pixels, count, None, criteria, 3, cv2.KMEANS_PP_CENTERS
    )

    order = np.argsort(-np.bincount(assignment.flatten(), minlength=count))
    return [
        "#%02x%02x%02x" % (int(centres[i][2]), int(centres[i][1]), int(centres[i][0]))
        for i in order
    ]
