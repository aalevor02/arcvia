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

    print(f"ARCVIA_OUTPUT:{target}")
    return {
        "view": view["id"], "path": str(target), "skipped": False,
        "passes": passes,
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
