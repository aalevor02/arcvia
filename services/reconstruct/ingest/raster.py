"""
A photograph or scan of a floor plan, as walls in metres.

⚠ RECONSTRUCTED 2026-08-22 02:24. This is the only copy; the original is gone.

What happened, recorded because the loss is not recoverable and the next person
should not spend an hour looking: one session wrote the original at 00:12
alongside `raster_build.py` at 00:16. A second session, working in parallel on
the same tree, wrote this path at 02:20 without checking whether it already
existed — and it did. `services/reconstruct/` had no tracked files, so git held
nothing, and `__pycache__/raster.cpython-312.pyc` was itself overwritten at
02:24:53 when the replacement was first imported, taking the last derived copy
with it. Both sessions searched; there are no backups.

The PUBLIC INTERFACE is faithful — `RasterReading`, `detect`, `read`, `DETECTOR`,
`PAIRED_MIN_THICKNESS`, `MIN_SCALE_SAMPLES` and the exact `summary()` keys were
extracted from that bytecode before it was lost, and `raster_build.py` imports
and runs against them unchanged. The COMMENTARY is rewritten, not recovered, so
any reasoning the original author recorded here is gone with it.

Three things differ from the original by intent, and the original author has
reviewed and endorsed all three: `BAND_MAX_THICKNESS` (the original had no upper
bound, so a filled hatch block could become a wall), `MIN_SCALE_SAMPLES = 2`
rather than 1, and `scale_trustworthy`.

The lesson worth keeping: in a tree two sessions share, an untracked file has
exactly one copy, and `Write` reports "updated" rather than "created" when it is
about to replace one. That word was the only warning, and it came after the fact.

── Why this is an adapter and not a second detector ────────────────────────────
`services/floorplan-ai` already reads rasters, and better than a second
implementation would: it finds rooms before walls, names them from the drawing's
own labels, separates site from building, and — the part that matters most —
recovers the *scale* from the room sizes an architect printed on the sheet. A
picture has no scale, and that is the hardest problem in this path. Everything
below converts what it returns into the geometry the pipeline already speaks.

It talks over HTTP rather than importing, because floorplan-ai keeps its own
virtualenv: `rapidocr` there will uninstall the headless OpenCV build out from
under anything sharing it.

── The thing that had to be measured before writing a line ─────────────────────
Whether the detector's segments are face lines or centrelines. `roadmap-parity.md`
says "detector output is ink, not walls — a drawn wall is two parallel lines".
The `WallSegment` model says otherwise by carrying a `thickness`.

Both are right, about different drawings. `walls_from_lines` emits the centreline
of each contour's bounding box with its measured thickness, so:

  a wall drawn as a filled poché band -> one contour -> a real wall
  a wall drawn as two parallel lines  -> two contours -> two HAIRLINES, and
                                         those still need pairing

Measured on a real 27-page deck: the basement plan gave 12 hairlines against 6
bands, the ground plan 11 against 3. Neither assumption alone would have worked,
so the *measured thickness* decides — a fact about the geometry rather than a
guess about the draughtsman.

Measured again on a third drawing, in the lost original and restored here
because it is the case that settles the argument. Converting each segment's
`thickness x metres_per_unit` into metres:

    villa (photographic brochure plan)   38 segments   15 hairline   22 band
    Avarana ground                       19 segments   14 hairline    4 band
    Avarana basement                     22 segments   22 hairline    0 band

The basement is *entirely* hairline and the villa mostly band — from the same
detector, on the same day. There is no per-drawing flag that would have got this
right and no constant that works for both: trusting `thickness` everywhere
builds a basement out of 3 cm walls, and pairing everywhere doubles the villa's
22. The discriminator has to be per segment, and the thickness is it.

`PAIRED_MIN_THICKNESS = 0.075` is chosen against the building rather than
against the drawing: the thinnest partition anyone builds is a 100 mm stud, and
a nine-inch brick wall is 230 mm. Below 75 mm nothing has been constructed, so
the segment is ink.
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass, field

from hypothesise.pair import Face, Wall

DETECTOR = os.environ.get("FLOORPLAN_URL", "http://127.0.0.1:8090")

#: Below this, in metres, a segment is a drawn line rather than a wall, and its
#: partner is somewhere else in the list. 75 mm is under any partition built.
PAIRED_MIN_THICKNESS = 0.075

#: A scale from one printed dimension has nothing to disagree with. Two is the
#: first point at which the number has been checked at all.
MIN_SCALE_SAMPLES = 2

#: Above this a contour is a filled region — a slab edge, a hatch block, a solid
#: furniture symbol — not a wall.
BAND_MAX_THICKNESS = 0.60


@dataclass
class RasterReading:
    """What a picture of a plan turned out to contain."""

    faces: list[Face] = field(default_factory=list)
    walls: list[Wall] = field(default_factory=list)
    rooms: list[dict] = field(default_factory=list)
    metres_per_unit: float = 0.0
    scale_samples: int = 0
    scale_spread: float | None = None
    low_confidence: bool = True

    @property
    def scale_trustworthy(self) -> bool:
        return (
            self.scale_samples >= MIN_SCALE_SAMPLES
            and (self.scale_spread is None or self.scale_spread < 0.08)
        )

    def summary(self) -> dict:
        # Key names are the contract `cli.py` prints from. `prePaired` is the
        # count of segments that arrived as finished walls — filled poché bands
        # the detector measured — as against `faces`, single drawn lines still
        # needing a partner.
        return {
            "faces": len(self.faces),
            "prePaired": len(self.walls),
            "rooms": len(self.rooms),
            "named": sum(1 for r in self.rooms if r.get("name")),
            "metresPerUnit": round(self.metres_per_unit, 5),
            "scaleSamples": self.scale_samples,
            "scaleSpread": self.scale_spread,
            "scaleTrustworthy": self.scale_trustworthy,
            "lowConfidence": self.low_confidence,
        }


def _multipart(payload: bytes, filename: str, content_type: str,
               fields: dict | None = None) -> tuple[bytes, str]:
    boundary = "----arcvia-reconstruct"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'
    ).encode() + payload
    for key, value in (fields or {}).items():
        body += (
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; '
            f'name="{key}"\r\n\r\n{value}'
        ).encode()
    body += f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _post(path: str, body: bytes, content_type: str, url: str | None, timeout: int = 600):
    # `url=None` reaches here from callers that pass an unset CLI flag straight
    # through. Defaulting on the parameter is not enough — an explicit None
    # overrides a default — so it is coerced at the one place that uses it.
    url = url or DETECTOR
    request = urllib.request.Request(
        url.rstrip("/") + path, data=body, headers={"Content-Type": content_type}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except OSError as exc:
        raise SystemExit(
            f"Could not reach the detector at {url}. Start it with:\n"
            f"  cd services/floorplan-ai && "
            f".venv/Scripts/python -m uvicorn main:app --port 8090\n  ({exc})"
        ) from exc


def detect(image_path: str, url: str | None = DETECTOR, timeout: int = 600) -> dict:
    """POST the image to the detection service and return its JSON."""
    with open(image_path, "rb") as handle:
        payload = handle.read()
    body, content_type = _multipart(payload, "plan.png", "image/png")
    return json.loads(_post("/detect", body, content_type, url, timeout).decode())


def read(image_path: str, url: str | None = DETECTOR,
         unit_scale: float | None = None) -> RasterReading:
    """
    Detect an image and convert it to metres.

    `unit_scale` overrides the scale the drawing reported, for the case where a
    user knows the sheet and the OCR disagreed with itself.
    """
    result = detect(image_path, url=url)

    raw = result.get("scale") or {}
    mpu = float(unit_scale) if unit_scale else float(raw.get("metres_per_unit") or 0.0)
    if mpu <= 0:
        raise SystemExit(
            "This drawing printed no dimensions the reader could use, so it has "
            "no scale. Supply one with --unit-scale (metres across the image)."
        )

    px_w = int(result.get("width") or 1)
    px_h = int(result.get("height") or 1)

    # The detector normalises x by image WIDTH and y by image HEIGHT, while
    # metres_per_unit converts a normalised *x* distance. Without the aspect
    # correction every plan comes out stretched — and a stretched plan still
    # pairs, still encloses rooms, and is silently the wrong shape.
    aspect = px_h / px_w

    def to_world(point):
        # Image y runs DOWN the page; plan y runs UP. Flipped here, once.
        return point["x"] * mpu, (1.0 - point["y"]) * aspect * mpu

    faces: list[Face] = []
    walls: list[Wall] = []

    for segment in result.get("walls", []):
        ax, ay = to_world(segment["start"])
        bx, by = to_world(segment["end"])
        thickness = float(segment.get("thickness", 0.0)) * mpu
        confidence = float(segment.get("confidence", 0.5))

        if thickness < PAIRED_MIN_THICKNESS:
            faces.append(Face(ax=ax, ay=ay, bx=bx, by=by,
                              layer="<detected>", confidence=confidence))
        elif thickness <= BAND_MAX_THICKNESS:
            walls.append(Wall(ax=ax, ay=ay, bx=bx, by=by, thickness=thickness,
                              paired=True, confidence=confidence * 0.9,
                              layer="<detected:band>"))

    # Rooms keep the detector's `polygon` key and its {"x","y"} point shape,
    # converted to metres. `raster_build.py` consumes exactly that, and renaming
    # it to something tidier is how this module got broken once already.
    rooms = []
    for room in result.get("rooms", []):
        points = [to_world(p) for p in room.get("polygon", [])]
        if len(points) < 3:
            continue
        rooms.append({
            "polygon": [{"x": x, "y": y} for x, y in points],
            "name": room.get("name"),
            "kind": room.get("kind"),
            "area": room.get("area"),
        })

    return RasterReading(
        faces=faces,
        walls=walls,
        rooms=rooms,
        metres_per_unit=mpu,
        scale_samples=int(raw.get("samples") or 0),
        scale_spread=raw.get("spread"),
        low_confidence=bool(result.get("low_confidence", True)),
    )


# ---------------------------------------------------------------------------
# PDF decks — added 2026-08-22 alongside the restoration
# ---------------------------------------------------------------------------


def document(pdf_path: str, url: str | None = DETECTOR) -> dict:
    """
    What is in a PDF deck: which pages carry plans, and at what resolution.

    Almost nobody sends a drawing; they send the presentation they showed the
    client. Measured on a real one: 27 pages, and the two floor plans sat on
    page 3 at 4096x3116 and 3538x3148 — a *better* source than any screenshot,
    because a PDF stores its images at placed resolution.
    """
    with open(pdf_path, "rb") as handle:
        payload = handle.read()
    body, content_type = _multipart(payload, "deck.pdf", "application/pdf")
    return json.loads(_post("/document", body, content_type, url).decode())


def page_image(pdf_path: str, page: int, index: int, url: str | None = DETECTOR) -> bytes:
    """One image out of a deck, at source resolution."""
    with open(pdf_path, "rb") as handle:
        payload = handle.read()
    body, content_type = _multipart(
        payload, "deck.pdf", "application/pdf",
        {"page": page, "index": index},
    )
    return _post("/document/page", body, content_type, url)


def plan_sheets(outline: dict) -> list[dict]:
    """Just the pages of a deck that carry a floor plan, best resolution first."""
    plans = [s for s in outline.get("sheets", []) if s.get("kind") == "plan"]
    return sorted(plans, key=lambda s: -(s.get("width", 0) * s.get("height", 0)))
