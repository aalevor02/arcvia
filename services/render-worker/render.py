"""
Headless Blender render worker.

Invoked by the API as:

    blender --background --factory-startup --python render.py -- \
        --spec '<json>' --job-id <id>

Reads a glTF/GLB scene, applies the light rig and environment described in the
spec, and renders either a camera view or a full lightmap bake with Cycles.

Everything is driven by the spec so the same script serves the 240px preview and
the 2560px final still. `--factory-startup` guarantees the render does not
depend on whatever add-ons or preferences happen to exist on the machine, which
is the difference between reproducible output and "it looked different on the
render box".

Tested against Blender 4.2 LTS and 5.1.
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

import bpy  # type: ignore  # provided by the Blender runtime
import mathutils  # type: ignore


# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """Blender swallows everything before `--`; our args come after it."""
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []

    parser = argparse.ArgumentParser(prog="arcvia-render")
    parser.add_argument("--spec", required=True, help="JSON render spec")
    parser.add_argument("--job-id", required=True)
    parser.add_argument(
        "--out-dir",
        default=os.environ.get("ARCVIA_OUT_DIR", tempfile.gettempdir()),
    )
    return parser.parse_args(argv)


def fetch(url: str, suffix: str) -> str:
    """Resolve a spec URL to a local path, downloading it if remote."""
    if not url:
        raise ValueError("empty url")
    if url.startswith(("http://", "https://")):
        handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        handle.close()
        urllib.request.urlretrieve(url, handle.name)
        return handle.name
    return str(Path(url).expanduser().resolve())


# --------------------------------------------------------------------------
# Scene assembly
# --------------------------------------------------------------------------

def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path: str) -> None:
    suffix = Path(path).suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise ValueError(f"unsupported model format: {suffix}")


def apply_environment(hdri_path: str | None, strength: float = 1.0) -> None:
    """
    Image-based lighting from an HDR environment map.

    Without this the scene renders against a flat grey world and every material
    reads as plastic — an HDRI is doing most of the work in making an interior
    look photographic, far more than adding extra lamps.
    """
    world = bpy.data.worlds.new("ArcviaWorld")
    bpy.context.scene.world = world
    world.use_nodes = True

    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputWorld")
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Strength"].default_value = strength
    links.new(background.outputs["Background"], output.inputs["Surface"])

    if hdri_path:
        env = nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(hdri_path)
        links.new(env.outputs["Color"], background.inputs["Color"])
        return

    # No HDRI: a physical sky, not a dark grey constant.
    #
    # ── Why the old default was the single worst thing here ─────────────────
    # It was (0.05, 0.05, 0.06) — very nearly black. With no lights either, a
    # bake of an unlit scene came back almost entirely dark: the first verified
    # atlas measured 0.062 mean brightness. Applied as a lightmap it *darkens*
    # the model, so the feature that exists to make interiors look real was
    # making them look worse, and doing it without any error.
    #
    # A sky texture also gives the thing an interior most needs: light arriving
    # through the window openings from a bright hemisphere, rather than uniform
    # ambient from nowhere. That is the difference between a room and a box.
    try:
        sky = nodes.new("ShaderNodeTexSky")

        # Chosen from the enum this Blender actually has, rather than named.
        # The physical sky was `NISHITA` in 3.x and 4.0 and is
        # `MULTIPLE_SCATTERING` in 5.1; hard-coding either one means the other
        # version quietly falls through to the fallback colour and the bake
        # loses its sky without saying so. That is exactly what happened here
        # the first time, and the only visible symptom was a flatter image.
        available = {item.identifier for item in sky.bl_rna.properties["sky_type"].enum_items}
        for candidate in ("MULTIPLE_SCATTERING", "NISHITA", "HOSEK_WILKIE", "PREETHAM"):
            if candidate in available:
                sky.sky_type = candidate
                break

        # Every one of these is optional: the property set differs per sky type
        # and per version, and a missing one must cost us that single setting
        # rather than the whole sky.
        for name, value in (
            ("sun_elevation", 0.94),  # ~54 degrees, mid-morning
            ("sun_rotation", 2.4),
            ("altitude", 0.0),
            # Slightly hazy. A perfectly clear sky is a very small, very hard
            # source, which puts razor-edged shadows in an interior and reads
            # as unfinished rather than as sunny.
            ("air_density", 1.6),
            ("dust_density", 2.2),
        ):
            if hasattr(sky, name):
                try:
                    setattr(sky, name, value)
                except (AttributeError, TypeError):
                    pass

        links.new(sky.outputs["Color"], background.inputs["Color"])
        print(f"ARCVIA_WORLD:sky:{sky.sky_type}", flush=True)
    except (AttributeError, TypeError, RuntimeError) as exc:
        # A bright neutral is a poor substitute for a sky, but an immeasurably
        # better failure than the near-black this used to default to.
        background.inputs["Color"].default_value = (0.55, 0.62, 0.74, 1.0)
        print(f"ARCVIA_WARN:sky unavailable ({exc}); using flat daylight", flush=True)


def default_daylight() -> None:
    """
    A sun, when the scene arrived without a light rig.

    Mirrors `addDefaultRig()` in packages/viewer — deliberately, and this is the
    one thing in this file that must be kept in step with the browser by hand.
    The whole premise of the viewer living in a shared package is that the
    editor preview and the published walkthrough cannot drift apart; a bake lit
    differently from the preview reintroduces exactly that drift, in the one
    operation whose entire purpose is to make the preview permanent.

    Browser rig: DirectionalLight(0xfff2e0, 2.6) at (6, 9, 4) aimed at origin,
    in Three.js Y-up. Converted here to Blender's Z-up as (x, -z, y).
    """
    from mathutils import Vector

    light = bpy.data.lights.new("ArcviaSun", type="SUN")
    light.color = (1.0, 0.949, 0.878)  # 0xfff2e0
    # Watts per square metre, not a Three.js intensity — the two scales are
    # unrelated. 3.2 is a bright but not blown-out daylight sun.
    light.energy = 3.2
    # Angular diameter. The real sun is about half a degree; opening it up
    # softens shadow edges, which is most of what separates a photograph from a
    # ray-traced image.
    light.angle = 0.035

    sun = bpy.data.objects.new("ArcviaSun", light)
    bpy.context.scene.collection.objects.link(sun)

    # (6, 9, 4) in Three.js -> (6, -4, 9) in Blender.
    position = Vector((6.0, -4.0, 9.0))
    sun.location = position
    # A sun lamp emits along its local -Z, so rotate that axis onto the
    # direction from the lamp toward the origin.
    sun.rotation_euler = Vector((0.0, 0.0, -1.0)).rotation_difference(-position.normalized()).to_euler()


def apply_lights(lights: list[dict]) -> None:
    """
    Recreate the light rig the browser editor authored.

    Positions arrive already converted to Blender's Z-up convention by the API,
    so no axis juggling happens here — doing it in exactly one place is what
    stops renders coming back mysteriously rotated.
    """
    type_map = {
        "point": "POINT",
        "spot": "SPOT",
        "sun": "SUN",
        "directional": "SUN",
        "area": "AREA",
    }

    for index, spec in enumerate(lights):
        kind = type_map.get(str(spec.get("type", "point")).lower(), "POINT")
        data = bpy.data.lights.new(name=f"light_{index}", type=kind)

        data.energy = float(spec.get("intensity", 100.0))
        color = spec.get("color", [1.0, 1.0, 1.0])
        data.color = (float(color[0]), float(color[1]), float(color[2]))

        if kind == "SPOT":
            data.spot_size = float(spec.get("angle", 0.8))
            data.spot_blend = float(spec.get("blend", 0.2))
        if kind == "AREA":
            data.size = float(spec.get("size", 1.0))

        obj = bpy.data.objects.new(name=f"light_{index}", object_data=data)
        position = spec.get("position", {})
        obj.location = (
            float(position.get("x", 0.0)),
            float(position.get("y", 0.0)),
            float(position.get("z", 3.0)),
        )

        target = spec.get("target")
        if target:
            direction = mathutils.Vector(
                (
                    float(target.get("x", 0.0)) - obj.location.x,
                    float(target.get("y", 0.0)) - obj.location.y,
                    float(target.get("z", 0.0)) - obj.location.z,
                )
            )
            obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

        bpy.context.collection.objects.link(obj)


def setup_camera(camera_spec: dict | None) -> None:
    data = bpy.data.cameras.new("ArcviaCamera")
    data.lens = float((camera_spec or {}).get("focalLength", 35.0))

    obj = bpy.data.objects.new("ArcviaCamera", data)
    bpy.context.collection.objects.link(obj)
    bpy.context.scene.camera = obj

    position = (camera_spec or {}).get("position") or {}
    obj.location = (
        float(position.get("x", 6.0)),
        float(position.get("y", -6.0)),
        float(position.get("z", 4.0)),
    )

    rotation = (camera_spec or {}).get("rotation")
    if rotation:
        # Quaternion from the browser: (x, y, z, w). Blender orders it (w, x, y, z).
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = (
            float(rotation.get("w", 1.0)),
            float(rotation.get("x", 0.0)),
            float(rotation.get("y", 0.0)),
            float(rotation.get("z", 0.0)),
        )
    else:
        # No camera supplied: aim at the world origin so the job still produces
        # something useful rather than failing.
        obj.rotation_euler = (
            mathutils.Vector((0, 0, 0)) - obj.location
        ).to_track_quat("-Z", "Y").to_euler()


def configure_cycles(spec: dict) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"

    cycles = scene.cycles
    cycles.samples = int(spec.get("samples", 32))
    cycles.max_bounces = int(spec.get("maxBounces", 4))
    cycles.diffuse_bounces = int(spec.get("diffuseBounces", 3))
    cycles.glossy_bounces = int(spec.get("glossyBounces", 3))
    cycles.transmission_bounces = int(spec.get("transmissionBounces", 4))

    # Denoising lets a 32-sample render look like a far more expensive one. It
    # is the single highest-leverage cost setting in this file: without it you
    # need roughly an order of magnitude more samples for comparable output.
    cycles.use_denoising = True

    # Adaptive sampling stops refining tiles that have already converged, so
    # flat walls do not get sampled as hard as a glass table.
    cycles.use_adaptive_sampling = True
    cycles.adaptive_threshold = float(spec.get("adaptiveThreshold", 0.01))

    scene.render.resolution_x = int(spec.get("width", 1920))
    scene.render.resolution_y = int(spec.get("height", 1080))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    scene.view_settings.view_transform = spec.get("viewTransform", "AgX")
    scene.view_settings.exposure = float(spec.get("exposure", 0.0))

    enable_gpu(cycles)


def enable_gpu(cycles) -> None:
    """
    Prefer a GPU if one is present, and fall back to CPU rather than failing.

    A worker that hard-requires CUDA cannot be developed on a laptop, and a
    worker that silently renders on CPU when you are paying for a GPU instance
    is worse. So: try each backend, log which one won.
    """
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                prefs.compute_device_type = backend
            except TypeError:
                continue  # this build does not support that backend

            prefs.get_devices()
            devices = [d for d in prefs.devices if d.type == backend]
            if devices:
                for device in prefs.devices:
                    device.use = device.type == backend
                bpy.context.scene.cycles.device = "GPU"
                print(f"ARCVIA_DEVICE:{backend}", flush=True)
                return
    except Exception as exc:  # noqa: BLE001 - never let device probing kill a job
        print(f"ARCVIA_WARN:gpu probe failed: {exc}", flush=True)

    bpy.context.scene.cycles.device = "CPU"
    print("ARCVIA_DEVICE:CPU", flush=True)


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------

def render_still(out_path: str) -> None:
    bpy.context.scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)


def bake_lightmap(out_path: str, spec: dict) -> None:
    """
    Bake indirect lighting into a single shared texture atlas.

    This is the expensive one — it renders every surface in the scene rather
    than one camera view. The payoff is that the published walkthrough plays
    back with photoreal lighting at real-time frame rates on a phone, because
    the lighting is already in the texture.

    ── The part that is easy to get wrong ───────────────────────────────────
    Creating a UV layer with `uv_layers.new()` does NOT unwrap anything. The new
    layer spans the full 0-1 square for every object, so every object bakes over
    every other one. The result is a texture at 100% coverage with no gutters,
    which looks like a successful bake right up until you apply it and every
    surface is showing someone else's lighting.

    A correct lightmap needs two things:

      1. Per-object unwrapping with no self-overlap  (smart_project)
      2. Each object occupying its OWN region of the shared atlas

    Step 2 uses a uniform grid here: ceil(sqrt(n)) cells, one per object, UVs
    scaled and offset into their cell. That is not an optimal packing — a large
    floor gets the same texel budget as a doorknob — but it is correct, and
    correctness was the thing missing. Area-weighted allocation is the obvious
    next improvement.
    """
    import math

    scene = bpy.context.scene

    # DIFFUSE without the colour pass — not COMBINED.
    #
    # ── The distinction, and why it is not cosmetic ─────────────────────────
    # COMBINED bakes fully shaded output: light *times* surface colour. That is
    # a finished picture of the surface.
    #
    # The browser attaches this atlas as a Three.js `lightMap`, and a lightMap
    # is **multiplied** by the material's albedo. Feed it COMBINED and albedo is
    # applied twice — a mid-grey wall renders at a quarter of its brightness,
    # timber goes muddy, and every colour in the scene oversaturates. It looks
    # like a lighting problem and it is a units problem.
    #
    # What a lightMap wants is irradiance: how much light *arrives* at the
    # surface, with no colour of its own. That is DIFFUSE with direct and
    # indirect on and `use_pass_color` off.
    scene.cycles.bake_type = "DIFFUSE"
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = False
    scene.render.bake.margin = int(spec.get("bakeMargin", 8))

    size = int(spec.get("width", 2048))
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("scene contains no mesh objects to bake")

    image = bpy.data.images.new(
        "ArcviaLightmap", width=size, height=size, float_buffer=True
    )

    cells = math.ceil(math.sqrt(len(meshes)))
    cell = 1.0 / cells
    # Keep islands off the cell boundary so the bake margin cannot bleed one
    # object's lighting into its neighbour's region.
    inset = 0.02 * cell

    # ---- Does the caller already own the layout? --------------------------
    #
    # The studio generates its own geometry, so it can lay lightmap UVs out
    # deterministically before sending anything (see plan/lightmapUV.ts) and
    # then pass `prebakedUv: true`. When it does, this must NOT unwrap:
    # smart_project would produce a different layout from the one the browser
    # samples with, so every surface would light with some other surface's
    # bake. That renders perfectly and is very hard to read as a UV bug.
    #
    # The saving is the point of the arrangement. Unwrapping here means the
    # geometry has to travel back carrying its new UVs — tens of megabytes, and
    # the reason a Shapespark export ships 27 MB of buffers. Agreeing the layout
    # up front means only the atlas image returns.
    prebaked = bool(spec.get("prebakedUv", False))
    print(f"ARCVIA_BAKE_UV:{'prebaked' if prebaked else 'smart-project'}", flush=True)

    for index, obj in enumerate(meshes):
        # Deselect INSIDE the loop, every iteration.
        #
        # This is not defensive tidying, it is load-bearing. `mode_set('EDIT')`
        # enters multi-object edit mode for everything currently selected, and
        # `smart_project` then unwraps all of them into the full 0-1 square. Let
        # selections accumulate and each pass silently re-unwraps every object
        # handled so far, destroying the atlas cells already assigned to them.
        # Only the final object survives correctly — and the bake looks
        # plausible enough that the corruption is easy to miss.
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)

        # 1. A dedicated lightmap UV channel, kept separate from the artist's
        #    texture UVs (which usually overlap deliberately, for tiling).
        #
        #    When the caller supplied the layout that channel already exists —
        #    glTF TEXCOORD_1 arrives as the mesh's second UV layer — and the
        #    only job here is to make it the one Cycles bakes into.
        uv_name = "ArcviaLightmapUV"

        if prebaked and len(obj.data.uv_layers) > 1:
            uv_layer = obj.data.uv_layers[len(obj.data.uv_layers) - 1]
            obj.data.uv_layers.active = uv_layer
        else:
            if uv_name in obj.data.uv_layers:
                obj.data.uv_layers.remove(obj.data.uv_layers[uv_name])
            uv_layer = obj.data.uv_layers.new(name=uv_name)
            obj.data.uv_layers.active = uv_layer

        # BOTH of these are required, and they are not the same thing.
        #
        #   .active        = the row highlighted in the UI list. This is what
        #                    smart_project unwraps into.
        #   .active_render = the layer with the camera icon. This is what the
        #                    renderer and the BAKE actually read.
        #
        # Setting only `.active` produces a bake that silently ignores the
        # atlas and uses whatever UV map came in with the model — every object
        # spanning 0-1, all stacked on top of each other. It looks like a
        # successful bake and the output is worthless.
        uv_layer.active_render = True

        # 2 and 3. Unwrap, then squeeze the result into this object's atlas
        #          cell — unless the caller already did both.
        if not prebaked:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.04)
            bpy.ops.object.mode_set(mode="OBJECT")

            col, row = index % cells, index // cells
            for loop_uv in obj.data.uv_layers[uv_name].data:
                u, v = loop_uv.uv
                loop_uv.uv = (
                    col * cell + inset + u * (cell - 2 * inset),
                    row * cell + inset + v * (cell - 2 * inset),
                )

        # 4. Point every material at the shared bake target.
        if not obj.data.materials:
            obj.data.materials.append(bpy.data.materials.new(f"{obj.name}_mat"))
        for material in obj.data.materials:
            if material is None:
                continue
            material.use_nodes = True
            node = material.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = image
            node.select = True
            material.node_tree.nodes.active = node

        obj.select_set(True)

    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.bake(type="DIFFUSE", use_clear=True)

    # Save through the scene's image settings rather than image.save(), which
    # writes the float buffer at 16 bits per channel: a 2048 atlas came out at
    # 6.1 MB, and that file is downloaded by every browser that opens the
    # walkthrough.
    #
    # 8 bits is the right depth for this particular image. A lightmap is
    # low-frequency — broad gradients of shade, no detail — and it is
    # *multiplied* over an albedo texture rather than shown directly, so
    # banding that would be visible in a photograph is not visible here. The
    # extra 8 bits per channel buy nothing anybody can see and roughly quadruple
    # the download.
    settings = bpy.context.scene.render.image_settings
    settings.file_format = "PNG"
    settings.color_mode = "RGB"
    settings.color_depth = "8"
    settings.compression = 90

    # `save_render` applies the scene's view transform, and modern Blender
    # defaults that to AgX — a film emulation designed to make a *photograph*
    # look good. This atlas is not a photograph, it is a table of irradiance
    # values that the browser multiplies by albedo. Grading it rolls off the
    # highlights and lifts the shadows, so every baked room comes back flatter
    # and greyer than it was lit, and no setting in the viewer can undo it.
    #
    # Standard is a plain sRGB encode: what was computed is what is stored.
    view = bpy.context.scene.view_settings
    previous = view.view_transform
    for candidate in ("Standard", "Raw", "None"):
        try:
            view.view_transform = candidate
            break
        except TypeError:
            continue
    try:
        view.look = "None"
    except TypeError:
        pass

    # Said out loud, because the failure is otherwise invisible: a graded atlas
    # still bakes, still saves, still loads, and merely makes every room flatter
    # than it was lit. The names come from the OCIO config, so a future Blender
    # renaming them must not fail quietly.
    if view.view_transform not in ("Standard", "Raw", "None"):
        print(
            f"ARCVIA_WARN:could not disable the view transform (still {view.view_transform}); "
            "the lightmap will be tone-mapped and will bake flat",
            flush=True,
        )

    # 8-bit means irradiance above 1.0 clips — a patch of direct sun on a floor
    # saturates. That is an accepted trade for quartering the download: interior
    # irradiance is below 1.0 nearly everywhere, and a blown-out sun patch is
    # what a photograph of that floor would show anyway.
    image.save_render(filepath=out_path, scene=bpy.context.scene)
    view.view_transform = previous

    print(f"ARCVIA_BAKE_CELLS:{cells}x{cells} objects:{len(meshes)}", flush=True)
    try:
        print(f"ARCVIA_BAKE_BYTES:{Path(out_path).stat().st_size}", flush=True)
    except OSError:
        pass


# --------------------------------------------------------------------------

def main() -> int:
    args = parse_args()
    spec = json.loads(args.spec)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    kind = spec.get("type", "render")
    out_path = str(out_dir / f"{kind}_{args.job_id}.png")

    reset_scene()

    model_path = fetch(spec["inputUrl"], ".glb")
    import_model(model_path)

    hdri_path = fetch(spec["hdriUrl"], ".hdr") if spec.get("hdriUrl") else None
    apply_environment(hdri_path, float(spec.get("environmentStrength", 1.0)))

    if spec.get("lightsUrl"):
        with open(fetch(spec["lightsUrl"], ".json"), encoding="utf-8") as handle:
            apply_lights(json.load(handle).get("lights", []))
    elif not hdri_path:
        # Nothing authored a rig and there is no environment map, so the scene
        # would render with sky light alone: soft, directionless, and with no
        # daylight falling through the windows. The editor is not showing that,
        # so neither should this.
        default_daylight()
        print("ARCVIA_LIGHTS:default-daylight", flush=True)

    setup_camera(spec.get("camera"))
    configure_cycles(spec)

    if kind == "bake":
        bake_lightmap(out_path, spec)
    else:
        render_still(out_path)

    # The API watches stdout for this line to learn where the result landed.
    print(f"ARCVIA_OUTPUT:{out_path}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - surface the reason to the queue
        print(f"ARCVIA_ERROR:{exc}", file=sys.stderr, flush=True)
        sys.exit(1)
