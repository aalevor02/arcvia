"""
Reading a presentation deck.

Built around the document that prompted the feature: a 27-page slide deck where
one page carried two floor plans and twenty-two carried captioned interior
renders. The fixture is generated rather than committed, so the suite carries no
9 MB binary and still exercises the thing that matters — that the caption beside
an image decides what the image is, and which room it belongs to.
"""

import io
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pymupdf

import deck

passed = failed = 0


def check(label, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


def drawing(width=900, height=700):
    """A line drawing: mostly paper, a few flat strokes."""
    page = np.full((height, width, 3), 250, np.uint8)
    page[80:90, 100:800] = 40
    page[600:610, 100:800] = 40
    page[80:610, 100:110] = 40
    page[80:610, 790:800] = 40
    page[300:310, 100:500] = 40
    return page


def photograph(width=900, height=600, seed=4):
    """A render: continuous tone, no paper."""
    rng = np.random.default_rng(seed)
    base = rng.integers(30, 210, (height // 20, width // 20, 3)).astype(np.uint8)
    import cv2

    return cv2.resize(base, (width, height), interpolation=cv2.INTER_LINEAR)


def build_deck(pages):
    """A PDF of captioned, full-bleed images — the shape a studio deck has."""
    import cv2

    document = pymupdf.open()
    for caption, image in pages:
        page = document.new_page(width=960, height=540)
        ok, encoded = cv2.imencode(".png", image)
        assert ok
        page.insert_image(pymupdf.Rect(60, 40, 900, 440), stream=encoded.tobytes())
        page.insert_text((60, 480), caption, fontsize=18)
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


# ---- Classification --------------------------------------------------------
data = build_deck(
    [
        ("Ground Floor Plan", drawing()),
        ("VILLA ELEVATION", photograph(seed=1)),
        ("GROUND FLOOR - BEDROOM (NORTH ORIENTED)", photograph(seed=2)),
        ("GROUND FLOOR - TOILET VIEW 2", photograph(seed=3)),
        ("Inspiration Board", photograph(seed=5)),
        ("OPTION 2 - VIEW 1", photograph(seed=6)),
    ]
)
sheets = deck.outline(data)

check("every full-page image is found", len(sheets) == 6, f"got {len(sheets)}")

by_page = {sheet.page: sheet for sheet in sheets}
check("a floor plan is read as a plan", by_page[1].kind == "plan", by_page[1].kind)
check("an elevation is not read as a room", by_page[2].kind == "elevation", by_page[2].kind)
check("a captioned interior is a render", by_page[3].kind == "render", by_page[3].kind)
check("a mood board is not a render", by_page[5].kind == "board", by_page[5].kind)

# The association that saves the user twenty-two decisions.
check("a render names its room", by_page[3].room == "Bedroom", str(by_page[3].room))
check("and its floor", by_page[3].floor == "Ground", str(by_page[3].floor))
check(
    "a view number is not mistaken for a room",
    by_page[4].room == "Toilet",
    str(by_page[4].room),
)

# An uncaptionable page still has to land somewhere sensible, since a deck with
# no captions at all is a perfectly ordinary thing to be handed.
check(
    "an unnamed photograph falls back to render",
    by_page[6].kind == "render",
    by_page[6].kind,
)

check("renders carry a palette", len(by_page[3].palette) == 5, str(by_page[3].palette))
check(
    "palette entries are hex",
    all(len(colour) == 7 and colour.startswith("#") for colour in by_page[3].palette),
)
check("plans do not carry a palette", by_page[1].palette == [])

# ---- Pixel fallback --------------------------------------------------------
check("a line drawing reads as a plan by pixels", deck.classify_pixels(drawing()) == "plan")
check(
    "a photograph reads as a render by pixels",
    deck.classify_pixels(photograph()) == "render",
)

# ---- Small images are furniture of the page, not content -------------------
import cv2

document = pymupdf.open()
page = document.new_page(width=960, height=540)
ok, encoded = cv2.imencode(".png", photograph(80, 60))
page.insert_image(pymupdf.Rect(10, 10, 60, 45), stream=encoded.tobytes())
page.insert_text((60, 480), "ARDS x CDC, Hyderabad", fontsize=12)
buffer = io.BytesIO()
document.save(buffer)
check("a logo is ignored", deck.outline(buffer.getvalue()) == [])

# ---- Extraction ------------------------------------------------------------
image = deck.extract(data, page=1, index=0, long_edge=400)
decoded = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
check("a page extracts as a decodable image", decoded is not None)
check("and is bounded to the requested size", max(decoded.shape[:2]) == 400,
      str(decoded.shape))

# ---- Caption parsing on its own --------------------------------------------
check("plan wins over a room word", deck.classify_caption("Basement Floor Plan") == "plan")
check("a bare room word is a render", deck.classify_caption("KITCHEN") == "render")
check("silence stays silent", deck.classify_caption("ARDS x CDC") is None)
check("a floor is read", deck.floor_of("BASEMENT FLOOR - TOILET") == "Basement")
check(
    "a room survives a parenthesised aside",
    deck.room_of("GROUND FLOOR - BEDROOM (EAST ORIENTED)") == "Bedroom",
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
