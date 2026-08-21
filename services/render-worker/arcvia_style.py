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
