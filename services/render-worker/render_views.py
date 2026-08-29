"""
Render solved views of a reconstructed building.

    blender -b --factory-startup --python render_views.py -- \
        --glb villa.glb --views villa.views.json --out A:/tmp/renders \
        --style photoreal --engine fast [--view interior-0] [--aov]

── The invocation is part of the contract ───────────────────────────────────
`-b` because there is no display. `--factory-startup` so a render can never
depend on an add-on someone happened to have enabled — a render that works on
one machine and not another is worse than one that fails everywhere.

── The stdout contract is load-bearing ──────────────────────────────────────
The API parses this output. `Sample N/M` drives the progress bar and
`ARCVIA_OUTPUT:<path>` is how the caller learns where the result landed. Change
either print and the job runs, exits zero, and is marked failed with a null
output path — which looks like a renderer bug and is not one.

── Resumable, because CPU Cycles is slow ────────────────────────────────────
No GPU here: budget around a minute a frame at 720p and 64 samples, and hours
for an orbit. Every frame checks for its own file first and skips it, and every
camera is placed from its view spec rather than from wherever the previous
frame left the camera. That second point matters more than it looks: placing
relatively means a resumed run produces different framing from a fresh one, and
the difference is subtle enough to ship.

── Coordinates ─────────────────────────────────────────────────────────────
The engine's GLB maps plan (x, y, z) to glTF (x, z, -y); Blender's importer maps
glTF (X, Y, Z) to (X, -Z, Y). Composed, Blender lands on plan coordinates
exactly — so `views.json` is used verbatim. There is deliberately no conversion
in this file. If a render ever comes back rotated, the bug is a fourth flip
someone added, not a missing one.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))

import arcvia_aov as aov          # noqa: E402
import arcvia_style as style      # noqa: E402

ENGINES = {
    "fast": (32, 1280, 720),
    "standard": (128, 1920, 1080),
    "ultra": (512, 2560, 1440),
}


def argv():
    """Blender swallows its own arguments; ours are after the `--`."""
    raw = sys.argv
    return raw[raw.index("--") + 1:] if "--" in raw else []


def parse():
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--views", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--style", default="photoreal")
    p.add_argument("--engine", default="fast")
    p.add_argument("--view", default=None, help="Render only this view id.")
    p.add_argument("--kind", default=None, help="Render only this kind of view.")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--aov", action="store_true", help="Write conditioning passes.")
    p.add_argument("--materials", default=None,
                   help="Material bridge JSON: dress meshes by their "
                        "extras.surfaceClass. Only meaningful with a style "
                        "that keeps materials.")
    p.add_argument("--fixtures", default=None,
                   help="building.json: replace the dimensioned fixture boxes "
                        "with the catalogue's own models.")
    p.add_argument("--catalogue", default=None,
                   help="data/catalogue-models.json. Defaults beside the repo "
                        "when --fixtures is given.")
    p.add_argument("--skip-tight", action="store_true", default=True)
    return p.parse_args(argv())


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: str) -> int:
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("ARCVIA_ERROR: the GLB imported no meshes.")
    return len(meshes)


#: The mesh carrying the dimensioned stand-in boxes, from
#: `build/solidify.py:build_fixtures`. Named rather than detected, because
#: guessing which mesh is furniture from its geometry is exactly the kind of
#: inference that goes wrong quietly.
FIXTURE_MESH = "storey0_fixtures"


#: An axis whose extent is this small a fraction of the model's largest carries
#: no information about scale. Same value and same reasoning as the studio
#: loader and `condition_asset.py`: flat is a PROPORTION, not a measurement ?
#: 12 mm is flat on a rug and is the whole object on a sheet of paper.
FLAT = 0.02


def _fit_to_catalogue(obj, entry: dict) -> None:
    """
    Scale one imported model to the catalogue's dimensions.

    ?? Why the renderer has to do this at all ????????????????????????????????
    Measured, and it is the whole reason the first version of this drew an
    eight-metre sink. The shipped catalogue GLBs are NOT at catalogue size:
    `sink-unit.glb` is 7.06 x 8.49 x 5.43 against a catalogue 1.2 x 0.6 x 0.9,
    `plant.glb` is 0.01 across against 0.55, `bed-king.glb` is 0.91 against
    1.83. That is not a defect ? `catalogue/types.ts` states the contract, that
    a model "is an upgrade layered on top, never a replacement for the
    dimensions" ? so every consumer fits the mesh to the entry, and the studio
    loader (`catalogue/models.ts`) has done exactly this all along. This
    function is that same fit, in Blender's Z-up rather than three.js's Y-up.

    Deliberately mirrors the studio rather than inventing a second rule: two
    fits that disagree would put a bed in the plan at one size and the same bed
    in the render at another, and nothing would report it.
    """
    bpy.context.view_layer.update()
    dims = obj.dimensions
    extent = (dims.x, dims.y, dims.z)
    largest = max(extent)
    if largest <= 0:
        return

    size = entry["size"]
    # A quarter turn swaps which catalogue dimension the model's local x will
    # end up spanning, so the fit has to target the dimensions the model ENDS
    # UP in. The rotation is still applied afterwards; only the meaning of
    # "width" changes here.
    yaw = entry.get("yaw") or 0
    quarter = abs(round(yaw / 90)) % 2 == 1
    target = (size["d"], size["w"], size["h"]) if quarter else (size["w"], size["d"], size["h"])

    carries = [e / largest > FLAT for e in extent]
    if not any(carries):
        return  # every axis flat: a point, not a model. Leave it alone.

    own = [t / e if e > 0 else 0.0 for t, e in zip(target, extent)]
    informed = [own[i] for i in range(3) if carries[i]]

    if entry.get("fitFootprint"):
        # Every informed axis meets its own target; a flat axis has no opinion
        # and follows the mean of the ones that do.
        mean = sum(informed) / len(informed)
        factors = [own[i] if carries[i] else mean for i in range(3)]
    else:
        # Uniform, and under-filling rather than distorting. Stretching each
        # axis to hit the box exactly guarantees the footprint and deforms the
        # object, and a sofa squashed along its length is more obviously wrong
        # than one leaving a few centimetres spare.
        factors = [min(informed)] * 3

    obj.scale = (obj.scale.x * factors[0],
                 obj.scale.y * factors[1],
                 obj.scale.z * factors[2])
    bpy.context.view_layer.update()


def place_fixtures(model_path: str, catalogue_path: str) -> dict:
    """
    Swap the fixture boxes for the catalogue's own models.

    ?? Why this belongs here and not in the reconstruction ????????????????????
    `build/solidify.py:build_fixtures` draws a BOX per identified fixture and
    says why: "a correctly *dimensioned* stand-in is what makes clearances
    checkable, which is the job at this stage", with `Definition.meshUrl` named
    as "the seam where a real GLB replaces one without anything else changing".
    That is right ? a clearance check wants a footprint, not a mesh, and the
    reconstruction GLB should stay small and semantic.

    The renderer is the consumer that wants the mesh. It already has everything
    needed: the reconstruction resolved each block to a CATALOGUE ID with a
    confidence (measured on the villa: 21 fixtures, `bed-king` x5, `bed-queen`
    x2, `wc`, `hob`, `sink-unit`, `plant` x2), and every one of those ids has a
    conditioned GLB shipped in `apps/studio/public/models`. Until now the render
    drew the boxes: 120 triangles for the lot.

    ?? Coordinates ???????????????????????????????????????????????????????????
    `build/glb.py` emits `v(x, y, h) -> (x, h, -y)`, and Blender's importer
    converts Y-up to Z-up, so a plan point (px, py) at height h lands at Blender
    (px, py, h). Fixture positions are in that same plan space, which is why no
    conversion appears below ? but it is stated because a silent identity
    transform is indistinguishable from a forgotten one.

    Returns a report rather than printing, so the caller decides what to say.
    """
    import math

    with open(model_path, encoding="utf-8") as handle:
        model = json.load(handle)
    with open(catalogue_path, encoding="utf-8") as handle:
        catalogue = json.load(handle)["items"]

    fixtures = (model.get("elements") or {}).get("fixtures") or []
    report = {"placed": 0, "boxed": 0, "unknown": 0, "items": {}, "missing": {}}

    # The boxes go only if something replaces them. A run that resolves nothing
    # must leave the scene exactly as it found it rather than deleting the
    # furniture and rendering an empty house.
    placeable = [
        f for f in fixtures
        if catalogue.get(f.get("item") or "", {}).get("file")
    ]
    if not placeable:
        for f in fixtures:
            item = f.get("item") or "?"
            if item in catalogue:
                report["boxed"] += 1
                report["missing"][item] = report["missing"].get(item, 0) + 1
            else:
                report["unknown"] += 1
        return report

    boxes = bpy.data.objects.get(FIXTURE_MESH)
    if boxes is not None:
        bpy.data.objects.remove(boxes, do_unlink=True)

    root = os.path.dirname(os.path.dirname(os.path.abspath(catalogue_path)))
    public = os.path.join(root, "apps", "studio", "public")

    for fixture in fixtures:
        item = fixture.get("item") or ""
        entry = catalogue.get(item)
        if entry is None:
            report["unknown"] += 1
            continue
        if not entry.get("file"):
            # A real catalogue item with no mesh ? a door is an opening, not an
            # object. Counted separately from an id nobody recognises, because
            # the two want different fixes.
            report["boxed"] += 1
            report["missing"][item] = report["missing"].get(item, 0) + 1
            continue

        path = os.path.join(public, entry["file"].lstrip("/").replace("/", os.sep))
        if not os.path.exists(path):
            report["boxed"] += 1
            report["missing"][item] = report["missing"].get(item, 0) + 1
            continue

        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        fresh = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
        if not fresh:
            report["boxed"] += 1
            continue

        px = fixture["position"]["x"]
        py = fixture["position"]["y"]
        rot = float(fixture.get("rotation") or 0.0)
        mount = entry.get("mountHeight") or 0.0

        for obj in fresh:
            obj.rotation_mode = "XYZ"
            if entry.get("upAxis") == "z":
                # Recorded per item in `items.ts` as "its own proportions match
                # the catalogue only when Z is up". The importer has already
                # applied a Y-up to Z-up conversion, so such a model arrives a
                # quarter turn out about X and has to be turned back.
                obj.rotation_euler[0] += math.radians(-90)
                bpy.context.view_layer.update()

            _fit_to_catalogue(obj, entry)

            # The catalogue's yaw first, then the plan's rotation. The yaw says
            # which way the MODEL faces and the rotation says which way the
            # object should face in the room; composing them in the other order
            # turns the correction by the placement.
            obj.rotation_euler[2] += math.radians(entry.get("yaw") or 0) + rot
            obj.location = (px, py, mount)

        report["placed"] += 1
        report["items"][item] = report["items"].get(item, 0) + 1

    return report


def place_camera(view: dict):
    """
    Build a camera from a solved view.

    Absolute placement every time — position, target, projection — so frame N is
    identical whether it was rendered first or resumed into.
    """
    cam_data = bpy.data.cameras.new(view["id"])
    if view.get("orthographic"):
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = view.get("orthoScale") or 20.0
    else:
        cam_data.type = "PERSP"
        cam_data.lens_unit = "FOV"
        cam_data.angle = float(view["fov"]) * 3.14159265 / 180.0

    # Generous clip range: an interior eye is centimetres from a wall, and an
    # orbit camera is tens of metres out.
    cam_data.clip_start = 0.02
    cam_data.clip_end = 500.0

    cam = bpy.data.objects.new(view["id"], cam_data)
    bpy.context.scene.collection.objects.link(cam)

    eye = Vector(view["eye"])
    target = Vector(view["target"])
    cam.location = eye
    # Blender cameras look down -Z with +Y up. to_track_quat does the aiming
    # without a constraint, which keeps this deterministic under --background.
    cam.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()

    bpy.context.scene.camera = cam
    return cam


#: Blown-out fraction past which a frame is not a picture of anything.
#:
#: Measured. Across 56 lit frames the observed values sort as:
#:
#:     ... 18.55, 28.44, 29.00 | 71.66, 81.20, 81.58, 95.44, 100.00
#:
#: A clean empty band from 29 to 72, and 60 sits inside it, so any line drawn in
#: that range separates the same frames. This one is a real threshold.
BLOWN_LIMIT = 0.60

#: Distinct tone count below which a frame is worth a second look.
#:
#: NOT measured, and the comment above this pair used to claim both were. The
#: observed counts are:
#:
#:     5, 10, 11, 22, 25, 25, 31, 34, 35, 36, 38, 42, 43, 54, 69, 71, 77, 84,
#:     89, 107, 112, 118, 122, 124, 125, 166, 167, ...
#:
#: Entirely continuous. 64 falls between 54 and 69 — a gap of 15, and not even
#: the widest in the distribution. There is no natural line here, so this will
#: eventually argue with a reader about a 54-versus-69 frame and lose.
#:
#: It stays because it is only ever a SUSPECT marker: nothing in this file fails
#: a render, and low tone count is the only signal that catches a frame aimed at
#: a blank wall, which is not bright enough to trip BLOWN_LIMIT. Kept, labelled
#: honestly, rather than dressed up as measured.
MIN_TONES = 64

#: Read every Nth pixel. The statistics below are proportions, and 130k samples
#: settle them to well under a percent, which is far finer than the thresholds
#: care about. Reading all 921,600 costs seconds per frame on an orbit.
SAMPLE_STRIDE = 7


def inspect_frame(path: Path) -> dict:
    """
    Is this frame a picture, or a blank rectangle that rendered successfully?

    ── Why this is not another near-black check ─────────────────────────────
    Every validity test in this repository looks for BLACK, because a black
    frame is what a broken render produced the last several times. A blank WHITE
    frame passes all of them: it is not near-black, a PNG exists, the process
    returned 0, and ARCVIA_OUTPUT was printed. Measured on the villa's interiors
    at photoreal, five of fourteen came back over 70% blown and three were
    effectively blank — one TOILET at 100%, with seven distinct grey values in
    921,600 pixels — and nothing anywhere noticed.

    Blown-ness alone is not enough either. The same view under `clay` is not
    blown at all and still carries only 13 tones, because the camera is aimed at
    a featureless wall. A frame can fail by being too bright or by having nothing
    in it, and those are different faults with different owners: exposure
    belongs to the style, aim belongs to the camera solver.

    Reported, never fatal. A blown frame is still a rendered frame, and the
    caller is better placed than this script to decide whether to keep it.
    """
    try:
        img = bpy.data.images.load(str(path))
    except Exception as exc:                      # noqa: BLE001
        return {"error": str(exc)}

    try:
        px = img.pixels[:]
        count = len(px) // 4
        if not count:
            return {"error": "no pixels"}

        # The thresholds below are stated in the values a person reads off the
        # image, which is right — but whether the buffer needs converting to get
        # there depends on the image, and this used to assume it always did.
        #
        # A rendered PNG is 8-bit, `is_float` is False, and `pixels` hands back
        # the stored bytes scaled to 0-1 with no colour management applied. They
        # are ALREADY display-referred. Encoding them again moves every midtone
        # up: measured on one cgi isometric, 32.06% blown became 41.07%, and
        # across 58 frames it produced 8 false positives — one frame in seven —
        # while deflating tone counts by about 30% (250 read as 205, 163 as 94).
        # Both errors push the same way, toward flagging frames that are fine.
        #
        # Float buffers (EXR, and any AOV pass) genuinely are linear, so the
        # conversion is kept for them rather than deleted.
        encode = bool(img.is_float)

        dark = blown = seen = 0
        tones = set()
        for i in range(0, count, SAMPLE_STRIDE):
            base = i * 4
            lin = (0.2126 * px[base] + 0.7152 * px[base + 1]
                   + 0.0722 * px[base + 2])
            if encode:
                lin = (1.055 * (max(lin, 0.0) ** (1 / 2.4)) - 0.055
                       if lin > 0.0031308 else lin * 12.92)
            tone = max(0, min(255, int(lin * 255 + 0.5)))
            tones.add(tone)
            seen += 1
            if tone <= 8:
                dark += 1
            elif tone >= 250:
                blown += 1

        return {
            "black": round(dark / seen, 4),
            "blown": round(blown / seen, 4),
            "tones": len(tones),
        }
    finally:
        bpy.data.images.remove(img)


def render_one(view: dict, out_dir: Path, stem: str, want_aov: bool,
               line_art: bool = False, diagnostic: bool = False) -> dict | None:
    target = out_dir / f"{stem}.{view['id']}.png"
    if target.exists():
        print(f"ARCVIA_SKIP:{target}")
        return {"view": view["id"], "path": str(target), "skipped": True}

    cam = place_camera(view)
    passes = []
    if want_aov:
        try:
            passes = aov.enable(bpy)
            aov.wire_outputs(bpy, str(out_dir), f"{stem}.{view['id']}")
        except aov.PassesUnavailable as exc:
            # Degrade to the beauty pass rather than fail the render. The AOVs
            # only feed an optional diffusion finish; the picture is the job.
            print(f"ARCVIA_NO_AOV:{exc}")
            passes = []

    bpy.context.scene.render.filepath = str(target)
    bpy.ops.render.render(write_still=True)

    # Tidy up so the next view starts from the same state this one did.
    bpy.data.objects.remove(cam, do_unlink=True)

    if not target.exists():
        print(f"ARCVIA_ERROR: {view['id']} rendered nothing.")
        return None

    stats = inspect_frame(target)
    suspect = []
    # Brightness says nothing about a line drawing. `cad` and `sketch` are thin
    # dark lines on white paper and measure 96% and 95% blown while being
    # entirely correct — 94 and 97 distinct tones, more edge content than the
    # shaded styles. Judging them by a photoreal exposure rule reports every
    # good frame as broken, which is worse than not checking: a warning that
    # always fires on a whole style teaches the reader to ignore all of them.
    #
    # The tone count still applies. A line style with almost no tones has no
    # linework in it, which is a real failure and the one worth catching here.
    #
    # `raw` is exempt from both tests rather than tuned around. It is not a
    # picture: flat world plus emission returns every surface's own colour
    # regardless of light or facing, so a uniform near-white frame with a
    # handful of tones is its CORRECT output. It exists as the base layer the
    # --aov passes key against. A rule that flags it is measuring the wrong
    # thing, not measuring it badly.
    if not diagnostic:
        if not line_art and stats.get("blown", 0) >= BLOWN_LIMIT:
            suspect.append(f"{stats['blown'] * 100:.0f}% blown out")
        if stats.get("tones", 999) < MIN_TONES:
            suspect.append(f"only {stats['tones']} distinct tones")
    if suspect:
        # Not an error. The frame rendered, and something upstream — exposure on
        # this style, or where the camera is pointing — made it carry nothing.
        print(f"ARCVIA_SUSPECT:{view['id']} {'; '.join(suspect)}")

    print(f"ARCVIA_OUTPUT:{target}")
    return {
        "view": view["id"], "path": str(target), "skipped": False,
        "passes": passes, "frame": stats, "suspect": suspect,
    }


def main():
    args = parse()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    views = json.loads(Path(args.views).read_text(encoding="utf-8"))
    if args.view:
        views = [v for v in views if v["id"] == args.view]
    if args.kind:
        views = [v for v in views if v["kind"] == args.kind]
    if args.skip_tight:
        # A camera with no clearance renders the wall in front of it. Spending a
        # CPU-minute to produce that is the most expensive way to learn nothing.
        before = len(views)
        views = [
            v for v in views
            if v["kind"] != "interior" or v.get("clearance", 0) >= 0.6
        ]
        if before != len(views):
            print(f"ARCVIA_SKIPPED_TIGHT:{before - len(views)}")
    if args.limit:
        views = views[: args.limit]

    if not views:
        print("ARCVIA_ERROR: no views to render.")
        raise SystemExit(2)

    samples, width, height = ENGINES.get(args.engine, ENGINES["fast"])

    clear_scene()
    meshes = import_glb(args.glb)
    style.apply_engine(bpy, samples, width, height)
    applied = style.apply_style(bpy, args.style)
    if applied["materials"] in ("keep", "clay"):
        style.add_sun(bpy)

    # Surface-class materials. Deliberately AFTER apply_style, because a
    # style that overrides materials (clay, flat, paper) is a deliberate
    # request for one uniform surface and must win — dressing the model
    # and then claying it would be wasted work, and dressing it after
    # claying would silently defeat the style the caller asked for.
    surfaces = None
    if args.materials and applied["materials"] == "keep":
        bridge = style.load_material_bridge(args.materials)
        surfaces = style.apply_surface_materials(bpy, bridge)
        print("ARCVIA_MATERIALS:" + ", ".join(
            f"{k}={v}" for k, v in sorted(surfaces["applied"].items())))
        audit = style.audit_materials(bpy)
        surfaces["audit"] = audit
        for finding in audit["findings"]:
            print(f"ARCVIA_MATERIAL_WARNING:{finding}")
        if surfaces["untouched"]:
            print(f"ARCVIA_MATERIALS_UNTOUCHED:{len(surfaces['untouched'])} "
                  "meshes carry no surface class or no material for it")
    elif args.materials:
        print(f"ARCVIA_MATERIALS_SKIPPED:style {args.style} overrides materials")

    # After materials, deliberately. A catalogue model arrives with its own
    # conditioned materials and must NOT be dressed by surface class ? the
    # bridge paints by `extras.surfaceClass`, a bed carries none, and running
    # this first would hand the dresser a scene full of meshes it would report
    # as untouched.
    if args.fixtures:
        catalogue = args.catalogue or str(
            Path(__file__).resolve().parents[2] / "data" / "catalogue-models.json"
        )
        if not Path(catalogue).exists():
            print(f"ARCVIA_FIXTURES_SKIPPED:no catalogue at {catalogue}")
        else:
            placed = place_fixtures(args.fixtures, catalogue)
            detail = ", ".join(
                f"{k}={v}" for k, v in sorted(placed["items"].items())
            )
            print(f"ARCVIA_FIXTURES:{placed['placed']} placed"
                  + (f" ({detail})" if detail else ""))
            if placed["missing"]:
                # Named, not counted. "3 fixtures kept their box" cannot be
                # acted on; "door=4" says which catalogue entry needs a mesh.
                miss = ", ".join(
                    f"{k}={v}" for k, v in sorted(placed["missing"].items())
                )
                print(f"ARCVIA_FIXTURES_BOXED:{placed['boxed']} kept the "
                      f"dimensioned box ({miss})")
            if placed["unknown"]:
                print(f"ARCVIA_FIXTURES_UNKNOWN:{placed['unknown']} fixture(s) "
                      "carry an id the catalogue does not have")

    stem = Path(args.glb).stem
    print(f"ARCVIA_SCENE:{meshes} meshes, style={args.style}, "
          f"engine={args.engine} ({samples} samples, {width}x{height})")
    print(f"ARCVIA_VIEWS:{len(views)}")

    done = []
    for i, view in enumerate(views):
        print(f"ARCVIA_VIEW:{i + 1}/{len(views)} {view['id']}")
        result = render_one(view, out_dir, stem, args.aov,
                            line_art=bool(applied.get("freestyle")),
                            diagnostic=args.style == "raw")
        if result:
            done.append(result)

    manifest = out_dir / f"{stem}.renders.json"
    manifest.write_text(
        json.dumps(
            {"style": applied, "engine": args.engine, "samples": samples,
             "resolution": [width, height], "renders": done,
             **({"surfaces": surfaces} if surfaces else {})},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"ARCVIA_MANIFEST:{manifest}")

    # Always, never only when something is wrong. A line that appears solely on
    # failure is indistinguishable from a version that does not emit it at all,
    # and a caller cannot tell "every frame is good" from "this build predates
    # the check". That ambiguity is the same silent-drop family as the bug this
    # exists to catch, and renderQueue needs a number it can compare rather than
    # a marker it can only observe.
    valid = sum(1 for r in done if not r.get("suspect"))
    print(f"ARCVIA_VALID:{valid}/{len(done)}")
    print(f"ARCVIA_DONE:{len(done)}/{len(views)}")


if __name__ == "__main__":
    # Blender exits 0 after an unhandled Python traceback, so a frame that
    # crashed is indistinguishable from one that rendered if the caller checks
    # the return code. Measured: the `cad` style raised AttributeError, wrote no
    # PNG, and exited 0.
    #
    # That is worse than a plain failure because it disagrees with the resume
    # logic. Resuming skips a view when its PNG exists, so a crashed frame is
    # correctly retried — but a queue that recorded it as succeeded on rc == 0
    # never asks for it again. The two halves reach opposite conclusions about
    # the same frame and neither is obviously wrong from the outside.
    #
    # The stdout contract stays the source of truth — require ARCVIA_DONE:n/n
    # and compare n against the expected count. This just stops the exit code
    # from actively lying.
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:          # noqa: BLE001 — deliberate catch-all
        import traceback

        traceback.print_exc()
        print(f"ARCVIA_ERROR:{type(exc).__name__}: {exc}")
        sys.exit(1)
