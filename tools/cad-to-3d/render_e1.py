"""Render check views of the exported Villa E-1 GLB.

  blender --background --python render_e1.py -- <glb> <outdir>
"""
import bpy, sys, os, math, mathutils

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = argv[0]
OUT = argv[1]
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
print("[import] meshes:", len(objs))

# world bounds
mn = mathutils.Vector((1e9, 1e9, 1e9))
mx = mathutils.Vector((-1e9, -1e9, -1e9))
for o in objs:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        for i in range(3):
            mn[i] = min(mn[i], w[i])
            mx[i] = max(mx[i], w[i])
ctr = (mn + mx) / 2
size = mx - mn
print(f"[bounds] min={tuple(round(v,2) for v in mn)} max={tuple(round(v,2) for v in mx)}")
print(f"[bounds] size={tuple(round(v,2) for v in size)}")

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.render.resolution_x = 1000
scene.render.resolution_y = 720
scene.render.film_transparent = False

# sky + sun
world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.55, 0.68, 0.85, 1.0)
bg.inputs[1].default_value = 1.6

sun_data = bpy.data.lights.new("Sun", type="SUN")
sun_data.energy = 4.0
sun_data.angle = math.radians(3)
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (math.radians(52), 0, math.radians(35))
scene.collection.objects.link(sun)

cam_data = bpy.data.cameras.new("Cam")
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def look_at(obj, target):
    d = (mathutils.Vector(target) - obj.location)
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def shot(name, loc, target, lens=32):
    cam.location = mathutils.Vector(loc)
    cam_data.lens = lens
    look_at(cam, target)
    scene.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("[shot]", name)


R = max(size.x, size.y)
# exterior three-quarter, from the south-east and above
shot("01_aerial", (ctr.x + R * 0.95, ctr.y - R * 1.05, mn.z + size.z * 1.55),
     (ctr.x, ctr.y, ctr.z), 30)
shot("02_aerial_nw", (ctr.x - R * 1.0, ctr.y + R * 0.95, mn.z + size.z * 1.45),
     (ctr.x, ctr.y, ctr.z), 30)
# straight down - reads as a stacked plan, good for spotting missing walls
shot("03_top", (ctr.x, ctr.y, mx.z + R * 1.15), (ctr.x, ctr.y, mn.z), 32)
# elevation from the south
shot("04_south", (ctr.x, mn.y - R * 1.25, ctr.z), (ctr.x, ctr.y, ctr.z), 40)
print("[done]")
