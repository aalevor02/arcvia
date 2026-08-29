"""
The deck branch of `reconstruct`.

── What actually arrives ───────────────────────────────────────────────────────
Almost nobody sends a drawing. They send the deck they showed the client — a
twenty-odd-page slide document where one page happens to carry the floor plans
as full-resolution images and the rest are renders, elevations and a mood board.
`raster` reconstructs one plan image; this finds the plan images inside the deck
first, so the user hands over the file they already have rather than being asked
to export a clean plan by hand.

── Two phases, so uncertainty is not billed twice ──────────────────────────────
A rendered plan carries its sizes as text an architect typed, and the detector
recovers the scale by reading them. On a furnished, open-plan render it often
reads too few to be sure, and building at a guess and rebuilding after the user
corrects it charges them twice for our doubt. So the work splits:

  * `survey` — extract every plan sheet and run the detector only. Cheap. Returns
    the sheets with a preview image each, the sizes the detector read, and, for
    every confirmable room, the drawn span its printed size sits across — so a
    caller can ask the user to confirm one dimension and compute the scale from
    it without building anything.

  * `build` — one chosen sheet, once, with the scale settled. The expensive step
    runs a single time, on a number the user stood behind.

── The scale arithmetic a caller needs ─────────────────────────────────────────
The engine's scale is `metres across the image width` (`unit_scale`). A room's
printed long side of `D` metres drawn across a fraction `f` of that width fixes
it: `unit_scale = D / f`. `f` is `drawnSpanFraction`, reported per confirmable
room below; `D` is what the user confirms. `suggestedScale` is the detector's own
best guess, offered as the default so confirming is a nudge, not data entry.
"""

from __future__ import annotations

import json
from pathlib import Path

from ingest import raster
from ingest.raster_build import reconstruct_raster

PLAN_KIND = "plan"

# A room worth offering as the scale anchor: named, sized, and NOT a merge of
# several spaces (`also` empty), and not the whole sheet. A small enclosed room
# — a toilet, a shower — has the region the detector traces most reliably, so a
# span measured across it is the steadiest number to hang the building on.
_RELIABLE_AREA_MAX = 0.15


def _slug(text: str) -> str:
    """A filename-safe stem from a caption or floor name."""
    slug = "".join(c.lower() if c.isalnum() else "-" for c in (text or "")).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "plan"


def outline(pdf_bytes: bytes, detector_url: str | None = None) -> list[dict]:
    """The deck's sheets, as the detector describes them."""
    body, content_type = raster._multipart(pdf_bytes, "deck.pdf", "application/pdf")
    raw = raster._post("/document", body, content_type, detector_url)
    return json.loads(raw.decode()).get("sheets", [])


def extract_page(
    pdf_bytes: bytes,
    page: int,
    index: int,
    detector_url: str | None = None,
    long_edge: int = 2400,
) -> bytes:
    """One image out of the deck, as PNG bytes."""
    # page / index / long_edge are QUERY parameters on the endpoint, not form
    # fields — FastAPI binds a scalar beside an UploadFile from the query string.
    # Sent as fields they are silently ignored, and every sheet comes back as
    # page 1 image 0. They go in the path instead.
    body, content_type = raster._multipart(pdf_bytes, "deck.pdf", "application/pdf")
    path = f"/document/page?page={page}&index={index}&long_edge={long_edge}"
    return raster._post(path, body, content_type, detector_url)


def _detect(png_bytes: bytes, detector_url: str | None = None) -> dict:
    """Run the detector on one plan image."""
    body, content_type = raster._multipart(png_bytes, "plan.png", "image/png")
    return json.loads(raster._post("/detect", body, content_type, detector_url).decode())


def _confirm_candidates(detection: dict) -> list[dict]:
    """
    The rooms a caller can offer for a scale confirmation, steadiest first.

    Each carries the drawn fraction of the image WIDTH its long side spans, so a
    confirmed real length turns straight into `unit_scale = metres / span`. The
    aspect factor is folded in here (image y is normalised by height, x by
    width), because a caller working in image fractions should not have to know
    the detector's normalisation to get an unstretched building.
    """
    px_w = int(detection.get("width") or 1)
    px_h = int(detection.get("height") or 1)
    aspect = px_h / px_w if px_w else 1.0

    out = []
    for room in detection.get("rooms", []):
        size = room.get("size")
        if not room.get("name") or not size:
            continue
        xs = [p["x"] for p in room["polygon"]]
        ys = [p["y"] for p in room["polygon"]]
        span_w = max(xs) - min(xs)                 # already a fraction of width
        span_h = (max(ys) - min(ys)) * aspect      # height fraction -> width units
        drawn_span = max(span_w, span_h)
        if drawn_span <= 0:
            continue
        reliable = (
            room.get("kind") == "room"
            and not room.get("also")
            and room.get("area", 1.0) <= _RELIABLE_AREA_MAX
        )
        out.append({
            "room": room["name"],
            "kind": room.get("kind", "room"),
            "sizeMetres": [round(size[0], 2), round(size[1], 2)],
            "longSideMetres": round(max(size), 2),
            "drawnSpanFraction": round(drawn_span, 4),
            "impliedScale": round(max(size) / drawn_span, 2),
            "reliableAnchor": reliable,
        })
    # Reliable anchors first, then largest, so a picker's default is a small
    # enclosed room's implied scale rather than a merged great-room's.
    out.sort(key=lambda c: (c["reliableAnchor"], -c["drawnSpanFraction"]), reverse=True)
    return out


def _suggested_scale(detection: dict, candidates: list[dict]) -> float | None:
    """
    The scale to pre-fill the confirmation with.

    The detector's own reading when it trusted it; otherwise the median implied
    scale of the reliable anchors, which is a better guess than a lone merged
    room the detector happened to vote on.
    """
    scale = detection.get("scale") or {}
    samples = scale.get("samples") or 0
    spread = scale.get("spread")
    trustworthy = samples >= 2 and (spread is None or spread < 0.08)
    if trustworthy and scale.get("metres_per_unit"):
        return round(float(scale["metres_per_unit"]), 2)

    anchors = [c["impliedScale"] for c in candidates if c["reliableAnchor"]]
    if anchors:
        anchors.sort()
        return round(anchors[len(anchors) // 2], 2)
    if scale.get("metres_per_unit"):
        return round(float(scale["metres_per_unit"]), 2)
    return None


def survey_deck(
    pdf_path: str,
    out_dir: str,
    detector_url: str | None = None,
    long_edge: int = 2400,
) -> dict:
    """Phase 1: what plans are in this deck, and what each says about its scale."""
    source = Path(pdf_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pdf_bytes = source.read_bytes()

    sheets = outline(pdf_bytes, detector_url=detector_url)
    plans = [s for s in sheets if s.get("kind") == PLAN_KIND]

    surveyed = []
    for ordinal, sheet in enumerate(plans):
        page, index = sheet["page"], sheet["index"]
        stem = _slug(sheet.get("floor") or sheet.get("caption") or f"sheet-{ordinal}")
        preview = out / f"{stem}.png"

        png = extract_page(pdf_bytes, page, index, detector_url, long_edge)
        preview.write_bytes(png)
        detection = _detect(png, detector_url)

        candidates = _confirm_candidates(detection)
        scale = detection.get("scale") or {}
        surveyed.append({
            "page": page,
            "index": index,
            "floor": sheet.get("floor"),
            "caption": sheet.get("caption"),
            "stem": stem,
            "preview": str(preview),
            "width": detection.get("width"),
            "height": detection.get("height"),
            "rooms": sum(1 for r in detection.get("rooms", []) if r.get("name")),
            "scale": {
                "metresPerUnit": scale.get("metres_per_unit"),
                "samples": scale.get("samples", 0),
                "spread": scale.get("spread"),
                "trustworthy": (scale.get("samples", 0) >= 2
                                and (scale.get("spread") is None
                                     or scale.get("spread") < 0.08)),
            },
            "suggestedScale": _suggested_scale(detection, candidates),
            "confirmDimensions": candidates,
        })

    return {
        "source": str(source),
        "phase": "survey",
        "pages": max((s.get("page", 0) for s in sheets), default=0),
        "plansFound": len(plans),
        "sheets": surveyed,
        "otherSheets": [
            {"page": s["page"], "kind": s.get("kind"), "caption": s.get("caption")}
            for s in sheets if s.get("kind") != PLAN_KIND
        ],
    }


def build_sheet(
    pdf_path: str,
    page: int,
    index: int,
    out_dir: str,
    height: float = 2.7,
    detector_url: str | None = None,
    unit_scale: float | None = None,
    with_perimeter: bool = True,
    long_edge: int = 2400,
    with_roof: bool = False,
    roof_style: str = "flat",
    roof_pitch_degrees: float | None = None,
) -> dict:
    """Phase 2: reconstruct one chosen plan sheet, at the settled scale."""
    source = Path(pdf_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pdf_bytes = source.read_bytes()

    # Name the sheet from what the deck called it, so the GLB is `basement.glb`
    # rather than `p3i0.glb` in the file the client is handed.
    sheets = outline(pdf_bytes, detector_url=detector_url)
    match = next((s for s in sheets if s["page"] == page and s["index"] == index), None)
    stem = _slug(
        (match or {}).get("floor") or (match or {}).get("caption") or f"p{page}i{index}"
    )
    image_path = out / f"{stem}.png"
    image_path.write_bytes(extract_page(pdf_bytes, page, index, detector_url, long_edge))

    model = reconstruct_raster(
        input_path=str(image_path),
        out_dir=str(out),
        height=height,
        detector_url=detector_url,
        unit_scale=unit_scale,
        with_perimeter=with_perimeter,
        with_roof=with_roof,
        roof_style=roof_style,
        roof_pitch_degrees=roof_pitch_degrees,
    )

    # A supplied scale IS the confirmation the warning asks for. reconstruct_raster
    # overrides the metres but leaves the detector's original sample count and its
    # "confirm this against a known length" note — which, once the user has stood
    # behind a number, tells them to do the thing they just did. Marked confirmed
    # and the note cleared, so the panel does not show a resolved doubt as open.
    if unit_scale is not None:
        model["scale"] = {
            **model["scale"],
            "metresPerUnit": round(float(unit_scale), 4),
            "confirmed": True,
            "trustworthy": True,
            "warning": None,
        }

    model["phase"] = "build"
    model["sheet"] = {"page": page, "index": index, "floor": (match or {}).get("floor"),
                      "caption": (match or {}).get("caption"), "stem": stem}
    return model
