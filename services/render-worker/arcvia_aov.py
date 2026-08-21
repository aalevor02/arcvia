"""
The conditioning passes.

── What these are for ───────────────────────────────────────────────────────
A diffusion model given only a photograph can move a wall, invent a window and
delete a door, because nothing in its input says where those things are. Given
depth, a surface normal and a per-object mask alongside the image, it is
constrained by geometry it cannot argue with.

That is the whole difference between a finish and a generator. These passes come
out of the actual model — the same model the mesh came from — so the finish is a
filter with a geometric prior rather than a fresh hallucination that happens to
resemble the last one.

Cryptomatte is keyed on the mesh names the engine writes (`storey0_walls`,
`storey0_floors`, `storey0_fixtures`), so a mask can be pulled per element class
without a second render.

── Why they are written as separate files ──────────────────────────────────
Multi-layer EXR is the tidy answer and a poor one here: every consumer
downstream would need an EXR reader, and the depth pass wants normalising before
anything can use it as a control image. Writing PNGs beside the render means the
finish step is a plain HTTP call with plain files.
"""

from __future__ import annotations

PASSES = ("depth", "normal", "ao", "crypto")


def enable(bpy, wanted=PASSES):
    """Turn on the render passes. Must be called before rendering."""
    view_layer = bpy.context.view_layer
    scene = bpy.context.scene

    view_layer.use_pass_combined = True
    view_layer.use_pass_z = "depth" in wanted
    view_layer.use_pass_normal = "normal" in wanted
    view_layer.use_pass_ambient_occlusion = "ao" in wanted

    if "crypto" in wanted:
        view_layer.use_pass_cryptomatte_object = True
        # Two layers is enough for opaque architecture; more costs samples for
        # coverage nobody uses when there is no foliage or glass stack.
        view_layer.pass_cryptomatte_depth = 2

    if "ao" in wanted:
        scene.cycles.use_fast_gi = False

    return [p for p in PASSES if p in wanted]


def wire_outputs(bpy, out_dir: str, stem: str, wanted=PASSES):
    """
    Route each pass to its own file through the compositor.

    Depth is normalised before it is written. A raw Z pass is in metres and
    saturates instantly as an 8-bit PNG — the far wall and the sky both come out
    white — which makes it useless as a control image. The Normalize node maps
    the actual depth range in frame onto 0..1, which is what every
    depth-conditioned model expects.
    """
    scene = bpy.context.scene
    scene.use_nodes = True

    # Blender 5 rebuilt the compositor. `scene.node_tree` is gone: the tree is
    # now a node *group* hung on `scene.compositing_node_group`. Reading the old
    # attribute raises AttributeError at the first AOV render and takes the
    # whole job with it — which is how every conditioning pass on this host was
    # silently unavailable, since nothing renders AOVs unless asked.
    #
    # Both shapes are handled because the worker runs against whatever Blender
    # the host has, and the same fix already exists in render.py's denoiser.
    if hasattr(scene, "compositing_node_group"):
        tree = bpy.data.node_groups.new("ArcviaAOV", "CompositorNodeTree")
        scene.compositing_node_group = tree
    else:
        tree = scene.node_tree
    tree.nodes.clear()

    layers = tree.nodes.new("CompositorNodeRLayers")
    written = []

    def file_output(name, source, colour="BW"):
        node = tree.nodes.new("CompositorNodeOutputFile")

        # Blender 5 narrowed this node to OPEN_EXR_MULTILAYER. PNG is not in its
        # enum any more and assigning it raises rather than being ignored.
        #
        # Attempted rather than checked, because `bl_rna` reports the *static*
        # ImageFormatSettings enum — which still lists PNG — while the node
        # applies a dynamic restriction on top. Reading the schema therefore
        # says PNG is available right up until the assignment fails, so the only
        # honest test is to try it.
        #
        # Either container is a usable control image. A whole render dying
        # because a pass could not be written in the preferred one is not.
        try:
            node.format.file_format = "PNG"
            node.format.color_mode = colour
        except TypeError:
            node.format.file_format = "OPEN_EXR_MULTILAYER"

        # The File Output node changed shape in Blender 5 as well: `base_path`
        # became `directory`, and the multi-slot `file_slots` collection is gone
        # entirely — a node now writes one file, named by `file_name`, through a
        # single unnamed input. Writing one node per pass suits both, so the
        # only difference is which two attributes to set.
        if hasattr(node, "file_slots"):
            node.base_path = out_dir
            node.file_slots[0].path = f"{stem}.{name}."
        else:
            node.directory = out_dir
            node.file_name = f"{stem}.{name}."

        tree.links.new(source, node.inputs[0])
        written.append(name)

    if "depth" in wanted and "Depth" in layers.outputs:
        normalise = tree.nodes.new("CompositorNodeNormalize")
        tree.links.new(layers.outputs["Depth"], normalise.inputs[0])
        # Invert so near is bright — the convention every depth-control model
        # was trained on. Getting this backwards produces a plausible image of
        # the building turned inside out.
        invert = tree.nodes.new("CompositorNodeInvert")
        tree.links.new(normalise.outputs[0], invert.inputs["Color"])
        file_output("depth", invert.outputs["Color"])

    if "normal" in wanted and "Normal" in layers.outputs:
        # Normals are -1..1 and a PNG is 0..1. Without the remap, every
        # back-facing component clips to black and the map is half missing.
        remap = mix_node(tree, "MULTIPLY")
        tree.links.new(layers.outputs["Normal"], remap["a"])
        remap["b"].default_value = (0.5, 0.5, 0.5, 1.0)

        offset = mix_node(tree, "ADD")
        tree.links.new(remap["out"], offset["a"])
        offset["b"].default_value = (0.5, 0.5, 0.5, 1.0)
        file_output("normal", offset["out"], colour="RGB")

    if "ao" in wanted and "AO" in layers.outputs:
        file_output("ao", layers.outputs["AO"])

    return written


def mix_node(tree, blend):
    """
    A colour-mix node, whichever one this Blender has.

    `CompositorNodeMixRGB` was removed in Blender 5 and folded into the unified
    `CompositorNodeMix`, the same consolidation the shader nodes went through
    earlier. The sockets moved too: the old node took factor/image1/image2 by
    index, the new one is typed and its colour inputs are named "A" and "B".
    Indexing the new node by the old positions silently wires the factor into a
    colour slot, which produces a normal map that is subtly wrong rather than
    an error.

    Returns the sockets by role so the caller never touches an index.
    """
    for kind in ("ShaderNodeMixRGB", "CompositorNodeMixRGB"):
        try:
            node = tree.nodes.new(kind)
        except RuntimeError:
            continue
        node.blend_type = blend
        node.inputs["Fac"].default_value = 1.0
        colours = [i for i in node.inputs if i.name != "Fac"]
        return {"a": colours[0], "b": colours[1], "out": node.outputs[0]}

    raise RuntimeError("This Blender has no usable colour-mix node.")


def crypto_layers(bpy):
    """The object names a mask can be keyed on."""
    return [o.name for o in bpy.data.objects if o.type == "MESH"]
