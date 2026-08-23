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
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify.elements import classify_footprint, classify_room  # noqa: E402
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

    reading = kernel.read(str(dxf_path))

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

    doc, auditor = blk.open_dxf(str(dxf_path))

    footprints = blk.block_footprints(doc, scale)

    # Only text that actually names a room can act as room context. The nearest
    # *text* to a sofa is very often a dimension or a note, and letting those
    # win means the sofa is contextualised by the string "3.40" — which is
    # worse than having no context at all, because it silently reads as one.
    labels = [
        label
        for label in blk.room_labels(doc, scale, origin)
        if classify_room(label.text) != "unknown"
    ]

    # Wall linework only — this is what "against a wall" is measured against,
    # and running it over every segment in the drawing would measure distance
    # to the nearest dimension line instead.
    wall_layers = {r["name"] for r in reading["layers"] if r["guess"] == "wall"}
    wall_segments = [s for s in reading["_segments"] if s.layer in wall_layers]

    placed = kernel.furniture(str(dxf_path), reading)

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
) -> dict:
    """
    Drawing -> walls, rooms, openings, fixtures -> GLB.

    One frame, one storey. No solver and no residual queue yet — what this
    proves is that the whole chain from a real DWG to a furnished, room-bearing
    3D asset closes without a human in the middle.
    """
    from build.glb import MeshBuilder, write_glb
    from build.solidify import build_fixtures, build_slabs, build_walls
    from classify.catalogue_dims import CATALOGUE_DIMS
    from hypothesise import openings as op
    from hypothesise.pair import Face, join_corners, pair_faces, summarise
    from solve import spaces as sp
    from solve.frames import MIN_WALLS, segment_frames
    from hypothesise.perimeter import add_perimeter
    from hypothesise.perimeter import summarise as perimeter_summary
    from solve import verify as vf

    source = Path(input_path)
    work, out = Path(work_dir), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    dxf_path, converter = _as_dxf(source, work)
    reading = kernel.read(str(dxf_path))

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

    doc, _auditor = blk.open_dxf(str(dxf_path))

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

    # ---- Are any of these storeys of one building? -------------------------
    # Reported, not acted on. `storey0` is still hardcoded downstream, so this
    # does not yet change what gets built — but the question is now ANSWERED and
    # recorded, and a sheet holding one building with two floors no longer looks
    # identical to a sheet holding two buildings.
    from solve.storeys import register_storeys

    storeys = register_storeys(frames, rise=height + 0.3)

    # ── Frame selection: TRIED, MEASURED, AND REVERTED ──────────────────────
    # The obvious next step, now that storeys are named, is to default to the
    # GROUND floor rather than to `frames[0]` — which is whichever cluster
    # carries the most wall segments, a guess on a sheet with 37 drawings.
    # It is a better reason. It produces a worse building.
    #
    # Measured on the villa. Switching the default from frame 0 ('Lower Ground
    # Floor Plan') to frame 1 ('Ground Floor Plan') moves the per-frame layer
    # scan onto a different answer — `A1 WALLS HIDDEN + A7 COMPOUND WALL`
    # instead of `A1 WALLS HIDDEN + A5 FALSE CEILING` — and the result collapses:
    #
    #     frame 0 (lower ground)   146 walls   23 rooms   252.76 m2
    #     frame 1 (ground)          58 walls    5 rooms   296.87 m2, of which
    #                                                     ONE room is 274.84 m2
    #
    # A 274 m2 'LIVING / DINING' is a plan whose partitions did not close. So the
    # ground-floor frame reconstructs badly for a reason that has nothing to do
    # with which frame is the right one to pick: `solve/layerscan.py` chooses
    # wrongly for it. Changing the default before fixing that trades a guess with
    # a good outcome for a justified choice with a bad one.
    #
    # Recorded rather than silently dropped, because the finding is the useful
    # part: **the layer scan gets frame 1 of the villa wrong**, and that is worth
    # more than the selection change was. Do not re-attempt this until it is
    # fixed, and when you do, measure rooms and enclosed area, not just which
    # frame got chosen — the reason this was caught is that the second column
    # was there.

    def _labels_in(a, b, c, d):
        return [
            lb for lb in blk.room_labels(doc, scale, (ox, oy))
            if classify_room(lb.text) != "unknown"
            and a - 2 <= lb.x <= c + 2 and b - 2 <= lb.y <= d + 2
        ]

    placed = kernel.furniture(str(dxf_path), reading)

    def _blocks_in(a, b, c, d):
        return [
            q for q in placed["placements"]
            if a - 1 <= q["position"]["x"] <= c + 1
            and b - 1 <= q["position"]["y"] <= d + 1
        ]

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
    # Nested rather than top-level on purpose: it closes over the reading, the
    # document, the block placements and the scale, all of which are per-SHEET.
    # Only the walls, the bbox and the base are per-storey.
    def _solve_frame(frame_walls, bbox, base_z: float = 0.0) -> dict:
        x0, y0, x1, y1 = bbox
        walls = frame_walls
        chosen_here = set(chosen)

        labels = _labels_in(x0, y0, x1, y1)
        in_frame = _blocks_in(x0, y0, x1, y1)

        # ---- Second pass: choose the layers for THIS frame ---------------------
        # The first pass used the conservative name heuristic, which is plan-only
        # and so lands on the right part of the sheet even when it misses most of
        # the walls. That frame now scopes the layer search — which is what excludes
        # the elevation layers by geometry rather than by name.
        layer_choice = None
        if auto_layers and not layers:
            from solve import layerscan

            within: dict[str, list] = {}
            for seg in reading["_segments"]:
                face = Face(
                    ax=(seg.x1 - ox) * scale, ay=(seg.y1 - oy) * scale,
                    bx=(seg.x2 - ox) * scale, by=(seg.y2 - oy) * scale, layer=seg.layer,
                )
                if (min(face.ax, face.bx) >= x0 - 1 and max(face.ax, face.bx) <= x1 + 1
                        and min(face.ay, face.by) >= y0 - 1 and max(face.ay, face.by) <= y1 + 1):
                    within.setdefault(seg.layer, []).append(face)

            shortlist = layerscan.recommended(layerscan.scan(within)) | (chosen_here & set(within))
            selected, trace = layerscan.select_within_frame(
                within, shortlist, labels, in_frame, classify_room, kernel.guess_item,
            )
            if selected:
                # `sorted`, because `selected` is a set of layer NAME STRINGS
                # and Python randomises string hashing per process. Iterating
                # it directly built the wall-face pool in a different order on
                # every run, and pairing and corner-joining are order-sensitive
                # — so the same drawing produced 148 walls / 260.3 m2 on one
                # run and 147 / 259.4 on the next, with no code change between
                # them. That is a quotation that changes when you re-run it.
                #
                # PYTHONHASHSEED=0 pins it, which is how this was identified,
                # but pinning the seed hides the dependency rather than
                # removing it. Sorting cannot change WHICH layers were chosen,
                # only the order they are read in.
                #
                # Note the report on the next line already sorted. The display
                # was made deterministic and the data it described was not.
                pool = [f for name in sorted(selected) for f in within[name]]
                walls = join_corners(pair_faces(pool))
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
            in_frame = _blocks_in(x0, y0, x1, y1)

        # ---- The envelope ------------------------------------------------------
        # A partitions-only plan encloses almost nothing, because the largest space
        # in a modern house is open plan and bounded by the building rather than by
        # interior walls. See hypothesise/perimeter.py.
        if with_perimeter:
            walls = add_perimeter(walls)

        wall_stats = summarise(walls)
        wall_stats["perimeter"] = perimeter_summary(walls)

        # ---- Rooms -------------------------------------------------------------
        rooms = sp.detect_spaces(walls, labels=labels, classify_room=classify_room)
        room_stats = sp.summarise(rooms)

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

        holes, unhosted = op.from_sized_blocks(in_frame, walls, kernel.guess_item)
        holes = op.dedupe(holes)
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
        wall_mesh, floor_mesh, fixture_mesh = MeshBuilder(), MeshBuilder(), MeshBuilder()
        wall_build = build_walls(wall_mesh, walls, holes, height)
        slab_build = build_slabs(floor_mesh, rooms)
        fixture_build = build_fixtures(fixture_mesh, fixtures, CATALOGUE_DIMS)

        return {
            "walls": walls, "rooms": rooms, "holes": holes,
            "unhosted": unhosted, "fixtures": fixtures,
            "chosen": chosen_here, "layerChoice": layer_choice,
            "wallStats": wall_stats, "roomStats": room_stats,
            "openingStats": opening_stats,
            "meshes": (wall_mesh, floor_mesh, fixture_mesh),
            "builds": (wall_build, slab_build, fixture_build),
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
    stack = storeys.stacks[0] if (with_storeys and storeys.stacks) else []

    if stack:
        datum = frames[min(stack, key=lambda s: abs(s.level)).frame_index].bbox
        for level in stack:
            frame = frames[level.frame_index]
            frame_walls = [all_walls[i] for i in frame.wall_indices]
            result = _solve_frame(frame_walls, frame.bbox, base_z=level.base_z)
            shift = (datum[0] - frame.bbox[0], datum[1] - frame.bbox[1])
            for mesh in result["meshes"]:
                mesh.translate_plan(*shift)
            solved.append((level, result, shift))

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
    fixtures = storey["fixtures"]
    chosen = storey["chosen"]
    layer_choice = storey["layerChoice"]
    wall_stats = storey["wallStats"]
    room_stats = storey["roomStats"]
    opening_stats = storey["openingStats"]
    wall_mesh, floor_mesh, fixture_mesh = storey["meshes"]
    wall_build, slab_build, fixture_build = storey["builds"]


    # three.js sanitises node names, so `storey0/walls` loads as `storey0walls`.
    # The underscore is load-bearing.
    meshes = {"storey0_walls": wall_mesh, "storey0_floors": floor_mesh}
    if fixture_build["fixtures"]:
        meshes["storey0_fixtures"] = fixture_mesh

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
            w_mesh, f_mesh, x_mesh = result["meshes"]
            w_build, s_build, x_build = result["builds"]
            meshes[f"storey{n}_walls"] = w_mesh
            meshes[f"storey{n}_floors"] = f_mesh
            if x_build["fixtures"]:
                meshes[f"storey{n}_fixtures"] = x_mesh
            all_fixtures.extend({**f, "storey": n} for f in result["fixtures"])
            if result is storey:
                primary_storey = n
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

    manifest = write_glb(meshes, out / f"{source.stem}.glb")

    model = {
        "source": str(source),
        "converter": converter,
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
        "wallsTotal": len(all_walls),
        "wallsUnframed": len(all_walls) - sum(len(f.wall_indices) for f in frames),
        "framingNote": framing_note or None,
        "walls": wall_stats,
        "rooms": room_stats,
        "openings": opening_stats,
        "build": {**wall_build, **slab_build, **fixture_build},
        "verify": verdict.as_dict(),
        "glb": manifest,
        "elements": {
            "walls": [w.as_dict() for w in walls],
            "spaces": [r.as_dict() for r in rooms],
            "openings": [o.as_dict() for o in holes],
            # Single-storey models keep storey 0, so consumers read one shape.
            "fixtures": all_fixtures or [{**f, "storey": 0} for f in fixtures],
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

        issues = cl.check(model, CATALOGUE_DIMS)
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
        code_findings, code_coverage = cc.check(model, book)
        model["codecheck"] = {
            "rulebook": book.get("title"),
            "summary": cc.summarise(code_findings, code_coverage, book),
            "findings": [f.as_dict() for f in code_findings],
            "coverage": code_coverage,
        }
    except Exception as error:  # pragma: no cover - never fail a build for this
        model["codecheck"] = {"error": f"{type(error).__name__}: {error}"}

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
        for f in model["frames"][:6]:
            mark = "->" if f["index"] == used else "  "
            print(f"      {mark} frame {f['index']}: {f['walls']:>4} walls, span {f['span']} m")

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
    return {
        "source": str(source),
        "scores": [s.as_dict() for s in scores],
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
    print(f"{'layer':<26}{'segs':>6}{'pairs':>7}{'median':>9}{'spread':>8}  verdict")
    for s in report["scores"][:18]:
        m = f"{s['medianThickness']:.3f}" if s["medianThickness"] else "-"
        sp = f"{s['spread']:.3f}" if s["spread"] is not None else "-"
        print(f"{s['name'][:25]:<26}{s['segments']:>6}{s['paired']:>7}{m:>9}{sp:>8}  {s['verdict']}")

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

    views = cameras.solve(spaces, walls, openings=holes,
                          height=model.get("wallHeight", 2.7))
    stem = Path(model.get("source", "building")).stem
    plan = render_plan(model, out / f"{stem}.plan.svg")

    views_path = out / f"{stem}.views.json"
    views_path.write_text(
        json.dumps([v.as_dict() for v in views], indent=2), encoding="utf-8"
    )

    return {
        "plan": plan,
        "views": {"path": str(views_path), **cameras.summarise(views)},
        "surface": styles.catalogue(),
        "viewList": [v.as_dict() for v in views],
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


def clearance_report(model_path: str) -> dict:
    """
    Can you use the rooms this model describes?

    Geometric facts only — no rulebook, no jurisdiction, no verdict. See
    solve/clearance.py for why that boundary is drawn where it is.
    """
    from classify.catalogue_dims import CATALOGUE_DIMS
    from solve import clearance

    model = json.loads(Path(model_path).read_text(encoding="utf-8"))
    issues = clearance.check(model, CATALOGUE_DIMS)
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
    findings, coverage = cc.check(model, book)
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
    b.add_argument("--unit", default=None, help="Force a unit (mm|cm|m|in|ft).")
    b.add_argument("--layers", default=None,
                   help="Comma-separated wall layers. Defaults to the name heuristic.")
    b.add_argument("--height", type=float, default=DEFAULT_WALL_HEIGHT)
    b.add_argument("--frame", type=int, default=0,
                   help="Which drawing on the sheet (0 = largest).")
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
        model = reconstruct(
            ns.input, ns.work, ns.out, unit=ns.unit,
            layers=[s.strip() for s in ns.layers.split(",")] if ns.layers else None,
            height=ns.height, frame_index=ns.frame,
            with_fixtures=not ns.no_fixtures, auto_layers=ns.auto_layers,
            with_perimeter=not ns.no_perimeter,
            with_storeys=ns.storeys,
        )
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
