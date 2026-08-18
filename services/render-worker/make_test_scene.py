"""
Build a test scene for verifying the render worker.

Run:  blender --background --factory-startup --python make_test_scene.py -- --out test-scene.glb

The scene is deliberately ASYMMETRIC and colour-coded by axis:

    RED    box at Blender +X
    GREEN  box at Blender +Y
    BLUE   box at Blender +Z (elevated)
    GREY   floor at Z=0

A symmetric test scene is useless here. The whole class of bug we are hunting
is an axis swap or a sign flip, and those are invisible if the scene looks the
same from every direction. Colour-coding each axis means a bad conversion shows
up immediately as the wrong colour in frame — no eyeballing geometry required.
"""

import argparse
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    return parser.parse_args(argv)


def emissive(name, rgb):
    """
    Emissive rather than diffuse.

    We want to check geometry and orientation, not lighting. An emissive
    material renders the same colour regardless of how the scene is lit, so a
    failed colour assertion means a real axis problem rather than "that face was
    in shadow".
    """
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeEmission")
    shader.inputs["Color"].default_value = (*rgb, 1.0)
    shader.inputs["Strength"].default_value = 1.0
    links.new(shader.outputs["Emission"], output.inputs["Surface"])
    return material


def box(name, location, size, rgb):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(emissive(f"{name}_mat", rgb))
    return obj


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Floor, so there is something for shadows and the bake to land on.
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "Floor"
    floor.data.materials.append(emissive("Floor_mat", (0.25, 0.25, 0.28)))

    box("AxisX_Red", (4, 0, 0.5), 1.0, (1.0, 0.05, 0.05))
    box("AxisY_Green", (0, 4, 0.5), 1.0, (0.05, 1.0, 0.05))
    box("AxisZ_Blue", (0, 0, 4), 1.0, (0.05, 0.15, 1.0))

    # A marker at the origin so "did anything import at all" is distinguishable
    # from "the camera is pointing somewhere empty".
    box("Origin_White", (0, 0, 0.25), 0.5, (1.0, 1.0, 1.0))

    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(f"ARCVIA_TEST_SCENE:{args.out}", flush=True)


if __name__ == "__main__":
    main()
