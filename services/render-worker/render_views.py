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


#: A frame this blown out, or with this few distinct tones, is not a picture of
#: anything. Both thresholds are measured, not chosen — see `inspect_frame`.
BLOWN_LIMIT = 0.60
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

        dark = blown = seen = 0
        tones = set()
        for i in range(0, count, SAMPLE_STRIDE):
            base = i * 4
            lin = (0.2126 * px[base] + 0.7152 * px[base + 1]
                   + 0.0722 * px[base + 2])
            # Blender's buffer is linear; the thresholds are stated in the sRGB
            # values a person reads off the image.
            srgb = (1.055 * (max(lin, 0.0) ** (1 / 2.4)) - 0.055
                    if lin > 0.0031308 else lin * 12.92)
            tone = max(0, min(255, int(srgb * 255 + 0.5)))
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


def render_one(view: dict, out_dir: Path, stem: str, want_aov: bool) -> dict | None:
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
    if stats.get("blown", 0) >= BLOWN_LIMIT:
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

    stem = Path(args.glb).stem
    print(f"ARCVIA_SCENE:{meshes} meshes, style={args.style}, "
          f"engine={args.engine} ({samples} samples, {width}x{height})")
    print(f"ARCVIA_VIEWS:{len(views)}")

    done = []
    for i, view in enumerate(views):
        print(f"ARCVIA_VIEW:{i + 1}/{len(views)} {view['id']}")
        result = render_one(view, out_dir, stem, args.aov)
        if result:
            done.append(result)

    manifest = out_dir / f"{stem}.renders.json"
    manifest.write_text(
        json.dumps(
            {"style": applied, "engine": args.engine, "samples": samples,
             "resolution": [width, height], "renders": done},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"ARCVIA_MANIFEST:{manifest}")
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
