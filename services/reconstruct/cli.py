"""
The reconstruction CLI.

    python -m cli survey --input <file.dwg|file.dxf> [--json out.json]

`survey` is the free, read-only first pass: what is in this drawing, what units
is it in, what does each layer hold, and — the part that matters here — what is
furniture and what is not.

It is deliberately separate from `reconstruct`. A survey answers the questions a
human has to answer before a solve is worth running (which unit? which layers?
which of the five plans on this sheet?), and answering them costs nothing.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify.elements import classify_footprint, classify_layer, classify_room  # noqa: E402
from ingest import blocks as blk  # noqa: E402
from vendor import cad_kernel as kernel  # noqa: E402


def _as_dxf(path: Path, work: Path) -> tuple[Path, dict | None]:
    """DWG goes through the gate; DXF is already what we want."""
    if path.suffix.lower() != ".dwg":
        return path, None

    from ingest.dwg import to_dxf

    converted, receipt = to_dxf(path, work)
    return converted, receipt.as_dict()


#: Layer names that are never wall FACES even when they mention walls.
#:
#: Kept deliberately short. An earlier version of this list also excluded
#: `hidden`, on the reasoning that a hidden-linetype layer is a dashed underlay
#: of the storey above. On a real drawing `A1 WALLS HIDDEN` turned out to carry
#: 838 m of linework at 4.3 m per segment — the main wall run — and excluding it
#: cut the model from 126 walls to 26 and left the building with no rooms at all.
#:
#: That is the whole lesson of `cad.py`'s layer discussion, learned again: the
#: name heuristic PRE-SELECTS and never decides. What remains here are the two
#: cases where the name describes something drawn *on* a wall rather than the
#: wall itself, and even these are overridable with `--layers`.
_NOT_WALL_FACES = re.compile(r"tile|hatch|text|dim", re.I)


def default_wall_layers(reading: dict) -> set[str]:
    """Wall layers, as a starting point the caller is expected to review."""
    return {
        r["name"] for r in reading["layers"]
        if r["guess"] == "wall" and not _NOT_WALL_FACES.search(r["name"])
    }


#: Forcing a unit. `$INSUNITS` is a hint and it is routinely wrong — see the
#: scaleCandidates the survey prints. Overriding is how you test a candidate
#: before committing a solve to it.
UNIT_SCALES = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}


def survey(input_path: str, work_dir: str, unit: str | None = None) -> dict:
    source = Path(input_path)
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)

    dxf_path, converter = _as_dxf(source, work)

    # Recover once. On a 100k-entity real sheet, DXF recovery is the dominant
    # cost; reading geometry, annotations, and INSERTs through three separately
    # recovered documents consumed 48.5 of 62.1 profiled seconds.
    doc, auditor = blk.open_dxf(str(dxf_path))
    reading = kernel.read(str(dxf_path), doc=doc, auditor=auditor)

    # An override rescales everything the reader measured. The reader's own
    # numbers stay on the report as `headerUnit`, because the disagreement
    # between what the file claims and what the geometry implies is exactly
    # what a human is being asked to settle.
    header_unit, header_scale = reading["unit"], reading["scale"]
    if unit:
        if unit not in UNIT_SCALES:
            raise SystemExit(f"Unknown unit {unit!r}. One of: {', '.join(UNIT_SCALES)}")
        factor = UNIT_SCALES[unit] / header_scale
        reading["scale"] = UNIT_SCALES[unit]
        reading["unit"] = unit
        reading["extent"] = round(reading["extent"] * factor, 2)

    scale = reading["scale"]
    origin = reading["_origin"]

    footprints = blk.block_footprints(doc, scale)

    # Only text that actually names a room can act as room context. The nearest
    # *text* to a sofa is very often a dimension or a note, and letting those
    # win means the sofa is contextualised by the string "3.40" — which is
    # worse than having no context at all, because it silently reads as one.
    labels = blk.usable_room_labels(blk.room_labels(doc, scale, origin))

    # Wall linework only — this is what "against a wall" is measured against,
    # and running it over every segment in the drawing would measure distance
    # to the nearest dimension line instead.
    wall_layers = {r["name"] for r in reading["layers"] if r["guess"] == "wall"}
    wall_segments = [s for s in reading["_segments"] if s.layer in wall_layers]

    placed = kernel.furniture(str(dxf_path), reading, doc=doc)

    results = []
    for placement in placed["placements"]:
        name = placement["block"]
        w, d = footprints.get(name, (0.0, 0.0))
        px, py = placement["position"]["x"], placement["position"]["y"]

        room = blk.nearest_room(px, py, labels)
        gap = blk.wall_proximity(px, py, wall_segments, scale, origin) if wall_segments else 999.0

        verdict = classify_footprint(
            width=w,
            depth=d,
            block=name,
            layer=placement["layer"],
            room_name=room,
            against_wall=gap <= blk.AGAINST_WALL_M,
            guess_item=kernel.guess_item,
        )

        results.append(
            {
                "block": name,
                "layer": placement["layer"],
                "position": placement["position"],
                "rotation": placement["rotation"],
                "footprint": {"w": round(w, 3), "d": round(d, 3)},
                "room": room,
                "roomKind": classify_room(room),
                "wallGap": round(gap, 3) if gap < 900 else None,
                **verdict.as_dict(),
            }
        )

    by_label = Counter(r["label"] for r in results)
    by_item = Counter(r["item"] for r in results if r["item"])
    by_room = Counter(r["roomKind"] for r in results)
    review = sum(1 for r in results if r["needsReview"])

    return {
        "source": str(source),
        "dxf": str(dxf_path),
        "converter": converter,
        "unit": reading["unit"],
        "headerUnit": header_unit,
        "headerScale": header_scale,
        "unitOverridden": bool(unit),
        "scale": scale,
        "extent": reading["extent"],
        "scaleCandidates": reading["scaleCandidates"],
        "auditErrors": reading["audit"],
        "layers": reading["layers"][:40],
        "wallLayers": sorted(wall_layers),
        "counts": {
            "layers": len(reading["layers"]),
            "blockDefinitions": len(footprints),
            "placements": len(results),
            "roomLabels": len(labels),
            "wallSegments": len(wall_segments),
            "needsReview": review,
        },
        "census": {
            "byLabel": dict(by_label.most_common()),
            "byItem": dict(by_item.most_common(25)),
            "byRoomKind": dict(by_room.most_common()),
        },
        "placements": results,
    }


#: Storey height when the drawing does not say. Indian residential floor-to-floor
#: is typically 3.0-3.2 m; 2.7 m clear is a safe interior wall height and is what
#: the studio's own defaults use.
DEFAULT_WALL_HEIGHT = 2.7


def reconstruct(
    input_path: str,
    work_dir: str,
    out_dir: str,
    unit: str | None = None,
    layers: list[str] | None = None,
    height: float = DEFAULT_WALL_HEIGHT,
    frame_index: int = 0,
    with_fixtures: bool = True,
    auto_layers: bool = False,
    with_perimeter: bool = True,
    with_storeys: bool = False,
    with_roof: bool = False,
    building_index: int | None = None,
) -> dict:
    """
    Drawing -> walls, rooms, openings, fixtures -> GLB.

    One frame, one storey. No solver and no residual queue yet — what this
    proves is that the whole chain from a real DWG to a furnished, room-bearing
    3D asset closes without a human in the middle.
    """
    from build.glb import MeshBuilder, write_glb
    from build.solidify import (
        build_fixtures, build_room_finishes, build_room_slabs, build_roof,
        build_marked_stairs, build_stairs, build_walls, open_stair_cores,
    )
    from classify.catalogue_dims import CATALOGUE_DIMS
    from hypothesise import openings as op
    from hypothesise.pair import (
        Face, join_corners, pair_faces, summarise, summarise_by_layer,
    )
    from solve import site
    from solve import spaces as sp
    from solve.frames import MIN_WALLS, segment_frames
    from hypothesise.perimeter import add_perimeter
    from hypothesise.perimeter import summarise as perimeter_summary
    from solve import verify as vf

    source = Path(input_path)
    work, out = Path(work_dir), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    dxf_path, converter = _as_dxf(source, work)
    # One recovered document feeds geometry, text, titles, and block INSERTs.
    # Re-opening the same malformed-but-readable DXF at each stage dominated
    # end-to-end runtime on the corpus and produced no independent evidence.
    doc, auditor = blk.open_dxf(str(dxf_path))
    reading = kernel.read(str(dxf_path), doc=doc, auditor=auditor)

    header_unit, header_scale = reading["unit"], reading["scale"]
    if unit:
        if unit not in UNIT_SCALES:
            raise SystemExit(f"Unknown unit {unit!r}. One of: {', '.join(UNIT_SCALES)}")
        reading["scale"] = UNIT_SCALES[unit]
    scale = reading["scale"]
    ox, oy = reading["_origin"]

    # Layers are chosen, never guessed. `classify()` pre-selects and the caller
    # overrides — there is no layer-naming convention to rely on, and a hard
    # list works for exactly the drawing it was written against.
    chosen = set(layers) if layers else default_wall_layers(reading)

    # ---- Ask the walls what unit this is ------------------------------------
    # The reader offers candidates filtered by the drawing's overall EXTENT
    # (`_PLAUSIBLE = (3.0, 400.0)` in the vendored kernel), which discards the
    # right answer on any sheet bigger than a building — a site plan is not a
    # building. That inverts the kernel's own documented trust order, which is
    # measured > header > extent.
    #
    # So measure. `classify/units.py` scores each candidate by how many walls
    # land on a thickness a mason actually builds, and it is decisive: on the
    # seven real drawings here it agrees with itself at 6.7x to 12.5x margins
    # and DISAGREES with the reader on four of them.
    #
    # Never overrides `--unit`. A human who has said what the drawing is has
    # answered the question, and re-asking it is how you lose their calibration.
    unit_verdict = None
    if not unit:
        from classify.units import rank_units

        unit_verdict = rank_units(
            [s for s in reading["_segments"] if s.layer in chosen],
            reading["_origin"],
        )
        best = unit_verdict.best
        if unit_verdict.decided and best and abs(best.scale - reading["scale"]) > 1e-9:
            reading["scale"] = best.scale
            reading["unit"] = f"{best.label} (measured)"
            scale = best.scale

    faces = [
        Face(
            ax=(s.x1 - ox) * scale, ay=(s.y1 - oy) * scale,
            bx=(s.x2 - ox) * scale, by=(s.y2 - oy) * scale,
            layer=s.layer,
        )
        for s in reading["_segments"]
        if s.layer in chosen
    ]

    all_walls = join_corners(pair_faces(faces))

    # One frame, always. A sheet holds several drawings and reconstructing them
    # as one building yields a wall graph with no closed cycles — see
    # solve/frames.py. Defaulting to the largest is a stated choice, not an
    # accident of file order.
    frames = segment_frames(all_walls)

    # ── When NOTHING clears the wall floor ──────────────────────────────────
    # This used to fall through to "reconstruct the whole sheet", and because an
    # empty list is falsy the FRAMES block below was skipped entirely — so four
    # separate unit plans of seven walls each fused into one 98 m building, and
    # the operator saw output indistinguishable from a clean single-drawing file.
    # Verify passed with 0 blocking and 0 warnings.
    #
    # Fusing several drawings is strictly worse than building one of them, so
    # take the largest cluster instead. Do NOT lower MIN_WALLS to avoid this —
    # 8 is what keeps north arrows and title blocks out.
    framing_note = ""
    if not frames:
        loose = segment_frames(all_walls, min_walls=1)
        if loose:
            frames = loose[:1]
            framing_note = (
                f"no drawing on this sheet reached the {MIN_WALLS}-wall floor; "
                f"building the largest cluster ({len(loose[0].wall_indices)} of "
                f"{len(all_walls)} walls) and ignoring {len(loose) - 1} other(s)"
            )

    # The pick itself happens BELOW, after the ranking pass — which needs the
    # titles and labels read first. Nothing between here and there consumes it.
    # ---- What the drawing calls each frame ---------------------------------
    # The sheet usually says which storey each plan is, in plain TEXT, and until
    # now this file threw every one of them away: the label filter below keeps
    # only text that `classify_room` recognises, and a floor-plan title is not a
    # room kind. Nine titles on the villa, all discarded — including 'Ground
    # Floor Plan' and 'Lower Ground Floor Plan', which are the answer to the
    # hardest question in storey registration.
    #
    # ── Why the title and not the position ──────────────────────────────────
    # Measured on the villa: the frame HIGHER on the sheet is titled 'Lower
    # Ground Floor Plan' and the frame LOWER on the sheet is 'Ground Floor
    # Plan'. Sheet position is INVERTED against storey order on that drawing.
    # Ordering storeys by where they sit on the paper puts the lawn upstairs.
    sheet_titles = _real_plan_titles(blk.plan_titles(doc, scale, (ox, oy)))
    for frame in frames:
        fx0, fy0, fx1, fy1 = frame.bbox
        # Strict containment, no padding. A title sitting just outside one
        # frame is usually just inside the next one along, and a generous
        # tolerance gives two frames the same title without erroring.
        named = [t for t in sheet_titles if fx0 <= t.x <= fx1 and fy0 <= t.y <= fy1]
        if named:
            frame.title = named[0].text

    # ---- Annotations, read once ---------------------------------------------
    # `room_labels` queries the modelspace on every call, and the ranking pass
    # below asks about every frame on the sheet — 40 of them on a real drawing.
    # One query, filtered per ask. classify_room is pure, so this is the same
    # list the per-call version produced, forty times cheaper.
    _sheet_text = blk.room_labels(doc, scale, (ox, oy))
    _sheet_labels = blk.usable_room_labels(_sheet_text)
    _sheet_opening_labels = blk.opening_labels(_sheet_text)

    # Compact residential drawings sometimes omit formal plan titles and label
    # only the stair: UP on the lower plan, DOWN on the upper. That is textual
    # relative-level evidence, not a positional guess.
    stair_markers = blk.stair_level_markers(doc, scale, (ox, oy))
    for frame in frames:
        if frame.title:
            continue
        fx0, fy0, fx1, fy1 = frame.bbox
        within = [
            marker for marker in stair_markers
            if fx0 <= marker.x <= fx1 and fy0 <= marker.y <= fy1
        ]
        # More than one direction on a frame is a multi-flight stair and does
        # not establish that frame's relative storey.
        if len(within) == 1:
            frame.level_hint = within[0].level
            frame.level_label = within[0].label

    def _labels_in(a, b, c, d):
        return [
            lb for lb in _sheet_labels
            if a - 2 <= lb.x <= c + 2 and b - 2 <= lb.y <= d + 2
        ]

    def _opening_labels_in(a, b, c, d):
        return [
            lb for lb in _sheet_opening_labels
            if a - 2 <= lb.x <= c + 2 and b - 2 <= lb.y <= d + 2
        ]

    placed = kernel.furniture(str(dxf_path), reading, doc=doc)
    frame_layer_cache: dict[tuple[float, float, float, float], tuple] = {}

    def _blocks_in(a, b, c, d):
        return [
            q for q in placed["placements"]
            if a - 1 <= q["position"]["x"] <= c + 1
            and b - 1 <= q["position"]["y"] <= d + 1
        ]

    def _choose_frame_layers(a, b, c, d, labels, in_frame, text_openings):
        """
        Choose the wall layers for one frame and pair its pool.

        ONE implementation, shared by the ranking pass and the build
        (`_solve_frame`), because the layerscan defect this engine already paid
        for was exactly two copies of this decision grading on different bases.
        Returns (walls, selected, trace), or None when the scan chose nothing —
        the caller keeps whatever walls it had.
        """
        from solve import layerscan

        cache_key = (a, b, c, d)
        if cache_key in frame_layer_cache:
            return frame_layer_cache[cache_key]

        within: dict[str, list] = {}
        for seg in reading["_segments"]:
            face = Face(
                ax=(seg.x1 - ox) * scale, ay=(seg.y1 - oy) * scale,
                bx=(seg.x2 - ox) * scale, by=(seg.y2 - oy) * scale, layer=seg.layer,
            )
            if (min(face.ax, face.bx) >= a - 1 and max(face.ax, face.bx) <= c + 1
                    and min(face.ay, face.by) >= b - 1 and max(face.ay, face.by) <= d + 1):
                within.setdefault(seg.layer, []).append(face)

        scores = layerscan.scan(within)
        score_by_name = {score.name: score for score in scores}
        measured = layerscan.recommended(scores)
        shortlist = {
            name for name in measured
            if fallback_wall_layer_candidate(
                name, len(within[name]), score_by_name.get(name),
            )
        } | (set(chosen) & set(within))
        # A partitions layer may carry centrelines rather than paired wall
        # faces. Scored alone it has no wall thickness and never reaches the
        # shortlist, even though adding it to the exterior wall layer is what
        # closes the drawing's named rooms. Inside one already-isolated frame,
        # let the label/door fit test judge every non-annotation layer with
        # enough real linework to matter.
        shortlist.update(
            name for name, layer_faces in within.items()
            if len(layer_faces) >= 4
            and fallback_wall_layer_candidate(
                name, len(layer_faces), score_by_name.get(name),
            )
        )
        selected, trace = layerscan.select_within_frame(
            within, shortlist, labels, in_frame, classify_room, kernel.guess_item,
            seed=set(chosen) & set(within),
            opening_labels=text_openings,
        )
        if not selected:
            return None
        # `sorted`, because `selected` is a set of layer NAME STRINGS and Python
        # randomises string hashing per process. Iterating it directly built the
        # wall-face pool in a different order on every run, and pairing and
        # corner-joining are order-sensitive — so the same drawing produced 148
        # walls / 260.3 m2 on one run and 147 / 259.4 on the next, with no code
        # change between them. That is a quotation that changes when you re-run
        # it.
        #
        # PYTHONHASHSEED=0 pins it, which is how this was identified, but
        # pinning the seed hides the dependency rather than removing it. Sorting
        # cannot change WHICH layers were chosen, only the order they are read
        # in.
        pool = [f for name in sorted(selected) for f in within[name]]
        result = (join_corners(pair_faces(pool)), selected, trace)
        frame_layer_cache[cache_key] = result
        return result

    # ---- Which frame is the plan? Grade the candidates, then say so. --------
    # `frames[0]` used to be whichever cluster carried the most wall segments —
    # a guess on a many-drawing sheet, and a measured-wrong one: dense elevation
    # linework outranks a sparse floor plan. On `ALL PLANS` the wall-count
    # leader carries ZERO recognised room labels and reconstructs to 11 rooms
    # none of which the sheet names, while frame 12, titled FIRST FLOOR PLAN,
    # reconstructs to 15 rooms with 10 named.
    #
    # An earlier attempt (recorded here as TRIED, MEASURED, AND REVERTED) chose
    # by storey TITLE and produced a worse building, because the layer scan of
    # the day mis-graded the ground-floor frame. That defect is fixed (`fit_of`
    # now grades on the pipeline's own basis), and this pass keeps the lesson:
    # a frame is picked by what it RECONSTRUCTS INTO, not by any prior about
    # what it is. Grade the plausible candidates the exact way the build would,
    # and take the one with the most NAMED rooms.
    #
    # Named rooms, not raw label count and not room count — both were measured
    # and both lie: on PLANS_FOR_3D the label-count leader (11 labels) grades to
    # ZERO rooms (annotation over no closable walls), and unnamed room count
    # promotes elevations whose hatching closes into boxes. Named rooms cannot
    # be gamed from either side; it is the same objective the layer scan itself
    # settled on, one level up.
    #
    # Measured across the six-sheet corpus (2026-08-24, graded through the
    # pipeline's own per-frame scan + perimeter):
    #
    #     DOWN VILLA        #0 (13 named)  == wall-count pick, unchanged
    #     PLANS_FOR_3D      #1 (5 named, 6 rooms)   over #0 (2 named)
    #     ALL PLANS         #12 FIRST FLOOR PLAN (10 named, 15 rooms)
    #                                               over #0 (0 named)
    #     SITE PLAN 16-02   #2 (33 named, 60 rooms) over #0 site plan (0 named)
    #     REDDY / GARDEN    unchanged (agreement / single frame)
    #
    # The compound-wall constraint that made wall count load-bearing still
    # holds: 8 walls over 28 m with 0 labels grades to 0 named and stays last.
    #
    # Cost: at most eight per-frame layer scans per import, only on multi-frame
    # sheets, only when the layers are not a human's explicit choice.
    frame_ranking = None
    if auto_layers and not layers and len(frames) > 1:
        from solve import layerscan

        def _plan_evidence(frame) -> int:
            fa, fb, fc, fd = frame.bbox
            return len(_labels_in(fa, fb, fc, fd))

        by_walls = sorted(frames, key=lambda f: -len(f.wall_indices))[:4]
        by_labels = sorted(
            frames, key=lambda f: (-_plan_evidence(f), -len(f.wall_indices)),
        )[:2]
        # Raw label count favours a generous bbox that covers several stacked
        # plans. Preserve a lane for compact, explicitly titled floor plans:
        # on ALL PLANS the six-candidate cap contained four fused regions while
        # omitting the individually framed FIRST FLOOR PLAN beside them.
        def _frame_area(frame) -> float:
            fa, fb, fc, fd = frame.bbox
            return max(0.0, fc - fa) * max(0.0, fd - fb)

        def _floor_title_priority(frame) -> int:
            title = frame.title.upper()
            if "FIRST FLOOR" in title:
                return 0
            if "GROUND FLOOR" in title:
                return 1
            if "SECOND FLOOR" in title:
                return 2
            if "STILT FLOOR" in title:
                return 3
            return 4

        by_titled = sorted(
            (
                f for f in frames
                if f.title and "FLOOR" in f.title.upper()
                and "ROOF" not in f.title.upper()
            ),
            key=lambda f: (
                _floor_title_priority(f), _frame_area(f), -_plan_evidence(f),
            ),
        )[:4]
        # Each lane has a real budget. Appending four candidates from every
        # lane and truncating once at the end let the wall/label lanes consume
        # seven of eight slots, so the compact-title lane existed in code but
        # its actual floor-plan candidates were never graded.
        #
        # Order-stable dedupe (by identity — Frame is an eq-dataclass and
        # unhashable), wall-count candidates first: ties in the grade below
        # resolve toward the incumbent rule, so a sheet where grading cannot
        # separate the candidates behaves exactly as it always did.
        shortlist: list = []
        for f in [*by_walls, *by_labels, *by_titled]:
            if all(f is not g for g in shortlist):
                shortlist.append(f)
        shortlist = shortlist[:8]

        lo_area, hi_area = layerscan.ROOM_AREA
        graded: list[tuple] = []  # (frame, named, rooms, area, labels, error)
        for frame in shortlist:
            fa, fb, fc, fd = frame.bbox
            labs = _labels_in(fa, fb, fc, fd)
            opening_labs = _opening_labels_in(fa, fb, fc, fd)
            blocks = _blocks_in(fa, fb, fc, fd)
            contained = contained_frame_count(frame, frames)
            if contained:
                graded.append((
                    frame, 0, 0, 0.0, len(labs),
                    f"scope contains {contained} independently framed drawing"
                    + ("" if contained == 1 else "s"),
                ))
                continue
            try:
                scanned = _choose_frame_layers(
                    fa, fb, fc, fd, labs, blocks, opening_labs,
                )
                frame_walls = (
                    scanned[0] if scanned
                    else [all_walls[i] for i in frame.wall_indices]
                )
                # ── A candidate whose scope fuses several drawings must lose ──
                # Measured on LATEST DRAWINGS: an 11-wall stray cluster whose
                # bbox spans the whole 1,234 m sheet re-pulls 2,377 walls and
                # grades at 77 named rooms — the ENTIRE SHEET fused into one
                # "building", outscoring every real plan. The grade is honest
                # (picking that frame would build exactly that), which is why
                # the disqualification uses the engine's own definition of
                # "separate drawings" rather than a new constant: if the
                # candidate's walls segment into more than one frame, its scope
                # is a sheet region, not a drawing. Checked BEFORE the
                # perimeter, which closes on centrelines and could bridge two
                # drawings into one ring, hiding the fusion.
                sub_frames = segment_frames(frame_walls)
                if len(sub_frames) > 1:
                    graded.append((
                        frame, 0, 0, 0.0, len(labs),
                        f"scope fuses {len(sub_frames)} drawings",
                    ))
                    continue
                if with_perimeter:
                    frame_walls = join_corners(add_perimeter(frame_walls))
                rooms_all = sp.detect_spaces(
                    frame_walls, labels=labs, classify_room=classify_room,
                )
                separated = vf.separated_room_groups(rooms_all)
                if separated is not None:
                    gap, _extent = separated
                    graded.append((
                        frame, 0, 0, 0.0, len(labs),
                        f"reconstructed rooms split across a {gap:.2f} m gap",
                    ))
                    continue
                preflight = vf.check(
                    input_segments=len(frame_walls),
                    walls=frame_walls,
                    spaces=rooms_all,
                    openings=[],
                    unhosted=0,
                )
                rejected = next(
                    (
                        c for c in preflight.checks
                        if c.level == "blocking"
                        or (c.name == "envelope-coverage" and c.level != "info")
                    ),
                    None,
                )
                if rejected is not None:
                    graded.append((
                        frame, 0, 0, 0.0, len(labs),
                        f"preflight {rejected.name}: {rejected.message}",
                    ))
                    continue
                rooms_g = [
                    s for s in rooms_all
                    if lo_area <= s.area <= hi_area
                ]
                graded.append((
                    frame,
                    sum(1 for s in rooms_g if s.name),
                    len(rooms_g),
                    round(sum(s.area for s in rooms_g), 2),
                    len(labs),
                    None,
                ))
            except Exception as exc:  # noqa: BLE001 — an ungradable frame loses, loudly
                graded.append((frame, 0, 0, 0.0, len(labs), str(exc)))

        best = best_eligible_graded_index(
            [(g[1], g[2], g[3]) for g in graded],
            [g[5] for g in graded],
        )
        winner = graded[best][0]
        promoted = winner is not frames[0]
        if promoted:
            leader = frames[0]
            frames.remove(winner)
            frames.insert(0, winner)
            for n, f in enumerate(frames):
                f.index = n
            framing_note = (framing_note + "; " if framing_note else "") + (
                f"picked the frame by what it reconstructs into: "
                f"{graded[best][1]} named rooms "
                f"({winner.title or 'untitled'}, {len(winner.wall_indices)} walls) "
                f"over the wall-count leader "
                f"({leader.title or 'untitled'}, {len(leader.wall_indices)} walls)"
            )
        # A winner that could not be graded as ONE drawing is still built from
        # its bbox, and that build will contain whatever the bbox contains.
        # Say so — a model quietly holding two buildings is the failure this
        # whole file exists to prevent, and on one real sheet (ALL PLANS) every
        # candidate fuses because the bootstrap merged a stacked column of
        # storey plans. The ranking cannot fix that; it can refuse to hide it.
        for f, _n, _r, _a, _l, err in graded:
            if f is frames[0] and err:
                framing_note = (framing_note + "; " if framing_note else "") + (
                    f"the picked frame could not be graded as one drawing "
                    f"({err}) — the model may contain more than one building"
                )
                break

        # ── When NOTHING graded cleanly, the pick is not a judgement --------
        # `best_eligible_graded_index` falls back to the wall-count incumbent
        # when no candidate is error-free, and that fallback is deliberate: a
        # broken grade is no basis for promoting anything. What was missing is
        # that the operator was never told it had happened, so a fallback read
        # exactly like a decision.
        #
        # Measured on `SITE PLAN FOR 3D`. All four candidates errored. The
        # incumbent was frame 0, the 833 m `REVISED SITE PLAN` — a site layout,
        # which has no doors by nature and BLOCKS on two checks. Frame 2 was
        # rejected for the mildest of the four reasons ("rooms split across a
        # 10.82 m gap") and builds a model that PASSES, with 15 hosted doors.
        # A whole day was spent reading that as missing opening detection.
        #
        # This does not change the pick. Choosing between four broken grades by
        # ranking their errors would need a severity order invented here, and
        # the rejected candidate is not reliably the better one. It states what
        # happened and names the alternatives, which is what the operator needs
        # to type `--frame N` and see for themselves.
        fallback = fallback_frame_note(graded, frames[0])
        if fallback:
            framing_note = (framing_note + "; " if framing_note else "") + fallback

        # Materialised AFTER any re-index, so the frame numbers here are the
        # ones the rest of the report uses.
        frame_ranking = {
            "picked": winner.index,
            "promoted": promoted,
            "graded": [
                {
                    "frame": f.index, "title": f.title, "named": named,
                    "rooms": rooms, "area": area, "labels": labels_n,
                    **({"error": err} if err else {}),
                }
                for f, named, rooms, area, labels_n, err in graded
            ],
        }

    # ---- The pick -----------------------------------------------------------
    if frames:
        picked = frames[min(frame_index, len(frames) - 1)]
        walls = [all_walls[i] for i in picked.wall_indices]
        x0, y0, x1, y1 = picked.bbox
    else:
        picked = None
        walls = all_walls
        xs = [c for w in walls for c in (w.ax, w.bx)] or [0]
        ys = [c for w in walls for c in (w.ay, w.by)] or [0]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        framing_note = (
            f"no frames at all; building the WHOLE sheet as one drawing "
            f"({len(all_walls)} walls)"
        )

    # ---- Are any of these storeys of one building? -------------------------
    # AFTER the ranking pass on purpose: registration stores frame INDICES, and
    # the promotion above re-numbers them. Registering first would leave every
    # level pointing one frame to the left of the plan it named.
    from solve.storeys import register_storeys

    storeys = register_storeys(frames, rise=height + 0.3)

    # ── One storey, end to end ──────────────────────────────────────────────
    # Extracted so it can run more than once. `storey0` is hardcoded through the
    # engine and a house has floors; running this per storey is the remaining
    # half of that work.
    #
    # Extracted FIRST, changing nothing, and proved byte-identical on all seven
    # real drawings before anything loops it. A refactor that is not proven
    # identical is a refactor that has silently changed the building — and every
    # failure in this engine produces a building rather than an error.
    #
    # What the frame's rooms turned out to be — one building, or a site holding
    # several. Filled by `_solve_frame` because that is where the rooms exist,
    # read by the model assembly below. A list rather than a single slot so a
    # multi-storey stack records one entry per storey instead of the last one
    # quietly overwriting the rest.
    site_reports: list[dict] = []

    # Nested rather than top-level on purpose: it closes over the reading, the
    # document, the block placements and the scale, all of which are per-SHEET.
    # Only the walls, the bbox and the base are per-storey.
    def _solve_frame(frame_walls, bbox, base_z: float = 0.0) -> dict:
        frame_bbox = bbox
        x0, y0, x1, y1 = bbox
        walls = frame_walls
        chosen_here = set(chosen)

        labels = _labels_in(x0, y0, x1, y1)
        text_openings = _opening_labels_in(x0, y0, x1, y1)
        in_frame = _blocks_in(x0, y0, x1, y1)

        # ---- Second pass: choose the layers for THIS frame ---------------------
        # The first pass used the conservative name heuristic, which is plan-only
        # and so lands on the right part of the sheet even when it misses most of
        # the walls. That frame now scopes the layer search — which is what excludes
        # the elevation layers by geometry rather than by name. The scan itself
        # is `_choose_frame_layers`, shared with the ranking pass — one
        # implementation, so the frame that was picked for how it reconstructs
        # is reconstructed by the same decision that graded it.
        layer_choice = None
        if auto_layers and not layers:
            scanned = _choose_frame_layers(
                x0, y0, x1, y1, labels, in_frame, text_openings,
            )
            if scanned:
                walls, selected, trace = scanned
                chosen_here = selected
                layer_choice = {"selected": sorted(selected), "trace": trace}

        # ---- Re-scope annotations to where the walls actually are ---------------
        # The frame bbox comes from the bootstrap pass and is deliberately generous.
        # Blocks inside it but far outside the wall extent are not part of the
        # building: on one real drawing, 16 of 28 door blocks sat in a 6 x 3 m
        # corner with no walls anywhere near them — a door SCHEDULE, a legend of
        # door types. Counting those as doors we failed to place made the verify
        # gate block a model that was fine.
        #
        # The wall extent is the honest boundary: annotation that belongs to the
        # building sits on the building.
        if walls:
            wx0 = min(min(w.ax, w.bx) for w in walls)
            wx1 = max(max(w.ax, w.bx) for w in walls)
            wy0 = min(min(w.ay, w.by) for w in walls)
            wy1 = max(max(w.ay, w.by) for w in walls)
            x0, y0, x1, y1 = wx0, wy0, wx1, wy1
            labels = _labels_in(x0, y0, x1, y1)
            text_openings = _opening_labels_in(x0, y0, x1, y1)
            in_frame = _blocks_in(x0, y0, x1, y1)

        # ---- The envelope ------------------------------------------------------
        # A partitions-only plan encloses almost nothing, because the largest space
        # in a modern house is open plan and bounded by the building rather than by
        # interior walls. See hypothesise/perimeter.py.
        walls, labelled_holes, labelled_unhosted = op.from_text_labels(
            text_openings, walls,
        )

        # ---- Gaps that opening LINEWORK is sitting in ----------------------
        # Beside the labelled-gap bridge above, and before the rooms, for the
        # same reason it is: this changes geometry, and `detect_spaces`, the
        # wall statistics and the bill all read that geometry afterwards.
        #
        # The opening-layer segments are gathered here rather than at the
        # emitter further down, because by the time the emitter runs the rooms
        # are already solved and a bridge would leave them describing a wall
        # run that no longer exists.
        opening_faces = [
            face
            for segment in reading["_segments"]
            if op.is_opening_layer(segment.layer)
            for face in [Face(
                ax=(segment.x1 - ox) * scale, ay=(segment.y1 - oy) * scale,
                bx=(segment.x2 - ox) * scale, by=(segment.y2 - oy) * scale,
                layer=segment.layer,
            )]
            if x0 - 1 <= min(face.ax, face.bx) and max(face.ax, face.bx) <= x1 + 1
            and y0 - 1 <= min(face.ay, face.by) and max(face.ay, face.by) <= y1 + 1
        ]
        bridge_issues: list[dict] = []
        walls, opening_bridges = op.bridge_opening_runs(
            opening_faces, walls, issues=bridge_issues,
        )
        if with_perimeter:
            walls = add_perimeter(walls)
            # Derived rings and labelled gap bridges are added after the first
            # pairing pass. Snap their endpoints too, or a 75 mm drafting
            # offset leaves a visually closed facade topologically open.
            walls = join_corners(walls)

        wall_stats = summarise(walls)
        wall_stats["perimeter"] = perimeter_summary(walls)

        # ---- Rooms -------------------------------------------------------------
        rooms = sp.detect_spaces(walls, labels=labels, classify_room=classify_room)

        # ---- One building, or a site holding several? ----------------------
        # Only now can this be asked. A site plan's villas are joined by roads,
        # plot lines and the compound wall, so framing correctly returns ONE
        # frame spanning the estate; what separates the buildings is which
        # rooms share a wall, and rooms do not exist until the line above.
        #
        # Recorded on EVERY build, not only when narrowing. The whole-site
        # figures are the evidence a reviewer needs to choose a building, and
        # they are also what makes a later regression visible: a villa that
        # starts reporting two buildings has broken its own wall pairing.
        segmentation = site.segment_site(walls, rooms)
        report = segmentation.as_dict()

        if building_index is not None:
            if not segmentation.buildings:
                raise SystemExit(
                    "--building was given but this frame contains no closed "
                    "rooms, so it holds no buildings to choose between."
                )
            if not 0 <= building_index < segmentation.count:
                raise SystemExit(
                    f"--building {building_index} does not exist: this frame "
                    f"holds {segmentation.count} building(s), numbered 0 to "
                    f"{segmentation.count - 1}."
                )
            picked = segmentation.buildings[building_index]

            # Narrow the WALLS and solve the rooms again, rather than filtering
            # the rooms that were just found. Everything downstream — openings,
            # fixtures, the perimeter, the meshes, the bill — is derived from
            # this wall list, so narrowing here is the one edit that reaches all
            # of them consistently. Filtering the room list instead would leave
            # every one of those still describing the whole site while the room
            # schedule described one villa, and each artefact would look right
            # on its own.
            walls = [walls[i] for i in picked.wall_indices]
            rooms = sp.detect_spaces(
                walls, labels=labels, classify_room=classify_room
            )

            # Every wall statistic above was computed against the WHOLE frame,
            # a few lines before the narrowing could be known. Recompute them,
            # or `elements.walls` carries one building's 102 walls while the
            # summary — and the bill of quantities that reads it — still prices
            # the site's 106. Caught by measurement, not by reasoning: both
            # numbers are individually plausible and nothing downstream
            # compares them.
            wall_stats = summarise(walls)
            wall_stats["perimeter"] = perimeter_summary(walls)
            report["picked"] = {
                "index": building_index,
                "of": segmentation.count,
                "rooms": len(rooms),
                "roomsBefore": len(picked.space_indices),
                "walls": len(walls),
                "area": round(picked.area, 2),
                "span": round(picked.span, 2),
                "bbox": [round(v, 3) for v in picked.bbox],
            }
            # Re-solving can legitimately find a different room count — the
            # narrowed wall set no longer closes faces against its neighbours —
            # so the before/after pair is kept rather than one number that
            # silently changed meaning.

            # The per-building index lists describe the WHOLE frame, and the
            # model no longer contains that frame: `elements.walls` now holds
            # this building's walls renumbered from zero. Indices pointing into
            # a list nobody carries are worse than absent, because they resolve
            # to real entries and quietly name the wrong walls. The counts stay,
            # since a reviewer choosing a building needs them; the pointers go.
            for entry in report["buildings"]:
                entry.pop("spaceIndices", None)
                entry.pop("wallIndices", None)
            report["indicesDropped"] = (
                "counts describe the whole frame; the index lists were removed "
                "because --building renumbered elements.walls and "
                "elements.spaces from zero"
            )

        site_reports.append(report)
        # `labels` is passed so the summary can account for room names the drawing
        # printed and the model never placed. Without it, a dropped label is
        # indistinguishable from a room that was never labelled.
        room_stats = sp.summarise(rooms, labels=labels)

        # ---- Which of that run is actually indoor -------------------------
        # `Space.bounded_by` was in the schema and empty on every space this
        # engine had ever produced. Populated, it answers a question nothing
        # else could: **which walls belong to the rooms people live in.**
        #
        # Before this, `wall-run-per-area` had to report TWO bases — indoor-only
        # and including-site — because it could total a building's wall run but
        # not attribute it. On this villa that matters enormously: more than half
        # the site is outdoor, so the ratio reads a comfortable 1.20 against
        # everything and 2.43 against the indoor rooms alone, and only one of
        # those is a number about a building.
        #
        # A wall is indoor if it bounds at least one indoor room. A party wall
        # between a bedroom and a terrace is therefore indoor, which is right —
        # somebody builds and plasters it, and it is the bedroom's wall.
        from quantify.schedules import _is_outdoor

        indoor_walls: set[int] = set()
        outdoor_walls: set[int] = set()
        for room in rooms:
            side = outdoor_walls if _is_outdoor(room.as_dict()) else indoor_walls
            side.update(room.bounded_by)

        def _run(indices) -> float:
            return round(sum(walls[i].length for i in indices if i < len(walls)), 2)

        wall_stats["attribution"] = {
            "indoorLength": _run(indoor_walls),
            "outdoorOnlyLength": _run(outdoor_walls - indoor_walls),
            # Walls bounding no room at all: the derived envelope's outer face, a
            # compound wall, a railing. Reported separately rather than folded
            # into either, because a large number here means the rooms are not
            # closing and the other two figures are then both understatements.
            "unattributedLength": _run(
                set(range(len(walls))) - indoor_walls - outdoor_walls
            ),
            "roomsIndoor": sum(1 for r in rooms if not _is_outdoor(r.as_dict())),
            "roomsOutdoor": sum(1 for r in rooms if _is_outdoor(r.as_dict())),
        }
        wall_stats["layers"] = summarise_by_layer(walls, indoor_walls)

        opening_issues: list[dict] = []
        # Separate from `opening_issues` on purpose. That list is the review
        # queue of openings that could NOT be hosted, and the API asserts one
        # entry per unassigned opening (services/api/test/cad.mjs:255). An
        # ambiguous host is the opposite finding — the opening WAS placed — so
        # mixing them made 9 issues against 0 unassigned openings and broke two
        # API tests.
        opening_ambiguities: list[dict] = []
        block_holes, block_unhosted = op.from_sized_blocks(
            in_frame, walls, kernel.guess_item, issues=opening_issues,
            ambiguities=opening_ambiguities,
        )

        # ---- Openings the drawing DRAWS rather than blocks ------------------
        # `opening_faces` was gathered before the rooms were solved, because
        # bridging had to happen up there. The same list is emitted from here,
        # against the walls those bridges produced.
        opening_issues.extend(bridge_issues)
        layer_holes, layer_unhosted = op.from_opening_layers(
            opening_faces, walls, issues=opening_issues,
        )

        holes = op.dedupe(labelled_holes + block_holes + layer_holes)
        unhosted = labelled_unhosted + block_unhosted + layer_unhosted
        opening_stats = op.summarise(holes, unhosted)

        fixtures: list[dict] = []
        if with_fixtures:
            footprints = blk.block_footprints(doc, scale)
            # ── Signal 4 is two questions; this path was only asking one ─────
            # `classify_footprint` takes the room AND whether the thing is
            # pressed against a wall. The survey at the top of this file
            # measures the second one. This path — the one that actually builds
            # the GLB — passed a hardcoded `against_wall=False`, which is not
            # "unknown", it is the assertion that nothing in the building
            # touches a wall.
            #
            # That assertion is wrong for precisely the items defined by
            # touching one. `elements.py` reads it both ways: deep-against
            # shapes lose their 1.35x, and counter / overhead / wardrobe /
            # tv-unit are then multiplied by 0.5 for standing free. So the most
            # common built-in furniture in a house was being halved on every
            # reconstruct, while the free survey scored it correctly. A block
            # named `tv unit` — which the kernel resolves to `tv-unit` without
            # help — lost to `wardrobe-small`, and the drawing lost its TV.
            #
            # Solved walls are centrelines, so the faces are half a thickness
            # out on each side; `wall_gap` takes the inset for that reason.
            wall_faces = [(w.ax, w.ay, w.bx, w.by, w.thickness / 2.0) for w in walls]

            # ---- The same object inserted twice is one object ----------------
            #
            # Measured on DOWN VILLA: two `bed-king` fixtures from block
            # `VZXVZXV` 0.008 m apart — eight MILLIMETRES — with identical
            # footprints and identical confidences. That is one bed drawn
            # twice, not two beds, and it produced FIVE bed-kings in a villa
            # with two bedrooms: four in one BED ROOM and two in the FOYER.
            #
            # The engine already noticed and said so. The clearance pass
            # reports "bed-king and bed-king overlap by 3.70 m2 — 99% of the
            # smaller one", and the model shipped both anyway. This is the
            # same shape as every other finding this week: the signal existed
            # and nothing consumed it.
            #
            # Keyed on the BLOCK NAME as well as position, deliberately. Two
            # different blocks at the same point are a genuine stack — a lamp
            # on a table — and collapsing those would delete real furniture.
            # Only the SAME block at the SAME spot is a duplicate insert.
            #
            # 0.05 m, because two identical chairs 5 cm apart is not a room
            # anyone drew, while two identical chairs 1 m apart is a dining
            # set. The gap between a duplicate and a pair is orders of
            # magnitude here, not a threshold to tune: the duplicates measure
            # 0.008 m and the real neighbours 1.08 m.
            DUPLICATE_M = 0.05

            # ---- And the same object drawn twice with an OFFSET -------------
            #
            # Distance alone only catches an exact re-insert. Measured on the
            # same villa, after the 0.05 m rule had already run, two pairs of
            # the SAME BLOCK still overlapped:
            #
            #     bed-king / bed-king   45.6% overlap, 1.09 m apart
            #     plant    / plant      64.1% overlap, 0.49 m apart
            #
            # Two solid objects cannot occupy the same floor. Two instances of
            # ONE block that overlap are therefore one object drawn twice, not
            # two objects — and unlike the cross-item overlaps in the same model
            # (plant against bed-king at 37-40%, different blocks) there is no
            # question of WHICH is wrong, because they are the same thing.
            #
            # 0.30 because distinct same-block objects do not overlap at all —
            # two beds side by side touch at most — so anything above zero is
            # already the anomaly, and 0.30 sits well clear of both the noise
            # floor and the 45.6% actually observed.
            DUPLICATE_OVERLAP = 0.30

            def _footprint_rect(placement):
                """Axis-aligned footprint. Rotations in plan are quarter turns."""
                w, d = footprints.get(placement["block"], (0.0, 0.0))
                if not w or not d:
                    return None
                turned = round((placement.get("rotation") or 0.0) / (math.pi / 2)) % 2
                if turned:
                    w, d = d, w
                px, py = placement["position"]["x"], placement["position"]["y"]
                return (px - w / 2, py - d / 2, px + w / 2, py + d / 2, w * d)

            def _overlap_share(a, b):
                if a is None or b is None:
                    return 0.0
                wide = min(a[2], b[2]) - max(a[0], b[0])
                tall = min(a[3], b[3]) - max(a[1], b[1])
                if wide <= 0 or tall <= 0:
                    return 0.0
                smaller = min(a[4], b[4])
                return (wide * tall) / smaller if smaller else 0.0

            deduped, dropped = [], 0
            for placement in in_frame:
                px, py = placement["position"]["x"], placement["position"]["y"]
                block = placement["block"]
                rect = _footprint_rect(placement)
                if any(
                    kept["block"] == block
                    and (
                        math.hypot(px - kept["position"]["x"],
                                   py - kept["position"]["y"]) <= DUPLICATE_M
                        or _overlap_share(rect, _footprint_rect(kept))
                        >= DUPLICATE_OVERLAP
                    )
                    for kept in deduped
                ):
                    dropped += 1
                    continue
                deduped.append(placement)
            if dropped:
                print(f"ARCVIA_FIXTURE_DUPLICATES:{dropped} placement(s) collapsed "
                      f"(same block within {DUPLICATE_M} m, or overlapping by "
                      f"{DUPLICATE_OVERLAP:.0%})")
            in_frame = deduped

            for placement in in_frame:
                w, d = footprints.get(placement["block"], (0.0, 0.0))
                px, py = placement["position"]["x"], placement["position"]["y"]
                room = next(
                    (r.name for r in rooms
                     if _inside(px, py, r.loop)), None
                )
                verdict = classify_footprint(
                    width=w, depth=d, block=placement["block"], layer=placement["layer"],
                    room_name=room,
                    against_wall=blk.wall_gap(px, py, wall_faces) <= blk.AGAINST_WALL_M,
                    guess_item=kernel.guess_item,
                )
                fixtures.append({
                    "block": placement["block"], "position": placement["position"],
                    "rotation": placement["rotation"], "room": room,
                    # Kept because the plan drawing needs it and re-measuring means
                    # reopening the DXF. It is also the evidence behind the verdict.
                    "footprint": {"w": round(w, 3), "d": round(d, 3)},
                    **verdict.as_dict(),
                })

        # ---- Meshes ------------------------------------------------------------
        # Vegetation gets two meshes of its own — foliage and trunks — so the
        # GLB can paint them green and brown instead of the beige every other
        # surface wears. build_fixtures routes plants into them; furniture still
        # goes into fixture_mesh as a box. See build/glb.py's material palette.
        wall_mesh, fixture_mesh = MeshBuilder(), MeshBuilder()
        plant_mesh, trunk_mesh = MeshBuilder(), MeshBuilder()
        # `base_z` MUST reach every builder. It arrived in this signature with
        # the storey work and was forwarded to none of them, so a two-storey
        # build put both floors at z=0 — the report said "storey0 z -3.0",
        # the geometry interpenetrated, and only measuring the GLB's actual
        # mesh heights caught it. The builders all supported it already.
        # The poché's two long faces go to their own meshes so each can carry
        # its own surface class — the outside of the envelope and the inside of
        # a room are different materials, and they used to arrive on the same
        # triangles. Ends, tops and bottoms stay in `wall_mesh`: an end cap is
        # a reveal, not a wall surface, and claims neither class.
        wall_inner_mesh, wall_outer_mesh = MeshBuilder(), MeshBuilder()
        wall_reveal_mesh, wall_plinth_mesh = MeshBuilder(), MeshBuilder()
        wall_build = build_walls(
            wall_mesh, walls, holes, height, base_z=base_z,
            internal_mesh=wall_inner_mesh, external_mesh=wall_outer_mesh,
            reveal_mesh=wall_reveal_mesh, plinth_mesh=wall_plinth_mesh,
            spaces=rooms,
        )
        room_meshes, slab_build = build_room_slabs(rooms, base_z=base_z)
        finish_meshes, finish_build = build_room_finishes(
            rooms, walls, holes, height, base_z=base_z,
        )
        fixture_build = build_fixtures(
            fixture_mesh, fixtures, CATALOGUE_DIMS, base_z=base_z,
            plants=plant_mesh, trunks=trunk_mesh,
        )

        meshes = {"walls": wall_mesh, **room_meshes, **finish_meshes}
        # Only when the split actually produced faces. A model whose rooms did
        # not close classifies nothing, and an empty node in the GLB is worse
        # than an absent one — it reads as "the engine found no external wall".
        if wall_outer_mesh.indices:
            meshes["wallface_external"] = wall_outer_mesh
        if wall_inner_mesh.indices:
            meshes["wallface_internal"] = wall_inner_mesh
        if wall_reveal_mesh.indices:
            meshes["wallface_reveal"] = wall_reveal_mesh
        if wall_plinth_mesh.indices:
            meshes["wallface_plinth"] = wall_plinth_mesh
        # Inferred, never drawn, and off unless asked for — a roof lids
        # the cutaway isometric. See build/solidify.build_roof.
        if with_roof:
            roof_meshes, roof_build = build_roof(rooms, height, base_z=base_z)
            meshes.update(roof_meshes)
        if fixture_build["fixtures"]:
            meshes["fixtures"] = fixture_mesh
        if plant_mesh.indices:
            meshes["plants"] = plant_mesh
        if trunk_mesh.indices:
            meshes["trunks"] = trunk_mesh

        # Raw selected linework for cross-storey evidence such as measured
        # riser sequences. The bootstrap `faces` list uses the name heuristic;
        # auto-layer selection can add the actual stair layer only here.
        fx0, fy0, fx1, fy1 = frame_bbox
        stair_faces = []
        for segment in reading["_segments"]:
            if segment.layer not in chosen_here:
                continue
            ax = (segment.x1 - ox) * scale
            ay = (segment.y1 - oy) * scale
            bx = (segment.x2 - ox) * scale
            by = (segment.y2 - oy) * scale
            if not (fx0 <= (ax + bx) / 2 <= fx1
                    and fy0 <= (ay + by) / 2 <= fy1):
                continue
            stair_faces.append(Face(ax, ay, bx, by, segment.layer))

        return {
            "walls": walls, "rooms": rooms, "holes": holes,
            "labels": labels,
            "unhosted": unhosted, "openingIssues": opening_issues,
            # Openings that WERE hosted, but where a second wall was equally
            # close and list order decided. Its own key so `openingIssues`
            # keeps meaning "could not be hosted" and nothing else.
            "openingAmbiguities": opening_ambiguities,
            # Reported, not just done. A bridge MERGES two walls the drawing
            # drew separately, which changes wall count, wall run and the bill;
            # a reviewer looking at a wall that is not in the drawing has to be
            # able to find out why it is there.
            "openingBridges": opening_bridges,
            "fixtures": fixtures,
            "chosen": chosen_here, "layerChoice": layer_choice,
            "wallStats": wall_stats, "roomStats": room_stats,
            "openingStats": opening_stats,
            "meshes": meshes,
            "stairFaces": stair_faces,
            "builds": (wall_build, slab_build, finish_build, fixture_build),
        }

    # ---- One storey, or all of them ----------------------------------------
    # Opt-in, because a two-storey model is a different artefact from what every
    # consumer downstream currently expects — `storey0` is assumed by the plan
    # SVG, the camera solver, the BOQ and the viewer alike. Off by default until
    # each of those has been through.
    #
    # ── The registration datum, which is a CHOICE and is reported ───────────
    # The storeys are drawn SIDE BY SIDE on the sheet and have to be
    # superimposed. Aligning the minimum corner of each frame's bbox is the
    # simplest datum that works, and on the villa it is exact: both storeys
    # share x0 = 90.63 and are 20.82 m wide to the centimetre.
    #
    # It is NOT right in general. A storey with a setback has a different
    # minimum corner, and aligning corners would slide it against the floor
    # below by exactly the setback. A structural-grid correlation is the real
    # answer. Until that exists the offset is recorded per storey in the model
    # so a wrong stack can be SEEN rather than merely looked at — a
    # mis-registered building renders perfectly plausibly.
    solved: list[tuple] = []
    stair_builds: list[dict] = []
    stack = storeys.stacks[0] if (with_storeys and storeys.stacks) else []

    # ── Why a multi-storey stack refuses a building pick ────────────────────
    # `--building N` is an index into ONE frame's segmentation, ordered by floor
    # area. Nothing carries that identity between storeys: building 2 on the
    # ground floor and building 2 upstairs are separate orderings of separate
    # frames, and a site sheet is exactly where they diverge, because the
    # buildings on it need not all have the same number of floors.
    #
    # Refusing is the honest answer. Silently picking index N per storey would
    # stack one villa's ground floor under another villa's first floor and the
    # result renders perfectly plausibly — the same failure mode the storey
    # registration datum above is careful to make visible rather than hide.
    # The flag is present on the API path by default, so this gates on the
    # stack actually having more than one storey, not on the flag being set.
    if building_index is not None and len(stack) > 1:
        raise SystemExit(
            f"--building {building_index} cannot be combined with a "
            f"{len(stack)}-storey stack: the building numbering is per frame, "
            "so the same index need not mean the same building on each floor. "
            "Rebuild one storey at a time with --frame."
        )

    if stack:
        datum = frames[min(stack, key=lambda s: abs(s.level)).frame_index].bbox
        for level in stack:
            frame = frames[level.frame_index]
            frame_walls = [all_walls[i] for i in frame.wall_indices]
            result = _solve_frame(frame_walls, frame.bbox, base_z=level.base_z)
            shift = (datum[0] - frame.bbox[0], datum[1] - frame.bbox[1])
            for mesh in result["meshes"].values():
                mesh.translate_plan(*shift)
            solved.append((level, result, shift))

        # A stair is a relationship between two storeys, so it cannot be built
        # inside the single-frame solver. Add it only after both plans have been
        # solved and registered to the same datum. The builder is deliberately
        # narrow: it accepts uniquely matched named, overlapping stair rooms
        # that fit either a straight flight or a conservative dog-leg/U layout,
        # and records every refusal instead of guessing through ambiguity.
        ordered_solved = sorted(solved, key=lambda item: item[0].level)
        for n, (lower, upper) in enumerate(
            zip(ordered_solved, ordered_solved[1:])
        ):
            lower_level, lower_result, lower_shift = lower
            upper_level, upper_result, upper_shift = upper
            stair_meshes, stair_report = build_stairs(
                lower_result["rooms"],
                upper_result["rooms"],
                rise=upper_level.base_z - lower_level.base_z,
                base_z=lower_level.base_z,
                lower_shift=lower_shift,
                upper_shift=upper_shift,
            )
            if not stair_meshes:
                lower_bbox = frames[lower_level.frame_index].bbox
                upper_bbox = frames[upper_level.frame_index].bbox

                def markers_in(bbox):
                    a, b, c, d = bbox
                    return [marker for marker in stair_markers
                            if a <= marker.x <= c and b <= marker.y <= d]

                marked_meshes, marked_report = build_marked_stairs(
                    lower_result["stairFaces"], upper_result["stairFaces"],
                    markers_in(lower_bbox), markers_in(upper_bbox),
                    rise=upper_level.base_z - lower_level.base_z,
                    base_z=lower_level.base_z,
                    lower_shift=lower_shift, upper_shift=upper_shift,
                )
                if marked_meshes:
                    marked_report["labelRefusals"] = stair_report["refused"]
                    stair_meshes, stair_report = marked_meshes, marked_report
            stair_report["removedCaps"] = open_stair_cores(
                lower_result["meshes"], upper_result["meshes"], stair_report,
                lower_spaces=lower_result["rooms"],
                upper_spaces=upper_result["rooms"],
                lower_shift=lower_shift, upper_shift=upper_shift,
                lower_ceiling_z=upper_level.base_z,
                upper_base_z=upper_level.base_z,
            )
            lower_result["meshes"].update(stair_meshes)
            stair_builds.append({
                "fromStorey": n,
                "toStorey": n + 1,
                "fromTitle": lower_level.title,
                "toTitle": upper_level.title,
                **stair_report,
            })

        # The ground floor is the storey whose statistics stand for the
        # building — it is what a person means by "the plan" and what the site
        # is measured from.
        storey = min(solved, key=lambda item: abs(item[0].level))[1]
    else:
        storey = _solve_frame(walls, (x0, y0, x1, y1))

    walls = storey["walls"]
    rooms = storey["rooms"]
    holes = storey["holes"]
    unhosted = storey["unhosted"]
    opening_issues = storey["openingIssues"]
    opening_ambiguities = storey.get("openingAmbiguities") or []
    opening_bridges = storey.get("openingBridges") or []
    fixtures = storey["fixtures"]
    chosen = storey["chosen"]
    layer_choice = storey["layerChoice"]
    wall_stats = storey["wallStats"]
    room_stats = storey["roomStats"]
    opening_stats = storey["openingStats"]
    wall_build, slab_build, finish_build, fixture_build = storey["builds"]


    # three.js sanitises node names, so `storey0/walls` loads as `storey0walls`.
    # The underscore is load-bearing.
    meshes = {f"storey0_{name}": mesh for name, mesh in storey["meshes"].items()}
    # `_plants` / `_trunks` in the name is what glb.py keys the green and bark
    # materials on — see build/glb.py. Only added when non-empty so an
    # indoor-only building carries no empty vegetation node.

    storey_report: list[dict] = []
    # ── Furniture belongs to the building, not to the primary storey ─────────
    # `walls`, `rooms` and `openings` below are deliberately the PRIMARY storey:
    # they are what the plan drawing draws and what a person means by "the
    # plan". Fixtures were following them by accident rather than by argument,
    # and the result was a model whose GLB carried `storey0_fixtures` AND
    # `storey1_fixtures` while `elements.fixtures` listed one storey's worth.
    #
    # On the villa that is 21 fixtures reported for a building holding 55. The
    # lower ground floor's beds and sanitaryware were visible in the 3D and
    # absent from the data — so `solve/clearance.py`, the only consumer, was
    # checking one floor of a two-floor house and reporting a clean result for
    # the other. Nothing here reaches the bill: `quantify/boq.py` does not read
    # fixtures at all, which is why this list can be made complete without
    # moving a single costed quantity.
    #
    # Each entry carries `storey`, because two beds at the same (x, y) on
    # different floors are not an overlap and a checker with no storey index
    # cannot tell that.
    all_fixtures: list[dict] = []
    all_opening_issues: list[dict] = []
    #: Per-storey element blocks — the whole building, for consumers that can
    #: read more than one floor. Empty on single-storey builds.
    storey_elements: list[dict] = []
    #: Which storey `elements.walls` / `spaces` / `openings` describe. Anything
    #: that pairs a fixture with WALLS has to filter to this one, because those
    #: walls belong to one floor and a fixture from another would be measured
    #: against a room it is not in.
    primary_storey = 0
    if solved:
        meshes = {}
        # Numbered from the bottom of the stack, so storey0 is the lowest thing
        # in the building and not whichever frame happened to be first.
        for n, (level, result, shift) in enumerate(
            sorted(solved, key=lambda item: item[0].level)
        ):
            for name, mesh in result["meshes"].items():
                meshes[f"storey{n}_{name}"] = mesh
            all_fixtures.extend({**f, "storey": n} for f in result["fixtures"])
            all_opening_issues.extend({
                **issue,
                "storey": n,
                "storeyTitle": level.title,
                "registeredPosition": {
                    "x": round(issue["position"]["x"] + shift[0], 4),
                    "y": round(issue["position"]["y"] + shift[1], 4),
                },
            } for issue in result["openingIssues"])
            if result is storey:
                primary_storey = n
            # The whole building's elements, one block per storey, in FRAME
            # coordinates (the registration shift is recorded beside them, and
            # applied only to the meshes). `elements.walls/spaces/openings`
            # stay the primary storey so every existing consumer keeps its
            # shape; anything that wants the WHOLE building iterates these —
            # see solve/storeys.py::element_blocks.
            storey_elements.append({
                "storey": n,
                "level": level.level,
                "title": level.title,
                "shift": [round(shift[0], 3), round(shift[1], 3)],
                "walls": [w.as_dict() for w in result["walls"]],
                "spaces": [r.as_dict() for r in result["rooms"]],
                "openings": [o.as_dict() for o in result["holes"]],
                "openingIssues": result["openingIssues"],
            })
            storey_report.append({
                "storey": n,
                "level": level.level,
                "title": level.title,
                "frame": level.frame_index,
                "baseZ": round(level.base_z, 3),
                # The registration offset, recorded because it is a choice and a
                # wrong one produces a building that renders perfectly.
                "shift": [round(shift[0], 3), round(shift[1], 3)],
                "walls": result["wallStats"]["total"],
                "rooms": result["roomStats"]["count"],
                "area": result["roomStats"]["totalArea"],
            })

    if not solved:
        all_opening_issues = [{
            **issue,
            "storey": 0,
            "storeyTitle": None,
            # `.get`, not `[...]`. Every emitter is supposed to give each issue
            # a position and they all now do — but this is the REVIEW payload
            # for advisory findings, and an advisory that cannot be displayed
            # must not end a build that otherwise succeeded. It did exactly
            # that once: a refusal raised against a merged run, which has no
            # single segment to point at, took down a villa that had already
            # reconstructed. Same rule the clearance and codecheck blocks below
            # follow — a model is still a model without one of its reports.
            "registeredPosition": issue.get("position"),
        } for issue in opening_issues]

    # The gate. Every failure mode here produces *a building* rather than an
    # error, so the only defence is checking the result against its own input
    # before anything expensive or user-facing happens.
    verdict = vf.check(
        input_segments=len(faces), walls=walls, spaces=rooms,
        openings=holes, unhosted=unhosted,
        scale_candidates=reading.get("scaleCandidates"),
        # Only `cli` can see this: the walls are dropped by `segment_frames`
        # before verify is handed a wall list, so from verify's side they never
        # existed. See the framing-coverage check.
        walls_dropped=len(all_walls) - sum(len(f.wall_indices) for f in frames),
        walls_before_framing=len(all_walls),
    )

    # Verify every storey against the annotations inside its own frame. The
    # generic geometry gate cannot know that zero rooms is impossible when the
    # drawing itself says KITCHEN, LIVING and BEDROOM. Multi-storey builds used
    # to verify only the primary floor, allowing another floor to be empty.
    quality_storeys = solved or [(None, storey, (0.0, 0.0))]
    for level, result, _shift in quality_storeys:
        label_count = len(result["labels"])
        title = level.title if level is not None else "the selected plan"
        if label_count and not result["rooms"]:
            verdict.checks.append(vf.Check(
                "rooms-from-labels",
                "blocking",
                f"{title} contains {label_count} room labels but the reconstructed "
                "walls enclose zero rooms. "
                + unresolved_unit_guidance(unit_verdict, scale),
                0,
            ))
        if len(result["rooms"]) >= 2 and not result["holes"]:
            # Still blocking, and the wording of the finding is unchanged. What
            # is added is WHY, when the drawing's own title already answers it.
            #
            # A site layout draws footprints, plots, roads and levels; it
            # carries no doors because doors are not what it is for. So this
            # finding on such a frame is about the FRAME, not about opening
            # detection — and on `SITE PLAN FOR 3D` a full day went into
            # reading it the other way while the title said `REVISED SITE PLAN`
            # the whole time. The gate is not weakened by explaining itself.
            frame_title = (level.title if level is not None else None) or (
                frames[0].title if frames else None
            )
            aside = ""
            if vf.is_site_layout_title(frame_title):
                aside = (
                    f" The frame is titled {frame_title!r} — a site layout, not "
                    "a construction plan. A site layout carries no doors by "
                    "nature, so this is about which frame was built rather than "
                    "about opening detection; build a detail frame instead, and "
                    "see the framing note for the candidates."
                )
            verdict.checks.append(vf.Check(
                "openings-present",
                "blocking",
                f"{title} contains {len(result['rooms'])} rooms but no hosted doors "
                "or windows. The reconstruction is incomplete." + aside,
                0,
            ))

        # ---- Rooms and doors, but not one window ----------------------------
        #
        # `openings-present` above is satisfied by DOORS alone, and on this
        # corpus that is almost always what happens. Measured 2026-08-29 across
        # every reconstruction on this machine: 129 of 132 models carry zero
        # windows, and every one of them verified CLEAN. A building that cannot
        # admit daylight shipped 129 times with nothing saying so — and the
        # first place it shows is a render, where an interior comes back either
        # blown out or black depending on whether it has a ceiling.
        #
        # A WARNING and not blocking, deliberately. A drawing that genuinely
        # draws no windows is a real thing — a basement, a services layout, a
        # detail frame — and refusing to build it would be wrong. What is not
        # acceptable is silence.
        #
        # The message names the two causes actually observed, because both are
        # invisible from the output and neither is guessable:
        #   * the client draws windows as LINEWORK and never as blocks (true of
        #     all 7 drawings in the Casa Altinho corpus: 0 window blocks, 2,280
        #     window-layer entities), so nothing arrives from `from_sized_blocks`
        #   * that linework sits OUTSIDE the built frame on a multi-drawing
        #     sheet, so `cli.py`'s opening-face filter excludes it. Sheets here
        #     carry a median of 8 drawings.
        window_count = sum(
            1 for h in result["holes"] if getattr(h, "kind", None) == "window"
        )
        if result["rooms"] and window_count == 0:
            door_count = len(result["holes"]) - window_count
            verdict.checks.append(vf.Check(
                "windows-present",
                "warning",
                f"{title} reconstructed {len(result['rooms'])} rooms and "
                f"{door_count} door(s) but NO windows. Interiors will be lit "
                "through doorways only, so renders of them will not be usable. "
                "Two causes are common and neither is visible from the output: "
                "the drawing may encode windows as linework rather than as "
                "blocks, or that linework may sit outside this frame on a "
                "sheet carrying several drawings — check the other frames with "
                "--frame N.",
                0,
            ))

    # ---- Openings whose host wall was decided by list order -----------------
    #
    # `host()` keeps the nearest wall on a strict `<`, so two walls at the same
    # distance are separated by their index and nothing else. Measured on the
    # villa: 3 of 4 doors, and across both storeys 9 openings with rival
    # distances of 0.005 to 0.14 m — seven of them under 7 cm.
    #
    # It matters beyond the picture. The host wall sets the opening's reveal
    # depth AND `quantify` deducts the opening from the wall it is hosted on,
    # so an arbitrary choice between a 0.115 m partition and a 0.23 m wall puts
    # the deduction on the wrong wall in the bill of quantities.
    #
    # A warning, not a block: the opening is real and refusing it would lose a
    # door. The detail sits in `openingAmbiguities` with both candidates and
    # their thicknesses, so a reviewer who knows the drawing can settle it.
    if opening_ambiguities:
        worst = min(a["rivalDistance"] for a in opening_ambiguities)
        differing = sum(
            1 for a in opening_ambiguities
            if a["hostWallThickness"] != a["rivalWallThickness"]
        )
        verdict.checks.append(vf.Check(
            "opening-host-ambiguous",
            "warning",
            f"{len(opening_ambiguities)} opening(s) were hosted on a wall that "
            "another wall was equally close to — the tie was broken by wall "
            f"order, not by geometry (closest rival {worst:.3f} m)."
            + (f" {differing} of them "
               + ("sits" if differing == 1 else "sit")
               + " between walls of DIFFERENT thickness, so the reveal depth "
                 "and the bill-of-quantities deduction depend on which was "
                 "chosen." if differing else "")
            + " See openingAmbiguities.",
            len(opening_ambiguities),
        ))

    # ---- A fragment built while the building sat unbuilt beside it ----------
    #
    # The console already prints every frame, marks the one built and suggests
    # `--frame N`. That is good reporting and it is not enough: it is a PRINT,
    # so nothing reaches building.json, and the API, the studio and anyone
    # reading the artifact later see a model that verified clean with no hint
    # that a far larger drawing on the same sheet was passed over.
    #
    # Measured 2026-08-29 on REDDY- SITE PLAN FOR 3D 17-2-24: the ranker built
    # frame 0 — 12 walls, 2 rooms — while frame 1 carried 161 walls and frame 2
    # carried 99. A thirteen-fold difference, and the output looked healthy.
    # DOWN VILLA is the control: frames 0 and 1 are 44 and 50 walls, both real
    # floor plans of the same house, and this must stay quiet there.
    #
    # Deliberately NOT a change to frame ranking. Choosing between drawings on
    # a sheet is a genuine judgement — a site layout legitimately carries more
    # walls than the floor plan somebody wants — and a heuristic that overrode
    # the ranker here would trade a visible wrong choice for an invisible one.
    # This says "look", and leaves the choosing alone.
    #
    # Gated on FEW ROOMS as well as a big alternative, because room count is
    # what distinguishes a fragment from a small-but-complete plan. Two rooms
    # from a 12-wall frame is a fragment; 25 rooms from a 44-wall frame is a
    # house.
    if frames and len(frames) > 1:
        # Positionally, exactly as line 727 picks it. Selecting by `.index`
        # instead would silently identify a different frame the moment index
        # and position diverge, and this check would then describe a build that
        # did not happen.
        built = frames[min(frame_index, len(frames) - 1)]
        biggest = max(frames, key=lambda f: len(f.wall_indices))
        if biggest is not built:
            built_walls = len(built.wall_indices)
            other_walls = len(biggest.wall_indices)
            total_rooms = sum(len(r["rooms"]) for _l, r, _s in quality_storeys)
            if total_rooms <= 3 and built_walls and other_walls >= 3 * built_walls:
                label = biggest.title or ""
                verdict.checks.append(vf.Check(
                    "frame-choice",
                    "warning",
                    f"Built frame {built.index} ({built_walls} walls, "
                    f"{total_rooms} room(s)) while frame {biggest.index} on the "
                    f"same sheet carries {other_walls} walls"
                    + (f" ({label})" if label else "")
                    + f" — {other_walls / built_walls:.0f}x more. This may be a "
                    "fragment rather than the drawing you wanted; build the "
                    f"other with --frame {biggest.index}.",
                    built_walls,
                ))

    # Which room each mesh belongs to, so a floor is tagged for what it IS
    # (`floor_bath`, not a generic floor). Mesh names carry `room<N>` by
    # construction — build/solidify.py `_room_mesh_slug` — and the index is
    # per storey, so a two-storey building has two `room0`s and the storey
    # prefix is what tells them apart.
    room_kinds: dict[str, str] = {}
    blocks = storey_elements or [{"spaces": [r.as_dict() for r in rooms]}]
    for n, block in enumerate(blocks):
        by_index = {
            s.get("index"): (s.get("kind") or "unknown")
            for s in block.get("spaces", [])
            if s.get("index") is not None
        }
        prefix = f"storey{n}_"
        for mesh_name in meshes:
            if len(blocks) > 1 and not mesh_name.startswith(prefix):
                continue
            for index, kind in by_index.items():
                if f"_room{index}_" in mesh_name:
                    room_kinds[mesh_name] = kind
                    break

    manifest = write_glb(meshes, out / f"{source.stem}.glb", room_kinds=room_kinds)

    model = {
        "source": str(source),
        "converter": converter,
        # One building, or a site holding several. Always the PRIMARY storey's
        # answer, with the rest under `storeys` when there is more than one —
        # the same shape rule `elements.*` follows, so a consumer reading
        # `site.count` gets a number on every model instead of a number on
        # single-storey builds and a list on multi-storey ones.
        "site": _site_summary(site_reports),
        # Walls this build MERGED because an opening's own linework proved the
        # gap between them was a doorway, not a break. Empty on most drawings;
        # never absent, so "none were made" and "never attempted" stay
        # different states.
        "openingBridges": opening_bridges,
        "unit": unit or reading["unit"],
        "headerUnit": header_unit,
        # What the WALLS said, alongside what the header said. Kept even when
        # the two agree, because "we checked and they agree" and "we never
        # checked" are different states and only one of them is reassuring.
        "unitMeasured": unit_verdict.as_dict() if unit_verdict else None,
        "headerScale": header_scale,
        "scale": scale,
        "wallHeight": height,
        "layersUsed": sorted(chosen),
        "layerChoice": layer_choice,
        "faces": len(faces),
        "frames": [f.as_dict() for f in frames],
        # How frames[0] was chosen, with the grades for every candidate — a
        # reviewer accepting an import should see the race, not just the winner.
        # None when there was nothing to rank (one frame, or a human's layers).
        "frameRanking": frame_ranking,
        "frameUsed": picked.as_dict() if picked else None,
        # ── How much linework never reached a frame ─────────────────────────
        # Walls-in versus walls-out was not merely unreported, it was
        # arithmetically unrecoverable: nothing sat between `faces` and the
        # per-frame counts, so two sheets with identical face counts and
        # byte-identical frame blocks could have lost different amounts. On the
        # real villa, 216 walls in, 176 assigned, 40 unframed — 18.5% — with no
        # number anywhere that moved.
        #
        # It is usually correct to drop them (title blocks, north arrows, stray
        # callouts). The dangerous case is a MISFIRED drop — a guard house that
        # pairs to 5 walls, or a layer choice that fragments a partitions-only
        # plan — which produces a bill of quantities for less building than the
        # client drew. This is the number that moves when that happens.
        "storeys": {**storeys.as_dict(), "built": storey_report,
                    "primary": primary_storey},
        "stairs": {
            "built": sum(report["stairs"] for report in stair_builds),
            "connections": stair_builds,
        },
        "wallsTotal": len(all_walls),
        "wallsUnframed": len(all_walls) - sum(len(f.wall_indices) for f in frames),
        "framingNote": framing_note or None,
        "walls": wall_stats,
        "rooms": room_stats,
        "openings": opening_stats,
        # Exact evidence for every sized door/window block that could not be
        # hosted. The aggregate warning is useful, but cannot highlight or fix
        # a missing wall without these targets.
        "openingIssues": all_opening_issues,
        # Hosted openings whose host wall was NOT decided by geometry: a
        # second wall was equally close and list order broke the tie. Kept
        # apart from `openingIssues`, which the API reads as the review
        # queue of openings that could not be hosted at all.
        "openingAmbiguities": opening_ambiguities,
        "build": {**wall_build, **slab_build, **finish_build, **fixture_build},
        "verify": verdict.as_dict(),
        "glb": manifest,
        "elements": {
            "walls": [w.as_dict() for w in walls],
            "spaces": [r.as_dict() for r in rooms],
            "openings": [o.as_dict() for o in holes],
            # Single-storey models keep storey 0, so consumers read one shape.
            "fixtures": all_fixtures or [{**f, "storey": 0} for f in fixtures],
            # The whole building, one block per storey — present only when a
            # confirmed stack was built. The flat lists above remain the
            # primary storey, so nothing that reads them changes meaning.
            **({"storeys": storey_elements} if storey_elements else {}),
        },
    }

    # ---- Can these rooms actually be used? ---------------------------------
    # `solve/clearance.py` has been complete and working for some time, with 25
    # assertions on it, and was reachable only by running a separate CLI command
    # against a model somebody had already built. It appears in no API route, in
    # no `building.json`, and nowhere in the studio.
    #
    # That is the same shape as four other things found in this codebase this
    # week — a finished producer with nothing consuming it — and it is the most
    # expensive instance, because clearance is the one question a floor plan
    # cannot answer by looking at it. On this villa it finds 13 things,
    # including two beds overlapping, a WC with no clear floor in front of it,
    # and four rooms with no door into them at all.
    #
    # Computed here rather than left to the caller because it needs the
    # catalogue's dimensions, which is exactly what the fixtures were given for.
    # Cheap: geometry over the fixture list, ~19 shapes on this model.
    try:
        from solve import clearance as cl

        issues = cl.check_building(model, CATALOGUE_DIMS)
        model["clearance"] = {
            "summary": cl.summarise(issues),
            "issues": [i.as_dict() for i in issues],
        }
    except Exception as error:  # pragma: no cover - never fail a build for this
        # A model is still a model without its clearance report, and refusing to
        # write one because an advisory check raised would lose the expensive
        # half of the work. Recorded rather than swallowed.
        model["clearance"] = {"error": f"{type(error).__name__}: {error}"}

    # ---- Measured against the rulebook -------------------------------------
    # Same shape as clearance and embedded for the same reason: clearance sat
    # finished and unreachable for weeks because it lived behind a separate CLI
    # command nobody ran. The default rulebook is a transcription of NBC 2016
    # the architect must verify (data/rulebooks/); which book was used is
    # recorded beside the findings, because a finding without its rulebook is
    # a number without a unit.
    try:
        from solve import codecheck as cc

        book = cc.load_rulebook(DEFAULT_RULEBOOK)
        code_findings, code_coverage = cc.check_building(model, book)
        model["codecheck"] = {
            "rulebook": book.get("title"),
            "summary": cc.summarise(code_findings, code_coverage, book),
            "findings": [f.as_dict() for f in code_findings],
            "coverage": code_coverage,
        }
    except Exception as error:  # pragma: no cover - never fail a build for this
        model["codecheck"] = {"error": f"{type(error).__name__}: {error}"}

    # ---- And against the machine-extracted ruleset --------------------------
    # Beside `codecheck`, never merged into it. The two answer the same shape of
    # question from different sources: `codecheck` from a rulebook the architect
    # of record works to, this from rules extracted out of the eCFR API that
    # carry their clause, issue date and the regulation's own sentence.
    #
    # Keeping them separate is the point. A finding that cites 36 CFR 1191 is a
    # different kind of claim from one citing an NBC transcription, and a reader
    # has to be able to tell which they are looking at.
    #
    # Evaluates nothing unless the project's jurisdiction is in scope — see
    # DEFAULT_JURISDICTION. Wrapped like clearance and codecheck for the same
    # reason: a compliance pass must never fail a build.
    try:
        from comply import assess as comply_assess

        report = comply_assess(model, DEFAULT_RULESET,
                               jurisdiction=DEFAULT_JURISDICTION)
        model["compliance"] = report.as_dict()
    except Exception as error:  # pragma: no cover - never fail a build for this
        model["compliance"] = {"error": f"{type(error).__name__}: {error}"}

    (out / f"{source.stem}.building.json").write_text(
        json.dumps(model, indent=2), encoding="utf-8"
    )
    return model


def _inside(px: float, py: float, loop) -> bool:
    """Ray-cast point-in-polygon. Used to name a fixture by the room it stands in."""
    inside = False
    n = len(loop)
    for i in range(n):
        x1, y1 = loop[i]
        x2, y2 = loop[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            if px < (x2 - x1) * (py - y1) / (y2 - y1 + 1e-18) + x1:
                inside = not inside
    return inside


def _print_build(model: dict) -> None:
    w, r, o, b = model["walls"], model["rooms"], model["openings"], model["build"]
    print(f"\nSOURCE   {model['source']}")
    if model["converter"]:
        c = model["converter"]
        print(f"CONVERT  libredwg {c['version']} -> {c['modelSpaceEntities']} entities")
    print(f"UNIT     {model['unit']}  (scale {model['scale']})")

    # A wrong unit is the most expensive silent failure this engine has — it
    # builds the villa a thousand times too small and every number downstream is
    # confidently wrong — so what the walls measured is always printed, whether
    # it agreed, disagreed, or could not tell.
    measured = model.get("unitMeasured")
    if measured:
        if not measured["decided"]:
            print(f"         ? walls could not settle it: {measured['reason']}")
        elif abs((measured["scale"] or 0) - model["scale"]) > 1e-9:
            print(f"         ! walls say {measured['unit']} and the header was "
                  f"kept: {measured['reason']}")
        elif measured["unit"] not in str(model["unit"]):
            print(f"         walls agree: {measured['reason']}")
        else:
            print(f"         measured: {measured['reason']}")

    print(f"LAYERS   {', '.join(model['layersUsed'][:6])}"
          f"{' …' if len(model['layersUsed']) > 6 else ''}")

    print(f"\nFACES    {model['faces']} lines on those layers")
    if model.get("frames"):
        used = (model.get("frameUsed") or {}).get("index")
        print(f"FRAMES   {len(model['frames'])} separate drawings on this sheet")
        # Print the drawing's OWN title where it has one. The engine already
        # reads it — `frameUsed.title` was "Ground Floor Plan" on a real client
        # master file whose frame 1 was the "Lower Ground Floor Plan", i.e. the
        # other half of the same house — and printing only "50 walls, span
        # 20.82 m" left the operator no way to know that, or that `--frame 1`
        # would build it. One-shot import is a decision; hiding what was not
        # imported is not part of it.
        shown = model["frames"][:8]
        for f in shown:
            mark = "->" if f["index"] == used else "  "
            label = f.get("title") or f.get("levelLabel") or ""
            print(f"      {mark} frame {f['index']}: {f['walls']:>4} walls, "
                  f"span {f['span']} m" + (f"   {label}" if label else ""))
        if len(model["frames"]) > len(shown):
            print(f"         ... and {len(model['frames']) - len(shown)} more")
        others = [f for f in model["frames"] if f["index"] != used]
        if others:
            named = [f for f in others if f.get("title") or f.get("levelLabel")]
            nxt = (named or others)[0]
            print(f"         build another with --frame N, e.g. --frame "
                  f"{nxt['index']}"
                  + (f" ({nxt.get('title') or nxt.get('levelLabel')})"
                     if (nxt.get("title") or nxt.get("levelLabel")) else ""))

    # Printed whatever happened, INCLUDING when there are no frames at all —
    # `if model["frames"]` skipped this block entirely on an empty list, so a
    # sheet whose drawings all fell below the wall floor produced output
    # indistinguishable from a clean single-drawing file.
    # A sheet holding one building with two floors used to look exactly like a
    # sheet holding two buildings. It no longer does — and the refusals matter
    # as much as the stacks, because "we could not tell" is a different state
    # from "there is nothing here".
    storey_report = model.get("storeys") or {}
    for stack in storey_report.get("stacks", []):
        names = ", ".join(f"{s['title']} (z {s['baseZ']:+.1f})" for s in stack)
        print(f"STOREYS  {len(stack)} storeys of ONE building: {names}")
    for refusal in storey_report.get("refusals", []):
        print(f"STOREYS  ? frames {refusal['frames']}: {refusal['reason']}")

    # What was actually BUILT, which is a different question from what was
    # detected — detection happens always, building only with --storeys.
    for built in storey_report.get("built", []):
        shift = built["shift"]
        moved = f"  shifted ({shift[0]:+.2f}, {shift[1]:+.2f}) m" if any(shift) else ""
        print(f"         storey{built['storey']}  z {built['baseZ']:+.1f}  "
              f"{built['walls']:>4} walls  {built['rooms']:>3} rooms  "
              f"{built['area']:>7.1f} m2   {built['title']}{moved}")

    stairs = model.get("stairs") or {}
    for connection in stairs.get("connections", []):
        route = (
            f"storey{connection['fromStorey']} -> "
            f"storey{connection['toStorey']}"
        )
        if connection.get("stairs"):
            forms = ", ".join(
                layout.get("type", "unknown")
                for layout in connection.get("layouts", [])
            )
            suffix = f" ({forms})" if forms else ""
            print(f"STAIRS   {route}: {connection['stairs']} stair built{suffix}")
        for refusal in connection.get("refused", []):
            print(f"STAIRS   ? {route}: {refusal}")

    if model.get("framingNote"):
        print(f"       ! {model['framingNote']}")
    unframed = model.get("wallsUnframed") or 0
    if unframed:
        total = model.get("wallsTotal") or 0
        share = unframed / total if total else 0
        mark = " !" if share > 0.25 else "  "
        print(f"      {mark} {unframed} of {total} walls ({share:.0%}) reached no frame")

    print(f"\nWALLS    {w['total']}  ({w['paired']} paired, {w['unpaired']} unpaired)")
    print(f"         total length {w['totalLength']} m")
    # Railings are the one thing built from a line the pairer could NOT
    # confirm, so they are the one figure a reader should check against the
    # drawing by eye. Printed rather than left in building.json: the recurring
    # defect in this codebase is a finished producer with no consumer.
    _railings = (model.get("build") or {}).get("railings") or 0
    if _railings:
        print(f"         {_railings} built as balcony guards at 1.0 m "
              f"(unpaired lines on a named balcony/terrace edge)")
    if w["medianThickness"] is not None:
        print(f"         thickness: median {w['medianThickness']} m, "
              f"range {w['thicknessRange'][0]}–{w['thicknessRange'][1]} m")

    if r["count"]:
        print(f"\nROOMS    {r['count']} enclosed  ({r['named']} named)")
        print(f"         total {r['totalArea']} m2, "
              f"largest {r['largest']} m2, smallest {r['smallest']} m2")
        for space in model["elements"]["spaces"][:8]:
            name = space["name"] or "(unnamed)"
            print(f"           {name[:28]:<28} {space['area']:>7.2f} m2   {space['kind']}")
    else:
        print(f"\nROOMS    none — {r.get('warning', '')}")

    print(f"\nOPENINGS {o['total']}  ({o['doors']} doors, {o['windows']} windows)")
    if o["unassigned"]:
        print(f"         ! {o['unassigned']} could not be hosted on any wall")

    print(f"\nMESH     {b['pieces']} wall pieces "
          f"({b['solids']} solid, {b['lintels']} lintels, {b['aprons']} aprons)")
    print(f"         {b['slabs']} floor slabs, {b['fixtures']} fixtures")

    v = model.get("verify", {})
    if v:
        state = "PASS" if v["ok"] else "BLOCKED"
        print("")
        print(f"VERIFY   {state}  ({v['blocking']} blocking, {v['warnings']} warnings)")
        for c in v["checks"]:
            if c["level"] == "info":
                continue
            tag = "!!" if c["level"] == "blocking" else " !"
            print(f"      {tag} {c['name']}: {c['message']}")

    # Clearance is advisory and never blocks, but it answers the one question a
    # floor plan cannot be looked at to answer — whether the rooms can actually
    # be used — so it is printed rather than left in the JSON for somebody to go
    # and find. The full findings are in `clearance.issues`.
    clear = model.get("clearance") or {}
    if clear.get("error"):
        print(f"\nCLEARANCE  not computed: {clear['error']}")
    elif clear.get("summary"):
        s = clear["summary"]
        if s["total"]:
            kinds = ", ".join(f"{k}={n}" for k, n in s["byKind"].items())
            print(f"\nCLEARANCE  {s['total']} findings "
                  f"({s['blocking']} blocking, {s['tight']} tight, "
                  f"{s['notes']} notes)")
            print(f"           {kinds}")
            for issue in clear["issues"]:
                if issue.get("severity") == "blocking":
                    print(f"        !! {issue.get('message', '')[:96]}")
        else:
            print("\nCLEARANCE  nothing to report")

    code = model.get("codecheck") or {}
    if code.get("error"):
        print(f"\nCODE     not computed: {code['error']}")
    elif code.get("summary"):
        s = code["summary"]
        print(f"\nCODE     {code.get('rulebook')}")
        print(f"         {s['total']} findings across {s['checked']} checks; "
              f"{s['skipped']} not measurable")
        for finding in code.get("findings", [])[:6]:
            where = finding.get("roomName") or "-"
            print(f"      !  [{where[:22]:<22}] {finding.get('message', '')[:96]}")

    g = model["glb"]
    print(f"\nGLB      {g['path']}")
    print(f"         {g['bytes']:,} bytes, {g['triangles']:,} triangles, "
          f"{g['vertices']:,} vertices")
    print(f"         meshes: {', '.join(g['meshes'])}")


def layer_report(input_path: str, work_dir: str, unit: str | None = None) -> dict:
    """
    Which layers hold walls, with the evidence for saying so.

    Free and read-only. This is the question a human has to settle before a
    solve is worth running, and neither the layer name nor the pairing
    statistics can settle it alone — see solve/layerscan.py.
    """
    from hypothesise.pair import Face
    from solve import layerscan

    source = Path(input_path)
    dxf_path, _converter = _as_dxf(source, Path(work_dir))
    reading = kernel.read(str(dxf_path))
    if unit:
        reading["scale"] = UNIT_SCALES[unit]
    scale = reading["scale"]
    ox, oy = reading["_origin"]

    by_layer: dict[str, list] = {}
    for seg in reading["_segments"]:
        by_layer.setdefault(seg.layer, []).append(
            Face(ax=(seg.x1 - ox) * scale, ay=(seg.y1 - oy) * scale,
                 bx=(seg.x2 - ox) * scale, by=(seg.y2 - oy) * scale, layer=seg.layer)
        )

    scores = layerscan.scan(by_layer)
    shortlist = layerscan.recommended(scores)
    chosen, trace = layerscan.select_wall_layers(by_layer, shortlist)

    hinted = default_wall_layers(reading)
    # Rooms each layer closes ALONE. The pairing verdict alone is not enough —
    # on a real client upload the layer verdicted WALLS enclosed nothing and
    # the one dismissed as "not at wall thicknesses" enclosed twenty-one
    # rooms. See solve/layerscan.encloses.
    enclosed = layerscan.encloses(by_layer)
    return {
        "source": str(source),
        "scores": [
            {**s.as_dict(), "encloses": enclosed.get(s.as_dict()["name"], 0)}
            for s in scores
        ],
        "byName": sorted(hinted),
        "byNameRooms": layerscan._rooms_from([f for n in hinted for f in by_layer.get(n, [])]),
        "byEvidence": sorted(chosen),
        "byEvidenceRooms": trace[-1]["rooms"] if trace else 0,
        "trace": trace,
    }


def _print_layers(report: dict) -> None:
    print("")
    print(f"SOURCE   {report['source']}")
    print("")
    print(f"{'layer':<26}{'segs':>6}{'pairs':>7}{'median':>9}{'rooms':>7}  verdict")
    for s in report["scores"][:18]:
        m = f"{s['medianThickness']:.3f}" if s["medianThickness"] else "-"
        print(f"{s['name'][:25]:<26}{s['segments']:>6}{s['paired']:>7}{m:>9}"
              f"{s.get('encloses', 0):>7}  {s['verdict']}")

    # THE line that would have saved a real drawing. A layer the pairing
    # verdict dismisses can be the only one that closes the building, because
    # a drawing may split a wall's two faces across two layers.
    dismissed = [s for s in report["scores"]
                 if s["verdict"] != "WALLS" and s.get("encloses", 0) > 0]
    endorsed = max((s.get("encloses", 0) for s in report["scores"]
                    if s["verdict"] == "WALLS"), default=0)
    for s in sorted(dismissed, key=lambda r: -r.get("encloses", 0))[:3]:
        if s["encloses"] > endorsed:
            print("")
            print(f"  !! {s['name']} is NOT verdicted a wall layer, yet it closes "
                  f"{s['encloses']} rooms on its own — more than every layer that is "
                  f"({endorsed}).")
            print("     A drawing may put a wall's two faces on two layers, and each "
                  "then pairs\n     at ink thickness alone. Try --layers with it "
                  "included before believing\n     the verdict column.")
            break

    print("")
    print(f"BY NAME      {report['byNameRooms']:>3} rooms   {', '.join(report['byName'])}")
    print(f"BY EVIDENCE  {report['byEvidenceRooms']:>3} rooms   {', '.join(report['byEvidence'])}")
    if report["trace"]:
        print("")
        print("  greedy selection, by rooms enclosed:")
        for t in report["trace"]:
            print(f"    + {t['added']:<28} -> {t['rooms']:>3}  (+{t['gain']})")
    print("")
    print("  The table is the useful half. BY EVIDENCE optimises room COUNT, which")
    print("  is a proxy — on this drawing it picks the elevation layers, reaching 16")
    print("  rooms with 0 named and 0 doors, because elevations sit beside the plan")
    print("  and drag the frame off it. More loops, less building.")
    print("  Choose with --layers, and judge on named rooms and hosted doors.")


def deliverables(model_path: str, out_dir: str) -> dict:
    """
    Everything the model can produce without a renderer.

    The plan is drawn as vector, not rendered — see render/plan_svg.py. The
    views are solved, not sampled: each one is a camera with a position in
    metres and a measured clearance, which is the claim an image generator
    cannot make about its own "camera angle".
    """
    from render import cameras, styles
    from render.plan_svg import render_plan

    model = json.loads(Path(model_path).read_text(encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # The camera solver works on objects, so rebuild the light structures it
    # needs from the stored model rather than re-running the whole pipeline.
    class _S:
        def __init__(self, d):
            self.index = d["index"]; self.loop = [tuple(p) for p in d["loop"]]
            self.area = d["area"]; self.name = d.get("name")

    class _W:
        def __init__(self, d):
            self.ax = d["a"]["x"]; self.ay = d["a"]["y"]
            self.bx = d["b"]["x"]; self.by = d["b"]["y"]
            self.thickness = d["thickness"]; self.paired = d["paired"]

        @property
        def length(self):
            import math
            return math.hypot(self.bx - self.ax, self.by - self.ay)

    class _O:
        def __init__(self, d):
            self.kind = d["kind"]; self.wall = d["wall"]
            self.along = d["along"]; self.width = d["width"]

    spaces = [_S(d) for d in model["elements"].get("spaces", [])]
    walls = [_W(d) for d in model["elements"]["walls"]]
    holes = [_O(d) for d in model["elements"].get("openings", [])]

    # Fixtures are passed so an interior camera has something to look at when
    # the room has no glazing — which, on this corpus, is every room in almost
    # every model. Read from the model dict rather than re-derived: the
    # reconstruction already resolved each one to a catalogue id and a plan
    # position, and deriving them twice is how two consumers end up disagreeing.
    views = cameras.solve(spaces, walls, openings=holes,
                          height=model.get("wallHeight", 2.7),
                          fixtures=model["elements"].get("fixtures", []))
    stem = Path(model.get("source", "building")).stem
    plan = render_plan(model, out / f"{stem}.plan.svg")

    views_path = out / f"{stem}.views.json"
    views_path.write_text(
        json.dumps([v.as_dict() for v in views], indent=2), encoding="utf-8"
    )

    # The statutory area statement — RERA §2(k) and IS 3861 carpet, every
    # figure tagged with its definition. This is a deliverable clients pay a
    # surveyor to produce, and it is pure arithmetic over the stored model;
    # see quantify/areas.py for why the two figures must never be conflated.
    from quantify import areas as qa

    statement = qa.area_statement(model)
    areas_path = out / f"{stem}.areas.json"
    areas_path.write_text(json.dumps(statement, indent=2), encoding="utf-8")

    return {
        "plan": plan,
        "views": {"path": str(views_path), **cameras.summarise(views)},
        "surface": styles.catalogue(),
        "viewList": [v.as_dict() for v in views],
        "areas": {"path": str(areas_path), "statement": statement},
    }


def _print_deliverables(report: dict) -> None:
    p, v = report["plan"], report["views"]
    print("")
    print(f"PLAN     {p['path']}")
    print(f"         {p['bytes']:,} bytes, {p['extent'][0]} x {p['extent'][1]} m")
    print(f"         {p['walls']} walls in poche, {p['rooms']} rooms "
          f"({p['named']} named), {p['openings']} openings, {p['fixtures']} fixtures")
    print("")
    print(f"VIEWS    {v['path']}")
    print(f"         {v['total']} solved, {v['usable']} usable, "
          f"{v['interior']} interior ({v['tooTight']} too tight)")
    print(f"         best interior clearance {v['bestClearance']} m")
    for view in report["viewList"][:8]:
        tag = view["name"] or view["kind"]
        note = ("  " + view["notes"][0]) if view["notes"] else ""
        print(f"           {view['id']:<14} {tag[:22]:<24} "
              f"clearance {view['clearance']:>6.2f} m{note}")
    s = report["surface"]
    print("")
    print(f"SURFACE  {len(s['engines'])} engines, {len(s['experts'])} experts, "
          f"{len(s['styles'])} styles")
    print("         Geometry is deterministic. The seed affects only the finish.")

    if report.get("areas"):
        from quantify import areas as qa

        print("")
        print(qa.as_text(report["areas"]["statement"]))
        print(f"         -> {report['areas']['path']}")


def clearance_report(model_path: str) -> dict:
    """
    Can you use the rooms this model describes?

    Geometric facts only — no rulebook, no jurisdiction, no verdict. See
    solve/clearance.py for why that boundary is drawn where it is.
    """
    from classify.catalogue_dims import CATALOGUE_DIMS
    from solve import clearance

    model = json.loads(Path(model_path).read_text(encoding="utf-8"))
    issues = clearance.check_building(model, CATALOGUE_DIMS)
    return {
        "source": model.get("source"),
        "summary": clearance.summarise(issues),
        "issues": [i.as_dict() for i in issues],
    }


def codecheck_report(model_path: str, rulebook_path: str) -> dict:
    """
    Measured against a rulebook the architect owns.

    Findings carry a citation each; coverage carries everything that could NOT
    be checked and why. See solve/codecheck.py for the boundary with clearance.
    """
    from solve import codecheck as cc

    model = json.loads(Path(model_path).read_text(encoding="utf-8"))
    book = cc.load_rulebook(rulebook_path)
    findings, coverage = cc.check_building(model, book)
    return {
        "source": model.get("source"),
        "rulebook": book.get("title"),
        "summary": cc.summarise(findings, coverage, book),
        "findings": [f.as_dict() for f in findings],
        "coverage": coverage,
    }


def _print_codecheck(report: dict) -> None:
    s = report["summary"]
    print("")
    print(f"CODE     {report['rulebook']}")
    print(f"         {s['total']} findings across {s['checked']} checks; "
          f"{s['skipped']} not measurable")
    for finding in report["findings"][:20]:
        where = finding["roomName"] or (
            f"room {finding['room']}" if finding["room"] is not None else "-")
        if finding.get("storeyTitle"):
            where = f"{finding['storeyTitle']} · {where}"
        print(f"      !  [{where[:22]:<22}] {finding['message'][:96]}")
        print(f"           {finding['cite']}")
    if len(report["findings"]) > 20:
        print(f"     ... {len(report['findings']) - 20} more")
    skipped = [(row["rule"], skip) for row in report["coverage"]
               for skip in row["skipped"]]
    for rule, skip in skipped[:8]:
        print(f"      ?  {rule}: {skip['subject']} — {skip['reason']}")
    if len(skipped) > 8:
        print(f"     ... {len(skipped) - 8} more unmeasured")
    print("")
    print(f"  {s['basis']}")


def _print_comply(report: dict) -> None:
    """Print a compliance pass. The not-applicable case is the important one:
    it must read as a deliberate refusal, never as a clean bill of health."""
    s = report["summary"]
    print("")
    print(f"COMPLY   {report['ruleset']}  v{report['rulesetVersion']}")
    if not report["applicable"]:
        print(f"         NOT EVALUATED — project jurisdiction "
              f"{report['projectJurisdiction']!r} is outside this ruleset's "
              f"{report['jurisdiction']} scope.")
        print(f"         {s.get('note', '')}")
        print("")
        print("  Nothing was checked. This is not a pass.")
        return
    print(f"         {s['total']} findings · {s['checked']} checked · "
          f"{s['passed']} met · {s['unknown']} not measurable")
    print(f"         {s['rulesEvaluated']} rules evaluated of {s['rulesAvailable']} "
          f"usable ({s['rejectedRules']} rejected before measurement)")
    for finding in report["findings"][:20]:
        where = finding["roomName"] or (
            f"room {finding['room']}" if finding["room"] is not None else "-")
        print(f"      !  [{where[:22]:<22}] {finding['message'][:96]}")
        print(f"           {finding['cite']}")
    if len(report["findings"]) > 20:
        print(f"     ... {len(report['findings']) - 20} more")
    skipped = [(row["rule"], sk) for row in report["coverage"] for sk in row["skipped"]]
    for rule, sk in skipped[:8]:
        print(f"      ?  {rule}: {sk}")
    if len(skipped) > 8:
        print(f"     ... {len(skipped) - 8} more unmeasured")
    print("")
    print(f"  {s['basis']}")


def _print_clearance(report: dict) -> None:
    s = report["summary"]
    print("")
    print(f"CLEARANCE  {s['total']} findings "
          f"({s['blocking']} blocking, {s['tight']} tight, {s['notes']} notes)")
    if s["byKind"]:
        print("           " + ", ".join(f"{k}={n}" for k, n in s["byKind"].items()))
    print("")
    for issue in report["issues"][:14]:
        mark = {"blocking": "!!", "tight": " !", "note": "  "}.get(issue["severity"], "  ")
        where = issue["roomName"] or (f"room {issue['room']}" if issue["room"] is not None else "-")
        if issue.get("storeyTitle"):
            where = f"{issue['storeyTitle']} · {where}"
        print(f"  {mark} [{where[:22]:<22}] {issue['message']}")
    if len(report["issues"]) > 14:
        print(f"     ... {len(report['issues']) - 14} more")
    print("")
    print(f"  {s['basis']}")


def _print_report(report: dict) -> None:
    c = report["counts"]
    print(f"\nSOURCE   {report['source']}")
    if report["converter"]:
        conv = report["converter"]
        print(f"CONVERT  libredwg {conv['version']} -> "
              f"{conv['modelSpaceEntities']} model-space entities  passes={conv['passes']}")
        for w in conv["warnings"]:
            print(f"         ! {w}")

    flag = "  [FORCED]" if report["unitOverridden"] else ""
    print(f"UNIT     {report['unit']}  (scale {report['scale']}){flag} "
          f"extent {report['extent']} m   audit errors {report['auditErrors']}")
    if report["unitOverridden"]:
        print(f"         header said: {report['headerUnit']} (scale {report['headerScale']})")
    if len(report["scaleCandidates"]) > 1:
        print(f"         candidates: {report['scaleCandidates']}")

    print(f"\nLAYERS   {c['layers']}   wall layers: {', '.join(report['wallLayers'][:6]) or 'none'}")
    print(f"BLOCKS   {c['blockDefinitions']} definitions, {c['placements']} placements")
    print(f"LABELS   {c['roomLabels']} room labels, {c['wallSegments']} wall segments")

    print("\nCLASSIFIED")
    for label, n in report["census"]["byLabel"].items():
        print(f"  {label:<12} {n:>5}")
    print(f"  {'needs review':<12} {c['needsReview']:>5}")

    if report["census"]["byItem"]:
        print("\nIDENTIFIED ITEMS")
        for item, n in report["census"]["byItem"].items():
            print(f"  {item:<18} {n:>5}")

    if report["census"]["byRoomKind"]:
        print("\nBY ROOM KIND")
        for kind, n in report["census"]["byRoomKind"].items():
            print(f"  {kind:<14} {n:>5}")


#: Two plan titles closer together than this — measured in CHARACTER HEIGHTS of
#: the title's own text — belong to a text-style sample block, not to drawings.
#:
#: Measured on the villa: the two real titles sit 78.2 and 73.3 character heights
#: from their nearest neighbour; the five legend entries sit 2.13 to 2.24 apart.
#: A factor of 33, so 8.0 lands in the middle of a range where nothing changes.
#:
#: **Character heights and not metres**, because the unit inference is wrong on
#: four of the seven drawings in this corpus. Distance and character height
#: scale together, so the ratio survives a unit error that a metre threshold
#: would invert.
LEGEND_LINK_CHARHEIGHTS = 8.0


def best_graded_index(rows: list[tuple]) -> int:
    """
    Which graded frame wins: rows are (named, rooms, area) in shortlist order.

    Named rooms first — the objective the layer scan itself settled on, one
    level up; raw label count and unnamed room count were both measured and
    both lie (see the ranking pass in `reconstruct`). Ties resolve to the
    EARLIEST row, which is the incumbent wall-count order — a grade that cannot
    separate the candidates changes nothing.
    """
    return max(
        range(len(rows)),
        key=lambda i: (rows[i][0], rows[i][1], rows[i][2], -i),
    )


def _enclosure_seed(input_path: str, work_dir: str,
                    unit: str | None = None, limit: int = 4) -> list[str] | None:
    """
    The layers that actually CLOSE rooms, best first — a re-seed for a blocked build.

    Ranked by enclosure rather than by pairing verdict, for the reason
    `solve/layerscan.encloses` records at length: on a real client drawing the
    layer verdicted WALLS enclosed nothing and the layer dismissed as "not at
    wall thicknesses" enclosed eleven rooms, because that drawing puts a
    wall's two faces on two different layers.

    Returns None when nothing encloses anything — there is then no better seed
    to offer and the caller should keep the blocked build and its diagnosis
    rather than substitute a differently-wrong one.
    """
    report = layer_report(input_path, work_dir, unit=unit)
    ranked = [
        row for row in sorted(
            report.get("scores", []),
            key=lambda r: (-r.get("encloses", 0), -r.get("paired", 0)),
        )
        if row.get("encloses", 0) > 0
        and automatic_wall_layer_candidate(row["name"])
    ]
    if not ranked:
        return None
    # Keep the endorsed wall layers too: the enclosing layer is often only
    # half of each wall, and dropping its partner would trade one wrong
    # answer for another.
    seed = [row["name"] for row in ranked[:limit]]
    for row in report.get("scores", []):
        if (row.get("verdict") == "WALLS" and row["name"] not in seed
                and automatic_wall_layer_candidate(row["name"])):
            seed.append(row["name"])
    return seed


def automatic_wall_layer_candidate(name: str) -> bool:
    """Whether an inferred layer may enter wall fitting."""
    return (
        kernel.classify(name) != "ignore"
        and classify_layer(name) in ("wall", "other")
    )


MAX_UNMEASURED_OTHER_SEGMENTS = 400
MIN_LARGE_OTHER_PAIRED_FRACTION = 0.10


def fallback_wall_layer_candidate(name: str, segments: int, score) -> bool:
    """
    Admit useful centreline fallbacks without fitting enormous noise layers.

    Explicit wall semantics always survive. Unknown layers survive when small
    enough to be a plausible partitions supplement, or when their own measured
    pairing passes the wall scan. The 400-line safety net is above every useful
    fallback measured on the villa and compact plan frames; pathological
    ESMajor layers carry 1,211-15,922 lines with only 1-4% pairing coverage.
    """
    if not automatic_wall_layer_candidate(name):
        return False
    semantic = classify_layer(name)
    if semantic == "wall":
        return True
    if segments <= MAX_UNMEASURED_OTHER_SEGMENTS:
        return True
    return (
        score is not None
        and score.verdict == "WALLS"
        and getattr(score, "paired_fraction", 0.0)
        >= MIN_LARGE_OTHER_PAIRED_FRACTION
    )


def enclosure_retry_improves(original: dict, retry: dict) -> bool:
    """Whether an enclosure re-seed is safe to substitute for a blocked build."""
    if not (original.get("verify") or {}).get("blocking"):
        return False
    if (retry.get("verify") or {}).get("blocking"):
        return False

    # A layer retry is not permission to revisit the drawing's units. Explicit
    # retry layers change the evidence rank_units sees; on PLANS_FOR_3D that
    # changed measured metres to the 0.001 header and replaced 106 walls / 28
    # rooms with 4 / 1 merely because the tiny model happened not to block.
    try:
        if abs(float(retry["scale"]) - float(original["scale"])) > 1e-9:
            return False
    except (KeyError, TypeError, ValueError):
        return False

    before_rooms = original.get("rooms") or {}
    after_rooms = retry.get("rooms") or {}
    return (
        int(after_rooms.get("count", 0)) >= int(before_rooms.get("count", 0))
        and int(after_rooms.get("named", 0)) >= int(before_rooms.get("named", 0))
    )


def _site_summary(reports: list[dict]) -> dict | None:
    """The primary storey's segmentation, carrying the others when there are any."""
    if not reports:
        return None
    summary = dict(reports[0])
    if len(reports) > 1:
        summary["storeys"] = reports
    return summary


def promote_build(model: dict, trial_dir: Path, out_dir: Path) -> dict:
    """
    Move an ACCEPTED trial build's artefacts into the real output directory.

    ── The failure this exists to stop ────────────────────────────────────────
    `enclosure_retry_improves` decides which model the caller keeps, and it
    works: on `PLANS_FOR_3D` it correctly REFUSES the header-mm, `tx`-only
    4-wall / 1-room retry and keeps the measured-metre 106-wall / 28-room
    build. Measured 2026-08-26: the guard was defeated anyway, because
    `reconstruct()` WRITES `<stem>.building.json` and `<stem>.glb` as its final
    act. Both builds wrote to the same `--out`, so the rejected retry had
    already overwritten the accepted model before the guard was ever consulted.

    The console printed the 28-room build. The file on disk was the 4-wall one,
    carrying `"ok": true` — a REJECTED build published as a clean pass. That is
    the dangerous direction: `services/api/src/lib/cadEngine.js` reads the model
    from disk and never sees stdout, and its own docstring says shipping a
    blocking verdict to a viewer "is worse than failing". The worse the drawing,
    the more likely the viewer got a tidy 2.49 m2 "building" instead of a
    refusal.

    So a trial build goes somewhere else and only a decision moves it. The guard
    protects the decision; this protects the artefact.
    """
    import shutil

    stem = None
    glb = (model.get("glb") or {}).get("path") if isinstance(model.get("glb"), dict) else None
    for candidate in trial_dir.glob("*.building.json"):
        stem = candidate.name[: -len(".building.json")]
        break
    if stem is None:                      # nothing was written; nothing to promote
        return model

    out_dir.mkdir(parents=True, exist_ok=True)
    for suffix in (".building.json", ".glb"):
        source = trial_dir / f"{stem}{suffix}"
        if source.exists():
            shutil.copy2(source, out_dir / f"{stem}{suffix}")

    # The model records its own GLB's absolute path and the caller hands that
    # straight to a renderer. Copying the bytes and leaving the path pointing
    # into a scratch directory that is about to be reused would be the same
    # class of bug one layer down.
    if glb:
        model.setdefault("glb", {})["path"] = str(out_dir / f"{stem}.glb")

    (out_dir / f"{stem}.building.json").write_text(
        json.dumps(model, indent=2), encoding="utf-8"
    )
    return model


def unresolved_unit_guidance(unit_verdict, current_scale: float) -> str:
    """Actionable review text when walls prefer, but cannot prove, another unit."""
    if unit_verdict is None or unit_verdict.decided or unit_verdict.best is None:
        return "Review the wall layers before building 3D."
    best = unit_verdict.best
    if abs(best.scale - current_scale) <= 1e-9:
        return "Review the wall layers before building 3D."
    return (
        "Review the unit first: wall thickness weakly prefers "
        f"{best.label} (scale {best.scale:g}) over the current scale "
        f"{current_scale:g}. Re-solve with that unit, then review wall layers "
        "if rooms still do not close."
    )


def contained_frame_count(frame, frames: list) -> int:
    """How many independently segmented drawings lie wholly inside this bbox."""
    x0, y0, x1, y1 = frame.bbox
    return sum(
        1 for other in frames
        if other is not frame
        and other.bbox[0] >= x0 and other.bbox[1] >= y0
        and other.bbox[2] <= x1 and other.bbox[3] <= y1
    )


#: How much of a rejected candidate's error to quote in the note. Presentation
#: only — the whole string is already in `frameRanking.graded`. One of these
#: errors is a full envelope-coverage paragraph and would bury the frame
#: numbers, which are the part the operator has to act on.
REJECTED_ERROR_CHARS = 90


def fallback_frame_note(graded: list[tuple], incumbent) -> str:
    """
    Say so when the frame was a fallback rather than a choice, and name the rest.

    `best_eligible_graded_index` returns the wall-count incumbent when no
    candidate grades cleanly, and that is the right conservative move: a broken
    grade is no basis for promoting anything over anything else. What was
    missing is that nobody was TOLD. A silent fallback reads exactly like a
    decision, and the report says `promoted: false` in a JSON field no operator
    reads mid-build.

    Measured on `SITE PLAN FOR 3D`: all four candidates errored, the incumbent
    was the 833 m `REVISED SITE PLAN` — a site layout, which has no doors by
    nature and blocks on two checks — while frame 2, rejected for the mildest
    of the four reasons, builds a model that PASSES with 15 hosted doors. A
    full day went into reading that as missing opening detection.

    This deliberately does not re-rank. Choosing between four broken grades
    needs a severity order, that order would be invented here rather than
    measured, and the rejected candidate is not reliably the better one — on
    this sheet it was, on the next it need not be. Naming the alternatives lets
    the operator type `--frame N` and settle it in one build.
    """
    if not graded or not all(row[5] for row in graded):
        return ""
    others = "; ".join(
        f"--frame {frame.index} ({frame.title or 'untitled'}, "
        f"{len(frame.wall_indices)} walls): "
        f"{error.splitlines()[0][:REJECTED_ERROR_CHARS]}"
        for frame, _named, _rooms, _area, _labels, error in graded
        if frame is not incumbent
    )
    if not others:
        return ""
    return ("NO candidate graded cleanly, so this frame is the wall-count "
            "fallback rather than a choice — the others were considered and "
            f"rejected: {others}")


def best_eligible_graded_index(rows: list[tuple], errors: list[str | None]) -> int:
    """Pick the best coherent grade; fall back to the incumbent if none exist."""
    eligible = [i for i, error in enumerate(errors) if error is None]
    if not eligible:
        return 0
    local = best_graded_index([rows[i] for i in eligible])
    return eligible[local]


def _real_plan_titles(titles: list) -> list:
    """Drop titles that are really entries in a legend or a style sample."""
    import math

    kept = []
    for title in titles:
        if not title.char_height:
            continue
        others = [t for t in titles if t is not title]
        if not others:
            kept.append(title)
            continue
        nearest = min(math.hypot(title.x - t.x, title.y - t.y) for t in others)
        if nearest / title.char_height >= LEGEND_LINK_CHARHEIGHTS:
            kept.append(title)
    return kept


#: The rate library, relative to the repo root.
DEFAULT_RATES = Path(__file__).resolve().parents[2] / "data" / "rates" / "hyderabad-2026.csv"
DEFAULT_RULEBOOK = (
    Path(__file__).resolve().parents[2]
    / "data" / "rulebooks" / "nbc-2016-residential.json"
)

#: The machine-extracted ruleset, for the `comply` pass that runs beside codecheck.
DEFAULT_RULESET = (
    Path(__file__).resolve().parents[2]
    / "data" / "rulesets" / "building-rules-v0.1.0.json"
)

#: Jurisdiction the model is being built for. `comply` holds US FEDERAL rules, so it
#: evaluates nothing unless the project is actually in that scope.
#:
#: The default is deliberately NOT "US federal". These are mostly Indian buildings, and a
#: 0.75 m internal door is legal in India while falling short of ADA's 812.8 mm — running
#: the pass by default would put dozens of true-but-inapplicable findings in front of
#: someone, which is how a report teaches its reader to ignore it. Declaring the
#: jurisdiction is a statement about the project and has to be made deliberately.
DEFAULT_JURISDICTION = os.environ.get("ARCVIA_JURISDICTION", "IN")

#: Mirrored from `quantify.rates` rather than imported, so this CLI still starts
#: when the rate library is absent — `survey` and `reconstruct` do not need it.
FRESH_DAYS_HINT = 7
STALE_DAYS_HINT = 90


def costing_report(model_path: str, rates_path: str, height: float | None = None,
                   band: str = "base", masonry: str = "brick") -> dict:
    """Price a reconstructed model against the rate library."""
    from quantify import boq
    from quantify.rates import RateLibrary

    model = json.loads(Path(model_path).read_text(encoding="utf-8"))
    library = RateLibrary.load(rates_path)

    # The model records the height its walls were built to. Using anything else
    # silently prices a different building from the one in the GLB.
    if height is None:
        height = float(model.get("wallHeight") or DEFAULT_WALL_HEIGHT)

    costing = boq.build(model, library, height=height, band=band, masonry=masonry)
    report = costing.as_dict()
    report["model"] = model_path
    report["rates"] = str(rates_path)
    report["height"] = height
    return report


def _print_costing(report: dict) -> None:
    print()
    print(f"BOQ      {report['model']}")
    print(f"         band {report['band']}, walls at {report['height']:.2f} m")
    print()

    for section, amount in report["bySection"].items():
        print(f"  {section:<14} {amount:>16,.2f}")
    print(f"  {'':<14} {'-' * 16}")
    print(f"  {'TOTAL':<14} {report['total']:>16,.2f}  {report['currency']}")

    if report["unpriced"]:
        # Never a footnote. A BOQ that quietly omits what it could not price is
        # a BOQ that is too cheap, and the omission is invisible precisely where
        # it matters most.
        print()
        print(f"UNPRICED {len(report['unpriced'])} line(s) — NOT in the total above")
        for line in report["unpriced"]:
            print(f"  {line['description']:<38} {line['quantity']:>10,.2f} {line['unit']}")
            print(f"      {line['note'] or line['rule']}")

    age = report.get("oldestRateDays")
    print()
    if age is None:
        print("RATES    undated — this total cannot be said to be current")
    elif age > STALE_DAYS_HINT:
        print(f"RATES    !! oldest rate is {age} days old. This is a historical "
              f"note, not a quotation.")
    elif age > FRESH_DAYS_HINT:
        print(f"RATES    oldest rate {age} days old — past the weekly refresh. "
              f"Run `rates --refresh` before quoting.")
    else:
        print(f"RATES    oldest rate {age} days old")
    print()


def rates_report(rates_path: str, do_refresh: bool = False, older_than: int = 7,
                 hosts: set[str] | None = None, write_back: bool = False) -> dict:
    """Report the library's freshness, and optionally re-read its sources."""
    from quantify import refresh as refresher
    from quantify.rates import RateLibrary

    library = RateLibrary.load(rates_path)
    report = {"source": str(rates_path), "before": library.freshness()}

    if do_refresh:
        result = refresher.refresh(library, only_older_than=older_than, limit_hosts=hosts)
        report["refresh"] = result.as_dict()
        report["after"] = library.freshness()

        # Writing is opt-in even after a successful fetch. A refresh that
        # rewrites the library by default makes `--refresh` unrunnable as a
        # dry run, and a dry run is exactly what you want the first time a
        # source page changes layout.
        if write_back:
            refresher.write_csv(library, str(rates_path))
            report["written"] = str(rates_path)

    return report


def _print_rates(report: dict) -> None:
    before = report["before"]
    print()
    print(f"RATES    {report['source']}")
    print(f"         {before['rates']} rates, {before['dated']} dated, "
          f"{before['undated']} undated")
    print(f"         oldest {before['oldestDays']} days, newest {before['newestDays']} days")
    print(f"         {before['refreshable']} refreshable, "
          f"{before['vendorQuoteRequired']} need a vendor quote")

    if "refresh" not in report:
        print()
        print("         Report only. Add --refresh to re-read the sources.")
        print()
        return

    result = report["refresh"]
    print()
    print(f"REFRESH  {result['checkedAt']}")
    print(f"         {result['updated']} updated, "
          f"{result['unreachable']} unreachable, "
          f"{result['untrusted']} read but not trusted")

    # All three are printed, always. The dangerous refresh is the one that half
    # succeeds and reports only the half that worked.
    for line in result["detail"]["updated"][:10]:
        print(f"  ok    {line['id']:<12} {line['from']} -> {line['to']} "
              f"({line['move']:+.1%})  page dated {line['pageDate'] or 'none'}")
    for line in result["detail"]["unreachable"][:10]:
        print(f"  DOWN  {line['id']:<12} {line['reason']}")
    for line in result["detail"]["untrusted"][:10]:
        print(f"  ??    {line['id']:<12} {line['reason']}")

    if report.get("written"):
        print(f"\n         wrote {report['written']}")
    else:
        print("\n         Nothing written. Add --write to save.")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(prog="reconstruct")
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("survey", help="Read a drawing and report what is in it.")
    s.add_argument("--input", required=True)
    s.add_argument("--work", default="A:/tmp/reconstruct")
    s.add_argument("--unit", default=None,
                   help="Force a unit (mm|cm|m|in|ft), overriding $INSUNITS.")
    s.add_argument("--json", dest="json_out", default=None)

    b = sub.add_parser("reconstruct", help="Drawing -> walls -> GLB.")
    b.add_argument("--input", required=True)
    b.add_argument("--work", default="A:/tmp/reconstruct")
    b.add_argument("--out", required=True)
    b.add_argument("--with-roof", action="store_true",
                   help="Infer a flat roof and parapet. OFF by default: "
                        "the isometric view is a CUTAWAY and a roof lids it.")
    b.add_argument("--unit", default=None, help="Force a unit (mm|cm|m|in|ft).")
    b.add_argument("--layers", default=None,
                   help="Comma-separated wall layers. Defaults to the name heuristic.")
    b.add_argument("--height", type=float, default=DEFAULT_WALL_HEIGHT)
    b.add_argument("--frame", type=int, default=0,
                   help="Which drawing on the sheet (0 = largest).")
    b.add_argument("--building", type=int, default=None,
                   help="Which building within the frame (0 = largest by floor "
                        "area). For a SITE plan, whose villas share no wall. "
                        "The build reports its buildings either way.")
    b.add_argument("--no-fixtures", action="store_true",
                   help="Walls and rooms only.")
    b.add_argument("--auto-layers", action="store_true",
                   help="Choose wall layers by what they enclose, per frame.")
    b.add_argument("--no-perimeter", action="store_true",
                   help="Do not derive the building envelope.")
    b.add_argument("--storeys", action="store_true",
                   help="Build every storey the sheet names, not just one frame.")

    R = sub.add_parser("raster", help="A photo or scan of a plan -> walls -> GLB.")
    R.add_argument("--input", required=True, help="PNG, JPG or WebP of a floor plan.")
    R.add_argument("--out", required=True)
    R.add_argument("--height", type=float, default=DEFAULT_WALL_HEIGHT)
    R.add_argument("--detector", default=None,
                   help="Where services/floorplan-ai is listening.")
    R.add_argument("--scale", type=float, default=None,
                   help="Metres across the image, if the drawing prints none.")
    R.add_argument("--no-perimeter", action="store_true")

    # A client's presentation PDF, not a single plan image. Two phases so the
    # scale the user confirms is not billed twice — survey reads, build models.
    DK = sub.add_parser("deck", help="A presentation PDF -> a GLB per floor plan.")
    dk_sub = DK.add_subparsers(dest="deck_mode", required=True)

    dks = dk_sub.add_parser("survey", help="What plans are inside, and their scale.")
    dks.add_argument("--input", required=True, help="The PDF.")
    dks.add_argument("--out", required=True, help="Where preview images are written.")
    dks.add_argument("--detector", default=None,
                     help="Where services/floorplan-ai is listening.")
    dks.add_argument("--long-edge", type=int, default=2400)
    dks.add_argument("--json", dest="json_out", default=None,
                     help="Write the survey JSON here as well as stdout.")

    dkb = dk_sub.add_parser("build", help="Reconstruct one chosen plan sheet.")
    dkb.add_argument("--input", required=True, help="The PDF.")
    dkb.add_argument("--out", required=True)
    dkb.add_argument("--page", type=int, required=True,
                     help="The sheet's page, as survey reported it.")
    dkb.add_argument("--index", type=int, default=0,
                     help="Which image on that page (survey reports it).")
    dkb.add_argument("--scale", type=float, default=None,
                     help="Metres across the image, from the confirmed dimension.")
    dkb.add_argument("--height", type=float, default=DEFAULT_WALL_HEIGHT)
    dkb.add_argument("--detector", default=None)
    dkb.add_argument("--no-perimeter", action="store_true")
    dkb.add_argument("--long-edge", type=int, default=2400)

    L = sub.add_parser("layers", help="Which layers hold walls, with evidence.")
    L.add_argument("--input", required=True)
    L.add_argument("--work", default="A:/tmp/reconstruct")
    L.add_argument("--unit", default=None)
    L.add_argument("--json", dest="json_out", default=None)

    D = sub.add_parser("deliverables", help="Plan drawing and solved cameras.")
    D.add_argument("--model", required=True, help="A building.json from reconstruct.")
    D.add_argument("--out", required=True)

    C = sub.add_parser("clearance", help="Can you use these rooms? Geometry only.")
    C.add_argument("--model", required=True)
    C.add_argument("--json", dest="json_out", default=None)

    K = sub.add_parser("codecheck",
                       help="Measured against a rulebook. Citations, no verdict.")
    K.add_argument("--model", required=True, help="A building.json from reconstruct.")
    K.add_argument("--rulebook", default=str(DEFAULT_RULEBOOK),
                   help="A rulebook JSON. The default is an NBC 2016 transcription "
                        "the architect must verify.")
    K.add_argument("--json", dest="json_out", default=None)

    Y = sub.add_parser("comply",
                       help="Measured against the machine-extracted ruleset. "
                            "Clause, date and the regulation's own sentence on every "
                            "finding. No verdict.")
    Y.add_argument("--model", required=True, help="A building.json from reconstruct.")
    Y.add_argument("--ruleset", default=str(DEFAULT_RULESET),
                   help="A versioned ruleset JSON from data/rulesets/.")
    Y.add_argument("--jurisdiction", default=DEFAULT_JURISDICTION,
                   help="The project's jurisdiction. The ruleset is US FEDERAL law and "
                        "evaluates nothing outside its scope, so this defaults to "
                        f"{DEFAULT_JURISDICTION!r} — pass 'US federal' deliberately.")
    Y.add_argument("--json", dest="json_out", default=None)

    Q = sub.add_parser("costing", help="A priced bill of quantities from a model.")
    Q.add_argument("--model", required=True, help="A building.json from reconstruct.")
    Q.add_argument("--rates", default=str(DEFAULT_RATES))
    Q.add_argument("--height", type=float, default=None,
                   help="Wall height. Defaults to the height the model was built to.")
    Q.add_argument("--band", default="base", choices=["low", "base", "high"])
    Q.add_argument("--masonry", default="brick", choices=["brick", "aac"])
    Q.add_argument("--json", dest="json_out", default=None)

    T = sub.add_parser("rates", help="Rate library freshness, and the weekly refresh.")
    T.add_argument("--rates", default=str(DEFAULT_RATES))
    # Refresh and write are separate flags on purpose. `--refresh` alone is a dry
    # run that reaches the network and tells you what it WOULD change, which is
    # what you want the first time a source page changes layout. Nothing is
    # written to the library without --write.
    T.add_argument("--refresh", action="store_true",
                   help="Re-read the source pages. Reports only; use --write to save.")
    T.add_argument("--write", action="store_true",
                   help="Write the refreshed rates back to the CSV.")
    T.add_argument("--older-than", type=int, default=7,
                   help="Only re-fetch rates older than this many days.")
    T.add_argument("--hosts", default=None,
                   help="Comma-separated host substrings, to refresh one source.")
    T.add_argument("--json", dest="json_out", default=None)

    ns = parser.parse_args()

    if ns.command == "raster":
        from ingest.raster_build import reconstruct_raster

        model = reconstruct_raster(
            ns.input, ns.out,
            height=ns.height,
            detector_url=ns.detector,
            unit_scale=ns.scale,
            with_perimeter=not ns.no_perimeter,
        )
        stem = Path(ns.input).stem
        (Path(ns.out) / f"{stem}.building.json").write_text(
            json.dumps(model, indent=2), encoding="utf-8"
        )
        detector = model["detector"]
        scale = model["scale"]
        print()
        print(f"DETECT   {detector['faces']} single lines, "
              f"{detector['prePaired']} already paired, "
              f"{detector['rooms']} rooms ({detector['named']} named)")
        spread = scale["spread"]
        agreement = (
            f", {spread:.0%} spread" if spread is not None
            else " with nothing to disagree with"
        )
        print(f"SCALE    {scale['metresPerUnit']:.2f} m across the image, "
              f"{scale['samples']} room(s){agreement}")
        if scale.get("warning"):
            # Printed on its own line and marked, because everything below it is
            # measured in this number and a reader skims a report like this.
            print(f"         !! {scale['warning']}")
        print(f"WALLS    {model['walls']['total']}, "
              f"median thickness {model['walls']['medianThickness']} m")
        print(f"ROOMS    {model['rooms']['count']} "
              f"({model['rooms']['fromWallGraph']} from the wall graph alone)")
        v = model["verify"]
        print(f"VERIFY   {'PASS' if v.get('ok') else 'BLOCKED'}  "
              f"({v.get('blocking', 0)} blocking, {v.get('warnings', 0)} warnings)")
        print(f"GLB      {model['glb']['path']}")
        print(f"         {model['glb']['triangles']:,} triangles")
        print()
        return

    if ns.command == "deck":
        from ingest.deck_build import survey_deck, build_sheet

        if ns.deck_mode == "survey":
            result = survey_deck(
                ns.input, ns.out, detector_url=ns.detector, long_edge=ns.long_edge
            )
            if ns.json_out:
                Path(ns.json_out).parent.mkdir(parents=True, exist_ok=True)
                Path(ns.json_out).write_text(
                    json.dumps(result, indent=2), encoding="utf-8"
                )
            print()
            print(f"DECK     {result['pages']} pages, {result['plansFound']} floor "
                  f"plan(s) found")
            for sheet in result["sheets"]:
                trust = "trustworthy" if sheet["scale"]["trustworthy"] else "UNCONFIRMED"
                print(f"  [{sheet['page']}.{sheet['index']}] {sheet['stem']:16} "
                      f"{sheet['rooms']} named room(s), scale {trust}"
                      f"  suggest {sheet['suggestedScale']} m across")
                anchor = next(
                    (c for c in sheet["confirmDimensions"] if c["reliableAnchor"]), None
                )
                if anchor:
                    print(f"        confirm e.g. {anchor['room']} "
                          f"{anchor['longSideMetres']} m -> "
                          f"--scale {anchor['impliedScale']}")
            if result["otherSheets"]:
                print(f"  ({len(result['otherSheets'])} non-plan sheet(s): "
                      f"renders, elevations, board)")
            print()
            return

        model = build_sheet(
            ns.input, ns.page, ns.index, ns.out,
            height=ns.height,
            detector_url=ns.detector,
            unit_scale=ns.scale,
            with_perimeter=not ns.no_perimeter,
            long_edge=ns.long_edge,
        )
        stem = model["sheet"]["stem"]
        (Path(ns.out) / f"{stem}.building.json").write_text(
            json.dumps(model, indent=2), encoding="utf-8"
        )
        scale = model["scale"]
        print()
        print(f"SHEET    {stem}  (page {ns.page}.{ns.index})")
        print(f"SCALE    {scale['metresPerUnit']:.2f} m across the image, "
              f"{scale['samples']} sample(s)"
              + (f", {scale['spread']:.0%} spread" if scale.get("spread") is not None
                 else ""))
        if scale.get("warning"):
            print(f"         !! {scale['warning']}")
        print(f"WALLS    {model['walls']['total']}, "
              f"median thickness {model['walls']['medianThickness']} m")
        print(f"ROOMS    {model['rooms']['count']}")
        v = model["verify"]
        print(f"VERIFY   {'PASS' if v.get('ok') else 'BLOCKED'}  "
              f"({v.get('blocking', 0)} blocking, {v.get('warnings', 0)} warnings)")
        print(f"GLB      {model['glb']['path']}")
        print(f"         {model['glb']['triangles']:,} triangles")
        print()
        return

    if ns.command == "costing":
        report = costing_report(ns.model, ns.rates, height=ns.height,
                                band=ns.band, masonry=ns.masonry)
        _print_costing(report)
        if ns.json_out:
            Path(ns.json_out).parent.mkdir(parents=True, exist_ok=True)
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"wrote {ns.json_out}\n")
        return 0

    if ns.command == "rates":
        if ns.write and not ns.refresh:
            # --write on its own would rewrite the library from itself: a no-op
            # that rewrites every row and touches the file's mtime, which looks
            # exactly like a successful refresh in a directory listing.
            print("--write does nothing without --refresh.")
            return 2

        report = rates_report(
            ns.rates,
            do_refresh=ns.refresh,
            older_than=ns.older_than,
            hosts={h.strip() for h in ns.hosts.split(",")} if ns.hosts else None,
            write_back=ns.write,
        )
        _print_rates(report)
        if ns.json_out:
            Path(ns.json_out).parent.mkdir(parents=True, exist_ok=True)
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"wrote {ns.json_out}\n")

        # A refresh that reached nothing is a failed run, not a quiet success —
        # it must be visible to whatever runs this on a timer.
        if ns.refresh:
            result = report["refresh"]
            if result["updated"] == 0 and (result["unreachable"] or result["untrusted"]):
                return 1
        return 0

    if ns.command == "clearance":
        report = clearance_report(ns.model)
        _print_clearance(report)
        if ns.json_out:
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 0

    if ns.command == "codecheck":
        report = codecheck_report(ns.model, ns.rulebook)
        _print_codecheck(report)
        if ns.json_out:
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 0

    if ns.command == "comply":
        from comply import assess as comply_assess

        model = json.loads(Path(ns.model).read_text(encoding="utf-8"))
        report = comply_assess(model, ns.ruleset,
                               jurisdiction=ns.jurisdiction).as_dict()
        _print_comply(report)
        if ns.json_out:
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 0

    if ns.command == "deliverables":
        report = deliverables(ns.model, ns.out)
        _print_deliverables(report)
        return 0

    if ns.command == "layers":
        report = layer_report(ns.input, ns.work, unit=ns.unit)
        _print_layers(report)
        if ns.json_out:
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 0

    if ns.command == "reconstruct":
        def _build(chosen_layers, out_dir=None):
            return reconstruct(
                ns.input, ns.work, out_dir or ns.out, unit=ns.unit,
                layers=chosen_layers,
                height=ns.height, frame_index=ns.frame,
                with_fixtures=not ns.no_fixtures, auto_layers=ns.auto_layers,
                with_perimeter=not ns.no_perimeter,
                with_storeys=ns.storeys, with_roof=ns.with_roof,
                building_index=ns.building,
            )

        explicit = [s.strip() for s in ns.layers.split(",")] if ns.layers else None
        model = _build(explicit)

        # ── One retry, and ONLY out of a blocked build ──────────────────────
        # The bootstrap frame is derived from the name-heuristic layer seed,
        # and that seed only has to land in the right PLACE — except when it
        # is a small minority of the plan's linework, and then it does not.
        # Measured on a real client upload: seeding from `A-WALL` (a third of
        # the drawing) framed the building as TWO drawings of 9.2 m where it
        # is one of 28.66 m, and layer selection, scoped to a frame that was
        # both too small and falsely split, could never recover — 3 rooms and
        # a blocked verify against 33 rooms and a clean pass from the same
        # file with the right layers.
        #
        # The fix is not a better seed heuristic; enclosure already knows the
        # answer (`solve/layerscan.encloses`), it just is not consulted until
        # after framing. So: if the build BLOCKED, re-seed from the layers
        # that actually close rooms and try once more. Gating on failure is
        # what makes this safe — a drawing that verifies is never re-run, so
        # nothing that works today can change — and it costs time only where
        # the alternative was an unusable model.
        blocked = bool((model.get("verify") or {}).get("blocking"))
        if blocked and not explicit:
            try:
                widened = _enclosure_seed(ns.input, ns.work, unit=ns.unit)
            except Exception as error:  # noqa: BLE001 — never fail a build for this
                # The comment here used to say "a retry must not mask the
                # error" while doing precisely that: the reason went into a
                # bare `None` and the operator saw a build that simply did not
                # retry, with nothing to say why. A status without its reason
                # is not a record.
                widened = None
                print(f"\nRETRY    could not re-seed from the enclosing layers: "
                      f"{type(error).__name__}: {error}")
            if widened:
                # Into a scratch directory, NOT `--out`. `reconstruct()` writes the
                # model and the GLB itself, so a retry aimed at the real output
                # overwrites the accepted build before anything gets to judge it —
                # measured 2026-08-26; see `promote_build`.
                trial = Path(ns.work) / "enclosure-retry"
                retry = _build(widened, str(trial))
                if enclosure_retry_improves(model, retry):
                    retry["layerRetry"] = {
                        "reason": "first build blocked; re-seeded from the "
                                  "layers that enclose rooms",
                        "layers": widened,
                    }
                    print("\nRETRY    the first build was BLOCKED. Re-seeded from "
                          f"the layers that enclose rooms: {', '.join(widened)}")
                    model = promote_build(retry, trial, Path(ns.out))
                else:
                    # Say so. A refused retry that vanished silently is how this went
                    # unnoticed for so long: the operator saw one summary and had no
                    # way to know a second build had been run and rejected.
                    print("\nRETRY    re-seeded from the enclosing layers and "
                          "REFUSED the result; keeping the first build.")

        _print_build(model)
        return 0

    if ns.command == "survey":
        report = survey(ns.input, ns.work, unit=ns.unit)
        _print_report(report)
        if ns.json_out:
            Path(ns.json_out).parent.mkdir(parents=True, exist_ok=True)
            Path(ns.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"\nwrote {ns.json_out}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
