"""
Read the DESIGN out of a deck render: materials, colours, furnishing.

── Why this exists ──────────────────────────────────────────────────────────
A client deck's renders are the design contract: the architect already chose
the floor, the wall colour, the furniture. The reconstruction pipeline reads
the PLAN sheets and rebuilds the geometry — and then dresses it in defaults,
because nothing read the renders. This module is the reading half: one render
image in, one structured DesignSpec out. The studio matches the spec against
the asset hub and the surface catalogue; nothing here knows about assets.

── The palette constrains the model ─────────────────────────────────────────
deck.py already measures each render's dominant colours (k-means, hex). A
vision model asked for "the wall colour" invents plausible hexes; asked to
ASSIGN measured colours to surfaces, it can only choose among colours that
are actually in the image. The measured palette is ground truth; the model
contributes the mapping, which is the part pixels alone cannot answer.

Reuses adjudicate.py's client wholesale — same endpoint, same key, same
fail-open contract: no key or no answer yields None, and the caller says
"the design reader is not configured" rather than inventing beige.
"""

from __future__ import annotations

import numpy as np

import adjudicate

#: Kinds the studio can actually act on, spelled out in the prompt so the
#: model does not free-associate ("engineered oak herringbone") past what the
#: matcher downstream can use. "other" is an honest answer, not a failure.
_FLOOR_KINDS = "wood, tile, marble, stone, carpet, concrete, paving, grass, other"
_WALL_KINDS = "paint, wallpaper, panelling, exposed-brick, stone, tile, other"
_CEILING_KINDS = "flat, false-ceiling, wood, exposed, other"

#: The interior-style taxonomy, taken from the industry vocabulary the
#: competitor's own tooling exposes (docs/reference-mnml.md §6 — their 33
#: styles with prompt fragments). One overall style per render gives the
#: matcher a search axis ("japandi sideboard") and any later restyle pass its
#: prompt seed. Constrained to a list so specs cluster instead of every
#: render inventing its own adjective.
_STYLES = ("modern, neoclassic, minimalist, boho-chic, art-deco, biophilic, "
           "industrial, japandi, luxurious, art-nouveau, warm-cozy, "
           "contemporary, eclectic, wabi-sabi, zen, coastal, mediterranean, "
           "shabby-chic, bauhaus, futuristic, rustic, midcentury-modern, "
           "maximalist, vintage, tropical, other")

def _prompt(palette: list[str], room_hint: str | None) -> str:
    """Built by concatenation, never str.format — the body is full of literal
    JSON braces, and a format pass over resolved f-string braces raised
    KeyError '"material"' the first time this ran. One brace discipline."""
    pal = ", ".join(palette) if palette else "unmeasured"
    text = (
        "This is an interior or exterior RENDER from an architect's "
        "presentation deck. Read the finishes and furnishing the designer "
        "chose. The measured dominant colours of this image are: " + pal +
        ". Wherever one of those measured colours is the true colour of a "
        "surface, use it VERBATIM; invent a hex only for something small the "
        "palette missed.\n"
        "Classify the floor from visible construction cues, not from colour: "
        "carpet is continuous soft pile without board joints; wood requires "
        "visible plank seams or grain; tile/stone requires hard slab or grout "
        "joints. If those cues are not visible, use other rather than guessing.\n"
        "Answer ONLY a JSON object:\n"
        "{\n"
        '  "room": "what room this shows, lowercase, e.g. bedroom",\n'
        f'  "floor": {{"material": "one of: {_FLOOR_KINDS}", "colour": "#hex",\n'
        '            "pattern": "plank|herringbone|large-tile|small-tile|plain|other"},\n'
        f'  "walls": {{"finish": "one of: {_WALL_KINDS}", "colour": "#hex",\n'
        '            "accent": "#hex of an accent wall, or null"},\n'
        f'  "ceiling": {{"kind": "one of: {_CEILING_KINDS}", "colour": "#hex"}},\n'
        '  "furniture": [{"item": "bed|sofa|wardrobe|table|chair|desk|rug|'
        'plant|tv-unit|painting|mirror|ceiling-light|pendant|wall-light|other", '
        '"colour": "#hex", "style": "a few words"}],\n'
        '  "lighting": "warm|neutral|cool",\n'
        f'  "style": "the overall interior style, one of: {_STYLES}",\n'
        '  "confidence": 0..1\n'
        "}\n"
        "List at most 8 visible items, including defining furniture and visible "
        "wall or ceiling decor. Use pendant only for a hanging ceiling lamp, "
        "wall-light only for a sconce, and ceiling-light only for a flush light. If "
        "this image is not actually a render of a space (a logo page, a map, "
        'text), answer {"room": null}.'
    )
    if room_hint:
        text += f'\nThe deck captions this render as: "{room_hint}".'
    return text


def available() -> bool:
    return adjudicate.available()


def read_design(image: np.ndarray, palette: list[str],
                room_hint: str | None = None) -> dict | None:
    """
    One render, one spec — or None when unconfigured/unanswered/not-a-render.

    `palette` is deck.py's measured hex list for this image; an empty list is
    tolerated (the constraint is weaker, the answer still structured).
    """
    if not available():
        return None

    # A full spec with eight furniture entries runs well past the verdict
    # budget; 300 tokens truncated the first real answer mid-walls.
    answer = adjudicate._ask(image, _prompt(palette, room_hint), max_tokens=1200)
    spec = adjudicate._json_object(answer) if answer else None
    if not spec or spec.get("room") is None:
        return None

    # A floor of shape {"material": ...} is the contract; a model that
    # flattened it to a string still said something usable. Normalise rather
    # than refuse — the studio's matcher checks fields defensively anyway.
    for key, wrap in (("floor", "material"), ("walls", "finish"), ("ceiling", "kind")):
        if isinstance(spec.get(key), str):
            spec[key] = {wrap: spec[key]}
    if not isinstance(spec.get("furniture"), list):
        spec["furniture"] = []
    spec["furniture"] = spec["furniture"][:8]
    spec["palette"] = list(palette)
    spec["model"] = adjudicate.name()
    return spec
