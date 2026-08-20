"""Interior eye-height views of Villa E-1, aimed from the CAD's own room labels.

  blender --background --python render_interior.py -- <glb> <building.json> <outdir>
"""
import bpy, sys, os, math, mathutils, json

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB, JSN, OUT = argv[0], argv[1], argv[2]
os.makedirs(OUT, exist_ok=True)
B = json.load(open(JSN))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.render.resolution_x = 900
scene.render.resolution_y = 650

world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.62, 0.72, 0.86, 1.0)
bg.inputs[1].default_value = 3.0

sd = bpy.data.lights.new("Sun", type="SUN")
sd.energy = 5.0
sun = bpy.data.objects.new("Sun", sd)
sun.rotation_euler = (math.radians(48), 0, math.radians(200))
scene.collection.objects.link(sun)

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 18  # wide, the way interior archviz is shot
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

EYE = 1.60

# room label -> which way to face (yaw degrees, 0 = +X, 90 = +Y)
SHOTS = [
    ("second", "LIVING AREA", 200, "living"),
    ("second", "KITCHEN", 250, "kitchen"),
    ("second", "OPEN DECK", 180, "deck"),
    ("first", "MASTER BEDROOM", 150, "master"),
    ("first", "PASSAGE", 180, "passage"),
    ("stilt", "FAMILY LOUNGE & RECREATION", 90, "lounge"),
    ("lower-ground", "BEDROOM-1", 200, "bedroom1"),
]


def find_label(fid, needle):
    for fl in B["floors"]:
        if fl["id"] != fid:
            continue
        for l in fl["labels"]:
            if l["t"].upper().startswith(needle.upper()):
                return fl, l
    return None, None


for fid, needle, yaw, name in SHOTS:
    fl, lab = find_label(fid, needle)
    if not lab:
        print("[skip]", fid, needle)
        continue
    x, y = lab["p"]
    z = fl["level"] + EYE
    cam.location = (x, y, z)
    cam.rotation_euler = (math.radians(90), 0, math.radians(yaw))
    scene.render.filepath = os.path.join(OUT, f"{fid}_{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[shot] {fid}_{name}  at ({x:.2f},{y:.2f},{z:.2f}) yaw {yaw}")
print("[done]")
