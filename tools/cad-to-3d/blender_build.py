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
import bpy, bmesh, json, math, sys, os, re

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
# Fine grain will not survive a 2-4 cm texel, so these differ by tone and
# roughness rather than by texture - which is what actually reads at eye height.
M_TIMBER = mat("timber", (0.372, 0.243, 0.145, 1.0), 0.55)
M_WATER = mat("pool_water", (0.129, 0.376, 0.420, 1.0), 0.05, 0.55)
M_FABRIC = mat("upholstery", (0.451, 0.443, 0.416, 1.0), 0.92)
M_CERAMIC = mat("ceramic", (0.957, 0.957, 0.949, 1.0), 0.18)
M_COUNTER = mat("counter_stone", (0.243, 0.247, 0.243, 1.0), 0.28)

MESHES = []
ASSET_OBJS = set()
CURRENT_FLOOR = [""]
FLOOR_OF = {}

TEX_DIR = os.path.join(r"A:\Projects\CasaAltinho\_work\cad", "textures")
_TEX = {}
_tm = os.path.join(TEX_DIR, "manifest.json")
if os.path.exists(_tm):
    _TEX = json.load(open(_tm))

# which downloaded surface dresses which material
TEXTURE_FOR = {
    "floor_stone": "floor_stone", "wall_plaster": "wall_plaster",
    "ceiling": "ceiling", "column": "column", "timber": "floor_timber",
    "counter_stone": "counter",
}
UV_METRES = 2.0        # one texture tile per 2 m of wall or floor


def dress(m, key):
    """Give a material real CC0 maps instead of a flat colour."""
    entry = _TEX.get(key)
    if not entry or not m.use_nodes:
        return False
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return False
    made = False
    if entry.get("Diffuse") and os.path.exists(entry["Diffuse"]):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(entry["Diffuse"], check_existing=True)
        t.location = (-600, 300)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        made = True
    if entry.get("Rough") and os.path.exists(entry["Rough"]):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(entry["Rough"], check_existing=True)
        t.image.colorspace_settings.name = "Non-Color"
        t.location = (-600, 0)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Roughness"])
    if entry.get("nor_gl") and os.path.exists(entry["nor_gl"]):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(entry["nor_gl"], check_existing=True)
        t.image.colorspace_settings.name = "Non-Color"
        t.location = (-600, -300)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (-350, -300)
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return made


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
    FLOOR_OF[ob.name] = CURRENT_FLOOR[0]


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
    FLOOR_OF[ob.name] = CURRENT_FLOOR[0]


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


# Footprint (long x short, metres) -> height and material. A plan symbol is an
# outline seen from above, so size and proportion are the only cues available -
# but for massing they are enough to tell a bed from a coffee table.
FURN_KINDS = [
    (1.75, 2.35, 1.15, 2.10, 0.55, "bed"),
    (1.70, 3.30, 0.72, 1.15, 0.42, "sofa"),
    (1.15, 2.70, 0.78, 1.35, 0.75, "table"),
    (1.40, 4.50, 0.40, 0.72, 0.90, "counter"),
    (0.75, 1.45, 0.45, 0.95, 0.40, "low_table"),
    (0.30, 0.75, 0.28, 0.75, 0.45, "chair"),
]
SANI_KINDS = [
    (1.40, 2.20, 0.65, 1.00, 0.55, "tub"),
    (0.80, 1.10, 0.75, 1.10, 0.12, "shower"),
    (0.55, 0.85, 0.32, 0.60, 0.42, "wc"),
    (0.35, 0.75, 0.30, 0.60, 0.85, "basin"),
]


def kind_of(table, w, d, default_h, default_name):
    hi, lo = max(w, d), min(w, d)
    for a, b, c, e, h, name in table:
        if a <= hi <= b and c <= lo <= e:
            return h, name
    return default_h, default_name


ASSET_DIR = os.path.join(r"A:\Projects\CasaAltinho\_work\cad", "assets")
_ASSET_CACHE = {}
_MANIFEST = {}
_mf = os.path.join(ASSET_DIR, "manifest.json")
if os.path.exists(_mf):
    _MANIFEST = json.load(open(_mf))

# massing kind -> which CC0 asset stands in for it. Poly Haven has no modern bed
# and no sanitary ware, so those stay as blocks.
ASSET_FOR = {"sofa": "sofa", "chair": "chair", "table": "table",
             "low_table": "low_table", "armchair": "armchair", "plant": "plant",
             "tv": "tv"}
DECIMATE_TRIS = 1500


def load_asset(kind):
    """Import a CC0 asset once and keep it as a template to copy from."""
    if kind in _ASSET_CACHE:
        return _ASSET_CACHE[kind]
    slug = ASSET_FOR.get(kind)
    entry = _MANIFEST.get(slug) if slug else None
    if not entry or not os.path.exists(entry["gltf"]):
        _ASSET_CACHE[kind] = None
        return None
    before = set(bpy.context.scene.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=entry["gltf"])
    except Exception as e:
        print(f"[asset] {slug} import failed: {e}")
        _ASSET_CACHE[kind] = None
        return None
    new = [o for o in bpy.context.scene.objects if o not in before and o.type == "MESH"]
    if not new:
        _ASSET_CACHE[kind] = None
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in new:
        o.select_set(True)
    bpy.context.view_layer.objects.active = new[0]
    if len(new) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    # Photogrammetry assets are far denser than a lightmapped shell needs, and
    # every copy carries that cost into the atlas and the export.
    tris = len(ob.data.polygons)
    if tris > DECIMATE_TRIS:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.ratio = max(0.03, DECIMATE_TRIS / tris)
        bpy.ops.object.modifier_apply(modifier="dec")
    ob.name = f"asset_{kind}"
    ob.hide_render = True
    ob.location = (0, 0, -500)          # parked; copies are what get placed
    print(f"[asset] {kind}: {slug} {tris} -> {len(ob.data.polygons)} tris")
    _ASSET_CACHE[kind] = ob
    return ob


def place_asset(kind, cx, cy, z, w, d, rot, name):
    tpl = load_asset(kind)
    if tpl is None:
        return False
    ob = tpl.copy()
    ob.data = tpl.data          # share the mesh until the join
    ob.hide_render = False
    scene.collection.objects.link(ob)
    ob.location = (0, 0, 0)
    ob.rotation_euler = (0, 0, 0)
    ob.scale = (1, 1, 1)
    bpy.context.view_layer.update()
    bb = [v for v in ob.bound_box]
    ax = max(p[0] for p in bb) - min(p[0] for p in bb)
    ay = max(p[1] for p in bb) - min(p[1] for p in bb)
    az = max(p[2] for p in bb) - min(p[2] for p in bb)
    if ax <= 0 or ay <= 0:
        scene.collection.objects.unlink(ob)
        return False
    # uniform scale, matched on the larger plan dimension - non-uniform scaling
    # to force an exact footprint match visibly distorts a recognisable object
    k = max(max(w, d) / max(ax, ay), 0.05)
    ob.scale = (k, k, k)
    ob.rotation_euler = (0, 0, rot)
    ob.location = (cx, cy, z - min(p[2] for p in bb) * k)
    ob.name = name
    MESHES.append(ob)
    ASSET_OBJS.add(ob.name)
    FLOOR_OF[ob.name] = CURRENT_FLOOR[0]
    return True


def add_massing(fl, z, tag):
    """Furniture and sanitary as blocks at the size and place the plan shows."""
    n = 0
    for it in (fl.get("furniture") or []):
        h, name = kind_of(FURN_KINDS, it["w"], it["d"], 0.45, "piece")
        if place_asset(name, it["c"][0], it["c"][1], z, it["w"], it["d"],
                       math.radians(it["angle"]), f"fur_{tag}_{n}"):
            n += 1
            continue
        m = M_FABRIC if name in ("bed", "sofa", "chair") else (
            M_COUNTER if name == "counter" else M_TIMBER)
        add_box(it["c"][0], it["c"][1], z + h / 2, max(it["w"], 0.15), max(it["d"], 0.15), h,
                math.radians(it["angle"]), m, f"fur_{tag}_{n}")
        n += 1
    for it in (fl.get("sanitary") or []):
        h, name = kind_of(SANI_KINDS, it["w"], it["d"], 0.45, "fitting")
        add_box(it["c"][0], it["c"][1], z + h / 2, max(it["w"], 0.15), max(it["d"], 0.15), h,
                math.radians(it["angle"]), M_CERAMIC, f"san_{tag}_{n}")
        n += 1
    return n


def add_stairs(fl, z, rise, tag):
    """Stepped flights, so a stair reads as a stair rather than a hole.

    The viewer's walk controller has no collision and moves horizontally at a
    fixed floor height, so these are visual only - a visitor still changes level
    by picking a viewpoint, not by climbing. Making floors genuinely walk-
    connected needs collision in the viewer, which is a change to the controls,
    not to this geometry.
    """
    n = 0
    for st in (fl.get("stairs") or []):
        run = max(st["w"], st["d"])
        wide = min(st["w"], st["d"])
        if run < 1.5 or wide < 0.6:
            continue
        steps = max(6, min(20, int(rise / 0.18)))
        ang = math.radians(st["angle"] if st["w"] >= st["d"] else st["angle"] + 90)
        ux, uy = math.cos(ang), math.sin(ang)
        for i in range(steps):
            t = (i + 0.5) / steps
            sx = st["c"][0] + ux * (t - 0.5) * run
            sy = st["c"][1] + uy * (t - 0.5) * run
            hz = rise * (i + 1) / steps
            add_box(sx, sy, z + hz / 2, run / steps, wide, hz, ang,
                    M_FLOOR, f"step_{tag}_{n}_{i}")
        n += 1
    return n


DIMS = re.compile(r"(\d+\.?\d*)\s*[xX]\s*(\d+\.?\d*)")


def add_patches(fl, z, tag):
    """Pool and deck surfaces, sized from the room label's own dimensions.

    Only placed when the label states a size - guessing the extent of a pool is
    worse than leaving it flat floor.
    """
    n = 0
    for l in (fl.get("labels") or []):
        t = l["t"].upper()
        pool = "POOL" in t
        deck = any(k in t for k in ("DECK", "TERRACE", "BALCONY", "VERANDAH"))
        if not (pool or deck):
            continue
        m = DIMS.search(l["t"])
        if not m:
            continue
        w, d = float(m.group(1)), float(m.group(2))
        if not (0.8 <= w <= 14 and 0.8 <= d <= 14):
            continue
        z0 = z - 0.35 if pool else z + 0.01
        z1 = z - 0.02 if pool else z + 0.04
        add_box(l["p"][0], l["p"][1], (z0 + z1) / 2, w, d, z1 - z0, 0.0,
                M_WATER if pool else M_TIMBER, f"pat_{tag}_{n}")
        n += 1
    return n


# Indicative furnishing, driven by the room schedule rather than the plan's
# furniture symbols. The `furn` layer is a scatter of partial outlines - good
# for where something sits, unreliable for what it is - whereas a room label is
# unambiguous and states its own size. Offsets below are fractions of the room,
# so a scheme scales with the room it is in.
SCHEMES = {
    "LIVING":   [("sofa", 0.0, -0.28, 0.0), ("low_table", 0.0, 0.02, 0.0),
                 ("armchair", 0.30, 0.16, -2.4), ("plant", -0.36, 0.30, 0.0)],
    "DINING":   [("table", 0.0, 0.0, 0.0), ("chair", 0.0, -0.22, 0.0),
                 ("chair", 0.0, 0.22, 3.14), ("chair", -0.24, 0.0, 1.57),
                 ("chair", 0.24, 0.0, -1.57)],
    "FAMILY":   [("sofa", 0.0, -0.26, 0.0), ("low_table", 0.0, 0.04, 0.0),
                 ("plant", 0.34, 0.30, 0.0)],
    "LOUNGE":   [("sofa", 0.0, -0.26, 0.0), ("low_table", 0.0, 0.04, 0.0)],
    "FOYER":    [("plant", 0.28, 0.24, 0.0)],
    "ENTRANCE": [("plant", 0.26, 0.22, 0.0)],
    "DECK":     [("armchair", -0.22, 0.0, 1.57), ("armchair", 0.22, 0.0, -1.57),
                 ("low_table", 0.0, 0.0, 0.0)],
    "TERRACE":  [("armchair", -0.20, 0.0, 1.57), ("plant", 0.30, 0.10, 0.0)],
    "VERANDAH": [("armchair", -0.20, 0.0, 1.57), ("plant", 0.28, 0.12, 0.0)],
}
# nominal footprint (m) for each piece, before it is scaled into the room
PIECE_SIZE = {"sofa": (2.10, 0.90), "armchair": (0.85, 0.85), "low_table": (1.05, 0.60),
              "table": (1.80, 0.95), "chair": (0.48, 0.50), "plant": (0.55, 0.55),
              "tv": (1.20, 0.12)}


def add_scheme(fl, z, tag):
    """Furnish the named rooms from the schedule."""
    n = 0
    for l in (fl.get("labels") or []):
        t = l["t"].upper()
        key = next((k for k in SCHEMES if k in t), None)
        if not key:
            continue
        m = DIMS.search(l["t"])
        if not m:
            continue
        rw, rd = float(m.group(1)), float(m.group(2))
        if not (2.0 <= max(rw, rd) <= 13.0 and min(rw, rd) >= 1.2):
            continue
        for kind, fx, fy, rot in SCHEMES[key]:
            pw, pd = PIECE_SIZE.get(kind, (0.8, 0.8))
            cx = l["p"][0] + fx * rw
            cy = l["p"][1] + fy * rd
            if place_asset(kind, cx, cy, z, pw, pd, rot, f"sch_{tag}_{n}"):
                n += 1
            elif kind in ("sofa", "table", "armchair", "low_table", "chair"):
                h = {"sofa": 0.42, "table": 0.75, "armchair": 0.45,
                     "low_table": 0.40, "chair": 0.45}[kind]
                add_box(cx, cy, z + h / 2, pw, pd, h, rot, M_FABRIC, f"sch_{tag}_{n}")
                n += 1
    return n


def add_perimeter(fl, z, tag):
    """Build the exterior wall from the floor slab outline.

    The drawings draw a villa's perimeter as its outline, not as paired wall
    faces, so extracting walls from the wall layers alone yields interior
    partitions and no elevations - the building renders as a sectioned display
    model you can see straight through. The traced footprint IS that perimeter
    line, so extrude it.

    Openings are cut with the same prisms the interior walls use, which is what
    keeps windows and glazing lining up with the plan.
    """
    poly = fl.get("footprint") or []
    if len(poly) < 3:
        return 0
    existing = [w for w in fl.get("walls") or [] if not w.get("unpaired")]
    n = 0
    for i in range(len(poly)):
        ax, ay = poly[i - 1]
        bx, by = poly[i]
        d = math.hypot(bx - ax, by - ay)
        if d < 0.45:
            continue
        # skip an edge that a real paired wall already covers, or the elevation
        # gets a double thickness and z-fights along its whole length
        mx, my = (ax + bx) / 2, (ay + by) / 2
        covered = False
        for w in existing:
            wx0, wy0 = w["a"]
            wx1, wy1 = w["b"]
            wd = math.hypot(wx1 - wx0, wy1 - wy0)
            if wd < 1e-6:
                continue
            ux, uy = (wx1 - wx0) / wd, (wy1 - wy0) / wd
            t = max(0.0, min(wd, (mx - wx0) * ux + (my - wy0) * uy))
            px, py = wx0 + ux * t, wy0 + uy * t
            if math.hypot(px - mx, py - my) < 0.45:
                covered = True
                break
        if covered:
            continue
        build_wall(dict(a=[ax, ay], b=[bx, by], t=0.23), z, fl.get("openings") or [],
                   f"per_{tag}_{i}")
        n += 1
    return n


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
    CURRENT_FLOOR[0] = fl["id"]
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
    counts["massing"] = counts.get("massing", 0) + add_massing(fl, z, fl["id"])
    counts["stairs"] = counts.get("stairs", 0) + add_stairs(fl, z, B["floorToFloor"], fl["id"])
    counts["patches"] = counts.get("patches", 0) + add_patches(fl, z, fl["id"])
    counts["furnished"] = counts.get("furnished", 0) + add_scheme(fl, z, fl["id"])
    counts["perimeter"] = counts.get("perimeter", 0) + add_perimeter(fl, z, fl["id"])

# Roof over the enclosed part of the top floor only. The pool and open deck sit
# along one edge and must stay open to the sky; roofing the whole footprint turns
# them into interior rooms and seals the level.
CURRENT_FLOOR[0] = B["floors"][-1]["id"]
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

# Join per FLOOR, not into a single mesh. A dollhouse view has to lift each
# level independently, which a fused mesh cannot do.
import collections as _c
by_floor = _c.defaultdict(list)
for o in MESHES:
    by_floor[FLOOR_OF.get(o.name, "misc")].append(o)

floor_objs = []
for fid, objs in by_floor.items():
    objs = [o for o in objs if o.name in bpy.data.objects]
    if not objs:
        continue
    shell = [o for o in objs if o.name not in ASSET_OBJS]
    assets = [o for o in objs if o.name in ASSET_OBJS]
    if shell:
        bpy.ops.object.select_all(action="DESELECT")
        for o in shell:
            o.select_set(True)
        bpy.context.view_layer.objects.active = shell[0]
        bpy.ops.object.make_single_user(object=True, obdata=True)
        bpy.ops.object.join()
        sh = bpy.context.view_layer.objects.active
        # world-scale box UVs; imported assets already carry their own
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=UV_METRES, correct_aspect=True)
        bpy.ops.object.mode_set(mode="OBJECT")
        for m in sh.data.materials:
            if m:
                dress(m, TEXTURE_FOR.get(m.name, ""))
        group = [sh] + assets
    else:
        group = assets
    if len(group) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for o in group:
            o.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        bpy.ops.object.make_single_user(object=True, obdata=True)
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = f"floor_{fid}"
    floor_objs.append(ob)
    print(f"[floor] {ob.name}: {len(ob.data.polygons)} polys")

for ob in list(bpy.context.scene.objects):
    if ob.name.startswith("asset_"):
        bpy.data.objects.remove(ob, do_unlink=True)

ob = floor_objs[0]
total = sum(len(o.data.polygons) for o in floor_objs)
print(f"[mesh] {len(floor_objs)} floor objects, {total} polys")

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
    scene.render.bake.margin = 8
    # Ambient occlusion, NOT combined lighting.
    #
    # The previous approach baked full lighting into an emissive texture over a
    # black base colour. It reproduces a bake exactly and it has no graceful
    # failure: any face the atlas misses renders pure BLACK rather than merely
    # unlit. Once furniture pushed the mesh to 40k polys the packer ran out of
    # room and those faces became the black slabs filling the view.
    #
    # AO in glTF's standard occlusionTexture keeps every material's own colour
    # and only darkens the contacts, so a packing failure degrades to "flat
    # lit" instead of "invisible".
    bpy.ops.object.bake(type="AO")
    print("[bake] AO done")

    # The exporter reads occlusion from a node group named "glTF Material
    # Output" with an "Occlusion" input - it will not pick the image up from
    # anywhere else in the tree.
    for m in ob.data.materials:
        if not m or not m.use_nodes:
            continue
        nt = m.node_tree
        grp = bpy.data.node_groups.get("glTF Material Output")
        if grp is None:
            grp = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
            grp.interface.new_socket("Occlusion", in_out="INPUT",
                                     socket_type="NodeSocketFloat")
            gin = grp.nodes.new("NodeGroupInput")
            gin.location = (0, 0)
        node = nt.nodes.new("ShaderNodeGroup")
        node.node_tree = grp
        node.location = (400, -400)
        tex = next((n for n in nt.nodes
                    if n.type == "TEX_IMAGE" and n.image is img), None)
        if tex is None:
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            tex.location = (100, -400)
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (260, -400)
        nt.links.new(tex.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs[0], node.inputs["Occlusion"])


def add_sky_dome():
    """An inward-facing sky sphere.

    The viewer hardcodes `scene.background = 0x11151c`, so without this every
    window and doorway reads as night. Emissive, so it is unaffected by the
    scene lighting and needs no bake.
    """
    bpy.ops.mesh.primitive_uv_sphere_add(radius=90.0, segments=32, ring_count=16,
                                         location=(0, 0, 0))
    d = bpy.context.active_object
    d.name = "Sky"
    bm = bmesh.new()
    bm.from_mesh(d.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])   # seen from inside
    bm.to_mesh(d.data)
    bm.free()

    W, H = 8, 128
    img = bpy.data.images.new("skygrad", W, H)
    px = [0.0] * (W * H * 4)
    for row in range(H):
        v = row / (H - 1)
        if v < 0.5:
            k = v / 0.5
            r, g, b = (0.20 + 0.62 * k, 0.17 + 0.66 * k, 0.13 + 0.66 * k)
        else:
            k = (v - 0.5) / 0.5
            r, g, b = (0.82 - 0.55 * k, 0.85 - 0.42 * k, 0.88 - 0.10 * k)
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


add_sky_dome()


# Downscale every texture before export. The shell carries six PBR sets of three
# maps each and every placed asset brings its own; at 1k that is ~15 MB per
# villa, which across five types would weigh as much as the 75 MB reference this
# is meant to beat. At the size these read on screen, 512 is indistinguishable.
MAX_TEX = 512
_shrunk = 0
for img in bpy.data.images:
    if img.name in ("Render Result", "Viewer Node") or not img.has_data:
        continue
    w, h = img.size
    if max(w, h) <= MAX_TEX:
        continue
    k = MAX_TEX / max(w, h)
    try:
        img.scale(max(1, int(w * k)), max(1, int(h * k)))
        _shrunk += 1
    except Exception:
        pass
print(f"[textures] {_shrunk} images downscaled to {MAX_TEX}px")

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=DST, export_format="GLB", export_apply=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6, export_yup=True)
print(f"[export] {DST}  {os.path.getsize(DST)/1024:.0f} KB")
