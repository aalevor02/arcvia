"""
Telling walls, openings and furniture apart.

── The structural claim ──────────────────────────────────────────────────────
"Is this a wall?" is not a heuristic question. A wall is linework that *bounds a
room*: two long parallel faces participating in a minimal cycle of the plan
graph. Furniture is a closed loop that sits *inside* a cycle and contributes
nothing to it. `rooms.ts` already derives those cycles on every edit, so the
wall/not-wall split falls out of topology and is exact.

What is genuinely uncertain is the second question — *which* piece of furniture —
and that is what this module is for.

── Four signals, no single verdict ───────────────────────────────────────────
Each signal reports independently and the fusion keeps the disagreement:

  1. BLOCK NAME   `guess_item()`. Strongest when it hits, because a block
                  reference is the architect's own label. Deliberately silent on
                  noise: `_MEANINGLESS` refuses to guess at `A$C4F2A1`.
  2. LAYER NAME   Pre-selects only. There is no layer-naming convention — one
                  practice used `walls`, `A1 WALLS`, `NEW WALLS` and `Wall`
                  across seven drawings of the same project.
  3. FOOTPRINT    Measured width and depth against the real catalogue
                  dimensions. This is what rescues the anonymous blocks that
                  signal 1 correctly refuses to guess at.
  4. CONTEXT      Which room the centroid lands in, and whether it is pressed
                  against a wall. A 0.6 x 2.0 m box against a wall is a counter
                  in a kitchen and a wardrobe in a bedroom — same geometry,
                  different answer, and only the room can tell you which.

── Why margin, not score, is the review signal ───────────────────────────────
A verdict at 0.6 with no rival is fine and needs nobody's attention. Two rivals
at 0.55 and 0.54 is a coin toss wearing a number, and *that* is what deserves a
human glance. Reporting `margin` separately from `score` is what lets the UI ask
about the second case and stay quiet about the first.

Nothing here ever silently picks a winner it is not entitled to: below
`MIN_SCORE` the verdict is `unknown`, which keeps the object out of the scene
rather than putting a wrong one in it. An absent sofa is a gap someone notices;
a wrong sofa is a gap nobody does.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from .catalogue_dims import CATALOGUE_DIMS, FLOOR_STANDING, IN_WALL, WALL_MOUNTED

# ---------------------------------------------------------------------------
# Room kinds — read off whatever the drawing calls its rooms.
# ---------------------------------------------------------------------------

#: Ordered: the first match wins, so the specific patterns come first.
#: Drawn from the room names in real Indian residential drawings, which is what
#: this was built against — `TOILET-01`, `WALK-IN`, `VERANDAH`, `FOYER`.
_ROOM_KINDS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"walk[\s\-]*in|dress", re.I), "dressing"),
    (re.compile(r"toilet|bath|w\.?c\.?\b|shower|powder|lavatory", re.I), "bathroom"),
    (re.compile(r"kitchen|pantry|utility|scullery", re.I), "kitchen"),
    (re.compile(r"bed\s?room|\bbed\b|\bmbr\b|master", re.I), "bedroom"),
    (re.compile(r"dining", re.I), "dining"),
    (re.compile(r"living|lounge|drawing|family|hall\b", re.I), "living"),
    # Outdoor is tested BEFORE study/circulation, and the order is load-bearing.
    # `OFFICE PATIO` is a real label in a real drawing, and with `office` first it
    # classified as `study` — an indoor habitable room. NBC's habitable-area and
    # habitable-width rules would then have been applied to a patio. An outdoor word
    # is a strong, specific qualifier: a room called anything PATIO, BALCONY, TERRACE
    # or DECK is outside, whatever else the label says.
    (re.compile(r"veranda|balcon|terrace|deck|porch|patio|garden|lawn|court", re.I), "outdoor"),
    (re.compile(r"study|office|library|work", re.I), "study"),
    (re.compile(r"foyer|entry|entrance|lobby|passage|corridor|stair|lift", re.I), "circulation"),
    (re.compile(r"store|storage|closet|almirah", re.I), "store"),
    (re.compile(r"car\s?park|garage|parking", re.I), "parking"),
]


#: Text that reaches the room-label pool but is an ANNOTATION, not a room name.
#:
#: A drawing's text layer carries title blocks, notes and provisions alongside room
#: labels, and `usable_room_labels` does not fully separate them — a real build offered
#: `Architect`, `Project`, `VILLAS AT ASSAGAON` and `Provision for home lift` as room
#: labels. Most fall through to `unknown` harmlessly, but `Provision for home lift`
#: matched `lift` and became a `circulation` ROOM: a note about a future lift turning
#: into a space the code checks measure.
#:
#: Matching a phrase is not the same as naming a room. These are the shapes that say
#: "this sentence is about the drawing, not a space in it".
_NOT_A_ROOM = re.compile(
    r"provision\s+for|refer\s+to|\bnote[s]?\b|drawn\s+by|checked\s+by|"
    r"\bscale\b|\bclient\b|\barchitect\b|\bproject\b|\brevision\b|\bsheet\b|"
    r"\btyp\.|do\s+not\s+scale",
    re.I,
)


def classify_room(name: str | None) -> str:
    """The kind of room a printed label refers to, or 'unknown'.

    'unknown' is a real answer and is preserved deliberately: a room the drawing never
    named, or named something this vocabulary does not know, must stay distinguishable
    from one that was classified. Nothing here guesses past it.
    """
    if not name or not name.strip():
        return "unknown"
    if _NOT_A_ROOM.search(name):
        return "unknown"
    for pattern, kind in _ROOM_KINDS:
        if pattern.search(name):
            return kind
    return "unknown"


#: What each kind of room makes more or less likely. Multipliers on the
#: footprint score, not verdicts of their own.
#:
#: The negative entries matter as much as the positive ones. Without them a
#: 2.0 x 0.6 m box in a kitchen scores identically as a counter and a wardrobe,
#: and the tie is broken by dictionary order — which is to say, arbitrarily.
_ROOM_PRIORS: dict[str, dict[str, float]] = {
    "bedroom": {
        "bed-king": 2.5, "bed-queen": 2.5, "bed-single": 2.2, "bedside": 2.0,
        "wardrobe": 1.8, "wardrobe-small": 1.6, "chest": 1.5, "tv": 1.2,
        "counter": 0.15, "island": 0.05, "hob": 0.05, "sink-unit": 0.1,
        "wc": 0.05, "bathtub": 0.05, "dining-table-6": 0.2, "sofa-3": 0.4,
    },
    "bathroom": {
        "wc": 3.0, "basin": 3.0, "shower": 2.5, "bathtub": 2.5, "mirror": 2.0,
        "bed-queen": 0.02, "bed-king": 0.02, "sofa-3": 0.02, "sofa-2": 0.02,
        "dining-table-6": 0.02, "hob": 0.1, "tv": 0.1, "wardrobe": 0.3,
    },
    "kitchen": {
        "counter": 3.0, "island": 2.5, "hob": 3.0, "sink-unit": 3.0,
        "fridge": 2.5, "overhead": 2.5,
        "bed-queen": 0.02, "bed-king": 0.02, "wc": 0.05, "bathtub": 0.02,
        "sofa-3": 0.1, "wardrobe": 0.2, "tv": 0.4,
    },
    "living": {
        "sofa-3": 2.5, "sofa-2": 2.2, "armchair": 2.0, "coffee-table": 2.2,
        "tv-unit": 2.2, "tv": 2.0, "rug": 1.8, "bookshelf": 1.5, "plant": 1.4,
        "bed-queen": 0.05, "bed-king": 0.05, "wc": 0.02, "hob": 0.05,
        "basin": 0.1, "counter": 0.3,
    },
    "dining": {
        "dining-table-6": 3.0, "dining-table-4": 2.8, "dining-chair": 2.5,
        "bench": 1.6, "sink-unit": 0.3,
        "bed-queen": 0.02, "wc": 0.02, "bathtub": 0.02, "sofa-3": 0.4,
    },
    "study": {
        "desk": 3.0, "bookshelf": 2.5, "dining-chair": 1.8, "chest": 1.3,
        "bed-queen": 0.3, "wc": 0.02, "hob": 0.05, "bathtub": 0.02,
    },
    "dressing": {
        "wardrobe": 3.0, "wardrobe-small": 2.5, "chest": 2.2, "mirror": 2.0,
        "bed-queen": 0.3, "hob": 0.02, "wc": 0.1, "sofa-3": 0.2,
    },
    "store": {"wardrobe": 1.6, "bookshelf": 1.5, "chest": 1.4, "bed-queen": 0.2},
    # An outdoor space is where a plant is plausible and a bed is not. Kept
    # deliberately sparse: a veranda holds almost anything and pretending
    # otherwise would suppress real furniture.
    "outdoor": {
        "plant": 2.5, "bench": 1.8, "dining-chair": 1.4, "armchair": 1.3,
        "bed-queen": 0.05, "bed-king": 0.05, "wc": 0.05, "hob": 0.1,
        "wardrobe": 0.1, "tv": 0.2,
    },
    "circulation": {"plant": 1.5, "bench": 1.3, "mirror": 1.3,
                    "bed-queen": 0.05, "hob": 0.05, "sofa-3": 0.3},
    "parking": {"bed-queen": 0.02, "sofa-3": 0.05, "wc": 0.05, "hob": 0.02},
}


# ---------------------------------------------------------------------------
# Layer hints — pre-selection only, never a decision.
# ---------------------------------------------------------------------------

_LAYER_HINTS: list[tuple[re.Pattern, str]] = [
    # Ordered most specific first. `door` must be tested before `furniture`,
    # because `A4 DOOR WIN FURN` is a real layer name and it is about openings.
    (re.compile(r"door|window|\bwin\b|glaz|shutter|ventil", re.I), "opening"),
    (re.compile(r"\bwall|\bwal\b|^a-?wall|masonry|brick|partition|rcc|column", re.I), "wall"),
    (re.compile(r"sanitary|plumb|\bcp\b|w\.?c\.?\b|toilet|basin", re.I), "sanitary"),
    (re.compile(r"furn|furniture|\bfur\b|loose", re.I), "furniture"),
    (re.compile(r"joinery|wardrobe|cabinet|counter|slab|platform|kitchen", re.I), "joinery"),
    (re.compile(r"electric|light|switch|socket|\bdb\b|elec", re.I), "electrical"),
    (re.compile(r"hatch|pattern|fill|poche", re.I), "hatch"),
    (re.compile(r"dim|text|note|title|north|scale|legend|annot|leader|defpoints|grid",
                re.I), "annotation"),
]


def classify_layer(layer: str) -> str:
    """What a layer probably holds, from its name alone. A hint, not a verdict."""
    for pattern, kind in _LAYER_HINTS:
        if pattern.search(layer or ""):
            return kind
    return "other"


#: Short block names that are words, not noise.
#:
#: The vendored kernel refuses to guess at anything matching `^[a-z]{1,3}\d*$`,
#: which is the right call — `VXCBX` and `ewa` and `TC` really are the residue
#: every production drawing carries, and a wrong guess gets accepted without
#: thought. But the same shape catches genuine abbreviations, and `_BLOCK_HINTS`
#: already contains rules for three of them: `tv`, `wc` and `wb`. Those rules
#: are unreachable for the bare name, so a drawing whose television block is
#: called `TV` silently gets no television.
#:
#: `_SIZED_OPENING` was given an explicit escape above `_MEANINGLESS` for
#: exactly this reason — `D750` shares its shape with noise too. This is the
#: same escape for short words rather than sized openings. It stays a closed
#: list: every entry is a name observed in a real drawing, because the moment
#: this becomes a pattern it starts guessing at the noise again.
_SHORT_ALIASES: dict[str, str] = {
    "tv": "tv",
    "wc": "wc",
    "ewc": "wc",
    "wb": "basin",
    "cp": "wc",       # "closet pan"
    "st": "sink-unit",
    "ac": "annotation",   # air-conditioning symbol, not furniture
}


#: Items that are, geometrically, just a rectangle.
#:
#: A rug has no characteristic size and no characteristic proportion — it is
#: whatever rectangle the architect drew. So it matches *everything* moderately
#: well, and in a field of poor matches it wins by default. Run against a real
#: five-villa drawing this produced 93 rugs, which is not a plausible number of
#: rugs; they were every footprint nothing else could explain.
#:
#: The rule: these are only ever produced when the block name says so. Inferring
#: them from shape is not identification, it is a shrug with a label on it — and
#: `unknown` is the honest way to write that, because it routes to review
#: instead of quietly placing furniture nobody drew.
_FOOTPRINT_UNINFERABLE = {"rug", "painting", "curtain", "mirror"}


#: How much a layer hint is allowed to move a footprint score.
#: Modest on purpose. Layer names are unguessable across practices, so a wrong
#: hint must not be able to overrule a measured dimension.
_LAYER_WEIGHT = {
    "furniture": 1.4, "joinery": 1.3, "sanitary": 1.5,
    "opening": 0.3, "wall": 0.2, "electrical": 0.5,
    "hatch": 0.2, "annotation": 0.1, "other": 1.0,
}


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------

#: Below this *share* of the total, the answer is `unknown`. Leaving an object
#: out is recoverable; putting a wrong one in gets accepted without thought.
MIN_SCORE = 0.35

#: Below this *absolute* score, the answer is `unknown` however far ahead it is.
#:
#: MIN_SCORE alone is a share of the total, so it only ever asks "best of what
#: is here". When every candidate has been crushed — a bed-sized box in a
#: kitchen, where the priors correctly reduce a bed to 0.02 — the least-crushed
#: one still takes a large share and reads as confident. That is how a bed ends
#: up in a kitchen with a respectable-looking number attached.
#:
#: A good match scores around 1.0 before priors and is multiplied up by a
#: supporting room; a contradicted one lands two orders of magnitude below. 0.25
#: sits in the gap, and its job is to distinguish "confident" from "best of a
#: bad lot", which relative scoring cannot express at all.
MIN_RAW_SCORE = 0.25

#: Below this margin the decision is a coin toss and belongs in the review
#: queue, whatever its score.
REVIEW_MARGIN = 0.12


@dataclass
class Verdict:
    """One classification, with everything needed to argue with it."""

    label: str                       # wall | opening | fixture | annotation | unknown
    item: str | None = None          # catalogue id, when label == 'fixture'
    score: float = 0.0
    margin: float = 0.0
    alternatives: list[tuple[str, float]] = field(default_factory=list)
    signals: dict = field(default_factory=dict)

    #: The architect's label and the room disagree. Set when a named item stood
    #: in a room whose prior would have argued against it — see the room-prior
    #: loop. Always a review case, whatever the margin says, because the two
    #: most reliable signals in the file are pointing different ways.
    contested: bool = False

    @property
    def needs_review(self) -> bool:
        return (
            self.label == "unknown"
            or self.margin < REVIEW_MARGIN
            or self.contested
        )

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "item": self.item,
            "confidence": {
                "score": round(self.score, 4),
                "margin": round(self.margin, 4),
                "alternatives": [
                    {"label": a, "score": round(s, 4)} for a, s in self.alternatives[:4]
                ],
            },
            "signals": self.signals,
            "needsReview": self.needs_review,
        }


def _footprint_scores(width: float, depth: float, wall_mounted: bool = False) -> dict[str, float]:
    """
    Score every catalogue item against a measured footprint.

    Compares the sorted (long, short) pair so a rotated block matches, and
    scores on *relative* error because a 5 cm discrepancy means something very
    different on a bedside table than on a dining table.
    """
    if width <= 0 or depth <= 0:
        return {}

    long_m, short_m = max(width, depth), min(width, depth)
    pool = WALL_MOUNTED if wall_mounted else FLOOR_STANDING
    out: dict[str, float] = {}

    for item_id in pool:
        dims = CATALOGUE_DIMS[item_id]
        long_c, short_c = max(dims["w"], dims["d"]), min(dims["w"], dims["d"])

        err = math.hypot(
            (long_m - long_c) / max(long_c, 0.05),
            (short_m - short_c) / max(short_c, 0.05),
        )
        # Half-width 0.35 puts a 35% dimensional error at roughly half score,
        # which matches how much real drawings vary from catalogue nominals.
        out[item_id] = math.exp(-((err / 0.35) ** 2))

    return out


def classify_footprint(
    *,
    width: float,
    depth: float,
    block: str | None = None,
    layer: str = "",
    room_name: str | None = None,
    against_wall: bool = False,
    guess_item=None,
) -> Verdict:
    """
    Identify one placed object from its footprint and its surroundings.

    `guess_item` is injected rather than imported so the vendored CAD kernel
    stays a dependency of the caller, not of this module — which keeps this
    testable without ezdxf installed.
    """
    signals: dict = {}

    # ---- Signal 2 first: it can rule the question out entirely -------------
    layer_kind = classify_layer(layer)
    signals["layer"] = {"name": layer, "kind": layer_kind}

    if layer_kind == "annotation":
        return Verdict(label="annotation", score=0.9, margin=0.9, signals=signals)

    # ---- Signal 1: the architect's own label -------------------------------
    named: str | None = None
    via_alias = False
    if block:
        key = block.strip().lower()
        if key in _SHORT_ALIASES:
            # The kernel would refuse this one as noise — see _SHORT_ALIASES.
            named = _SHORT_ALIASES[key]
            via_alias = True
        elif guess_item is not None:
            named = guess_item(block)
    signals["block"] = {"name": block, "item": named, "viaAlias": via_alias}

    # A symbol, not an object. An air-conditioning marker has a footprint and
    # would otherwise match something roughly its size.
    if named == "annotation":
        return Verdict(label="annotation", score=0.85, margin=0.85, signals=signals)

    if named in IN_WALL:
        # A door or window block. Not an object standing in a room at all.
        return Verdict(
            label="opening", item=named, score=0.95, margin=0.9, signals=signals
        )

    # ---- Signal 3: measured against the real catalogue ---------------------
    wall_mounted = named in WALL_MOUNTED
    scores = _footprint_scores(width, depth, wall_mounted=wall_mounted)
    signals["footprint"] = {"w": round(width, 3), "d": round(depth, 3),
                            "wallMounted": wall_mounted}

    # A named item is strong evidence, but not proof — block libraries get
    # reused across projects and renamed carelessly. Boosting rather than
    # short-circuiting lets a wildly wrong dimension still register as a
    # low-margin decision instead of passing silently.
    if named:
        scores[named] = scores.get(named, 0.4) * 3.0 + 0.5

    # ---- Signal 4: the room it stands in -----------------------------------
    room_kind = classify_room(room_name)
    priors = _ROOM_PRIORS.get(room_kind, {})
    signals["context"] = {"room": room_name, "kind": room_kind,
                          "againstWall": against_wall}

    contested = False
    for item_id in list(scores):
        # A featureless rectangle is not evidence of a rug — see
        # _FOOTPRINT_UNINFERABLE. Only the architect's own label produces these.
        if item_id in _FOOTPRINT_UNINFERABLE and item_id != named:
            scores[item_id] = 0.0
            continue

        prior = priors.get(item_id, 1.0)

        # ── The room may argue with the architect. It may not overrule him ──
        # This module's own ordering puts the written label FIRST and the room
        # LAST: "a plan says what is in it three ways, in descending
        # reliability". The prior was inverting that. Measured on a real
        # drawing, the same block —
        #
        #     'double bed', 2.10 x 1.80, named bed-queen by the kernel
        #
        # — resolves to `bed-queen` in a BED ROOM and to `unknown` in an
        # `Enclosed Balcony`, because that room classifies as outdoor and the
        # outdoor prior takes the raw score under the floor. The architect wrote
        # "double bed" on it. Dropping it is not caution, it is preferring our
        # room guess to his label, and this villa is exactly where that guess is
        # weakest — an *enclosed* balcony is not obviously outdoors.
        #
        # So a prior below 1.0 no longer applies to the item the drawing NAMED.
        # It still applies to every rival, so the room keeps all of its power to
        # decide BETWEEN candidates; it simply cannot veto the only one with a
        # label. And the disagreement is recorded rather than smoothed over:
        # `contested` forces review, so this shows up as "check this" instead of
        # either a silent drop or a silent placement.
        if item_id == named and prior < 1.0:
            contested = True
            prior = 1.0

        scores[item_id] *= prior * _LAYER_WEIGHT.get(layer_kind, 1.0)

        # Depth-to-wall items — counters, wardrobes, TV units — are defined by
        # being against something. Free-standing ones mostly are not.
        dims = CATALOGUE_DIMS[item_id]
        deep_against = dims["d"] <= 0.75 and dims["w"] >= 1.0
        if against_wall and deep_against:
            scores[item_id] *= 1.35
        elif not against_wall and item_id in {"counter", "overhead", "wardrobe", "tv-unit"}:
            scores[item_id] *= 0.5

    if not scores:
        return Verdict(label="unknown", signals=signals)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    total = sum(s for _, s in ranked) or 1.0
    normalised = [(k, s / total) for k, s in ranked]

    top_id, top = normalised[0]
    runner = normalised[1][1] if len(normalised) > 1 else 0.0

    raw_top = ranked[0][1]
    signals["rawScore"] = round(raw_top, 4)

    # Plausible on its own terms before its ranking counts for anything.
    if raw_top < MIN_RAW_SCORE or top < MIN_SCORE:
        return Verdict(
            label="unknown", score=top, margin=top - runner,
            alternatives=normalised[:4], signals=signals, contested=contested,
        )

    return Verdict(
        label="fixture",
        item=top_id,
        score=top,
        margin=top - runner,
        alternatives=normalised[:4],
        signals=signals,
        contested=contested,
    )
