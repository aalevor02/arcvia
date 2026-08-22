"""
The orthographic plan, drawn as a drawing.

── Why SVG and not a render ─────────────────────────────────────────────────
A plan is not a photograph of a building from above. It is a *convention*: a
horizontal section at about 1.2 m, with everything the plane cuts filled solid —
the poché — and everything below it drawn in line. Rendering that in Cycles
means fighting the renderer to suppress shading it exists to produce, and the
result is still a picture of a model rather than a drawing.

Vector output also costs nothing, needs no Blender, and is the format an
architect actually wants: it scales, it prints, and it can be opened in CAD.

── What the poché is doing ──────────────────────────────────────────────────
Filling the cut solid is what makes a plan readable at a glance — the eye reads
enclosure from the black, not from the outlines. It is also the reason this
engine is called what it is: reading the poché and giving it height is the whole
job, and this draws the poché back out to show its work.
"""

from __future__ import annotations

import math
from pathlib import Path
from xml.sax.saxutils import escape

#: Millimetres of paper per metre of building, before fitting. Only the ratio
#: matters — the viewBox does the real work.
PX_PER_M = 40.0

MARGIN = 48.0

#: The identity, matched to the rest of the product.
INK = "#1B1E24"        # poché — the cut fill
ROOM = "#E9EBEE"       # floor tint
ROOM_ALT = "#DFE3E7"
RULE = "#9CA3AB"
REDLINE = "#B33E28"
LABEL = "#2B2F36"
SHEET = "#F7F8F9"


def _door_arc(cx, cy, dx, dy, width, flip=1):
    """A quarter-circle swing, drawn from the hinge."""
    hx, hy = cx - dx * width / 2, cy - dy * width / 2
    # Perpendicular, into the room.
    px, py = -dy * width * flip, dx * width * flip
    return (
        f"M {hx:.2f} {hy:.2f} L {hx + dx * width:.2f} {hy + dy * width:.2f} "
        f"M {hx + dx * width:.2f} {hy + dy * width:.2f} "
        f"A {width:.2f} {width:.2f} 0 0 {1 if flip > 0 else 0} "
        f"{hx + px:.2f} {hy + py:.2f}"
    )


def render_plan(model: dict, out_path: str | Path, title: str | None = None) -> dict:
    """
    Draw the building model as an architectural plan.

    Takes the `building.json` the engine writes, so it needs nothing else — no
    Blender, no GPU, no scene. Returns a small manifest for assertions.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    walls = model["elements"]["walls"]
    spaces = model["elements"].get("spaces", [])
    openings = model["elements"].get("openings", [])
    # A plan is one floor. `elements.fixtures` covers every storey in the
    # building while `walls` and `spaces` above are the primary one, so drawing
    # the list unfiltered would lay the lower ground floor's beds over the
    # ground floor's rooms — on the villa, 30 fixtures on a plan that holds 12.
    # `storeys.primary` says which floor the walls belong to; a single-storey
    # model has no such key and every fixture defaults into the drawing.
    primary = (model.get("storeys") or {}).get("primary", 0)
    fixtures = [
        f for f in model["elements"].get("fixtures", [])
        if f.get("label") == "fixture" and f.get("storey", primary) == primary
    ]

    # Bounds must cover everything DRAWN, not just the walls. Sizing the frame
    # from walls alone is right for a well-formed model and wrong the moment a
    # room polygon or a fixture reaches past them — and then the geometry is
    # simply outside the viewBox, silently, with no error and no clipping.
    xs = [c for w in walls for c in (w["a"]["x"], w["b"]["x"])]
    ys = [c for w in walls for c in (w["a"]["y"], w["b"]["y"])]
    for space in spaces:
        xs.extend(p[0] for p in space["loop"])
        ys.extend(p[1] for p in space["loop"])
    for f in fixtures:
        reach = max(f.get("footprint", {}).get("w", 0),
                    f.get("footprint", {}).get("d", 0)) / 2
        xs.extend((f["position"]["x"] - reach, f["position"]["x"] + reach))
        ys.extend((f["position"]["y"] - reach, f["position"]["y"] + reach))

    if not xs:
        raise ValueError("The model has nothing to draw.")

    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    width_m, height_m = x1 - x0, y1 - y0

    W = width_m * PX_PER_M + MARGIN * 2
    H = height_m * PX_PER_M + MARGIN * 2 + 56   # room for the title block

    def sx(x):
        return MARGIN + (x - x0) * PX_PER_M

    def sy(y):
        # Plan Y runs up the page; SVG Y runs down. Flipped once, here.
        return MARGIN + (y1 - y) * PX_PER_M

    parts: list[str] = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
        f'viewBox="0 0 {W:.0f} {H:.0f}" font-family="IBM Plex Sans, Segoe UI, sans-serif">'
    )
    parts.append(f'<rect width="{W:.0f}" height="{H:.0f}" fill="{SHEET}"/>')

    # ---- Rooms, under the walls ------------------------------------------
    parts.append('<g id="rooms">')
    for i, space in enumerate(spaces):
        pts = " ".join(f"{sx(px):.2f},{sy(py):.2f}" for px, py in space["loop"])
        fill = ROOM if i % 2 == 0 else ROOM_ALT
        parts.append(f'<polygon points="{pts}" fill="{fill}" stroke="none"/>')
    parts.append("</g>")

    # ---- Openings: gaps punched out of the poché --------------------------
    # Drawn as sheet-coloured bands over the wall fill. That is exactly what an
    # opening is on a plan — an absence — and painting it is far more robust
    # than trying to subtract it from a stroked path.
    gaps: list[str] = []
    swings: list[str] = []
    for op in openings:
        if op["wall"] >= len(walls):
            continue
        w = walls[op["wall"]]
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        length = math.hypot(bx - ax, by - ay) or 1.0
        dx, dy = (bx - ax) / length, (by - ay) / length
        t = op["along"]
        cx, cy = ax + dx * t, ay + dy * t
        thickness = w["thickness"] + 0.06
        nx, ny = -dy * thickness / 2, dx * thickness / 2
        half = op["width"] / 2

        corners = [
            (cx - dx * half + nx, cy - dy * half + ny),
            (cx + dx * half + nx, cy + dy * half + ny),
            (cx + dx * half - nx, cy + dy * half - ny),
            (cx - dx * half - nx, cy - dy * half - ny),
        ]
        pts = " ".join(f"{sx(px):.2f},{sy(py):.2f}" for px, py in corners)
        gaps.append(f'<polygon points="{pts}" fill="{SHEET}"/>')

        if op["kind"] == "door":
            path = _door_arc(sx(cx), sy(cy), dx, -dy, op["width"] * PX_PER_M)
            swings.append(
                f'<path d="{path}" fill="none" stroke="{RULE}" stroke-width="0.9"/>'
            )
        else:
            # A window is drawn as a thin line through the reveal.
            swings.append(
                f'<line x1="{sx(cx - dx * half):.2f}" y1="{sy(cy - dy * half):.2f}" '
                f'x2="{sx(cx + dx * half):.2f}" y2="{sy(cy + dy * half):.2f}" '
                f'stroke="{RULE}" stroke-width="1.2"/>'
            )

    # ---- The poché --------------------------------------------------------
    parts.append('<g id="poche">')
    drawn = 0
    for w in walls:
        if not w["paired"]:
            continue
        ax, ay = w["a"]["x"], w["a"]["y"]
        bx, by = w["b"]["x"], w["b"]["y"]
        length = math.hypot(bx - ax, by - ay)
        if length < 1e-6:
            continue
        dx, dy = (bx - ax) / length, (by - ay) / length
        nx, ny = -dy * w["thickness"] / 2, dx * w["thickness"] / 2
        corners = [
            (ax + nx, ay + ny), (bx + nx, by + ny),
            (bx - nx, by - ny), (ax - nx, ay - ny),
        ]
        pts = " ".join(f"{sx(px):.2f},{sy(py):.2f}" for px, py in corners)
        parts.append(f'<polygon points="{pts}" fill="{INK}" stroke="none"/>')
        drawn += 1
    parts.append("</g>")

    parts.append(f'<g id="openings">{"".join(gaps)}</g>')
    parts.append(f'<g id="swings">{"".join(swings)}</g>')

    # ---- Fixtures, as footprints ------------------------------------------
    parts.append('<g id="fixtures" opacity="0.62">')
    for f in fixtures:
        fw = f.get("footprint", {}).get("w", 0)
        fd = f.get("footprint", {}).get("d", 0)
        if not fw or not fd:
            continue
        px, py = f["position"]["x"], f["position"]["y"]
        rot = f.get("rotation", 0.0) or 0.0
        c, s = math.cos(rot), math.sin(rot)
        corners = []
        for ox, oy in ((-fw / 2, -fd / 2), (fw / 2, -fd / 2), (fw / 2, fd / 2), (-fw / 2, fd / 2)):
            corners.append((px + ox * c - oy * s, py + ox * s + oy * c))
        pts = " ".join(f"{sx(qx):.2f},{sy(qy):.2f}" for qx, qy in corners)
        parts.append(f'<polygon points="{pts}" fill="none" stroke="{RULE}" stroke-width="0.8"/>')
    parts.append("</g>")

    # ---- Room names and areas ---------------------------------------------
    parts.append('<g id="labels" text-anchor="middle">')
    named = 0
    for space in spaces:
        if space["area"] < 2.0:
            continue
        pxs = [p[0] for p in space["loop"]]
        pys = [p[1] for p in space["loop"]]
        cx, cy = sum(pxs) / len(pxs), sum(pys) / len(pys)
        name = space.get("name")
        if name:
            named += 1
            parts.append(
                f'<text x="{sx(cx):.1f}" y="{sy(cy):.1f}" font-size="10" '
                f'font-weight="600" fill="{LABEL}" letter-spacing="0.4">'
                f"{escape(name.upper()[:22])}</text>"
            )
        parts.append(
            f'<text x="{sx(cx):.1f}" y="{sy(cy) + (12 if name else 4):.1f}" '
            f'font-size="8.5" fill="{LABEL}" opacity="0.68" '
            f'font-family="IBM Plex Mono, monospace">'
            f'{space["area"]:.2f} m²</text>'
        )
    parts.append("</g>")

    # ---- Scale bar, with architectural ticks ------------------------------
    bar_m = max(1.0, round(width_m / 6))
    bx0 = MARGIN
    by = H - 30
    parts.append(
        f'<g id="scale" stroke="{REDLINE}" stroke-width="1.3">'
        f'<line x1="{bx0:.1f}" y1="{by:.1f}" x2="{bx0 + bar_m * PX_PER_M:.1f}" y2="{by:.1f}"/>'
        f'<line x1="{bx0:.1f}" y1="{by - 5:.1f}" x2="{bx0:.1f}" y2="{by + 5:.1f}"/>'
        f'<line x1="{bx0 + bar_m * PX_PER_M:.1f}" y1="{by - 5:.1f}" '
        f'x2="{bx0 + bar_m * PX_PER_M:.1f}" y2="{by + 5:.1f}"/></g>'
        f'<text x="{bx0:.1f}" y="{by + 18:.1f}" font-size="9" fill="{LABEL}" '
        f'font-family="IBM Plex Mono, monospace">{bar_m:.0f} m</text>'
    )

    # ---- Title block -------------------------------------------------------
    heading = title or Path(model.get("source", "plan")).stem
    total = sum(s["area"] for s in spaces)
    parts.append(
        f'<text x="{W - MARGIN:.1f}" y="{by:.1f}" text-anchor="end" font-size="11" '
        f'font-weight="600" fill="{LABEL}">{escape(heading[:44])}</text>'
        f'<text x="{W - MARGIN:.1f}" y="{by + 16:.1f}" text-anchor="end" font-size="8.5" '
        f'fill="{LABEL}" opacity="0.7" font-family="IBM Plex Mono, monospace">'
        f'{len(spaces)} rooms · {total:.1f} m² · {drawn} walls · '
        f'{len(openings)} openings</text>'
    )

    parts.append("</svg>")
    out_path.write_text("".join(parts), encoding="utf-8")

    return {
        "path": str(out_path),
        "bytes": out_path.stat().st_size,
        "walls": drawn,
        "rooms": len(spaces),
        "named": named,
        "openings": len(openings),
        "fixtures": len(fixtures),
        "extent": [round(width_m, 2), round(height_m, 2)],
    }
