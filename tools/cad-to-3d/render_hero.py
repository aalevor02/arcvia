"""
Photoreal beauty render of a villa, for a pre-rendered cinematic.

  blender --background --python render_hero.py -- <glb> <out.png> [frames]

Real-time photoreal is not reachable in a browser from plan-derived geometry.
Pre-rendered Cycles is, and this is what sets the quality ceiling. The levers
that actually matter here, roughly in order:

  1. A real HDRI sky. Sun angle, sky gradient and the colour of the light all
     come free and correct, and it is what makes glass and stone read as real.
  2. Ground. A building floating in void never looks photographed.
  3. AgX view transform + a real camera: 35 mm, f/4, focus on the building.
  4. Enough samples to be clean, then denoise.

This box has no GPU for Cycles, so everything is CPU - which is the binding
constraint on how long an animation can be.
"""
import bpy, sys, os, math, mathutils

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = argv[0]
OUT = argv[1]
FRAMES = int(argv[2]) if len(argv) > 2 else 1
SAMPLES = int(argv[3]) if len(argv) > 3 else 96
RES = (1280, 720)   # CPU-only box; this is the budget that makes an animation feasible

# Tried belfast_sunset_puresky for golden hour and it rendered flat and grey -
# a "puresky" is sky only, and this one's sun sits too low to reach the
# elevations. kloppenheim actually rakes the building, so warmth comes from the
# view transform instead.
HDRI = r"A:\Projects\CasaAltinho\_work\cad\hdri\kloppenheim_06_puresky_4k.hdr"
TEX = r"A:\Projects\CasaAltinho\_work\cad\textures"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=GLB)

# the exported sky dome is for the WebGL viewer; a real HDRI replaces it here
for ob in list(scene.objects):
    if ob.name.startswith("Sky"):
        bpy.data.objects.remove(ob, do_unlink=True)

meshes = [o for o in scene.objects if o.type == "MESH"]
mn = mathutils.Vector((1e9, 1e9, 1e9))
mx = mathutils.Vector((-1e9, -1e9, -1e9))
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        for i in range(3):
            mn[i] = min(mn[i], w[i])
            mx[i] = max(mx[i], w[i])
ctr = (mn + mx) / 2
size = mx - mn
print(f"[scene] {len(meshes)} meshes, {size.x:.1f} x {size.y:.1f} x {size.z:.1f} m")

# ---------------------------------------------------------------- world ----
world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
nt = world.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
out = nt.nodes.new("ShaderNodeOutputWorld")
bg = nt.nodes.new("ShaderNodeBackground")
env = nt.nodes.new("ShaderNodeTexEnvironment")
mapping = nt.nodes.new("ShaderNodeMapping")
coord = nt.nodes.new("ShaderNodeTexCoord")
if os.path.exists(HDRI):
    env.image = bpy.data.images.load(HDRI)
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    mapping.inputs["Rotation"].default_value[2] = math.radians(35)
else:
    bg.inputs["Color"].default_value = (0.55, 0.68, 0.85, 1.0)
bg.inputs["Strength"].default_value = 1.0
nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

# ---------------------------------------------------------------- ground ---
bpy.ops.mesh.primitive_plane_add(size=400, location=(ctr.x, ctr.y, mn.z - 0.02))
ground = bpy.context.active_object
ground.name = "Ground"
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
gb = gm.node_tree.nodes["Principled BSDF"]
gb.inputs["Base Color"].default_value = (0.215, 0.213, 0.190, 1.0)
gb.inputs["Roughness"].default_value = 0.95
paving = os.path.join(TEX, "marble_01")
if paving and os.path.isdir(paving):
    diff = next((os.path.join(paving, f) for f in os.listdir(paving) if "diff" in f.lower()), None)
    if diff:
        t = gm.node_tree.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(diff, check_existing=True)
        mp = gm.node_tree.nodes.new("ShaderNodeMapping")
        tc = gm.node_tree.nodes.new("ShaderNodeTexCoord")
        mp.inputs["Scale"].default_value = (60, 60, 60)
        gm.node_tree.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        gm.node_tree.links.new(mp.outputs["Vector"], t.inputs["Vector"])
        gm.node_tree.links.new(t.outputs["Color"], gb.inputs["Base Color"])
ground.data.materials.append(gm)

# --------------------------------------------------- upgrade the materials --
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if b is None:
        continue
    name = m.name.lower()
    if "glass" in name:
        b.inputs["Base Color"].default_value = (0.92, 0.96, 0.97, 1.0)
        b.inputs["Roughness"].default_value = 0.02
        for k in ("Transmission Weight", "Transmission"):
            if k in b.inputs:
                b.inputs[k].default_value = 1.0
                break
        if "IOR" in b.inputs:
            b.inputs["IOR"].default_value = 1.45
    elif "water" in name:
        b.inputs["Base Color"].default_value = (0.06, 0.26, 0.30, 1.0)
        b.inputs["Roughness"].default_value = 0.02
        for k in ("Transmission Weight", "Transmission"):
            if k in b.inputs:
                b.inputs[k].default_value = 0.9
                break
    elif "timber" in name or "counter" in name:
        b.inputs["Roughness"].default_value = 0.35
        if "Specular IOR Level" in b.inputs:
            b.inputs["Specular IOR Level"].default_value = 0.5

# ------------------------------------------------------------ landscape ----
def palm(x, y, z, h=7.0, lean=0.0, seed=0):
    """A coconut palm, built rather than downloaded.

    Poly Haven's only tree at this quality is a 476 MB fir - wrong species for
    Goa and absurd for a background element. A trunk and a ring of drooping
    fronds reads correctly at render distance and costs nothing.
    """
    import random
    rng = random.Random(seed)
    segs = 8
    verts, faces = [], []
    for i in range(segs + 1):
        t = i / segs
        r = 0.16 * (1 - 0.45 * t)
        cx = x + math.sin(t * 1.6 + lean) * h * 0.06
        cy = y + math.cos(t * 1.2 + lean) * h * 0.04
        for k in range(6):
            a = k / 6 * math.tau
            verts.append((cx + math.cos(a) * r, cy + math.sin(a) * r, z + t * h))
    for i in range(segs):
        for k in range(6):
            a = i * 6 + k
            b = i * 6 + (k + 1) % 6
            faces.append((a, b, b + 6, a + 6))
    me = bpy.data.meshes.new("palm_trunk")
    me.from_pydata(verts, [], faces)
    me.update()
    trunk = bpy.data.objects.new("palm_trunk", me)
    scene.collection.objects.link(trunk)
    tm = bpy.data.materials.new("palm_bark")
    tm.use_nodes = True
    tb = tm.node_tree.nodes["Principled BSDF"]
    tb.inputs["Base Color"].default_value = (0.28, 0.23, 0.17, 1.0)
    tb.inputs["Roughness"].default_value = 0.9
    trunk.data.materials.append(tm)

    fm = bpy.data.materials.new("palm_frond")
    fm.use_nodes = True
    fb = fm.node_tree.nodes["Principled BSDF"]
    fb.inputs["Base Color"].default_value = (0.075, 0.155, 0.055, 1.0)
    fb.inputs["Roughness"].default_value = 0.72
    top = (x + math.sin(1.6 + lean) * h * 0.06, y + math.cos(1.2 + lean) * h * 0.04, z + h)
    parts = [trunk]
    for k in range(13):
        a = k / 13 * math.tau + rng.random() * 0.25
        L = 3.4 + rng.random() * 1.3
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.30, depth=L,
                                        location=(top[0] + math.cos(a) * L * 0.42,
                                                  top[1] + math.sin(a) * L * 0.42,
                                                  top[2] - 0.35 - rng.random() * 0.5))
        fr = bpy.context.active_object
        # ~50 deg from vertical: a coconut palm's fronds arch out and hang,
        # they do not splay flat like an agave, which is what 74 deg gave.
        fr.rotation_euler = (math.radians(48 + rng.random() * 22), 0, a + math.pi / 2)
        fr.scale = (1.0, 0.09, 1.0)
        fr.data.materials.append(fm)
        parts.append(fr)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = trunk
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


# a loose grove around the plot, kept clear of the building itself
PALMS = int(os.environ.get('ARCVIA_PALMS', '0'))
import random as _r
_rng = _r.Random(7)
half = max(size.x, size.y) * 0.62
for i in range(PALMS):
    a = i / 18 * math.tau + _rng.random() * 0.2
    d = half * (1.95 + _rng.random() * 0.9)
    px, py = ctr.x + math.cos(a) * d, ctr.y + math.sin(a) * d
    palm(px, py, mn.z, h=6.0 + _rng.random() * 3.4, lean=_rng.random() * 2.0, seed=i)
print(f"[landscape] {PALMS} palms")

# ---------------------------------------------------------------- render ---
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 8
scene.cycles.transmission_bounces = 8
scene.cycles.caustics_reflective = False
scene.render.resolution_x, scene.render.resolution_y = RES
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 35
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 4.0
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

R = max(size.x, size.y) * 1.45


def place(az_deg, height_frac=None, t=0.0):
    """Camera on a rising arc, not a flat turntable.

    t runs 0..1 over the shot. Climbing while circling reveals the building
    instead of spinning it, and pulling in slightly as it rises keeps the frame
    from loosening at the top of the move.
    """
    az = math.radians(az_deg)
    if height_frac is None:
        height_frac = 0.40 + 0.38 * (0.5 - 0.5 * math.cos(t * math.tau))
    r = R * (1.06 - 0.10 * (0.5 - 0.5 * math.cos(t * math.tau)))
    cam.location = (ctr.x + math.cos(az) * r,
                    ctr.y + math.sin(az) * r,
                    mn.z + size.z * height_frac)
    target = mathutils.Vector((ctr.x, ctr.y, mn.z + size.z * 0.45))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.dof.focus_distance = (target - cam.location).length


os.makedirs(os.path.dirname(OUT), exist_ok=True)
if FRAMES <= 1:
    place(-58)
    scene.render.filepath = OUT
    bpy.ops.render.render(write_still=True)
    print(f"[hero] {OUT}")
else:
    base = os.path.splitext(OUT)[0]
    # Resume, don't restart. At ~1 minute a frame on CPU an interrupted run is
    # expensive to throw away, and every frame is independent - the camera is
    # placed from the frame index, not from the previous frame's state.
    done = 0
    for i in range(FRAMES):
        path = f"{base}_{i:04d}.png"
        if os.path.exists(path) and os.path.getsize(path) > 0:
            done += 1
            continue
        place(-58 + 360.0 * i / FRAMES, t=i / FRAMES)
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        print(f"[frame] {i + 1}/{FRAMES}")
    if done:
        print(f"[resume] skipped {done} frames already rendered")
