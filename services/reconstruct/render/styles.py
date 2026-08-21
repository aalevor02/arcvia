"""
Engine, Expert and Style — as configuration, not as prompt text.

── The same five controls, inverted ─────────────────────────────────────────
The competitor's Studio offers Engine, Expert, Style, Camera Angle and Seed.
Every one of them is a string appended to a diffusion prompt, because there is
nothing underneath for them to configure.

Here each one sets something real:

  ENGINE   sample count and resolution. A "fast" engine is fewer samples of the
           same scene, not a different model.
  EXPERT   which cameras get solved and what is in frame. Interior solves a
           camera per room; Masterplan looks straight down at the site.
  STYLE    shading and line work. A CAD style is Freestyle line art over flat
           fill; Photoreal is full Cycles. Same geometry, different shader.
  CAMERA   moves an actual camera. See render/cameras.py.
  SEED     affects the optional diffusion finish and NOTHING else. Geometry is
           deterministic: the same model renders identically every time.

That last line is the product claim, and it is the one a generated image cannot
make. It is worth putting in the interface verbatim.

── Where diffusion is still allowed ─────────────────────────────────────────
As a *finish* over a true render, conditioned on depth, normal and object-mask
passes that came out of the actual geometry — a filter with a geometric prior.
Never the source of truth. The distinction is not pedantry: a finish cannot
invent a window that is not there, and a generator has nothing stopping it.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Engine:
    id: str
    label: str
    samples: int
    width: int
    height: int
    denoise: bool
    note: str


#: Cycles sample counts. The difference between these is time, not quality of
#: understanding — both render the same building.
ENGINES = {
    "fast": Engine("fast", "Fast", 32, 1280, 720, True,
                   "Draft. Seconds per frame on CPU."),
    "standard": Engine("standard", "Standard", 128, 1920, 1080, True,
                       "The default. Minutes per frame on CPU."),
    "ultra": Engine("ultra", "Ultra", 512, 2560, 1440, True,
                    "2K, deep sampling. Budget an hour per frame without a GPU."),
}


@dataclass(frozen=True)
class Expert:
    id: str
    label: str
    views: tuple[str, ...]
    note: str


#: Which cameras a job solves. This is the honest version of an "expert": not a
#: different model, a different set of viewpoints over the same building.
EXPERTS = {
    "interior": Expert("interior", "Interior", ("interior",),
                       "One camera per room, placed where there is most space."),
    "exterior": Expert("exterior", "Exterior", ("exterior",),
                       "Orbit of the building envelope."),
    "plan": Expert("plan", "Plan", ("plan",),
                   "Orthographic, cut at 1.2 m."),
    "isometric": Expert("isometric", "Isometric", ("isometric",),
                        "The cutaway 3D floor plan — rendered, not generated."),
    "walkthrough": Expert("walkthrough", "Walkthrough",
                          ("interior", "exterior", "isometric", "plan"),
                          "Everything the model supports."),
}


@dataclass(frozen=True)
class Style:
    id: str
    label: str
    engine: str          # Blender render engine
    freestyle: bool
    world: str
    materials: str
    note: str


#: Shading. Every one of these renders the SAME camera of the SAME model, which
#: is what makes them comparable — and byte-stable between runs, because none of
#: them samples anything but light.
STYLES = {
    "photoreal": Style("photoreal", "Photoreal", "CYCLES", False, "hdri", "pbr",
                       "Full path tracing, image-based lighting."),
    "cgi": Style("cgi", "CGI", "CYCLES", False, "studio", "pbr",
                 "Studio lighting, Standard view transform — clean rather than filmic."),
    "clay": Style("clay", "Model", "CYCLES", False, "studio", "clay",
                  "Untextured white clay with ambient occlusion. Reads the massing."),
    "cad": Style("cad", "CAD", "CYCLES", True, "flat", "flat",
                 "Freestyle line art over flat fill. A drawing, not a photograph."),
    "sketch": Style("sketch", "Freehand Sketch", "CYCLES", True, "flat", "paper",
                    "Line art with a jitter modifier and a paper ground."),
    "raw": Style("raw", "RAW", "CYCLES", False, "flat", "emission",
                 "Flat emission by object. The diagnostic view — no lighting at all."),
}

#: Styles whose whole point is the line work. Freestyle needs geometry to trace,
#: which is exactly what a generated image has none of.
LINE_STYLES = {k for k, v in STYLES.items() if v.freestyle}


def resolve(engine: str = "standard", expert: str = "walkthrough",
            style: str = "photoreal", seed: int | None = None) -> dict:
    """
    Turn the five controls into a render configuration.

    `seed` is carried through but deliberately does not touch geometry or
    lighting. It reaches exactly one place: the optional diffusion finish. A
    caller that passes a seed and expects the walls to move has misunderstood
    what this is, and the returned `determinism` note says so.
    """
    e = ENGINES.get(engine) or ENGINES["standard"]
    x = EXPERTS.get(expert) or EXPERTS["walkthrough"]
    s = STYLES.get(style) or STYLES["photoreal"]

    return {
        "engine": {
            "id": e.id, "label": e.label, "samples": e.samples,
            "width": e.width, "height": e.height, "denoise": e.denoise,
        },
        "expert": {"id": x.id, "label": x.label, "views": list(x.views)},
        "style": {
            "id": s.id, "label": s.label, "renderEngine": s.engine,
            "freestyle": s.freestyle, "world": s.world, "materials": s.materials,
        },
        "seed": seed,
        "determinism": (
            "Geometry is deterministic. The seed affects only the optional "
            "diffusion finish; every view is a projection of the same model."
        ),
    }


def catalogue() -> dict:
    """The whole surface, for a UI to render."""
    return {
        "engines": [
            {"id": e.id, "label": e.label, "samples": e.samples,
             "resolution": f"{e.width}x{e.height}", "note": e.note}
            for e in ENGINES.values()
        ],
        "experts": [
            {"id": x.id, "label": x.label, "views": list(x.views), "note": x.note}
            for x in EXPERTS.values()
        ],
        "styles": [
            {"id": s.id, "label": s.label, "lineArt": s.freestyle, "note": s.note}
            for s in STYLES.values()
        ],
    }
