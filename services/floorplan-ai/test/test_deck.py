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


#: The fixture is written with reportlab (BSD-3), not PyMuPDF.
#:
#: PyMuPDF is AGPL, and while a test fixture never ships, leaving it in the dev
#: dependencies means the obligation is one careless `import` away from the
#: service. Removing it entirely is cheaper than remembering the distinction.
#:
#: reportlab measures y UPWARD from the bottom of the page; the rectangles below
#: are given in the top-down coordinates the rest of this codebase uses, and
#: converted in one place.
PAGE_W, PAGE_H = 960, 540


def _place(canvas, png: bytes, x0, y0, x1, y1):
    from reportlab.lib.utils import ImageReader

    canvas.drawImage(
        ImageReader(io.BytesIO(png)),
        x0, PAGE_H - y1,                 # the flip, once
        width=x1 - x0, height=y1 - y0,
        mask=None,
    )


def build_deck(pages):
    """A PDF of captioned, full-bleed images — the shape a studio deck has."""
    import cv2
    from reportlab.pdfgen import canvas as rl_canvas

    out = io.BytesIO()
    canvas = rl_canvas.Canvas(out, pagesize=(PAGE_W, PAGE_H))
    for caption, image in pages:
        ok, encoded = cv2.imencode(".png", image)
        assert ok
        _place(canvas, encoded.tobytes(), 60, 40, 900, 440)
        canvas.setFont("Helvetica", 18)
        canvas.drawString(60, PAGE_H - 480, caption)
        canvas.showPage()
    canvas.save()
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

from reportlab.pdfgen import canvas as rl_canvas

ok, logo = cv2.imencode(".png", photograph(80, 60))
assert ok

buffer = io.BytesIO()
canvas = rl_canvas.Canvas(buffer, pagesize=(PAGE_W, PAGE_H))
_place(canvas, logo.tobytes(), 10, 10, 60, 45)
canvas.setFont("Helvetica", 12)
canvas.drawString(60, PAGE_H - 480, "ARDS x CDC, Hyderabad")
canvas.showPage()
canvas.save()

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

# ---- The two readers must agree --------------------------------------------
#
# `pdfbackend` ships pypdfium2 + pdfplumber and can optionally be pointed at
# PyMuPDF (`ARCVIA_PDF_BACKEND=pymupdf`, see requirements-dev.txt). Having two
# is only worth anything if they agree on an easy document — otherwise a
# disagreement on a hard one tells you nothing, because you never established a
# baseline.
#
# The specific thing being guarded: PyMuPDF and pdfplumber measure y DOWNWARD
# from the top of the page, pypdfium2 measures it UPWARD from the bottom. There
# is a `height - y` flip on one path and none on the other. Getting that wrong
# does not raise — it pairs each image with some other page's caption, so every
# sheet comes back plausibly populated and wrong. Comparing captions across the
# backends is what catches it.
#
# Skipped, not failed, when PyMuPDF is absent. Absent is the *normal* case: it
# is not in requirements.txt and a release never has it.
import pdfbackend  # noqa: E402

if pdfbackend.backend_available(pdfbackend.PYMUPDF):
    def read_with(backend):
        previous = os.environ.get("ARCVIA_PDF_BACKEND")
        os.environ["ARCVIA_PDF_BACKEND"] = backend
        try:
            assert pdfbackend.backend_name() == backend
            return deck.outline(data)
        finally:
            if previous is None:
                os.environ.pop("ARCVIA_PDF_BACKEND", None)
            else:
                os.environ["ARCVIA_PDF_BACKEND"] = previous

    permissive = read_with(pdfbackend.PERMISSIVE)
    mupdf = read_with(pdfbackend.PYMUPDF)

    check("both backends find the same number of sheets",
          len(permissive) == len(mupdf), f"{len(permissive)} vs {len(mupdf)}")

    # Caption first and on its own. If the flip were wrong this is the assertion
    # that fails, and it fails legibly — you see which caption landed on which
    # page rather than a downstream classification being mysteriously off.
    check("both backends pair the same caption with each page",
          [(s.page, s.caption) for s in permissive] == [(s.page, s.caption) for s in mupdf],
          f"{[(s.page, s.caption) for s in mupdf]}")

    check("both backends agree what each sheet is",
          [(s.page, s.kind, s.floor, s.room) for s in permissive]
          == [(s.page, s.kind, s.floor, s.room) for s in mupdf])

    # Native resolution, not placed size — the reason either backend is worth
    # having. The fixture places a 900 px drawing into an 840 pt box, so a
    # backend that rasterised the page region would come back at ~840 and a
    # backend reading the embedded bitmap comes back at 900.
    check("both backends read the embedded bitmap at its native size",
          [(s.page, s.width, s.height) for s in permissive]
          == [(s.page, s.width, s.height) for s in mupdf],
          f"{[(s.width, s.height) for s in mupdf]}")
else:
    print("SKIP  cross-backend agreement (PyMuPDF not installed — the normal case)")

# An unrecognised backend name must raise rather than quietly using the other
# reader. This is the failure mode that would otherwise be invisible: the PDFs
# still parse, so nothing looks wrong until two machines disagree about a deck.
os.environ["ARCVIA_PDF_BACKEND"] = "pymudpf"  # a plausible typo
try:
    deck.outline(data)
    check("a mistyped backend name is refused", False, "it silently used a backend")
except RuntimeError as error:
    check("a mistyped backend name is refused", "not a backend" in str(error))
finally:
    os.environ.pop("ARCVIA_PDF_BACKEND", None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
