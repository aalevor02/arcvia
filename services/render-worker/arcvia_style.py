"""
Styles, as Blender configuration.

Imported by `render_views.py` inside Blender. Nothing here imports bpy at module
level so the mapping can be read and tested outside Blender; the functions take
`bpy` as an argument.

── The rules this file exists to enforce ────────────────────────────────────
Two of them have cost real time on this project and are hard-coded rather than
left to a preset:

  EEVEE RENDERS BLACK under `--background`. Every style sets CYCLES explicitly.
  There is no style here that does not, and there must never be one.

  A view transform is not a look. AgX tone-maps everything, which is right for a
  photograph and wrong for a CAD drawing or a diagnostic pass — a flat emission
  render that has been filmically graded is no longer flat, and no longer
  diagnostic. Styles that mean their colours literally force Standard.
"""

from __future__ import annotations

import os

#: id -> (view transform, world kind, material kind, freestyle, look)
#:
#: `raw` is NOT a picture and is not meant to be legible on its own. Flat world
#: plus emission materials means every surface returns its own colour regardless
#: of light or facing, so an isometric comes back near-uniform white — mean 253,
#: standard deviation under 2, no structure. That is the intended output: it is
#: the base layer the `--aov` conditioning passes are keyed against, where the
#: point is precisely that shading contributes nothing.
#:
#: Recorded here because two people have now had to work it out from the outside
#: and both reasonably suspected it was broken. Emission ignoring facing is also
#: why `raw` cannot be used to diagnose geometry: it renders an inside-out box
#: and a correct one identically, which cost a day earlier in this project.
STYLE_TABLE = {
    "photoreal": ("AgX", "sky", "keep", False, "Medium High Contrast"),
    "cgi": ("Standard", "studio", "keep", False, "None"),
    "clay": ("AgX", "studio", "clay", False, "None"),
    "cad": ("Standard", "flat", "flat", True, "None"),
    "sketch": ("Standard", "flat", "paper", True, "None"),
    "raw": ("Standard", "flat", "emission", False, "None"),
}


def apply_engine(bpy, samples: int, width: int, height: int, denoise: bool = True):
    """
    Cycles, always, on the CPU.

    `device = 'CPU'` is deliberate rather than defensive: this machine has no
    Cycles-capable GPU, and asking for one silently falls back after a delay
    while reporting a GPU render in the log.
    """
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"          # never EEVEE — see the module docstring
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    scene.cycles.use_adaptive_sampling = True
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False


def _world(bpy, kind: str):
    world = bpy.data.worlds.new("arcvia") if not bpy.data.worlds else bpy.data.worlds[0]
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputWorld")
    bg = nodes.new("ShaderNodeBackground")
    links.new(bg.outputs["Background"], out.inputs["Surface"])

    if kind == "sky":
        # A sky is not decoration. Windows are the brightest thing in an
        # interior photograph and the eye calibrates on them; against a black
        # void they come out DARKER than the walls and the whole image reads as
        # an object floating in space rather than a room inside a building.
        sky = nodes.new("ShaderNodeTexSky")
        sky.sun_elevation = 0.9
        sky.sun_rotation = 2.2
        links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 1.0
    elif kind == "studio":
        bg.inputs["Color"].default_value = (0.55, 0.57, 0.6, 1.0)
        bg.inputs["Strength"].default_value = 1.2
    else:  # flat
        bg.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bg.inputs["Strength"].default_value = 1.0


def _materials(bpy, kind: str):
    if kind == "keep":
        return

    if kind == "clay":
        clay = bpy.data.materials.new("arcvia_clay")
        clay.use_nodes = True
        bsdf = clay.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.82, 0.80, 0.77, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.85
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
        for obj in bpy.data.objects:
            if obj.type == "MESH":
                obj.data.materials.clear()
                obj.data.materials.append(clay)
        return

    if kind in ("flat", "paper", "emission"):
        base = (0.97, 0.97, 0.96, 1.0) if kind != "paper" else (0.94, 0.92, 0.87, 1.0)
        mat = bpy.data.materials.new(f"arcvia_{kind}")
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        nodes.clear()
        out = nodes.new("ShaderNodeOutputMaterial")
        # Emission, not a diffuse BSDF: these styles want the colour they were
        # given, not a colour that has been lit.
        em = nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = base
        em.inputs["Strength"].default_value = 1.0
        links.new(em.outputs["Emission"], out.inputs["Surface"])
        for obj in bpy.data.objects:
            if obj.type == "MESH":
                obj.data.materials.clear()
                obj.data.materials.append(mat)


def _freestyle(bpy, sketch: bool):
    scene = bpy.context.scene
    scene.render.use_freestyle = True
    view_layer = bpy.context.view_layer
    view_layer.use_freestyle = True

    settings = view_layer.freestyle_settings
    settings.as_render_pass = False
    if not settings.linesets:
        settings.linesets.new("arcvia")
    lineset = settings.linesets[0]

    # A lineset created by `linesets.new()` comes with a linestyle attached, but
    # the one the empty scene already carries does not — and because of the
    # guard above, that is the one we get. So `lineset.linestyle` is None
    # exactly when the branch is skipped, which is always, and the next line to
    # touch `.color` dies.
    if lineset.linestyle is None:
        lineset.linestyle = bpy.data.linestyles.new("arcvia")
    lineset.select_silhouette = True
    lineset.select_border = True
    lineset.select_crease = True

    # Blender 5 moved the crease angle from the lineset to the view layer's
    # freestyle settings, so `lineset.crease_angle = 1.4` raises AttributeError
    # and takes the whole render with it — the `cad` and `sketch` styles could
    # not draw a frame at all.
    #
    # Set on `settings`, not dropped: the default is 2.346 rad (134 degrees) and
    # we want 1.4 (80 degrees). That is the difference between creasing only at
    # sharp folds and creasing at every ordinary wall corner, which is most of
    # what makes the output read as a drawing rather than a silhouette.
    settings.crease_angle = 1.4

    style = lineset.linestyle
    style.color = (0.10, 0.11, 0.14)
    style.thickness = 1.4 if not sketch else 2.0

    if sketch:
        # The jitter is what separates a sketch from a CAD drawing. Both are the
        # same geometry traced the same way; only the line quality differs.
        mod = style.geometry_modifiers.new("jitter", "PERLIN_NOISE_2D")
        mod.amplitude = 2.5
        mod.frequency = 0.28
        thick = style.thickness_modifiers.new("vary", "NOISE")
        thick.amplitude = 1.0
        thick.period = 12


def apply_style(bpy, style_id: str):
    """Configure the scene for one style. Returns what it actually applied."""
    transform, world, materials, freestyle, look = STYLE_TABLE.get(
        style_id, STYLE_TABLE["photoreal"]
    )

    scene = bpy.context.scene
    scene.view_settings.view_transform = transform
    try:
        scene.view_settings.look = look
    except (TypeError, AttributeError):
        scene.view_settings.look = "None"

    _world(bpy, world)
    _materials(bpy, materials)

    scene.render.use_freestyle = False
    bpy.context.view_layer.use_freestyle = False
    if freestyle:
        _freestyle(bpy, sketch=style_id == "sketch")

    return {
        "style": style_id, "viewTransform": transform, "world": world,
        "materials": materials, "freestyle": freestyle,
    }


def add_sun(bpy, strength: float = 3.0):
    """
    A key sun and a fill, for the styles that are lit rather than emissive.

    ── Why a single sun is not enough here ─────────────────────────────────
    A reconstructed building is an open-topped cutaway: it has walls and floors
    and no roof. That sounds like it would be easy to light and is the opposite.
    Deep pockets — a stair core, a corridor between two thick walls, a lightwell
    — have no path to either the sun or the sky, so they render pure black while
    everything around them is correctly exposed.

    Measured on the villa: the same black pockets appeared under AgX and under
    Standard, and vanished entirely under flat emission. So they are not a tone
    map crushing shadows and not a normals problem; they are volumes with no
    light in them.

    A second, weaker sun from the opposite side reaches most of them. It is not
    physically motivated — it is the massing-render convention, and the honest
    description is that this is a diagram of a building rather than a photograph
    of one. The `raw` style stays available as the diagnostic that removes
    lighting from the question altogether.
    """
    scene = bpy.context.scene

    key = bpy.data.lights.new("arcvia_sun", type="SUN")
    key.energy = strength
    key.angle = 0.06
    key_obj = bpy.data.objects.new("arcvia_sun", key)
    scene.collection.objects.link(key_obj)
    key_obj.rotation_euler = (0.9, 0.0, 2.2)

    fill = bpy.data.lights.new("arcvia_fill", type="SUN")
    fill.energy = strength * 0.45
    # A wide angular diameter makes the fill soft, so it reads as bounce rather
    # than as a second sun casting a second set of shadows.
    fill.angle = 0.6
    fill_obj = bpy.data.objects.new("arcvia_fill", fill)
    scene.collection.objects.link(fill_obj)

    # Near-vertical, not opposite-azimuth.
    #
    # ── Why the first fill did not fix the black pockets ────────────────────
    # It was placed on the far side at 40 degrees from vertical, which is the
    # right instinct for a subject you are lighting from outside and the wrong
    # one for a cutaway. The pockets that go black are wells: a stair core, a
    # lightwell, the slot between two thick walls. A well is open at the *top*
    # and closed on every side, so the only sky it can see is near the zenith.
    # A sun at 40 or 52 degrees lands on the far wall and never reaches the
    # floor, which is why adding one barely moved the problem.
    #
    # Eight degrees off vertical reaches straight down into anything with an
    # open top while still raking enough to keep the walls from flattening out.
    # Measured against the villa's stair core, which had no light path at all
    # from either of the previous two.
    fill_obj.rotation_euler = (0.15, 0.0, 2.2 + 3.14159)

    return key_obj


# ---------------------------------------------------------------------------
# Surface-class materials — the bridge between what the geometry IS and how it
# looks. Added 2026-08-26.
# ---------------------------------------------------------------------------
#
# ── The channel, verified rather than assumed ──────────────────────────────
# `build/glb.py` tags every mesh it can with `extras.surfaceClass` and gives
# every vertex a UV in METRES. Blender's glTF importer carries both through:
# measured on the villa, `surfaceClass` arrives as a custom property on
# `obj.data` (the mesh, not the object) and the coordinates arrive as a
# `UVMap` layer. This module reads exactly those two things, so nothing here
# depends on mesh-name conventions.
#
# ── Why the UVs being in metres is what makes this simple ──────────────────
# A material knows its own real tile size — a 0.6 m floor tile, a 0.23 m
# brick course. With UVs in metres the tiling is one division: scale the UV by
# 1 / tile_metres and the texture lands at its true physical size, on any
# building, at any scale, with no per-model tuning. Had the mesh baked a tile
# COUNT instead, that size would be unrecoverable here.

def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _hex_to_linear(value: str) -> tuple:
    raw = str(value).lstrip("#")
    if len(raw) != 6:
        return (0.8, 0.8, 0.8, 1.0)
    rgb = [int(raw[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (*[_srgb_to_linear(c) for c in rgb], 1.0)


def load_material_bridge(path, tier: str = "standard"):
    """
    Read a material bridge and flatten it to {surface_class: material entry}.

    Consumes the bridge's own file rather than a bespoke format, so the
    library stays the single source of truth for what a surface is made of.

    ── Classes name a TIER, not always a single material ────────────────────
    Walls and roofs carry a `default`; floors carry `economy` / `standard` /
    `premium`, because the floor is where an Indian project's budget actually
    shows — IPS, vitrified 600, vitrified 800. Reading only `default` dropped
    all SIXTEEN floor classes, which is the largest surface area in any
    interior view, and the render came back with dressed walls standing on
    undressed floors.

    `standard` is the default tier on purpose: `premium` would make every
    unnamed room the most expensive floor in the catalogue, which is the same
    unearned-authority failure the ASSUME provenance exists to expose.

    A class whose material is missing from `materials` is dropped rather than
    substituted — a wrong material that renders is worse than an untouched
    surface a reviewer can see is untouched.
    """
    import json
    from pathlib import Path

    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    materials = doc.get("materials", {})
    library = doc.get("asset_library") or {}
    order = [tier, "standard", "economy", "premium"]
    out = {}
    for klass, spec in (doc.get("surface_classes") or {}).items():
        if not isinstance(spec, dict):
            entry = materials.get(spec)
            if entry:
                out[klass] = {"name": spec, **entry}
            continue
        name = spec.get("default")
        if name is None:
            for key in order:
                if spec.get(key):
                    name = spec[key]
                    break
        # `SAME_AS_FLOOR` is the library saying "reuse the floor's material",
        # which is an instruction to the caller and not a material name.
        if not name or str(name).isupper():
            continue
        entry = materials.get(name)
        if entry:
            out[klass] = {"name": name, "texture": _resolve_maps(entry, library),
                          **entry}
    return out


def _resolve_maps(entry: dict, library: dict) -> dict:
    """
    Absolute paths to the map files this material actually has on disk.

    ── Why resolution happens HERE and not in Blender ───────────────────────
    The library names its assets as `<source>:<slug>` and the file naming
    differs per source — ambientCG writes `_2K-JPG_Color.jpg`, Poly Haven
    writes `_diff_2k.jpg` — so a renderer that guessed would silently find
    nothing and fall back to flat colour, which looks like a lighting problem
    rather than a missing file. The rule is data in the bridge
    (`asset_library.map_suffixes`), so it is read, not assumed, and a map that
    is NOT on disk simply does not appear in the result.
    """
    from pathlib import Path

    root = Path(str(library.get("root") or "A:/Assets/Hub"))
    rel = entry.get("path")
    asset = entry.get("asset") or ""
    if not rel or ":" not in asset:
        return {}
    source = asset.split(":", 1)[0]
    suffixes = (library.get("map_suffixes") or {}).get(source) or {}
    folder = root / rel
    if not folder.is_dir():
        return {}
    slug = Path(rel).name
    found = {}
    for role in ("base_color", "roughness", "normal_gl"):
        pattern = suffixes.get(role)
        if not pattern:
            continue
        for res in ("2K", "2k", "1K", "1k", "4K", "4k"):
            candidate = folder / (slug + pattern.replace("{RES}", res))
            if candidate.is_file():
                found[role] = str(candidate)
                break
    return found


def apply_surface_materials(bpy, bridge: dict, aliases: dict | None = None) -> dict:
    """
    Give every tagged mesh the material its surface class calls for.

    Returns a report of what was dressed and what was left alone, because
    "which surfaces did not get a material" is the question a reviewer asks
    first and the one a render cannot answer by looking.
    """
    aliases = {"wallface_reveal": "internal_wall", **(aliases or {})}
    cache: dict[str, object] = {}
    applied: dict[str, int] = {}
    untouched: list[str] = []

    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data is None:
            continue
        klass = obj.data.get("surfaceClass")
        if not klass:
            untouched.append(obj.name)
            continue
        klass = aliases.get(klass, klass)
        entry = bridge.get(klass)
        if not entry:
            untouched.append(obj.name)
            continue

        if klass not in cache:
            cache[klass] = _build_material(bpy, klass, entry)
        obj.data.materials.clear()
        obj.data.materials.append(cache[klass])
        applied[klass] = applied.get(klass, 0) + 1

    return {"applied": applied, "untouched": untouched,
            "classes": sorted(applied)}


#: Longest edge, in pixels, that a surface texture is loaded at.
#:
#: ── Why there is a budget at all ───────────────────────────────────────────
#: Measured 2026-08-29, and it is not a tuning preference — it is the
#: difference between a dressed render and no render. A bridge resolving 13
#: surface classes over 74 meshes loads roughly two maps per class at the
#: 2K the hub stores. Blender holds a decoded 2048x2048 map at 16 MB as
#: bytes and 64 MB as float, so 26 maps is 0.4-1.6 GB of texture alone —
#: against 0.9 GB available on this machine. The first dressed render of
#: the villa died in three seconds with "Error: Out of memory" AFTER
#: reporting every class resolved correctly, which is the worst possible
#: place to fail: the material work all succeeded and the picture never
#: arrived.
#:
#: 1024 rather than 512, unlike `condition_asset.py`'s prop budget. A prop
#: is seen once across a room; an architectural surface TILES — the bridge
#: repeats a plaster sheet every 2 m of wall — so the same pixels are
#: stretched across every wall in shot and grain that survives at 512 on a
#: chair reads as mush on twenty square metres of plaster. Quartering the
#: area is enough: 26 maps come down to roughly 100-400 MB.
#:
#: Override with ARCVIA_MAX_TEXTURE when a hero still justifies the memory.
MAX_TEXTURE = int(os.environ.get("ARCVIA_MAX_TEXTURE", "1024"))


def _load_texture(bpy, path: str, role: str):
    """
    Load one surface map, stamped with its role and capped to `MAX_TEXTURE`.

    The role is stamped HERE rather than at the call site so that every image
    entering the scene carries one; `audit_materials` reads the role and never
    the filename, because `white_rough_plaster_diff_2K.jpg` is a diffuse map
    containing the word "rough".

    Downscaling is in-place and one-way, so the guard matters: `load` is called
    with `check_existing=True` and returns the SAME datablock for a map two
    materials share. Without the stamp a shared map would be halved once per
    material that uses it, and a texture quietly at 256 looks like a bad asset
    rather than like this function.
    """
    image = bpy.data.images.load(path, check_existing=True)
    image["arcvia_role"] = role

    if not image.get("arcvia_scaled") and MAX_TEXTURE > 0:
        width, height = image.size
        longest = max(width, height)
        if longest > MAX_TEXTURE:
            factor = MAX_TEXTURE / longest
            image.scale(max(1, int(width * factor)), max(1, int(height * factor)))
            image["arcvia_scaled"] = True
            print(f"ARCVIA_TEXTURE_SCALED:{role} {width}x{height} -> "
                  f"{image.size[0]}x{image.size[1]}", flush=True)

    return image


def _build_material(bpy, klass: str, entry: dict):
    """One Principled BSDF from a bridge entry, tiled at its real size."""
    mat = bpy.data.materials.new(f"arcvia_{klass}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat

    colour = entry.get("base_color_linear")
    if isinstance(colour, (list, tuple)) and len(colour) >= 3:
        bsdf.inputs["Base Color"].default_value = (*colour[:3], 1.0)
    elif entry.get("base_color_srgb"):
        # The bridge's own note: never pass an sRGB hex into a linear socket.
        bsdf.inputs["Base Color"].default_value = _hex_to_linear(
            entry["base_color_srgb"]
        )

    if entry.get("roughness") is not None:
        bsdf.inputs["Roughness"].default_value = float(entry["roughness"])
    if entry.get("metallic") is not None and "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = float(entry["metallic"])

    # Glass and water are transmissive; a solid pane reads as a grey slab.
    if "Transmission Weight" in bsdf.inputs and (
        "glass" in klass or "glaz" in klass or entry.get("name", "").startswith("glass")
    ):
        bsdf.inputs["Transmission Weight"].default_value = 1.0

    maps = entry.get("texture") or {}
    tile = entry.get("tile_metres")
    if maps.get("base_color"):
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        coord = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        # UVs are in METRES, so one division puts the texture at its real
        # size: a 2 m plaster sheet repeats every 2 m of wall, on any
        # building, with no per-model tuning. This is the whole reason the
        # mesh emits metres rather than a tile count.
        scale = 1.0 / float(tile) if tile else 1.0
        mapping.inputs["Scale"].default_value = (scale, scale, scale)
        links.new(coord.outputs["UV"], mapping.inputs["Vector"])

        image = nodes.new("ShaderNodeTexImage")
        # The role is recorded ON the image, because the FILENAME cannot
        # carry it: `white_rough_plaster_diff_2K.jpg` is a diffuse map
        # whose name contains "rough". Auditing on the name flagged it as
        # a mis-loaded data map — the substring-matcher trap, inside the
        # very check written to catch traps.
        image.image = _load_texture(bpy, maps["base_color"], "base_color")
        links.new(mapping.outputs["Vector"], image.inputs["Vector"])
        links.new(image.outputs["Color"], bsdf.inputs["Base Color"])

        if maps.get("roughness"):
            rough = nodes.new("ShaderNodeTexImage")
            rough.image = _load_texture(bpy, maps["roughness"], "roughness")
            # A roughness map is DATA, not a colour: reading it through the
            # sRGB transform lightens it and every surface comes out glossier
            # than the material says.
            rough.image.colorspace_settings.name = "Non-Color"
            links.new(mapping.outputs["Vector"], rough.inputs["Vector"])
            links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
        mat["arcvia_textured"] = True

    if tile:
        # Recorded on the material, not consumed here: with UVs already in
        # metres, a texture node would divide by this. Kept so a later pass
        # that adds image maps has the number without re-reading the bridge.
        mat["tile_metres"] = float(tile)
    mat["arcvia_surface_class"] = klass
    mat["arcvia_material"] = entry.get("name", "")
    return mat


def audit_materials(bpy) -> dict:
    """
    Check the traps the material corpus documents, in code rather than prose.

    ── Why this function exists at all ──────────────────────────────────────
    The material library's own notes ALREADY said a roughness map must load
    Non-Color, with the symptom spelled out — every surface too shiny, "fixed"
    by raising roughness, which then breaks under different lighting. The rule
    was written before this hook existed, and the hook still shipped the bug
    and had to rediscover it from a render.

    That is not a failure of the rule; it is a failure of where the rule
    lived. A trap documented in prose defends nobody who writes the code
    first and reads the prose afterwards — which is the normal order. So the
    ones that can be MACHINE-CHECKED are checked here, and the render reports
    them, because a check that runs is worth more than a paragraph that is
    correct.

    Returns findings; empty means nothing detectable is wrong.
    """
    findings: list[str] = []

    #: Map roles that are DATA, not colour. Read through the sRGB transform
    #: they come out wrong in a way that looks like a lighting problem rather
    #: than a colour-space problem.
    data_roles = {"roughness", "metallic", "normal_gl", "normal_dx",
                  "displacement", "arm_packed"}

    for image in bpy.data.images:
        # The ROLE, never the filename. `white_rough_plaster_diff_2K.jpg` is a
        # diffuse map containing the word "rough", and matching on the name
        # flagged it as a mis-loaded data map — this audit's own instance of
        # the species it exists to catch. Roles are stamped at load time.
        role = image.get("arcvia_role")
        if role is None or role not in data_roles:
            continue
        try:
            space = image.colorspace_settings.name
        except Exception:  # noqa: BLE001
            continue
        if space != "Non-Color":
            findings.append(
                f"{image.name}: a data map is loaded as {space!r}, not "
                "'Non-Color' — every surface using it renders too shiny"
            )

    for mat in bpy.data.materials:
        if not mat.get("arcvia_surface_class"):
            continue
        tile = mat.get("tile_metres")
        textured = mat.get("arcvia_textured")
        if textured and not tile:
            findings.append(
                f"{mat.name}: textured but carries no tile_metres, so its "
                "texture is tiling at one repeat per METRE by accident"
            )
        if textured and tile:
            mapping = [n for n in mat.node_tree.nodes if n.type == "MAPPING"]
            if not mapping:
                findings.append(
                    f"{mat.name}: textured with tile_metres={tile} but no "
                    "Mapping node — the physical size is being ignored"
                )

    return {"ok": not findings, "findings": findings}
