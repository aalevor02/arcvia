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
    from solve.frames import segment_frames
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

    doc, _auditor = blk.open_dxf(str(dxf_path))

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

        shortlist = layerscan.recommended(layerscan.scan(within)) | (chosen & set(within))
        selected, trace = layerscan.select_within_frame(
            within, shortlist, labels, in_frame, classify_room, kernel.guess_item,
        )
        if selected:
            pool = [f for name in selected for f in within[name]]
            walls = join_corners(pair_faces(pool))
            chosen = selected
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

    holes, unhosted = op.from_sized_blocks(in_frame, walls, kernel.guess_item)
    holes = op.dedupe(holes)
    opening_stats = op.summarise(holes, unhosted)

    fixtures: list[dict] = []
    if with_fixtures:
        footprints = blk.block_footprints(doc, scale)
        for placement in in_frame:
            w, d = footprints.get(placement["block"], (0.0, 0.0))
            px, py = placement["position"]["x"], placement["position"]["y"]
            room = next(
                (r.name for r in rooms
                 if _inside(px, py, r.loop)), None
            )
            verdict = classify_footprint(
                width=w, depth=d, block=placement["block"], layer=placement["layer"],
                room_name=room, against_wall=False, guess_item=kernel.guess_item,
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

    meshes = {"storey0_walls": wall_mesh, "storey0_floors": floor_mesh}
    if fixture_build["fixtures"]:
        meshes["storey0_fixtures"] = fixture_mesh

    # The gate. Every failure mode here produces *a building* rather than an
    # error, so the only defence is checking the result against its own input
    # before anything expensive or user-facing happens.
    verdict = vf.check(
        input_segments=len(faces), walls=walls, spaces=rooms,
        openings=holes, unhosted=unhosted,
        scale_candidates=reading.get("scaleCandidates"),
    )

    manifest = write_glb(meshes, out / f"{source.stem}.glb")

    model = {
        "source": str(source),
        "converter": converter,
        "unit": unit or header_unit,
        "headerUnit": header_unit,
        "headerScale": header_scale,
        "scale": scale,
        "wallHeight": height,
        "layersUsed": sorted(chosen),
        "layerChoice": layer_choice,
        "faces": len(faces),
        "frames": [f.as_dict() for f in frames],
        "frameUsed": picked.as_dict() if picked else None,
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
            "fixtures": fixtures,
        },
    }
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
    print(f"LAYERS   {', '.join(model['layersUsed'][:6])}"
          f"{' …' if len(model['layersUsed']) > 6 else ''}")

    print(f"\nFACES    {model['faces']} lines on those layers")
    if model.get("frames"):
        used = (model.get("frameUsed") or {}).get("index")
        print(f"FRAMES   {len(model['frames'])} separate drawings on this sheet")
        for f in model["frames"][:6]:
            mark = "->" if f["index"] == used else "  "
            print(f"      {mark} frame {f['index']}: {f['walls']:>4} walls, span {f['span']} m")

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

    if ns.command == "clearance":
        report = clearance_report(ns.model)
        _print_clearance(report)
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
