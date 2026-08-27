"""
The trained detector, as a backend that refuses to guess.

`FLOORPLAN_BACKEND=segment` runs a semantic-segmentation checkpoint through
onnxruntime and uses it for WHAT a thing is. Walls still come from the
heuristic pass, for the reason `detect_yolo` already gives: line extraction is
solved in classical CV and a model adds nothing there. Measured 2026-08-27 by
the session training it -- against the owner's five annotated markups, the
model beat the classical pass on furniture-that-is-not-wall by 10-40x and was
NARROWER on a recessed balcony. It earns its place on symbols, not on lines.

── Why this refuses to load a model without a class map ─────────────────────
The export is `plan[n,3,h,w] -> heads[n,44,oh,ow]`, and 44 channels mean
nothing on their own. Nothing in a bare file says which one is Wall.

A consumer therefore hardcodes the layout from the training code, and when that
layout shifts -- a class added, rooms and icons reordered -- it keeps running
and reads the wrong channel. No exception. A railing silently becomes a door.
That failure has no detection surface, which makes it worse than the ones this
service is hardened against: those at least produced a wrong-looking number.

The v6 artefact is stamped, and the schema is three heads laid end to end:

    head_layout    {"junctions": [0,21], "rooms": [21,33], "icons": [33,44]}
    classes.rooms  ["Background","Outdoor","Wall",...,"Railing",...]  (12)
    classes.icons  ["No Icon","Window","Door",...]                    (11)

**The named indices are RELATIVE to their head.** `railing_class_index: 8` is 8
within `rooms`, which is absolute channel **29**; channel 8 is `junctions[8]`.
A consumer reading the index as a tensor channel is off by 21 on every symbol
and produces a confident, entirely wrong answer. Resolving that is most of what
this loader is for.

Two checks earn their place because neither failure is otherwise visible: a
named list whose length disagrees with its span (a stale stamp shifts every
class after it), and an index whose name disagrees with what it points at
(a stamp written against a different class order). Both refuse rather than
proceed.

`dim_multiple: 64` is not cosmetic either -- the decoder dies on a size that is
a multiple of 32 but not 64, and the training rig rounded to 32 for months.

Where a file genuinely cannot be re-stamped, `FLOORPLAN_CLASS_MAP` points at a
JSON sidecar. It only fills gaps the model itself leaves, so a stale sidecar
cannot override a correctly stamped artefact.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np

#: Where the weights are. Shared with the yolo backend's variable on purpose:
#: one place to say which artefact is in play.
MODEL_PATH = os.environ.get("FLOORPLAN_MODEL", "")

#: An out-of-band class map, for weights that cannot be re-exported. JSON:
#: either a list (index == channel) or {"classes": [...], "head_layout": {...}}.
CLASS_MAP_PATH = os.environ.get("FLOORPLAN_CLASS_MAP", "")

#: What the net was trained at. Read from the model's metadata when present;
#: this is only the fallback for a file that carries none, and it is a guess
#: the loader will say out loud rather than apply silently.
_DEFAULT_INPUT = 512

_session: Any = None
_classes: list[str] | None = None
_input_size: int = _DEFAULT_INPUT
_normalisation: dict | None = None
#: Resolved absolute channel indices and the decoder's size constraint.
_extras: dict = {}


class SegmentUnavailable(RuntimeError):
    """The backend cannot run, with a reason a person can act on."""


def _spans_schema(meta: dict) -> tuple[list[str], dict] | None:
    """
    The head-span schema the trained detector actually ships.

    Not one flat `classes` list — three heads laid end to end, of which only two
    carry names:

        head_layout    {"junctions": [0,21], "rooms": [21,33], "icons": [33,44]}
        classes.rooms  12 names, index within the ROOMS span
        classes.icons  11 names, index within the ICONS span

    The junction head has 21 unnamed channels, so a consumer that assumed one
    flat list would be off by 21 on every symbol it read. This function returns
    the 44-long absolute list, with junctions filled in positionally, plus the
    named indices resolved to ABSOLUTE channels — because `railing_class_index:
    8` is 8 within rooms and channel 29 in the tensor, and confusing the two
    reads a Bath as a Railing.
    """
    layout_raw = meta.get("head_layout")
    if not layout_raw:
        return None
    layout = json.loads(layout_raw)

    names: dict[str, list[str]] = {}
    for head in layout:
        raw = meta.get(f"classes.{head}")
        if raw:
            names[head] = json.loads(raw)

    total = max(end for _, end in layout.values())
    absolute: list[str] = [""] * total
    for head, (start, end) in layout.items():
        head_names = names.get(head)
        for offset in range(start, end):
            if head_names and offset - start < len(head_names):
                absolute[offset] = head_names[offset - start]
            else:
                absolute[offset] = f"{head}[{offset - start}]"
        # A span whose named list is the wrong length is a stale stamp, and it
        # would silently shift every class after it.
        if head_names and len(head_names) != end - start:
            raise SegmentUnavailable(
                f"head_layout says {head} spans {end - start} channels but "
                f"classes.{head} lists {len(head_names)} names. The stamp and the "
                "weights are from different runs."
            )

    # ── `window` is resolved and deliberately NOT used. Measured, do not retry ──
    #
    # The checkpoint carries a Window class in its icons head (absolute channel
    # 34), and it is tempting: the vision adjudicator recovers the owner's
    # markup (4) in only 3 runs of 12, and a checkpoint is deterministic where
    # that pass is not. It was measured properly before being left alone.
    #
    # Three runs on the owner's plan gave 9 Window blobs, byte-identical every
    # run. What they are:
    #
    #     0.200,0.207  65px  the TOILET-3 window                 REAL
    #     0.770,0.417  34px  a mullioned panel between planters  REAL, and in
    #     0.771,0.432   8px    (the same one, split in two)      nobody's table
    #     0.356..0.388, 0.119..0.138, five blobs                 THE "BALCONY
    #                                                            4.57 x 1.00"
    #                                                            LABEL TEXT
    #     0.520,0.633  26px  a HEDGE, fronds read as mullions    FALSE
    #
    # So two real locations out of four, and — the point — IT MISSES MARKUP (4)
    # ENTIRELY. It does not solve the one thing the ground truth asserts.
    #
    # The obvious rescue does not work either. The adjudicator already refuses a
    # window further than 4% of image width from a proposed wall, and ALL NINE
    # BLOBS SURVIVE IT: the label text sits 0.010-0.028 from the balcony wall,
    # because plan labels are drawn against the wall they annotate, and the hedge
    # is 0.013 from one. That gate rejects windows floating mid-room; it cannot
    # reject anything drawn where a window would be.
    #
    # Why shipping it anyway would be worse than the current variance: these
    # errors are DETERMINISTIC. A false window that appears in one run of four
    # reads as noise; one that appears every single run reads as a confirmed
    # feature, and gets built.
    #
    # What would make it usable, untested: the service already reads text
    # (`reads_text`), so masking Window blobs that overlap detected text removes
    # the five-blob false cluster by rule rather than by threshold. That leaves
    # the hedge, which is the render-domain problem again — see the staircase in
    # adjudicate.py, where treads read as glazing bars for the same reason.
    resolved: dict[str, int] = {}
    for key, head in (
        ("wall_class_index", "rooms"),
        ("railing_class_index", "rooms"),
        ("window_icon_index", "icons"),
    ):
        if key in meta and head in layout:
            within = int(meta[key])
            resolved[key.replace("_class_index", "").replace("_icon_index", "")] = (
                layout[head][0] + within
            )
            # The index and the name must agree. This is the one cross-check
            # that catches a stamp written against a different class order,
            # which is otherwise undetectable and reads a Bath as a Railing.
            expected = key.split("_")[0].lower()
            actual = (names.get(head, [""] * 99)[within] if head in names else "").lower()
            if actual and expected not in actual.replace(" ", ""):
                raise SegmentUnavailable(
                    f"{key}={within} points at {actual!r} in classes.{head}, not "
                    f"{expected!r}. The indices and the names disagree, so one of "
                    "them is from a different training run."
                )
    return absolute, resolved


def _read_class_map(session: Any) -> tuple[list[str], int, dict | None, dict]:
    """Class names, input size, preprocessing and resolved indices."""
    meta = dict(session.get_modelmeta().custom_metadata_map or {})

    if CLASS_MAP_PATH:
        path = Path(CLASS_MAP_PATH)
        if not path.is_file():
            raise SegmentUnavailable(
                f"FLOORPLAN_CLASS_MAP points at {path}, which does not exist."
            )
        # A sidecar supplements the model's own metadata; the file on disk wins
        # only where the model says nothing, so a stale sidecar cannot override
        # a correctly stamped artefact.
        sidecar = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(sidecar, list):
            meta.setdefault("classes", json.dumps(sidecar))
        else:
            for key, value in sidecar.items():
                meta.setdefault(key, value if isinstance(value, str) else json.dumps(value))

    spans = _spans_schema(meta)
    if spans:
        classes, resolved = spans
    elif meta.get("classes"):
        classes, resolved = json.loads(meta["classes"]), {}
    else:
        raise SegmentUnavailable(
            "This checkpoint carries no class map, so nothing here knows what its "
            "output channels mean. Re-export it with `head_layout` plus "
            "`classes.<head>` entries in metadata_props (or a flat `classes` list), "
            "or set FLOORPLAN_CLASS_MAP to a JSON file beside the weights. Guessing "
            "a layout would read the wrong channel silently the first time the "
            "model is retrained."
        )

    if not isinstance(classes, list) or not classes:
        raise SegmentUnavailable("The class map carries no class list.")

    size = int(meta.get("train_crop") or meta.get("input_size") or 0)
    if not size:
        size = _DEFAULT_INPUT
        print(
            f"[segment] no train_crop in the metadata; assuming {size}. If the net "
            "was trained at another size this will degrade quietly rather than fail.",
            flush=True,
        )

    # Not cosmetic: this net dies in its decoder on a size that is a multiple of
    # 32 but not 64 (288, 544 and 608 all fail; 512, 576, 640 pass), and the
    # training rig rounded to 32 for months. Refusing beats resizing and hoping.
    multiple = int(meta.get("dim_multiple") or 0)

    pre_raw = meta.get("preprocess") or meta.get("normalisation")
    pre = json.loads(pre_raw) if pre_raw else None

    return classes, size, pre, {"indices": resolved, "dim_multiple": multiple}


def load() -> Any:
    """The session, loaded once — or a refusal that says what is missing."""
    global _session, _classes, _input_size, _normalisation
    if _session is not None:
        return _session

    if not MODEL_PATH:
        raise SegmentUnavailable(
            "FLOORPLAN_BACKEND=segment but FLOORPLAN_MODEL is not set."
        )
    if not Path(MODEL_PATH).is_file():
        raise SegmentUnavailable(f"FLOORPLAN_MODEL points at {MODEL_PATH}, which is not a file.")

    try:
        import onnxruntime as ort  # type: ignore
    except ImportError as exc:
        raise SegmentUnavailable("onnxruntime is not installed in this venv.") from exc

    session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    classes, size, pre, extras = _read_class_map(session)

    outputs = session.get_outputs()
    if not outputs:
        raise SegmentUnavailable("The model declares no outputs.")
    channels = outputs[0].shape[1] if len(outputs[0].shape) > 1 else None

    # The one check that catches a stale class map: a list that does not match
    # the head width is describing a different model than the one on disk.
    if isinstance(channels, int) and channels != len(classes):
        raise SegmentUnavailable(
            f"The class map lists {len(classes)} classes but the model emits "
            f"{channels} channels. One of them is from a different training run, "
            "and using either would read the wrong channel for every symbol."
        )

    _session, _classes, _input_size, _normalisation = session, classes, size, pre
    global _extras
    _extras = extras
    print(
        f"[segment] loaded {Path(MODEL_PATH).name}: {len(classes)} classes, "
        f"input {size}px, normalisation "
        f"{'declared' if pre else 'NOT SPECIFIED (raw 0-1)'}",
        flush=True,
    )
    return _session


def available() -> bool:
    """Whether this backend could run. Never raises — callers branch on it."""
    try:
        load()
        return True
    except SegmentUnavailable as reason:
        print(f"[segment] unavailable: {reason}", flush=True)
        return False


def describe() -> dict:
    """What /health should say about it, without pretending to more than it has.

    Three states, not two. The load is lazy, so a freshly started service that
    will classify perfectly on its first request reported `loaded: false` --
    indistinguishable from weights that are absent or broken. That is the same
    defect as a liveness field that says "unverified" and gets read as "down",
    and it was in the health payload written to prevent exactly that.
    """
    if not MODEL_PATH:
        return {"state": "not configured", "model": None}
    if _session is None:
        # Try, so the answer is about the artefact rather than about whether
        # anyone has made a request yet.
        try:
            load()
        except SegmentUnavailable as reason:
            return {"state": "refused", "model": Path(MODEL_PATH).name, "reason": str(reason)[:200]}
    if _session is None:
        return {"state": "refused", "model": Path(MODEL_PATH).name}
    meta = _session.get_modelmeta().custom_metadata_map or {}
    return {
        "state": "ready",
        # The BASENAME is not an identity. Two checkpoints on this machine are
        # both called floorplan_segment.onnx and one of them is refuted, so a
        # health payload naming only the file cannot answer "which model is
        # running" -- the question an operator actually has. The full path and
        # the artefact's own provenance stamp both go out.
        "model": Path(MODEL_PATH).name,
        "path": str(MODEL_PATH),
        "trained_from": meta.get("trained_from", "UNSTAMPED - provenance unknown"),
        "classes": len(_classes or []),
        "input_size": _input_size,
        "normalisation": "declared" if _normalisation else "assumed",
    }


def preprocess(image: np.ndarray) -> np.ndarray:
    """
    BGR uint8 -> the NCHW float tensor the net was trained on.

    The declared keys are `equivalent_mean` / `equivalent_std`, NOT `mean` /
    `std`. The first version of this read the latter, found nothing, fell back
    to its defaults of 0 and 1, and produced a tensor in [0,1] where the model
    wanted [-1,1] -- a silent halving of the input range that degrades output
    without raising anything. It looks like the model being mediocre.

    That is why an unrecognised normalisation block now RAISES instead of
    falling back. A default that silently disagrees with the artefact is worse
    than no default: the run completes, the numbers are plausible, and nothing
    anywhere says the input was wrong.
    """
    import cv2  # local: this module is importable without a model present

    resized = cv2.resize(image, (_input_size, _input_size), interpolation=cv2.INTER_AREA)

    # RGB, stated explicitly in the metadata, because cv2 hands out BGR and the
    # swap is another degrade-quietly failure.
    order = (_normalisation or {}).get("colour_order", "RGB").upper()
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB) if order == "RGB" else resized
    rgb = rgb.astype(np.float32) / 255.0

    if _normalisation:
        mean = _normalisation.get("equivalent_mean", _normalisation.get("mean"))
        std = _normalisation.get("equivalent_std", _normalisation.get("std"))
        if mean is None or std is None:
            raise SegmentUnavailable(
                "The artefact declares a preprocess block this loader does not "
                f"understand: {sorted(_normalisation)}. Expected equivalent_mean/"
                "equivalent_std (or mean/std). Refusing rather than falling back, "
                "because a wrong input range degrades the output silently."
            )
        rgb = (rgb - np.array(mean, np.float32)) / np.array(std, np.float32)

    return np.transpose(rgb, (2, 0, 1))[None, ...]

#: A wall must read at least this much Railing before the verdict is even
#: considered. Not a tuned constant: on the owner's plan 50 of 55 proposals sit
#: under 10% and the lowest genuine railing reads 33%, so anything in the teens
#: is the model's noise floor rather than a quiet opinion. The floor sits below
#: the lowest true positive and well above the band everything else occupies.
RAILING_FLOOR = 0.20

#: A proposal reading LESS Wall than this is dropped as furniture outline.
#:
#: Deliberately far below the 0.15 the training session used, and the reason is
#: the measurement rather than caution for its own sake. Their "two clean
#: populations" (real 0.58-1.00, false 0.000-0.006) turned out to be a
#: distribution read off its own tails; measured properly it is a CONTINUUM.
#: Three samplers were swept — centreline, region, and a perpendicular search at
#: reach 1/2/4/6/9 — and the ambiguous middle never collapses: 13-18 of 55 every
#: time, while the extremes hold (~19 at 0-1%, ~17 at 60-100%).
#:
#: So there is no gap to sit a threshold in. What IS robust is the bottom group:
#: the same ~19 proposals read essentially zero Wall under every geometry tried.
#: This ceiling takes only those and leaves the entire ambiguous middle standing.
#:
#: The asymmetry is on purpose. A wrongly kept furniture outline is a stray line
#: in a model somebody can delete; a wrongly dropped wall costs WINDOWS, because
#: the window pass only accepts a window within 4% of a proposed wall. The two
#: errors are not the same size, so the rule does not treat them as if they were.
FURNITURE_CEILING = 0.05


def classify_walls(
    image: np.ndarray, walls: list, samples: int = 48, drop_furniture: bool = False,
) -> tuple[list, list]:
    """
    Ask the trained model what each proposed wall actually is.

    The heuristic decides WHERE — line extraction is solved in classical CV.
    This decides WHAT, which is where morphology is weakest and where a balcony
    parapet and an interior partition are the same two lines on a drawing.

    ── Why this replaces the vision adjudicator for railings ──────────────────
    The adjudicator's railing verdict was measured NON-DETERMINISTIC: the same
    file through the same service gave 2 railings, then 1 boundary, then 0, then
    1. That verdict changes geometry — a marked line is built at parapet height
    rather than storey height — so a client's balcony was open on one import and
    boxed in on the next, and no amount of asking twice removed the flicker.
    A checkpoint is deterministic. The fix is not to make the vision model agree
    with itself; it is to stop asking it.

    ── Why the rule is a comparison and not a threshold ───────────────────────
    A tuned cutoff is a constant that was right once, on one drawing. This asks
    the model which of the two classes it prefers along that line, which is a
    question it was trained to answer. Measured on the owner's plan: the three
    genuine candidates read Railing 73/54/33% against Wall 0% for all three,
    while the two near-misses read Railing 17% and 15% against Wall 44% and 83%
    — the model is not ambivalent about them, it simply says wall. The floor
    exists only to keep a 2%-vs-0% line from winning by default.

    Returns the walls with `kind` set, and notes naming what changed and where.
    """
    session = load()
    layout = json.loads(session.get_modelmeta().custom_metadata_map["head_layout"])
    start, end = layout["rooms"]
    indices = _extras.get("indices", {})
    rail = indices.get("railing", 0) - start
    wall = indices.get("wall", 0) - start

    heads = session.run(None, {session.get_inputs()[0].name: preprocess(image)})[0]
    # argmax over the ROOMS head only. The three heads are not comparable, so a
    # global argmax across all 44 channels mixes junctions into room classes.
    winner = heads[0, start:end].argmax(axis=0)
    size = winner.shape[0]

    notes: list[str] = []
    kept: list = []
    dropped = 0
    for segment_ in walls:
        xs = np.linspace(segment_.start.x, segment_.end.x, samples) * (size - 1)
        ys = np.linspace(segment_.start.y, segment_.end.y, samples) * (size - 1)
        along = winner[
            np.clip(ys.astype(int), 0, size - 1),
            np.clip(xs.astype(int), 0, size - 1),
        ]
        rail_share = float((along == rail).mean())
        wall_share = float((along == wall).mean())

        mx = (segment_.start.x + segment_.end.x) / 2
        my = (segment_.start.y + segment_.end.y) / 2

        if rail_share >= RAILING_FLOOR and rail_share > wall_share:
            segment_.kind = "railing"
            kept.append(segment_)
            notes.append(
                f"detector: a structure near {mx:.0%},{my:.0%} reads railing "
                f"({rail_share:.0%}) rather than wall ({wall_share:.0%}) "
                "- built to parapet height"
            )
            continue

        # A RAILING READS ~0% WALL BY DESIGN, so the furniture test has to come
        # after the railing test and never see a segment it already claimed.
        # Ordered the other way, this rule deletes every parapet the line above
        # just identified — the two tests agree about the evidence and disagree
        # about what it means.
        if drop_furniture and wall_share < FURNITURE_CEILING:
            dropped += 1
            notes.append(
                f"detector: a proposal near {mx:.0%},{my:.0%} reads "
                f"{wall_share:.0%} wall - dropped as furniture outline"
            )
            continue

        kept.append(segment_)

    if not notes:
        # Silence here is a real answer and it should look like one, because
        # "no railings on this drawing" and "the classifier did not run" are
        # indistinguishable to a reader otherwise.
        notes.append("detector: no proposed structure read as railing")
    if drop_furniture:
        # Say the total as well as the individuals. A reader scanning for one
        # missing wall needs to know how many went, not just to count lines.
        notes.append(
            f"detector: kept {len(kept)} of {len(walls)} proposals, "
            f"dropped {dropped} reading under {FURNITURE_CEILING:.0%} wall"
        )
    return kept, notes
