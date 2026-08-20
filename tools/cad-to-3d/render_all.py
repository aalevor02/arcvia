"""Exterior check renders of every baked villa.

  blender --background --python render_all.py -- <glb> <out.png>

Baked models are emissive, so the image needs almost no sampling - there is no
global illumination left to solve, only the sky dome and the baked surfaces.
"""
import bpy, sys, os, math, mathutils

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, OUT = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 2
scene.render.resolution_x = 1000
scene.render.resolution_y = 720

# bounds of the villa itself, ignoring the sky dome
mn = mathutils.Vector((1e9, 1e9, 1e9))
mx = mathutils.Vector((-1e9, -1e9, -1e9))
for o in bpy.context.scene.objects:
    if o.type != "MESH":
        continue
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        if abs(w.x) > 60 or abs(w.y) > 60 or abs(w.z) > 60:
            continue          # sky dome
        for i in range(3):
            mn[i] = min(mn[i], w[i])
            mx[i] = max(mx[i], w[i])
ctr = (mn + mx) / 2
size = mx - mn
R = max(size.x, size.y)

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 34
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (ctr.x + R * 1.15, ctr.y - R * 1.25, mn.z + size.z * 1.35)
d = mathutils.Vector((ctr.x, ctr.y, ctr.z)) - cam.location
cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[shot] {OUT}  bounds {size.x:.1f} x {size.y:.1f} x {size.z:.1f} m")
