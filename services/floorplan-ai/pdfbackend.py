"""
Reading PDFs without an AGPL obligation.

── Why this file exists ──────────────────────────────────────────────────────
`deck.py` was written against PyMuPDF, which is **dual-licensed AGPL-3.0 or
commercial**. AGPL reaches *network use*: offering this as a hosted service with
PyMuPDF inside obliges you to offer the entire source to every user of that
service. For a product with a credit model waiting to be switched on, that is a
constraint discovered at exactly the wrong moment.

It is also the ONLY restrictive dependency in the whole stack. Everything else —
435 npm packages, both Python environments, 2,135 catalogue and library assets —
is MIT, BSD, Apache or CC0, with three CC-BY attributions and no NonCommercial
anywhere. Removing this one leaves nothing in the way of charging for Arcvia.

── What replaces it ─────────────────────────────────────────────────────────
Two libraries, because no single permissive one does both halves well:

  pypdfium2   BSD-3-Clause / Apache-2.0. Google's PDFium. Gives embedded images
              at their NATIVE resolution and where they were placed — which is
              the whole trick deck.py depends on, since a plan buried in a slide
              is a 4096 px original rather than a screenshot of a slide.
  pdfplumber  MIT, over pdfminer.six. Gives text with positions AND font size,
              which is what separates a caption from a footer.

── The coordinate trap this file absorbs ────────────────────────────────────
PyMuPDF and pdfplumber both measure y **downward from the top of the page**.
pypdfium2 returns PDF-native coordinates, which measure **upward from the
bottom**. `nearest_caption()` compares text positions against image rectangles,
so mixing the two does not raise — it silently captions the wrong picture, and
the failure looks like bad captioning rather than bad arithmetic.

Everything here is converted to top-down at the boundary. `deck.py` therefore
needs no coordinate changes at all, and there is exactly one place where the
convention flips.

── The second reader, and why it is opt-in rather than absent ───────────────
PyMuPDF is back, as a **selectable** backend. Two readers of the same PDF
disagree in useful ways — when a deck extracts as an empty sheet list, being
able to re-read it with a different engine turns "the importer is broken" into
"these two disagree about page 4", which is a far shorter conversation.

What makes that safe is that it is never installed by default:

    requirements.txt        pypdfium2 + pdfplumber      shipped, permissive
    requirements-dev.txt    pymupdf                     opt-in, AGPL

    ARCVIA_PDF_BACKEND unset       -> permissive (the only value a release sees)
    ARCVIA_PDF_BACKEND=pymupdf     -> PyMuPDF, if this machine has it

The distinction that matters for the licence is *distribution and network use*,
not call frequency. A fallback that silently reaches for PyMuPDF when the
permissive path struggles would carry the full AGPL obligation on every hosted
request, which is why there is **no automatic fallback** here: selecting PyMuPDF
is an explicit act by whoever deployed the process, and asking for a backend
this machine does not have raises rather than quietly using the other one. A
silent substitution would also make the two readers impossible to compare,
which is the entire reason for having both.

── The trap in having two ───────────────────────────────────────────────────
PyMuPDF measures y **downward from the top**, the same as pdfplumber and the
same as everything downstream — so unlike the pypdfium2 path it needs no flip.
That asymmetry is the danger: the flip is correct in one backend and wrong in
the other, and getting it wrong does not raise. It silently captions the wrong
picture. There is exactly one `height - y` in `_read`, none in `_read_pymupdf`,
and `test_deck.py` asserts both backends agree on caption pairing.
"""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass, field

import cv2
import numpy as np

try:
    import pypdfium2 as pdfium
except ImportError:  # pragma: no cover - optional, like the old backend
    pdfium = None  # type: ignore[assignment]

try:
    import pdfplumber
except ImportError:  # pragma: no cover
    pdfplumber = None  # type: ignore[assignment]

# The opt-in second reader. Absent from requirements.txt on purpose — see the
# module docstring. `pymupdf` is the modern import name; `fitz` is what older
# installs answer to, and both appear in the wild.
try:  # pragma: no cover - not installed in the shipped configuration
    import pymupdf as _mupdf
except ImportError:  # pragma: no cover
    try:
        import fitz as _mupdf  # type: ignore[no-redef]
    except ImportError:
        _mupdf = None  # type: ignore[assignment]


#: The shipped default. Permissive, and the only value a release ever sees.
PERMISSIVE = "permissive"

#: The opt-in extra. AGPL — a deployment that sets this accepts that obligation.
PYMUPDF = "pymupdf"

_ENV = "ARCVIA_PDF_BACKEND"


def backend_name() -> str:
    """
    Which reader this process will use.

    Read from the environment every call rather than cached at import, so a test
    can select a backend without reloading the module — and so `/health` reports
    what is *currently* true rather than what was true at boot.
    """
    choice = (os.environ.get(_ENV) or PERMISSIVE).strip().lower()
    if choice in ("", "auto", "default"):
        return PERMISSIVE
    return choice


def backend_available(name: str | None = None) -> bool:
    """
    Is the named backend (default: the selected one) actually importable?

    An unrecognised name is False, not "fall back to permissive". A typo in
    `ARCVIA_PDF_BACKEND` that silently ran the other reader would be invisible
    in every output — the PDFs would still parse — and would only surface as two
    machines mysteriously disagreeing about the same deck.
    """
    name = name or backend_name()
    if name == PYMUPDF:
        return _mupdf is not None
    if name == PERMISSIVE:
        return pdfium is not None and pdfplumber is not None
    return False


def available() -> bool:
    """
    Can this installation read a PDF at all?

    For the permissive backend both halves must be present — images without
    captions is not useful. For PyMuPDF the one library does both.

    Deliberately reports on the *selected* backend, not on whether any backend
    could work. An installation that asked for PyMuPDF and does not have it is
    broken, and saying `reads_pdf: true` because a different reader happens to
    be importable would hide exactly that.
    """
    return backend_available()


@dataclass(frozen=True)
class Rect:
    """
    A rectangle in top-down page coordinates.

    Deliberately the same shape as `pymupdf.Rect` — x0/y0/x1/y1 with width and
    height — so the calling code did not have to change when the backend did.
    """

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def centre(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)


@dataclass
class Image:
    """One embedded image, with where it sits and what it actually contains."""

    index: int
    rect: Rect
    _obj: object = field(repr=False, default=None)

    @property
    def px_size(self) -> tuple[int, int]:
        """Native pixel size, without decoding the bitmap."""
        try:
            return tuple(self._obj.get_px_size())
        except Exception:
            return (0, 0)

    @property
    def width(self) -> int:
        return self.px_size[0]

    @property
    def height(self) -> int:
        return self.px_size[1]

    def to_array(self) -> np.ndarray:
        """
        The image as OpenCV BGR, at its native resolution.

        `render=False` asks PDFium for the embedded bitmap rather than a
        rasterisation of the page region — which is the point. Rasterising would
        give us the image at *placed* size, throwing away the extra resolution
        that made extracting from a slide deck worth doing.
        """
        bitmap = self._obj.get_bitmap(render=False)
        array = bitmap.to_numpy()

        if array.ndim == 2:
            return cv2.cvtColor(array, cv2.COLOR_GRAY2BGR)
        if array.shape[2] == 4:
            return cv2.cvtColor(array, cv2.COLOR_RGBA2BGR)
        if array.shape[2] == 1:
            return cv2.cvtColor(array[:, :, 0], cv2.COLOR_GRAY2BGR)
        return cv2.cvtColor(array, cv2.COLOR_RGB2BGR)


@dataclass
class Page:
    number: int
    width: float
    height: float
    _images: list = field(repr=False, default_factory=list)
    _blocks: list = field(repr=False, default_factory=list)

    @property
    def rect(self) -> Rect:
        return Rect(0.0, 0.0, self.width, self.height)

    def images(self) -> list[Image]:
        return self._images

    def text_blocks(self) -> list[tuple]:
        """Each block of text as (Rect, text, point size) — deck.py's shape."""
        return self._blocks


class Document:
    """Enough of a PDF for deck.py, and nothing more."""

    def __init__(self, data: bytes) -> None:
        if not available():
            # Names the backend that was ASKED for. An install that selected
            # PyMuPDF and does not have it must not be told to install
            # pypdfium2 — that sends someone to fix the wrong thing, and the
            # other backend being importable is exactly why it would not be
            # obvious the selection had failed.
            selected = backend_name()
            if selected == PYMUPDF:
                raise RuntimeError(
                    f"{_ENV}={PYMUPDF} but PyMuPDF is not installed. "
                    "pip install -r requirements-dev.txt  (AGPL — opt-in), "
                    f"or unset {_ENV} to use the permissive default."
                )
            if selected != PERMISSIVE:
                raise RuntimeError(
                    f"{_ENV}={selected!r} is not a backend. "
                    f"Use {PERMISSIVE!r} (default) or {PYMUPDF!r}."
                )
            raise RuntimeError(
                "PDF reading needs pypdfium2 and pdfplumber. "
                "pip install pypdfium2 pdfplumber"
            )
        self._data = data
        self.pages: list[Page] = _read(data)
        self.page_count = len(self.pages)

    def __iter__(self):
        return iter(self.pages)

    def __getitem__(self, index: int) -> Page:
        return self.pages[index]

    def close(self) -> None:  # kept so callers can stay symmetrical
        self.pages = []


def _read(data: bytes) -> list[Page]:
    """Dispatch to the selected reader. No fallback — see the module docstring."""
    if backend_name() == PYMUPDF:
        return _read_pymupdf(data)
    return _read_permissive(data)


def _read_permissive(data: bytes) -> list[Page]:
    pdf = pdfium.PdfDocument(data)
    IMAGE = pdfium.raw.FPDF_PAGEOBJ_IMAGE

    # Text first, in one pass, so the file is parsed twice rather than 2N times.
    text_by_page: dict[int, list[tuple]] = {}
    with pdfplumber.open(io.BytesIO(data)) as plumbed:
        for number, page in enumerate(plumbed.pages, start=1):
            text_by_page[number] = _blocks_of(page)

    pages: list[Page] = []
    for number, raw_page in enumerate(pdf, start=1):
        height = raw_page.get_height()
        width = raw_page.get_width()

        images: list[Image] = []
        for obj in raw_page.get_objects():
            if obj.type != IMAGE:
                continue
            left, bottom, right, top = obj.get_bounds()
            # THE FLIP. PDF y grows upward; everything above this line and every
            # consumer of it measures downward from the top of the page.
            images.append(
                Image(
                    index=len(images),
                    rect=Rect(left, height - top, right, height - bottom),
                    _obj=obj,
                )
            )

        pages.append(
            Page(
                number=number,
                width=width,
                height=height,
                _images=images,
                _blocks=text_by_page.get(number, []),
            )
        )

    return pages


#: Words closer than this vertically are the same line; closer than this
#: horizontally are the same block. Generous, because a caption is one short
#: line and over-merging it with a neighbour is worse than splitting it.
_LINE_GAP = 3.0
_BLOCK_GAP = 14.0


def _blocks_of(page) -> list[tuple]:
    """
    Group pdfplumber's words into blocks, as (Rect, text, max point size).

    pdfminer gives words, not blocks, so the grouping PyMuPDF did internally has
    to happen here. Vertical proximity first, then horizontal — which is how a
    caption under an image stays one block and a footer three inches away does
    not join it.
    """
    try:
        words = page.extract_words(extra_attrs=["size"])
    except Exception:
        return []

    if not words:
        return []

    words = sorted(words, key=lambda w: (round(w["top"], 1), w["x0"]))

    lines: list[list[dict]] = []
    for word in words:
        if lines and abs(word["top"] - lines[-1][-1]["top"]) <= _LINE_GAP:
            lines[-1].append(word)
        else:
            lines.append([word])

    blocks: list[list[dict]] = []
    for line in lines:
        if blocks and abs(line[0]["top"] - blocks[-1][-1]["top"]) <= _BLOCK_GAP:
            blocks[-1].extend(line)
        else:
            blocks.append(list(line))

    out: list[tuple] = []
    for block in blocks:
        text = re.sub(r"\s+", " ", " ".join(w["text"] for w in block)).strip()
        if not text:
            continue
        out.append(
            (
                Rect(
                    min(w["x0"] for w in block),
                    min(w["top"] for w in block),
                    max(w["x1"] for w in block),
                    max(w["bottom"] for w in block),
                ),
                text,
                max(float(w.get("size") or 0.0) for w in block),
            )
        )
    return out


class _MuPdfBitmap:
    """Duck-types `pypdfium2`'s bitmap so `Image.to_array()` stays one path."""

    def __init__(self, array: np.ndarray) -> None:
        self._array = array

    def to_numpy(self) -> np.ndarray:
        return self._array


class _MuPdfImage:
    """
    One embedded image, presented with PDFium's interface.

    Matching the other backend's *shape* rather than adding a `_kind` branch to
    `Image` is deliberate: the channel-order conversions in `Image.to_array()`
    are the fiddliest tested code in this file, and a second backend that forks
    them is a second backend that gets them subtly wrong. The cost is that RGB
    is swapped twice on this path — `cv2.imdecode` hands back BGR, this converts
    it to RGB, and `to_array()` converts it straight back. That is a memcpy per
    image against a class of bug that does not raise, and it is worth it.
    """

    def __init__(self, doc, xref: int, width: int, height: int) -> None:
        self._doc = doc
        self._xref = xref
        self._size = (int(width), int(height))

    def get_px_size(self) -> tuple[int, int]:
        """Native pixel size, straight from the image dictionary. No decode."""
        return self._size

    def get_bitmap(self, render: bool = False) -> _MuPdfBitmap:
        # `render` exists only for signature parity. This always returns the
        # EMBEDDED bitmap, never a rasterisation of the placed region — same
        # guarantee the pypdfium2 path makes, and the reason either is useful.
        raw = self._doc.extract_image(self._xref)
        decoded = cv2.imdecode(
            np.frombuffer(raw["image"], dtype=np.uint8), cv2.IMREAD_UNCHANGED
        )

        if decoded is None:
            # JPEG2000 and CMYK streams that OpenCV will not decode. PyMuPDF
            # can rasterise the object itself; going through a Pixmap costs more
            # but it is the only route for these, and returning None here would
            # surface as an unexplained missing plan.
            pixmap = _mupdf.Pixmap(self._doc, self._xref)
            if pixmap.n - pixmap.alpha >= 4:  # CMYK
                pixmap = _mupdf.Pixmap(_mupdf.csRGB, pixmap)
            array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            return _MuPdfBitmap(array)  # already RGB / RGBA

        if decoded.ndim == 2:
            return _MuPdfBitmap(decoded)  # grayscale, no channel order to get wrong
        if decoded.shape[2] == 4:
            return _MuPdfBitmap(cv2.cvtColor(decoded, cv2.COLOR_BGRA2RGBA))
        return _MuPdfBitmap(cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB))


def _read_pymupdf(data: bytes) -> list[Page]:
    """
    The same pages, read by the opt-in backend.

    Note what is NOT here: a `height - y` flip. PyMuPDF already measures y
    downward from the top of the page, so its rectangles are usable as they
    stand. The pypdfium2 path needs the flip and this one does not, which is
    precisely the asymmetry flagged in the module docstring.
    """
    doc = _mupdf.open(stream=data, filetype="pdf")

    pages: list[Page] = []
    for number, raw_page in enumerate(doc, start=1):
        rect = raw_page.rect

        images: list[Image] = []
        for entry in raw_page.get_images(full=True):
            xref, _smask, px_width, px_height = entry[0], entry[1], entry[2], entry[3]
            # An image can be placed more than once on a page. Emit one per
            # placement, so this agrees with the other backend — which walks
            # page objects and therefore sees each placement separately.
            for placed in raw_page.get_image_rects(xref):
                images.append(
                    Image(
                        index=len(images),
                        rect=Rect(placed.x0, placed.y0, placed.x1, placed.y1),
                        _obj=_MuPdfImage(doc, xref, px_width, px_height),
                    )
                )

        pages.append(
            Page(
                number=number,
                width=rect.width,
                height=rect.height,
                _images=images,
                _blocks=_blocks_of_mupdf(raw_page),
            )
        )

    return pages


def _blocks_of_mupdf(page) -> list[tuple]:
    """
    Text blocks as (Rect, text, max point size).

    PyMuPDF groups words into blocks internally, which is the grouping
    `_blocks_of` has to reconstruct by proximity for pdfminer. The two will not
    always agree on where a block ends — that is a real difference between the
    readers, not a defect in either, and it is one of the things worth being
    able to compare when a deck reads badly.
    """
    try:
        raw = page.get_text("dict")
    except Exception:
        return []

    out: list[tuple] = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:  # 0 is text; 1 is an image block
            continue

        parts: list[str] = []
        size = 0.0
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                parts.append(span.get("text", ""))
                size = max(size, float(span.get("size") or 0.0))

        text = re.sub(r"\s+", " ", " ".join(parts)).strip()
        if not text:
            continue

        x0, y0, x1, y1 = block["bbox"]
        out.append((Rect(x0, y0, x1, y1), text, size))

    return out


def open_document(data: bytes) -> Document:
    return Document(data)
