"""
Build a villa in Blender from its building description, optionally bake the
lighting, and export glTF.

  blender --background --python blender_build.py -- <in.json> <out.glb> [--bake N]

Openings are cut arithmetically, not with boolean modifiers. Every wall is a
straight box and every opening a prism crossing it, so each wall is emitted as
the pieces that survive the cut - jamb, jamb, lintel over the head, sill under
the cill. Booleans would be slower and fail on the coplanar faces that occur
wherever an opening sits flush in a wall face.

The bake writes final lit colour into an emissive texture and sets base colour
to black. That is deliberate: glTF has no lightmap channel, so a baked map
carried as base colour would be multiplied by the viewer's realtime lights and
double-expose. Black albedo + emissive reproduces the bake exactly through
vanilla glTF, at the cost of realtime specular - which an unfurnished plaster
shell was never going to show anyway.
"""
import bpy, bmesh, json, math, sys, os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC, DST = argv[0], argv[1]
BAKE = 0
if "--bake" in argv:
    BAKE = int(argv[argv.index("--bake") + 1])
SKY = r"A:\Web\Arcvia\tools\cad-to-3d\sky.hdr"

B = json.load(open(SRC))
CLEAR, SLAB = B["clear"], B["slab"]
PARAPET = 1.00          # "Glass Railing ht.- 1.00 m", per the drawing note
HEIGHTS = {"door": (0.00, 2.10), "window": (0.90, 2.25), "glazing": (0.05, 2.45)}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"


def mat(name, rgba, rough=0.8, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    if transmission:
        for k in ("Transmission Weight", "Transmission"):
            if k in b.inputs:
                b.inputs[k].default_value = transmission
                break
    return m


M_WALL = mat("wall_plaster", (0.898, 0.878, 0.847, 1.0), 0.88)
M_FLOOR = mat("floor_stone", (0.760, 0.722, 0.671, 1.0), 0.35)
M_CEIL = mat("ceiling", (0.945, 0.941, 0.933, 1.0), 0.92)
M_COL = mat("column", (0.863, 0.843, 0.812, 1.0), 0.80)
M_GLASS = mat("glass", (0.85, 0.91, 0.93, 1.0), 0.06, 0.85)

MESHES = []


def add_box(cx, cy, cz, sx, sy, sz, rotz, material, name):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = (cx, cy, cz)
    ob.rotation_euler = (0.0, 0.0, rotz)
    ob.data.materials.append(material)
    scene.collection.objects.link(ob)
    MESHES.append(ob)


def add_prism(poly, z0, z1, material, name):
    if len(poly) < 3:
        return
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((float(p[0]), float(p[1]), z0)) for p in poly]
    try:
        bm.faces.new(verts)
    except Exception:
        bm.free()
        return
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    r = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    moved = [v for v in r["geom"] if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0.0, 0.0, z1 - z0), verts=moved)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    scene.collection.objects.link(ob)
    MESHES.append(ob)


def wall_cuts(w, openings, d, ax, ay, ux, uy):
    nx, ny = -uy, ux
    wang = math.degrees(math.atan2(uy, ux)) % 180.0
    cuts = []
    for op in openings:
        da = abs(wang - op["angle"]) % 180.0
        da = min(da, 180.0 - da)
        if da > 12.0:
            continue
        cx, cy = op["c"]
        if abs((cx - ax) * nx + (cy - ay) * ny) > w["t"] / 2 + 0.12:
            continue
        along = (cx - ax) * ux + (cy - ay) * uy
        s, e = along - op["length"] / 2, along + op["length"] / 2
        if e < 0.05 or s > d - 0.05:
            continue
        z0, z1 = HEIGHTS.get(op["kind"], HEIGHTS["door"])
        cuts.append((max(0.0, s), min(d, e), z0, min(z1, CLEAR), op["kind"]))
    cuts.sort()
    merged = []
    for c in cuts:
        if merged and c[0] <= merged[-1][1] + 0.02 and abs(c[2] - merged[-1][2]) < 0.01:
            merged[-1] = (merged[-1][0], max(merged[-1][1], c[1]), c[2],
                          max(merged[-1][3], c[3]), c[4])
        else:
            merged.append(c)
    return merged


def build_wall(w, base_z, openings, idx):
    ax, ay = w["a"]
    bx, by = w["b"]
    d = math.hypot(bx - ax, by - ay)
    if d < 0.05:
        return
    ux, uy = (bx - ax) / d, (by - ay) / d
    rot = math.atan2(uy, ux)
    t = max(w["t"], 0.08)
    h = PARAPET if w.get("unpaired") else CLEAR

    def piece(s, e, z0, z1, material, tag):
        if e - s < 0.02 or z1 - z0 < 0.02:
            return
        add_box(ax + ux * (s + e) / 2, ay + uy * (s + e) / 2, base_z + (z0 + z1) / 2,
                e - s, t, z1 - z0, rot, material, f"w{idx}_{tag}")

    cuts = [] if w.get("unpaired") else wall_cuts(w, openings, d, ax, ay, ux, uy)
    if not cuts:
        piece(0, d, 0, h, M_WALL, "full")
        return
    cursor = 0.0
    for (s, e, z0, z1, kind) in cuts:
        piece(cursor, s, 0, h, M_WALL, "jamb")
        if z0 > 0.01:
            piece(s, e, 0, z0, M_WALL, "sill")
        if z1 < h - 0.01:
            piece(s, e, z1, h, M_WALL, "lintel")
        if kind in ("window", "glazing"):
            add_box(ax + ux * (s + e) / 2, ay + uy * (s + e) / 2,
                    base_z + (z0 + z1) / 2, e - s, 0.02, z1 - z0, rot, M_GLASS, f"g{idx}")
        cursor = e
    piece(cursor, d, 0, h, M_WALL, "jamb")


def clip_halfplane(poly, ymin):
    out = []
    for i in range(len(poly)):
        cur, prv = poly[i], poly[i - 1]
        cin, pin = cur[1] >= ymin, prv[1] >= ymin
        if cin != pin:
            t = (ymin - prv[1]) / (cur[1] - prv[1])
            out.append([prv[0] + t * (cur[0] - prv[0]), ymin])
        if cin:
            out.append([cur[0], cur[1]])
    return out


counts = {"walls": 0, "openings": 0, "columns": 0, "slabs": 0}
for fl in B["floors"]:
    z = fl["level"]
    if fl["footprint"]:
        add_prism(fl["footprint"], z - SLAB, z, M_FLOOR, f"slab_{fl['id']}")
        counts["slabs"] += 1
    for i, w in enumerate(fl["walls"]):
        build_wall(w, z, fl["openings"], f"{fl['id']}_{i}")
        counts["walls"] += 1
    # Traced floors carry wall bands as ready-made rectangles rather than
    # centreline+thickness: on a rendered brochure plan the wall is a solid
    # band, so the mask is already the solid and there is nothing to pair.
    for k, poly in enumerate(fl.get("wallPolys") or []):
        add_prism(poly, z, z + CLEAR, M_WALL, f"tw_{fl['id']}_{k}")
        counts["walls"] += 1
    counts["openings"] += len(fl["openings"])
    for j, c in enumerate(fl["columns"]):
        if len(c) >= 3:
            add_prism(c, z, z + CLEAR, M_COL, f"col_{fl['id']}_{j}")
            counts["columns"] += 1

# Roof over the enclosed part of the top floor only. The pool and open deck sit
# along one edge and must stay open to the sky; roofing the whole footprint turns
# them into interior rooms and seals the level.
top = B["floors"][-1]
if top["footprint"]:
    open_air = [l["p"][1] for l in top.get("labels", [])
                if any(k in l["t"].upper() for k in ("POOL", "DECK", "TERRACE", "OPEN"))]
    poly = top["footprint"]
    if open_air:
        poly = clip_halfplane(poly, max(open_air) + 1.5)
    elif not top.get("labels"):
        # No labels means no way to find the open-air edge - which is the case on
        # a traced floor, where the brochure plan's text is not extractable.
        # Roofing the whole plate then seals a level that really carries a pool
        # and a deck, and the rooms below it go dark. Leave it open instead:
        # missing a roof is visible and honest, a sealed level just looks broken.
        poly = []
        print("[roof] skipped - no labels to locate the open-air edge")
    if len(poly) >= 3:
        add_prism(poly, top["level"] + CLEAR, top["level"] + CLEAR + SLAB, M_CEIL, "roof")

print(f"[build] {counts} objects={len(MESHES)}")
if not MESHES:
    raise SystemExit("nothing built")

bpy.ops.object.select_all(action="DESELECT")
for ob in MESHES:
    ob.select_set(True)
bpy.context.view_layer.objects.active = MESHES[0]
bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
ob.name = "Villa"
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.0005)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[mesh] verts={len(ob.data.vertices)} polys={len(ob.data.polygons)}")

# ------------------------------------------------------------------- world --
world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
nt = world.node_tree
bg = nt.nodes["Background"]
if os.path.exists(SKY):
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(SKY)
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
else:
    bg.inputs["Color"].default_value = (0.55, 0.68, 0.85, 1.0)
    bg.inputs["Strength"].default_value = 2.0

sd = bpy.data.lights.new("Sun", type="SUN")
sd.energy = 4.0
sd.angle = math.radians(2.5)
sun = bpy.data.objects.new("Sun", sd)
sun.rotation_euler = (math.radians(55), 0, math.radians(215))
scene.collection.objects.link(sun)

if BAKE:
    print(f"[bake] {BAKE} samples")
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = BAKE
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6

    # One lightmap UV layer, and only one: glTF binds textures to UV0, so the
    # packed layout must BE UV0 rather than sit behind an unused default.
    bpy.context.view_layer.objects.active = ob
    while len(ob.data.uv_layers) > 0:
        ob.data.uv_layers.remove(ob.data.uv_layers[0])
    ob.data.uv_layers.new(name="Lightmap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_FACES", PREF_MARGIN_DIV=0.3)
    bpy.ops.object.mode_set(mode="OBJECT")

    RES = 1024
    img = bpy.data.images.new("bake", RES, RES, float_buffer=True)
    for m in ob.data.materials:
        if not m or not m.use_nodes:
            continue
        n = m.node_tree.nodes.new("ShaderNodeTexImage")
        n.image = img
        n.select = True
        m.node_tree.nodes.active = n

    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.margin = 6
    bpy.ops.object.bake(type="COMBINED")
    print("[bake] done")

    # Replace every material with one emissive material carrying the bake.
    baked = bpy.data.materials.new("baked")
    baked.use_nodes = True
    bnt = baked.node_tree
    for n in list(bnt.nodes):
        bnt.nodes.remove(n)
    outn = bnt.nodes.new("ShaderNodeOutputMaterial")
    pr = bnt.nodes.new("ShaderNodeBsdfPrincipled")
    tex = bnt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    pr.inputs["Base Color"].default_value = (0, 0, 0, 1)
    pr.inputs["Roughness"].default_value = 1.0
    bnt.links.new(tex.outputs["Color"], pr.inputs["Emission Color"]
                  if "Emission Color" in pr.inputs else pr.inputs["Emission"])
    pr.inputs["Emission Strength"].default_value = 1.0
    bnt.links.new(pr.outputs["BSDF"], outn.inputs["Surface"])
    ob.data.materials.clear()
    ob.data.materials.append(baked)


def add_sky_dome():
    """An inward-facing sky sphere, added after the bake.

    The viewer hardcodes a dark background, so without this every window and
    doorway reads as night once the model is emissive-only. The dome is added
    after baking on purpose: at ~100,000 m2 it dwarfs the villa's ~1,500 m2 and
    would swallow almost the whole lightmap atlas if it were packed with it.
    """
    bpy.ops.mesh.primitive_uv_sphere_add(radius=90.0, segments=32, ring_count=16,
                                         location=(0, 0, 0))
    d = bpy.context.active_object
    d.name = "Sky"
    me = d.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])   # seen from inside
    bm.to_mesh(me)
    bm.free()

    W, H = 8, 128
    img = bpy.data.images.new("skygrad", W, H)
    px = [0.0] * (W * H * 4)
    for row in range(H):
        v = row / (H - 1)          # 0 = bottom of the sphere
        if v < 0.5:
            k = v / 0.5
            r, g, b = (0.20 + 0.62 * k, 0.17 + 0.66 * k, 0.13 + 0.66 * k)
        else:
            k = (v - 0.5) / 0.5
            r, g, b = (0.82 - 0.62 * k, 0.83 - 0.50 * k, 0.79 - 0.18 * k)
        for col in range(W):
            i = (row * W + col) * 4
            px[i:i + 4] = [r, g, b, 1.0]
    img.pixels = px
    img.pack()

    m = bpy.data.materials.new("sky")
    m.use_nodes = True
    nt2 = m.node_tree
    for n in list(nt2.nodes):
        nt2.nodes.remove(n)
    o = nt2.nodes.new("ShaderNodeOutputMaterial")
    pr = nt2.nodes.new("ShaderNodeBsdfPrincipled")
    tx = nt2.nodes.new("ShaderNodeTexImage")
    tx.image = img
    pr.inputs["Base Color"].default_value = (0, 0, 0, 1)
    pr.inputs["Roughness"].default_value = 1.0
    key = "Emission Color" if "Emission Color" in pr.inputs else "Emission"
    nt2.links.new(tx.outputs["Color"], pr.inputs[key])
    pr.inputs["Emission Strength"].default_value = 1.0
    nt2.links.new(pr.outputs["BSDF"], o.inputs["Surface"])
    m.use_backface_culling = False
    d.data.materials.append(m)
    print("[sky] dome added")


if BAKE:
    add_sky_dome()

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=DST, export_format="GLB", export_apply=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6, export_yup=True)
print(f"[export] {DST}  {os.path.getsize(DST)/1024:.0f} KB")
