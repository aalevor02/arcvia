"""
Which layers hold walls — measured, not guessed.

── Why the name cannot answer this ───────────────────────────────────────────
`cad.py` is emphatic and it is right: there is no layer-naming convention. One
practice used `walls`, `A1 WALLS`, `NEW WALLS` and `Wall` across seven drawings
of one project. Guessing from the name has now failed twice on this codebase in
opposite directions — once by excluding `A1 WALLS HIDDEN`, which turned out to
carry the main wall run, and once by trusting the name heuristic and missing
whatever holds the interior partitions.

── What can answer it ────────────────────────────────────────────────────────
A wall layer has a property no other layer has: **its lines pair up into
plausible wall thicknesses.** Dimension lines do not. Hatch does not. Furniture
does not. Text does not. Setting-out lines and grids do not.

So this runs the real pairing algorithm over each layer's linework on its own,
and reports what came out. A layer producing 40 pairs at a consistent 0.23 m is
a wall layer whatever it is called; a layer producing three pairs at wildly
scattered gaps is not, whatever it is called.

The output is evidence for a human, not a decision. That distinction is the
whole point — this ranks candidates, and the caller passes `--layers`.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, replace

#: Layers with less than this much linework cannot be a building's walls.
MIN_SEGMENTS = 12

#: A residential wall. Pairs outside this are two unrelated lines that happen
#: to be parallel.
PLAUSIBLE = (0.06, 0.45)

#: Below this, the pairs that formed are scattered noise rather than a
#: consistently-drawn wall.
MIN_PLAUSIBLE_FRACTION = 0.5


@dataclass
class LayerScore:
    name: str
    segments: int
    faces: int
    walls: int
    paired: int
    median_thickness: float | None
    spread: float | None
    plausible_fraction: float
    paired_fraction: float
    verdict: str

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "segments": self.segments,
            "faces": self.faces,
            "walls": self.walls,
            "paired": self.paired,
            "medianThickness": (
                round(self.median_thickness, 4) if self.median_thickness else None
            ),
            "spread": round(self.spread, 4) if self.spread is not None else None,
            "plausibleFraction": round(self.plausible_fraction, 3),
            "pairedFraction": round(self.paired_fraction, 3),
            "verdict": self.verdict,
        }


def encloses(faces_by_layer: dict[str, list]) -> dict[str, int]:
    """
    How many rooms each layer closes ON ITS OWN.

    ── Why the pairing verdict is not enough, measured on a real upload ─────
    `scan` asks how a layer's linework pairs with ITSELF. That is the right
    question for a layer drawing whole walls and the WRONG one for a drawing
    that splits a wall's two faces across two layers — and it then gives an
    actively misleading answer. From a Norwegian residential DWG a client
    actually uploaded:

        layer        segs   self-pairs   verdict                        rooms
        A-WALL        133   26 @ 0.150   WALLS                              0
        inne_gulv     179   36 @ 0.050   pairs, not at wall thicknesses     21

    The layer the report endorsed encloses NOTHING. The layer it dismissed as
    floor-finish hatching ("inne_gulv" is Norwegian for inner floor) is the
    inner face of the building's walls and closes twenty-one rooms. Selecting
    on the verdict alone gave 3 rooms and a BLOCKED verify; adding the
    dismissed layer gives 33 rooms, 10 named, and a clean pass.

    Enclosure is the honest measure and `select_wall_layers` already says why:
    *what only walls do is close*. It is reported per layer here so a human
    reading the free `layers` table sees the same evidence the fitter uses.

    Note what is NOT reported: a "gain" from pairing two layers together.
    That was tried and refuted — pairing is greedy and exclusive, so combining
    two layers yields FEWER pairs than the sum of their solos (measured 61
    against 62 here) while producing far better ones. Pair counts cannot see
    this; closed rooms can.
    """
    from hypothesise.pair import join_corners, pair_faces
    from solve.spaces import detect_spaces

    out: dict[str, int] = {}
    for name, faces in faces_by_layer.items():
        if len(faces) < MIN_SEGMENTS:
            continue
        pool = [replace(f, layer=name) for f in faces]
        try:
            out[name] = len(detect_spaces(join_corners(pair_faces(pool))))
        except Exception:  # noqa: BLE001 — a diagnostic must not break a report
            out[name] = 0
    return out


def scan(faces_by_layer: dict[str, list]) -> list[LayerScore]:
    """
    Score every layer by how well its own linework pairs into walls.

    Sorted best-first: the layers most likely to hold walls come out on top,
    with the evidence for that ranking attached to each one.

    A layer that scores badly here may still be half of a wall — see
    `cross_partners`, and do not read a poor verdict as "not a wall layer"
    without checking it.
    """
    from hypothesise.pair import pair_faces

    scores: list[LayerScore] = []

    for name, faces in faces_by_layer.items():
        if len(faces) < MIN_SEGMENTS:
            continue

        walls = pair_faces(faces)
        paired = [w for w in walls if w.paired]
        thicknesses = [w.thickness for w in paired]

        if thicknesses:
            median = statistics.median(thicknesses)
            spread = (
                statistics.pstdev(thicknesses) if len(thicknesses) > 1 else 0.0
            )
            lo, hi = PLAUSIBLE
            plausible = sum(1 for t in thicknesses if lo <= t <= hi) / len(thicknesses)
        else:
            median, spread, plausible = None, None, 0.0
        paired_fraction = len(paired) / len(walls) if walls else 0.0

        # A wall layer pairs a lot, at one thickness, in a buildable range.
        if not paired:
            verdict = "no pairs"
        elif plausible < MIN_PLAUSIBLE_FRACTION:
            verdict = "pairs, but not at wall thicknesses"
        elif len(paired) < 4:
            verdict = "too few pairs to tell"
        elif spread is not None and spread > 0.12:
            verdict = "pairs at inconsistent thicknesses"
        else:
            verdict = "WALLS"

        scores.append(
            LayerScore(
                name=name,
                segments=len(faces),
                faces=len(faces),
                walls=len(walls),
                paired=len(paired),
                median_thickness=median,
                spread=spread,
                plausible_fraction=plausible,
                paired_fraction=paired_fraction,
                verdict=verdict,
            )
        )

    scores.sort(key=lambda s: (s.verdict != "WALLS", -s.paired))
    return scores


def recommended(scores: list[LayerScore]) -> set[str]:
    """The layers whose linework pairs like walls. A shortlist, not an answer."""
    return {s.name for s in scores if s.verdict == "WALLS"}


# ---------------------------------------------------------------------------
# Selecting the set, by what it actually encloses
# ---------------------------------------------------------------------------

#: A room. Anything outside this is a cupboard-sized sliver or several rooms
#: that were never divided.
ROOM_AREA = (2.0, 150.0)

#: Stop adding layers once the best candidate adds fewer rooms than this.
MIN_GAIN = 1

#: Maximum new walls a candidate may add for each new piece of annotation it
#: explains.  The annotation objective still decides *which* candidate wins;
#: this only refuses a candidate that buys a tiny score increase with a large
#: amount of unrelated linework.  Measured on the villa's ground-floor frame,
#: the useful false-ceiling layer adds 92 walls for nine new pieces of evidence,
#: while generic layer ``0`` adds 137 walls for one named room.  The latter is
#: exactly how a greedy annotation score turns one extra label into 102.55 m of
#: spurious indoor wall run.
MAX_WALLS_PER_EVIDENCE_GAIN = 40


def _rooms_from(faces) -> int:
    """How many plausible rooms this linework encloses."""
    from hypothesise.pair import join_corners, pair_faces
    from solve.spaces import detect_spaces

    walls = join_corners(pair_faces(faces))
    if len(walls) < 4:
        return 0
    lo, hi = ROOM_AREA
    return sum(1 for s in detect_spaces(walls) if lo <= s.area <= hi)


@dataclass
class Fit:
    """How well a layer set reproduces the drawing's own annotations."""

    walls: int
    rooms: int
    named: int
    doors: int
    unhosted: int

    @property
    def score(self) -> tuple:
        # Named rooms first, then hosted doors. Raw room count is deliberately
        # NOT in the key — see `select_within_frame`.
        return (self.named, self.doors, -self.unhosted)

    def as_dict(self) -> dict:
        return {
            "walls": self.walls, "rooms": self.rooms, "named": self.named,
            "doors": self.doors, "unhosted": self.unhosted,
        }


def efficient_improvement(before: Fit, after: Fit) -> bool:
    """Whether a better annotation fit is proportionate to its wall growth."""
    if after.score <= before.score:
        return False

    opening_gain = max(
        max(0, after.doors - before.doors),
        max(0, before.unhosted - after.unhosted),
    )
    evidence_gain = max(0, after.named - before.named) + opening_gain
    if evidence_gain == 0:
        return False

    wall_gain = max(0, after.walls - before.walls)
    return wall_gain <= MAX_WALLS_PER_EVIDENCE_GAIN * evidence_gain


def fit_of(faces, labels, placements, classify_room, guess_item,
           perimeter: bool = True, opening_labels=None) -> Fit:
    """
    Grade a layer set against what the architect actually annotated.

    ── Why named rooms rather than rooms ────────────────────────────────────
    Room count is a proxy and optimising it picks up any layer that closes a
    loop. Measured on one frame of a real drawing:

        + false ceiling + layer 0    12 rooms, 3 named, 10 doors
        hidden + false ceiling        7 rooms, 6 named, 11 doors   <- better

    The second set is smaller, encloses fewer loops, and reproduces twice as
    many of the rooms the architect put a name inside. A loop with no label is
    a loop; a loop the drawing named is a room. The label is ground truth that
    happens to be sitting right there in the file, and it is the only signal
    here that cannot be manufactured by adding more linework.

    Hosted doors is the same idea from the other direction: a door block placed
    by the architect either lands on a wall we found or it does not.
    """
    from hypothesise import openings as op
    from hypothesise.pair import join_corners, pair_faces
    from hypothesise.perimeter import add_perimeter
    from solve.spaces import detect_spaces

    walls = join_corners(pair_faces(faces))
    if len(walls) < 4:
        return Fit(len(walls), 0, 0, 0, len(placements))

    # ── Grade the building the pipeline will actually build ─────────────────
    # This used to stop at `join_corners` while `cli.py` goes on to call
    # `add_perimeter` before detecting rooms. So the selector was ranking layer
    # sets by how well they enclose ON THEIR OWN, and then handing the winner to
    # a stage that encloses them differently.
    #
    # That is not a small difference, because the envelope is what closes the
    # largest space in a modern house — `hypothesise/perimeter.py` exists for
    # exactly that reason. Measured on the villa, the same layer set:
    #
    #     A1 WALLS HIDDEN + A5 FALSE CEILING    4 rooms,  2 named
    #                       ...with perimeter  15 rooms, 12 named
    #
    # A set that encloses badly alone can enclose well once the ring is added,
    # and the objective never saw it. On 2 of the 5 annotated frames of the
    # villa the winner changes outright once both are measured the same way:
    #
    #     frame 3   ('0',)              ->  ('0', 'A5 FURN')
    #     frame 4   ('0', 'A1 WALLS')   ->  ('0', 'A6 PLUMBING')
    #               3 rooms / 2 named       10 rooms / 8 named
    #
    # This is the shared-basis rule that `solve/verify.py` already carries one
    # level up: two measurements of the same quantity must share a basis, not
    # merely a band. `perimeter=False` is kept so the difference stays
    # measurable rather than becoming folklore.
    walls, _labelled, _labelled_unhosted = op.from_text_labels(
        opening_labels or [], walls,
    )
    if perimeter:
        walls = add_perimeter(walls)
        walls = join_corners(walls)

    lo, hi = ROOM_AREA
    spaces = [
        s for s in detect_spaces(walls, labels=labels, classify_room=classify_room)
        if lo <= s.area <= hi
    ]
    holes, unhosted = op.from_sized_blocks(placements, walls, guess_item)

    return Fit(
        walls=len(walls),
        rooms=len(spaces),
        named=sum(1 for s in spaces if s.name),
        doors=len(op.dedupe(holes)),
        unhosted=unhosted,
    )


def select_within_frame(
    faces_by_layer: dict[str, list],
    shortlist: set[str],
    labels,
    placements,
    classify_room,
    guess_item,
    max_layers: int = 6,
    seed: set[str] | None = None,
    opening_labels=None,
) -> tuple[set[str], list[dict]]:
    """
    Choose the wall layers for ONE frame, scored on named rooms.

    ── Two things make this work where the sheet-wide version failed ────────
    1. **Scope it to a frame.** Elevations are drawn beside the plan, so
       restricting to the plan's own extent excludes them by geometry rather
       than by name — measured: `A1 ELEV` contributes 0 of its 320 faces inside
       the plan frame. No heuristic required, and nothing to get wrong.

       It also turns out the layers are per-PLAN, not per-sheet: on one real
       drawing `A5 FALSE CEILING` has 284 of its 285 faces inside the plan frame
       while `A1 WALLS` has fewer than twelve. Different drawings on one sheet
       were authored with different layer conventions, so a sheet-wide answer is
       the wrong shape of answer.

    2. **Score on the drawing's own annotations**, not on loop count. See
       `fit_of`.

    Bootstrapping is deliberate: the frame comes from the conservative
    name-heuristic set, which is plan-only and therefore lands in the right
    place even when it misses most of the walls. Frames first, layers second,
    geometry last.
    """
    candidates = sorted(n for n in shortlist if n in faces_by_layer)
    chosen: set[str] = set(seed or ()) & set(candidates)
    pool: list = [
        face for name in sorted(chosen) for face in faces_by_layer[name]
    ]
    best = (
        fit_of(
            pool, labels, placements, classify_room, guess_item,
            opening_labels=opening_labels,
        )
        if pool
        else Fit(
            0, 0, 0, 0,
            sum(1 for placement in placements
                if guess_item(placement.get("block", "")) in ("door", "window")),
        )
    )
    trace: list[dict] = []
    if chosen:
        trace.append({"seeded": sorted(chosen), **best.as_dict()})

    for _ in range(min(max_layers, len(candidates))):
        winner, winner_fit, winner_pool = None, best, None

        for name in candidates:
            if name in chosen:
                continue
            trial = pool + faces_by_layer[name]
            fit = fit_of(
                trial, labels, placements, classify_room, guess_item,
                opening_labels=opening_labels,
            )
            if efficient_improvement(best, fit) and fit.score > winner_fit.score:
                winner, winner_fit, winner_pool = name, fit, trial

        if winner is None:
            break

        trace.append({"added": winner, **winner_fit.as_dict()})
        chosen.add(winner)
        pool = winner_pool
        best = winner_fit

    return chosen, trace


def select_wall_layers(
    faces_by_layer: dict[str, list],
    shortlist: set[str],
    max_layers: int = 8,
) -> tuple[set[str], list[dict]]:
    """
    Choose the layer set that encloses the most rooms.

    ── Why pairing alone is not enough ──────────────────────────────────────
    Scored on its own linework, `A5 FALSE CEILING` looks exactly like a wall
    layer: 69 pairs at a consistent 0.230 m. So do elevations, plumbing runs and
    hatch boundaries. Any two parallel lines a wall's-width apart pair, and a
    great deal of a drawing is parallel lines.

    What only walls do is *close*. A false-ceiling outline pairs beautifully and
    encloses nothing anyone can stand in. So the objective here is the thing we
    actually want — rooms — and the search is greedy forward selection over the
    shortlist, adding whichever layer contributes the most new rooms until none
    contributes any.

    Greedy rather than exhaustive because wall layers are complementary, not
    competing: partitions on one layer and structure on another both help.

    ── DO NOT APPLY THIS AUTOMATICALLY ──────────────────────────────────────
    Measured on `DOWN VILLA -WD 22-1-24.dxf`. This search picks 8 layers and
    reaches 25 rooms against the name heuristic's 9 — and the model it produces
    is *worse*:

        by name        9 rooms,  4 named,  7 doors
        by this search 16 rooms, 0 named,  0 doors   <- passes the verify gate

    It selects `A1 ELEV`, which is the elevation drawings. Elevations are drawn
    beside the plan on the same sheet, so including them expands the frame away
    from the plan — and every room label and every door then falls outside it.
    More closed loops, less building, and nothing downstream notices because
    loops are what the objective asked for.

    That is the general shape of the failure: room count is a proxy, and this
    optimises the proxy. The output is diagnostic evidence for a human, and the
    per-layer table above it is the more useful half.

    Returns the chosen set and the trace, so the choice can be shown rather than
    asserted.
    """
    candidates = [name for name in shortlist if name in faces_by_layer]
    chosen: set[str] = set()
    pool: list = []
    best_rooms = 0
    trace: list[dict] = []

    for _ in range(min(max_layers, len(candidates))):
        best_name, best_score, best_pool = None, best_rooms, None

        for name in candidates:
            if name in chosen:
                continue
            trial = pool + faces_by_layer[name]
            score = _rooms_from(trial)
            if score > best_score:
                best_name, best_score, best_pool = name, score, trial

        if best_name is None or best_score - best_rooms < MIN_GAIN:
            break

        trace.append({
            "added": best_name,
            "rooms": best_score,
            "gain": best_score - best_rooms,
        })
        chosen.add(best_name)
        pool = best_pool
        best_rooms = best_score

    return chosen, trace
