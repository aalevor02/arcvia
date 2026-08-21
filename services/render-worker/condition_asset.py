"""
Turn a downloaded model into a catalogue asset.

    blender -b --python condition_asset.py -- \
        --input sofa.glb --output sofa.glb --budget 6000 \
        --width 2.1 --depth 0.9 --height 0.8

── Why a download is not an asset ──────────────────────────────────────────────
A Sketchfab sofa arrives at 725,000 faces. The whole test room is 1,264
triangles. Forty pieces of furniture at that density is a scene heavier than the
reference product's, in a browser, on a phone — and the lightmap bake, already
half an hour on CPU, scales with what it has to trace.

Face count is not the only problem, just the loudest. A downloaded model also
arrives at whatever scale its author worked in, oriented however they left it,
with its origin wherever it happened to land, and carrying textures sized for a
turntable render rather than a piece of a room.

So nothing goes into the catalogue as downloaded. This is the gate.

── What it deliberately does not do ────────────────────────────────────────────
It does not fix bad topology, retopologise, or rescue a model that is wrong. A
decimated bad model is a smaller bad model. The check at the end reports what
came out; a piece that reads badly should be rejected and another one picked,
which is cheap when the library has thousands.
"""

import argparse
import array
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    # 6000 triangles is roughly a good sofa: enough for a rolled arm and a
    # seat cushion to read, far below the point where a browser cares. Scale it
    # with the object — a dining chair does not need a sofa's budget, and a
    # kitchen run needs more.
    parser.add_argument("--budget", type=int, default=6000)
    parser.add_argument("--width", type=float, required=True)
    parser.add_argument("--depth", type=float, required=True)
    parser.add_argument("--height", type=float, required=True)
    # Textures at 4K are common and pointless on a chair seen from two metres
    # away in a room lit by a baked atlas.
    # 512, not 1024. These are seen from across a room, in a scene whose
    # lighting comes from a baked atlas rather than from the texture — and every
    # one of them is downloaded by every visitor to the published walkthrough.
    # Raise it for a hero object somebody will stand next to.
    parser.add_argument("--max-texture", type=int, default=512)
    # Override the up-axis guess. The guess is deliberately conservative, so
    # this is how a genuinely lying-down asset gets stood up.
    parser.add_argument("--rotate", dest="rotate", action="store_true", default=None)
    parser.add_argument("--no-rotate", dest="rotate", action="store_false")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def load(path: str) -> None:
    suffix = Path(path).suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif suffix == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    else:
        raise ValueError(f"unsupported input format: {suffix}")


def meshes() -> list:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def triangle_count() -> int:
    total = 0
    for obj in meshes():
        mesh = obj.data
        # A quad is two triangles, an n-gon is n-2. Counting polygons instead
        # would under-report by roughly half on quad-modelled furniture, which
        # is most of it.
        for polygon in mesh.polygons:
            total += max(len(polygon.vertices) - 2, 1)
    return total


def join_all():
    """
    Collapse the model to a single mesh.

    Downloaded furniture routinely arrives as fifty objects — every screw and
    seam its own mesh, sometimes every cushion button. Each one is a draw call
    and, more expensively here, its own cell in the lightmap atlas: a 9x9 grid
    holds 81 objects, so one over-split sofa can exhaust the whole scene's
    budget by itself.
    """
    targets = meshes()
    if not targets:
        return None

    bpy.ops.object.select_all(action="DESELECT")
    for obj in targets:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]

    if len(targets) > 1:
        bpy.ops.object.join()

    return bpy.context.view_layer.objects.active


def extent(obj) -> mathutils.Vector:
    """
    The object's size, measured from its vertices.

    Not `obj.dimensions`, which reads a *cached* bounding box that is only
    refreshed when the dependency graph is evaluated. Transform the mesh data
    directly and then ask for `dimensions` and you get the size it used to be —
    silently, with no error, and the fit that follows is computed against the
    wrong numbers. That cost an afternoon here: the model rotated correctly and
    still came out the wrong size.

    Reading the vertices has no such staleness. `foreach_get` pulls the whole
    coordinate array in one call, so this stays fast on the 350,000-vertex
    models that are the reason this script exists.
    """
    mesh = obj.data
    count = len(mesh.vertices)
    if count == 0:
        return mathutils.Vector((0, 0, 0))

    coords = array.array("f", [0.0]) * (count * 3)
    mesh.vertices.foreach_get("co", coords)

    lows = [min(coords[i::3]) for i in range(3)]
    highs = [max(coords[i::3]) for i in range(3)]
    return mathutils.Vector((highs[0] - lows[0], highs[1] - lows[1], highs[2] - lows[2]))


def orient_and_fit(obj, width: float, depth: float, height: float, force_rotate=None) -> dict:
    """
    Scale to the catalogue's dimensions and sit the model on its origin.

    Uniform scale: stretching each axis to hit the box exactly would guarantee
    the footprint and distort the object, and a sofa squashed along its length
    is more obviously wrong than one that leaves a few centimetres spare.

    The catalogue is authoritative here, not the asset. A placed sofa is 2.1 m
    wide because a sofa is 2.1 m wide — clearances are the one thing that must
    not regress when the pretty models arrive.
    """
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    dimensions = extent(obj)
    if min(dimensions) <= 0:
        raise ValueError("model has zero extent on an axis")

    # Assets arrive lying down often enough to be worth handling, but the test
    # has to be scale-invariant: a model in centimetres has a height of 80 and
    # a target of 0.8, so comparing the numbers directly compares nothing.
    #
    # Proportions do not care about units. Normalise both the asset and the
    # catalogue entry by their own largest dimension, then ask which of the two
    # orientations is the closer match. A sofa is 1.00 x 0.43 x 0.38 whether it
    # is measured in metres or inches.
    def shape_of(a: float, b: float, c: float) -> tuple:
        largest = max(a, b, c)
        return (a / largest, b / largest, c / largest)

    def distance(x: tuple, y: tuple) -> float:
        return sum((p - q) ** 2 for p, q in zip(x, y))

    target = shape_of(width, depth, height)
    upright = shape_of(dimensions.x, dimensions.y, dimensions.z)
    # Y-up assets have their depth and height exchanged.
    lying = shape_of(dimensions.x, dimensions.z, dimensions.y)

    # Rotate only when lying-down is *clearly* the better reading.
    #
    # The importer already converts glTF's Y-up to Blender's Z-up, so a
    # well-formed asset arrives upright and this should do nothing. Rotation
    # exists for the malformed ones — a wardrobe exported on its back, where the
    # signal is unmistakable.
    #
    # The margin is what makes that safe. An armchair is 0.85 x 0.85 x 0.82:
    # near enough cubic that both orientations score within a hair of each
    # other, the comparison becomes noise, and a bare `<` will cheerfully lay a
    # perfectly good chair on its face. Which is exactly what it did.
    #
    # So: only rotate when lying-down explains the proportions substantially
    # better. When in doubt, trust the importer and leave it alone — a model
    # that needed rotating and did not get it is obvious and fixable with
    # --rotate; one that was rotated when it should not have been looks like a
    # broken asset.
    ROTATE_MARGIN = 0.6
    swapped = distance(lying, target) < distance(upright, target) * ROTATE_MARGIN

    if force_rotate is True:
        swapped = True
    elif force_rotate is False:
        swapped = False

    if swapped:
        # The mesh data is transformed directly rather than by setting
        # `rotation_euler` and applying it.
        #
        # `transform_apply` is an operator: it acts on the current selection in
        # the current context, and in a headless script that is one careless
        # `select_all` away from doing nothing at all. When it does nothing it
        # reports success, so the model is simply not rotated — and the only
        # symptom is a fit that comes out slightly small on two axes, which is
        # exactly as visible as it sounds. This form has no context to get
        # wrong.
        obj.data.transform(mathutils.Matrix.Rotation(math.radians(90), 4, "X"))
        obj.data.update()
        dimensions = extent(obj)

    scale = min(width / dimensions.x, depth / dimensions.y, height / dimensions.z)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Origin to the centre of the footprint, sitting on the floor — which is
    # what every placement, elevation and wall snap downstream assumes.
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    obj.location = (0, 0, extent(obj).z / 2)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    return {
        "rotated": bool(swapped),
        "scale": round(scale, 5),
        "size": [round(v, 4) for v in extent(obj)],
    }


def detect_facing(obj) -> dict:
    """
    Work out which way the model faces, and how far to turn it.

    ── Why this has to be automatic ────────────────────────────────────────────
    A GLB records no notion of "front". One armchair is modelled facing -Y, the
    next facing +X, and the catalogue's builders all draw their subject facing
    local +Z. Somebody has to reconcile the two, and it cannot be a person: a
    library of two hundred assets is two hundred judgement calls, and the whole
    point of an ingest pipeline is that it runs without one.

    ── The signal ──────────────────────────────────────────────────────────────
    Furniture with a front nearly always has a *tall back*. A sofa's backrest, a
    bed's headboard, a wardrobe's carcass, a bookshelf's panel, an armchair's
    rest — in every case the side meant to go against a wall carries more height
    than the side you approach from. So: divide the footprint into four outer
    slabs, measure the mean height of the vertices in each, and the tallest slab
    is the back.

    It is a heuristic and it is honest about that. `confidence` is how much
    taller the back is than the opposite side, as a fraction; a symmetric object
    — a dining table, a rug, a plant — scores near zero, and near zero means
    "leave it alone" rather than "spin it arbitrarily". A wrong guess on a
    symmetric object is invisible; a wrong guess on a chair is not, and the
    chairs are exactly the ones with a strong signal.
    """
    mesh = obj.data
    count = len(mesh.vertices)
    if count == 0:
        return {"yaw": 0, "confidence": 0.0, "back": "none"}

    coords = array.array("f", [0.0]) * (count * 3)
    mesh.vertices.foreach_get("co", coords)

    xs = coords[0::3]
    ys = coords[1::3]
    zs = coords[2::3]

    low_x, high_x = min(xs), max(xs)
    low_y, high_y = min(ys), max(ys)
    low_z, high_z = min(zs), max(zs)

    span_x = high_x - low_x
    span_y = high_y - low_y
    if span_x <= 0 or span_y <= 0 or high_z - low_z <= 0:
        return {"yaw": 0, "confidence": 0.0, "back": "degenerate"}

    # The outer quarter on each side. Wide enough to catch a backrest, narrow
    # enough that a seat cushion in the middle does not dominate it.
    band = 0.25

    def mean_height(predicate) -> float:
        total = 0.0
        seen = 0
        for i in range(count):
            if predicate(xs[i], ys[i]):
                total += zs[i] - low_z
                seen += 1
        return total / seen if seen else 0.0

    sides = {
        # Blender is Z-up here and glTF export flips to Y-up, so the model's
        # -Y is what becomes -Z in the viewer: the direction a builder puts a
        # backrest. Naming them by the viewer's axes avoids a second inversion
        # later.
        "back": mean_height(lambda x, y: y <= low_y + span_y * band),
        "front": mean_height(lambda x, y: y >= high_y - span_y * band),
        "left": mean_height(lambda x, y: x <= low_x + span_x * band),
        "right": mean_height(lambda x, y: x >= high_x - span_x * band),
    }

    tallest = max(sides, key=sides.get)
    opposite = {"back": "front", "front": "back", "left": "right", "right": "left"}[tallest]

    highest = sides[tallest]
    confidence = 0.0 if highest <= 0 else (highest - sides[opposite]) / highest

    # Below this the object is effectively symmetric and any rotation is a coin
    # toss. Leaving it at zero at least keeps it square to the plan, which is
    # predictable and trivially correctable.
    if confidence < 0.18:
        return {"yaw": 0, "confidence": round(confidence, 3), "back": "ambiguous"}

    # Degrees to turn the model so its tall side ends up at the back.
    yaw = {"back": 0, "right": 90, "front": 180, "left": 270}[tallest]

    return {"yaw": yaw, "confidence": round(confidence, 3), "back": tallest}


def decimate(obj, budget: int) -> dict:
    """
    Bring the triangle count down to budget.

    Collapse rather than un-subdivide: it works on the arbitrary topology these
    assets have, where un-subdivide expects a clean quad grid and mangles
    anything else. Below about 0.05 the result stops resembling the object, so
    the ratio is floored and the caller is told the budget was not met rather
    than handed a puddle.
    """
    before = triangle_count()
    if before <= budget:
        return {"before": before, "after": before, "ratio": 1.0, "met": True}

    ratio = max(budget / before, 0.05)

    modifier = obj.modifiers.new(name="ArcviaDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    # Keeps UV seams and material boundaries from being welded across, which is
    # what turns a decimated model's textures into smeared nonsense.
    modifier.use_collapse_triangulate = True

    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="ArcviaDecimate")

    after = triangle_count()
    return {"before": before, "after": after, "ratio": round(ratio, 4), "met": after <= budget}


def shrink_textures(limit: int) -> list:
    """
    Cap texture resolution.

    4K maps are normal on these downloads and pointless on a chair seen from
    two metres away in a room whose lighting is baked. Every one of them is also
    downloaded by every visitor to the published walkthrough, which is where the
    cost actually lands.
    """
    resized = []
    for image in bpy.data.images:
        if image.size[0] <= limit and image.size[1] <= limit:
            continue
        was = tuple(image.size)
        scale = limit / max(image.size)
        image.scale(int(image.size[0] * scale), int(image.size[1] * scale))
        resized.append({"name": image.name, "from": was, "to": tuple(image.size)})
    return resized


def main() -> int:
    args = parse_args()

    reset()
    load(args.input)

    obj = join_all()
    if obj is None:
        print("ARCVIA_ERROR:no mesh in the input file", file=sys.stderr, flush=True)
        return 1

    report = {"input": args.input, "output": args.output}
    report["placement"] = orient_and_fit(obj, args.width, args.depth, args.height, args.rotate)
    # Before decimation: the heuristic reads vertex heights, and collapsing the
    # mesh first would blur exactly the silhouette it is measuring.
    report["facing"] = detect_facing(obj)
    report["decimate"] = decimate(obj, args.budget)
    report["textures"] = shrink_textures(args.max_texture)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)

    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        use_selection=True,
        # Textures travel inside the GLB: a catalogue asset is one file or it is
        # a file that arrives without its maps.
        # WEBP, not AUTO.
        #
        # AUTO keeps PNG wherever a texture has alpha, and PNG is lossless —
        # which for a photographed wood grain means enormous. A conditioned
        # fridge came out at 8.8 MB against about 5,000 triangles: essentially
        # all of it was texture, on a catalogue that had reached 76 MB.
        #
        # WEBP handles alpha, so it does not force the trade JPEG does, and at
        # quality 80 a furniture albedo is visually identical at a fraction of
        # the size. Universally supported by anything that can run WebGL 2.
        export_image_format="WEBP",
        export_image_quality=80,
        export_yup=True,
        # Nothing here animates, and skins and morphs on a static prop are
        # bytes shipped to every visitor for no reason.
        export_animations=False,
        export_skins=False,
        export_morph=False,
        # No Draco.
        #
        # It compresses *geometry*, and by this point the geometry is a few
        # thousand triangles — a rounding error next to the embedded textures,
        # which are what actually make these files big. What it does cost is a
        # hard dependency: a Draco GLB will not parse without the decoder, and a
        # loader that lacks it fails silently and leaves the stand-in in place
        # with no error anywhere. That is exactly what happened the first time
        # this pipeline produced a real asset.
        export_draco_mesh_compression_enable=False,
    )

    report["bytes"] = Path(args.output).stat().st_size
    print("ARCVIA_ASSET:" + json.dumps(report), flush=True)

    if not report["decimate"]["met"]:
        print(
            f"ARCVIA_WARN:could not reach {args.budget} triangles without destroying the "
            f"model; left at {report['decimate']['after']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - the message is the product here
        print(f"ARCVIA_ERROR:{exc}", file=sys.stderr, flush=True)
        sys.exit(1)
