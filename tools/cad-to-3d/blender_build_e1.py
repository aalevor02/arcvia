"""
Build Villa E-1 in Blender from the extracted CAD description, and export glTF.

Run:
  blender --background --python blender_build_e1.py -- <in.json> <out.glb>

Openings are cut arithmetically, not with boolean modifiers. Every wall here is
a straight box and every opening a prism crossing it, so the wall can be emitted
directly as the pieces that survive the cut - jamb, jamb, lintel over the head,
sill under the cill. Booleans would be slower and would fail on the coplanar
faces that occur wherever an opening sits flush in a wall face.
"""
import bpy, bmesh, json, math, sys, os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = argv[0] if argv else r"A:\Projects\CasaAltinho\_work\cad\e1_building.json"
DST = argv[1] if len(argv) > 1 else r"A:\Projects\CasaAltinho\_work\cad\villa-e1.glb"

B = json.load(open(SRC))
CLEAR = B["clear"]      # 2.65 m floor to soffit
SLAB = B["slab"]        # 0.35 m structural zone
F2F = B["floorToFloor"]  # 3.00 m

# Opening heights, measured off the section linework where possible.
PARAPET = 1.00  # glass railing height, per the drawing note

HEIGHTS = {
    "door":    (0.00, 2.10),
    "window":  (0.90, 2.25),
    "glazing": (0.05, 2.45),
}

# ----------------------------------------------------------------- scene --
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.length_unit = "METERS"


def mat(name, rgba, rough=0.8, metal=0.0, transmission=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if transmission:
        for key in ("Transmission Weight", "Transmission"):
            if key in b.inputs:
                b.inputs[key].default_value = transmission
                break
        m.blend_method = "BLEND"
    return m


M_WALL = mat("wall_plaster", (0.902, 0.882, 0.851, 1.0), 0.88)
M_FLOOR = mat("floor_stone", (0.784, 0.749, 0.702, 1.0), 0.32)
M_CEIL = mat("ceiling", (0.945, 0.941, 0.933, 1.0), 0.92)
M_COL = mat("column", (0.871, 0.851, 0.820, 1.0), 0.80)
M_GLASS = mat("glass", (0.85, 0.91, 0.93, 1.0), 0.06, 0.0, 1.0)
M_TRIM = mat("trim_timber", (0.372, 0.243, 0.145, 1.0), 0.55)

MESHES = []


def add_box(cx, cy, cz, sx, sy, sz, rotz, material, name):
    """Axis-aligned box, rotated about Z, given by centre and full size."""
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
    return ob


def add_prism(poly, z0, z1, material, name):
    """Extrude a closed 2D polygon between two heights."""
    if len(poly) < 3:
        return None
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((float(p[0]), float(p[1]), z0)) for p in poly]
    bm.faces.new(verts)
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
    return ob


def wall_openings(w, openings):
    """Which openings cut this wall, as (start, end, z0, z1) along its length."""
    ax, ay = w["a"]
    bx, by = w["b"]
    d = math.hypot(bx - ax, by - ay)
    if d < 1e-6:
        return []
    ux, uy = (bx - ax) / d, (by - ay) / d
    nx, ny = -uy, ux
    wang = math.degrees(math.atan2(uy, ux)) % 180.0
    cuts = []
    for op in openings:
        da = abs(wang - op["angle"]) % 180.0
        da = min(da, 180.0 - da)
        if da > 12.0:
            continue
        cx, cy = op["c"]
        perp = abs((cx - ax) * nx + (cy - ay) * ny)
        if perp > w["t"] / 2 + 0.12:
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
            merged[-1] = (merged[-1][0], max(merged[-1][1], c[1]), c[2], max(merged[-1][3], c[3]), c[4])
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
    # An unpaired run is a single line in plan: a balcony railing, a terrace
    # parapet, a ledge. The drawing annotates them - "Glass Railing ht.- 1.00 m",
    # "Ledge wall ht.- 0.15 m". Extruding them to ceiling height walls in every
    # balcony and blacks out the rooms behind.
    h = PARAPET if w.get("unpaired") else CLEAR

    def piece(s, e, z0, z1, material, tag):
        if e - s < 0.02 or z1 - z0 < 0.02:
            return
        mx = ax + ux * (s + e) / 2
        my = ay + uy * (s + e) / 2
        add_box(mx, my, base_z + (z0 + z1) / 2, e - s, t, z1 - z0, rot,
                material, f"wall{idx}_{tag}")

    cuts = wall_openings(w, openings)
    if not cuts:
        piece(0, d, 0, h, M_WALL, "full")
        return
    cursor = 0.0
    for (s, e, z0, z1, kind) in cuts:
        piece(cursor, s, 0, h, M_WALL, "jamb")
        if z0 > 0.01:
            piece(s, e, 0, z0, M_WALL, "sill")        # under a window
        if z1 < h - 0.01:
            piece(s, e, z1, h, M_WALL, "lintel")      # over the head
        if kind in ("window", "glazing"):
            mx = ax + ux * (s + e) / 2
            my = ay + uy * (s + e) / 2
            add_box(mx, my, base_z + (z0 + z1) / 2, e - s, 0.02, z1 - z0, rot,
                    M_GLASS, f"glass{idx}")
        cursor = e
    piece(cursor, d, 0, h, M_WALL, "jamb")


# ------------------------------------------------------------------ build --
counts = {"walls": 0, "openings": 0, "columns": 0, "slabs": 0}
for fl in B["floors"]:
    z = fl["level"]
    poly = fl["footprint"]
    # Slab: top face at floor level, structure below it.
    if poly:
        add_prism(poly, z - SLAB, z, M_FLOOR, f"slab_{fl['id']}")
        counts["slabs"] += 1
    for i, w in enumerate(fl["walls"]):
        build_wall(w, z, fl["openings"], f"{fl['id']}_{i}")
        counts["walls"] += 1
    counts["openings"] += len(fl["openings"])
    for j, c in enumerate(fl["columns"]):
        if len(c) >= 3:
            add_prism(c, z, z + CLEAR, M_COL, f"col_{fl['id']}_{j}")
            counts["columns"] += 1

def clip_halfplane(poly, ymin):
    """Sutherland-Hodgman clip of a polygon to y >= ymin."""
    out = []
    n = len(poly)
    for i in range(n):
        cur, prv = poly[i], poly[i - 1]
        cin, pin = cur[1] >= ymin, prv[1] >= ymin
        if cin != pin:
            t = (ymin - prv[1]) / (cur[1] - prv[1])
            out.append([prv[0] + t * (cur[0] - prv[0]), ymin])
        if cin:
            out.append([cur[0], cur[1]])
    return out


# Roof over the enclosed part of the top floor only. The second floor carries the
# swimming pool and the 11.30 x 2.35 open deck along its southern edge - roofing
# the whole footprint turns both into interior rooms and seals the level.
ROOF_YMIN = 6.6   # living/kitchen/dining sit above this, pool and deck below it
top = B["floors"][-1]
if top["footprint"]:
    rp = clip_halfplane(top["footprint"], ROOF_YMIN)
    if len(rp) >= 3:
        add_prism(rp, top["level"] + CLEAR, top["level"] + CLEAR + SLAB,
                  M_CEIL, "roof_slab")

# No blanket ceilings. Floor N+1's slab is already floor N's ceiling, and it
# covers exactly the area that has a floor above it - so balconies, terraces and
# the pool deck are left open to the sky, which is what they are. Adding a
# ceiling over the whole footprint sealed them into windowless boxes and starved
# the rooms behind them of daylight.

print(f"[build] {counts}  objects={len(MESHES)}")

# Join into one object per material family keeps the draw call count sane.
bpy.ops.object.select_all(action="DESELECT")
for ob in MESHES:
    ob.select_set(True)
bpy.context.view_layer.objects.active = MESHES[0]
bpy.ops.object.join()
joined = bpy.context.view_layer.objects.active
joined.name = "VillaE1"

# Weld coincident vertices produced by adjacent wall pieces.
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.0005)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")

me = joined.data
print(f"[mesh] verts={len(me.vertices)} polys={len(me.polygons)}")

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=DST,
    export_format="GLB",
    export_apply=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_yup=True,
)
print(f"[export] {DST}  {os.path.getsize(DST)/1024:.0f} KB")
