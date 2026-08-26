"""
Writing a GLB, without Blender and without three.js.

── Why this is hand-rolled ──────────────────────────────────────────────────
The two obvious routes both cost more than they save at this stage. Spawning
Blender to export a few hundred boxes turns a two-second job into a thirty-second
one and drags in a headless-render dependency the extraction half does not
otherwise need. `GLTFExporter` in Node calls `new FileReader()` unconditionally
on its binary path, which Node 24 does not have, so that route needs a shim and
re-verification on every three.js bump.

glTF 2.0 is a small, stable, well-specified format, and boxes are the easy case.
Writing it directly means the extraction pipeline produces a loadable asset with
no external process at all — which is what makes the first milestone verifiable
in seconds rather than minutes.

── Geometry note ────────────────────────────────────────────────────────────
Each box is written with 24 vertices rather than 8, so every face carries its own
normal and reads as a flat surface. Sharing 8 corners averages the normals across
three perpendicular faces and makes a crisp wall look inflated.

Axes: the building model is +Z up (plan XY == world XY). glTF is +Y up. The flip
happens here, once, at the boundary — the same discipline the studio and the
Blender worker already follow. A render that comes back rotated 90 degrees is
always a second conversion site someone added.
"""

from __future__ import annotations

import json
import math
import re
import struct
from pathlib import Path

#: glTF component types
_FLOAT = 5126
_UINT = 5125


def _box_uv(point, normal) -> tuple[float, float]:
    """
    A texture coordinate for one vertex, in METRES of real building.

    ── Why UVs exist here at all ────────────────────────────────────────────
    Every mesh this writer produced carried POSITION and NORMAL and nothing
    else, so a reconstructed model had no texture coordinates — and a model
    with no UVs cannot take a textured material at all. Only the parametric
    half of a material library (glass, water, flat paint) could ever bind;
    brick, plaster, stone, timber and every tiled floor were unreachable, on
    every building the engine has ever produced.

    ── Why box projection, and why metres ───────────────────────────────────
    Architectural geometry is axis-aligned slabs and prisms, so the cheap,
    correct projection is per-face: drop the dominant axis of the face normal
    and use the other two world coordinates. Faces do not share vertices in
    this builder — `add_quad` and `add_tri` append their own — so each face
    projects independently and there are no seams to reconcile.

    The unit is the point. `u = 1.0` means ONE METRE of building, not one
    tile, so a material knows how to tile itself from its own physical size:
    a 0.6 m floor tile repeats every 0.6 of u. Vendor presets habitually ship
    `uvtiling 1.0` with no physical size at all, which is exactly the
    information a renderer cannot recover later — emitting metres here means
    the size always comes from the material, never from a guess baked into
    the mesh.

    Computed at WRITE time from the final positions and normals rather than
    stored per vertex, so `translate_plan` cannot leave UVs pointing at where
    the geometry used to be.
    """
    ax, ay, az = abs(normal[0]), abs(normal[1]), abs(normal[2])
    x, y, z = point
    if ay >= ax and ay >= az:
        return (x, z)          # floors and ceilings, seen from above

    # ── A wall is measured ALONG ITSELF, not along a world axis ─────────────
    # Dropping the dominant axis is right for a wall that runs north-south or
    # east-west and wrong for every other wall: at 45 degrees the run L
    # projects onto x as L·cos45, so the texture is compressed to 70.7% and a
    # brick course comes out 41.4% too long. The engine's own fixtures are all
    # orthogonal, so nothing caught it.
    #
    # The wall's direction is recoverable from the face itself: for a vertical
    # face the horizontal run is perpendicular to the normal in the ground
    # plane. Measuring u along THAT is exact at every angle, and for an
    # axis-aligned wall it reduces to the old +/-x or +/-z. `v` stays world
    # height, so courses remain horizontal by construction rather than by
    # convention.
    length = math.hypot(nz := normal[2], nx := normal[0]) or 1.0
    ux, uz = -nz / length, nx / length
    return (x * ux + z * uz, y)


class MeshBuilder:
    """Accumulates triangles into one interleaved-free, indexed mesh."""

    def __init__(self) -> None:
        self.positions: list[tuple[float, float, float]] = []
        self.normals: list[tuple[float, float, float]] = []
        self.indices: list[int] = []

    def translate_plan(self, dx: float, dy: float) -> None:
        """
        Shift this whole mesh by a distance measured in PLAN coordinates.

        Named for the coordinate system on purpose. Plan (x, y) maps to glTF
        (x, -z) — see `add_box_from_segment` — so a plan shift of (dx, dy) is a
        glTF shift of (dx, 0, -dy), and the sign on the third component is the
        kind of thing that produces a building translated the wrong way with
        nothing to show for it. Getting the vertical axis wrong once tonight
        (glTF is Y-up; `positions[2]` is depth, not height) is why this is a
        method with a name rather than a loop at the call site.
        NORMALS ARE UNCHANGED: translation does not rotate anything.
        """
        if not dx and not dy:
            return
        self.positions = [(x + dx, y, z - dy) for x, y, z in self.positions]

    def merge(self, other: "MeshBuilder") -> None:
        """Absorb another mesh, re-basing its indices onto ours."""
        base = len(self.positions)
        self.positions.extend(other.positions)
        self.normals.extend(other.normals)
        self.indices.extend(i + base for i in other.indices)

    def add_quad(self, p0, p1, p2, p3) -> None:
        """One planar face, wound counter-clockwise seen from outside."""
        ux, uy, uz = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        vx, vy, vz = (p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2])
        nx, ny, nz = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normal = (nx / length, ny / length, nz / length)

        base = len(self.positions)
        for point in (p0, p1, p2, p3):
            self.positions.append(point)
            self.normals.append(normal)
        self.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])

    def add_tri(self, p0, p1, p2) -> None:
        """
        One triangle.

        Not `add_quad(p0, p1, p2, p0)`. That looks equivalent and is not: the
        normal is computed from (p1 - p0) x (p3 - p0), and with p3 == p0 the
        second vector is zero, so the normal is the zero vector. Blender shades
        a zero-normal face black, which is how every floor slab in the first
        render came out as a hole in the building.
        """
        ux, uy, uz = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        vx, vy, vz = (p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2])
        nx, ny, nz = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length < 1e-12:
            return                      # a degenerate triangle has no face
        normal = (nx / length, ny / length, nz / length)

        base = len(self.positions)
        for point in (p0, p1, p2):
            self.positions.append(point)
            self.normals.append(normal)
        self.indices.extend([base, base + 1, base + 2])

    def add_tri_facing(self, p0, p1, p2, up: bool = True) -> None:
        """
        A triangle whose normal is made to point up (or down), whatever the
        vertex order happened to be.

        glTF is Y-up, so "up" is a positive Y component. Swapping two vertices
        reverses the normal, which is cheaper and clearer than trying to
        pre-sort the winding of something a triangulator produced.
        """
        ux, uy, uz = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
        vx, vy, vz = (p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2])
        ny = uz * vx - ux * vz          # the Y component of u x v
        if (ny < 0) if up else (ny > 0):
            p1, p2 = p2, p1
        self.add_tri(p0, p1, p2)

    def add_sphere(
        self, px: float, py: float, cy: float, r: float,
        rings: int = 6, segments: int = 8, squash: float = 1.0,
    ) -> None:
        """
        A low-poly sphere centred at PLAN (px, py) and height cy.

        For foliage — a plant or a tree canopy — so it is deliberately coarse
        (6x8 ≈ 96 triangles). `squash` scales the vertical axis: a canopy reads
        better slightly flattened than as a perfect ball. Plan (x, y) maps to
        glTF (x, -y) with height on Y, the same convention the box uses, so a
        sphere and a box placed at the same plan point coincide.
        """
        def v(theta: float, phi: float):
            # theta: 0..pi (pole to pole), phi: 0..2pi (around)
            sx = r * math.sin(theta) * math.cos(phi)
            sy = r * math.cos(theta) * squash
            sz = r * math.sin(theta) * math.sin(phi)
            # centre at glTF (px, cy, -py); the sphere's own XZ is a plan offset
            return (px + sx, cy + sy, -py + sz)

        for i in range(rings):
            t0 = math.pi * i / rings
            t1 = math.pi * (i + 1) / rings
            for j in range(segments):
                p0 = 2 * math.pi * j / segments
                p1 = 2 * math.pi * (j + 1) / segments
                a, b, c, d = v(t0, p0), v(t0, p1), v(t1, p1), v(t1, p0)
                # The poles collapse to a point, so those rings are triangles;
                # the rest are quads. add_tri drops degenerate ones on its own.
                if i == 0:
                    self.add_tri(a, c, d)
                elif i == rings - 1:
                    self.add_tri(a, b, c)
                else:
                    self.add_quad(a, b, c, d)

    def add_box_from_segment(
        self, ax: float, ay: float, bx: float, by: float,
        thickness: float, height: float, base_z: float = 0.0,
        right_face: "MeshBuilder | None" = None,
        left_face: "MeshBuilder | None" = None,
        end_face: "MeshBuilder | None" = None,
    ) -> None:
        """
        A wall: a segment given width and height.

        Plan (x, y) maps to glTF (x, -y) so that a plan viewed from above keeps
        its handedness when the camera looks down -Y in a Y-up world.
        """
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length < 1e-9 or thickness <= 0 or height <= 0:
            return
        dx, dy = dx / length, dy / length
        # RIGHT-hand normal in plan space, not left.
        #
        # The footprint loop below runs a+n -> b+n -> b-n -> a-n. With a LEFT
        # normal that loop is clockwise seen from above, which puts every face
        # of the box inside-out: measured, the top normal came back (0,-1,0),
        # the bottom (0,1,0), and all four sides facing inward. Cycles hides it
        # by flipping backfacing diffuse, so the render looks almost right and
        # the mesh is wrong. Negating the normal reverses the loop and fixes all
        # six faces at once.
        nx, ny = dy * thickness / 2, -dx * thickness / 2

        def v(x: float, y: float, z: float):
            return (x, z, -y)   # plan XY + Z-up  ->  glTF X, Y-up, -Z

        lo, hi = base_z, base_z + height
        # Four footprint corners, counter-clockwise in plan.
        c0 = (ax + nx, ay + ny)
        c1 = (bx + nx, by + ny)
        c2 = (bx - nx, by - ny)
        c3 = (ax - nx, ay - ny)

        # The two long faces may belong to DIFFERENT surface classes — the
        # outside of an envelope wall is sand-faced plaster, its inside is
        # putty and emulsion — so a caller that knows which side is which can
        # route them to separate meshes. `right` is the +n face (the RIGHT-hand
        # normal of a->b, per the note above); `left` is -n. Both default to
        # this mesh, so a caller that does not classify gets exactly the box it
        # got before.
        right = right_face or self
        left = left_face or self
        # The END faces are the wall's cut ends. Beside an opening they are the
        # REVEAL — the strip of wall you see standing in a doorway — and their
        # finish follows the frame rather than either wall side, which is a
        # materials decision the geometry cannot make. At a joined corner the
        # same face is buried inside the joint, and at a free end it is simply
        # a wall end. All three are "not a wall side", so they route together
        # and a library decides; folding them into external or internal would
        # be the guess this split exists to avoid.
        ends = end_face or self

        self.add_quad(v(*c0, hi), v(*c1, hi), v(*c2, hi), v(*c3, hi))    # top
        self.add_quad(v(*c3, lo), v(*c2, lo), v(*c1, lo), v(*c0, lo))    # bottom
        right.add_quad(v(*c0, lo), v(*c1, lo), v(*c1, hi), v(*c0, hi))   # +n side
        ends.add_quad(v(*c1, lo), v(*c2, lo), v(*c2, hi), v(*c1, hi))    # end
        left.add_quad(v(*c2, lo), v(*c3, lo), v(*c3, hi), v(*c2, hi))    # -n side
        ends.add_quad(v(*c3, lo), v(*c0, lo), v(*c0, hi), v(*c3, hi))    # end

    def add_polygon_slab(
        self, loop: list[tuple[float, float]], z: float, thickness: float,
        holes=(),
    ) -> None:
        """
        A floor or ceiling slab from a room outline.

        Triangulated by Delaunay-then-filter: shapely triangulates the convex
        hull, and keeping only the triangles whose centroid lies inside the
        polygon recovers the concave shape. Rooms are L-shaped often enough that
        assuming convexity puts floor where a corridor should be.
        """
        from shapely.geometry import Polygon
        from shapely.ops import triangulate

        if len(loop) < 3:
            return
        poly = Polygon(loop, holes=holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon":
            return

        for tri in triangulate(poly):
            if not poly.contains(tri.centroid):
                continue
            (x0, y0), (x1, y1), (x2, y2) = list(tri.exterior.coords)[:3]

            def v(x, y, h):
                return (x, h, -y)

            top, bottom = z + thickness, z
            # Force the facing rather than assuming a winding. `triangulate`
            # makes no promise about vertex order, so a slab built on the
            # assumption comes out with half its triangles facing down — lit
            # from underneath, which renders as a black hole in the floor.
            self.add_tri_facing(v(x0, y0, top), v(x1, y1, top), v(x2, y2, top), up=True)
            self.add_tri_facing(v(x0, y0, bottom), v(x1, y1, bottom), v(x2, y2, bottom),
                                up=False)

    def add_polygon_face(
        self, loop: list[tuple[float, float]], z: float, up: bool = True,
        holes=(),
    ) -> None:
        """One triangulated polygon face, with an explicit facing direction."""
        from shapely.geometry import Polygon
        from shapely.ops import triangulate

        if len(loop) < 3:
            return
        poly = Polygon(loop, holes=holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon":
            return

        for tri in triangulate(poly):
            if not poly.contains(tri.centroid):
                continue
            (x0, y0), (x1, y1), (x2, y2) = list(tri.exterior.coords)[:3]
            self.add_tri_facing(
                (x0, z, -y0), (x1, z, -y1), (x2, z, -y2), up=up,
            )

    @property
    def triangles(self) -> int:
        return len(self.indices) // 3


def _pad(data: bytearray, to: int = 4, fill: int = 0) -> None:
    while len(data) % to:
        data.append(fill)


#: The GLB's material palette. Index 0 is the default beige poché every wall and
#: floor wears; the rest exist so a garden does not render the colour of stone.
#: Kept small and named because the writer picks by mesh name, not per triangle.
_MATERIALS = [
    {
        "name": "poche",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.82, 0.80, 0.77, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.9,
        },
    },
    {
        # Foliage. A muted, slightly desaturated green — a fully saturated leaf
        # green reads as plastic under the neutral studio light, and this is a
        # stand-in for a plant, not a botanical render.
        "name": "foliage",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.36, 0.52, 0.28, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.85,
        },
    },
    {
        "name": "bark",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.34, 0.26, 0.19, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.95,
        },
    },
    {
        # Lawn / planted ground. Greener and rougher than foliage so a lawn
        # slab and a bush do not read as the same surface.
        "name": "lawn",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.33, 0.46, 0.25, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 1.0,
        },
    },
    {
        "name": "water",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.12, 0.40, 0.52, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.18,
        },
    },
    {
        "name": "paving",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.57, 0.54, 0.49, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.92,
        },
    },
]

#: Which material a mesh gets, by an underscore-delimited kind in its name.
#: First match wins; anything else falls through to poché (0).
_MATERIAL_BY_NAME = (
    ("plants", 1),
    ("foliage", 1),
    ("trunks", 2),
    ("lawn", 3),
    ("water", 4),
    ("paving", 5),
)


#: The engine's own mesh kinds and room kinds, mapped onto the shared
#: SURFACE-CLASS vocabulary that a material library binds against
#: (`A:\Research\BIM\tools\material_bridge.json`, 39 classes).
#:
#: ── Why this is a tag and not a material ─────────────────────────────────
#: The writer must not choose a brick or a plaster. What it alone knows is
#: WHAT EACH SURFACE IS — this face is a ceiling, that one is a bathroom
#: floor — and a library keyed on that can then choose per project, per
#: budget, per region without the geometry being rebuilt. Emitting the class
#: rather than the material is what keeps a rendered finish a presentation
#: decision instead of a reconstruction one.
_FLOOR_CLASS_BY_ROOM_KIND = {
    "bathroom": "floor_bath",
    "bedroom": "floor_bedroom",
    "circulation": "floor_corridor",
    "dining": "floor_dining",
    "kitchen": "floor_kitchen",
    "living": "floor_living",
    "parking": "floor_parking",
    "pooja": "floor_pooja",
    "store": "floor_store",
    "study": "floor_living",
    "toilet": "floor_toilet",
    "utility": "floor_utility",
}

#: An OUTDOOR floor's class, by a word in the room's own name.
#:
#: ── Why paving cannot be one class ───────────────────────────────────────
#: `build/solidify.py` routes every outdoor room to a `paving_*` mesh —
#: balcony, terrace, patio, deck, courtyard and parking bay alike — because
#: for GEOMETRY they are all hard ground. For MATERIAL they are not: a
#: balcony gets a floor finish and a driveway gets pavers, and mapping the
#: whole mesh kind to `driveway` put tarmac on the most visible surface in a
#: villa walkthrough. The room's name is the only evidence available and it
#: is usually enough.
_OUTDOOR_CLASS_BY_WORD = (
    ("balcony", "floor_balcony"),
    ("verandah", "floor_verandah"),
    ("veranda", "floor_verandah"),
    ("sitout", "floor_verandah"),
    ("terrace", "floor_balcony"),
    ("deck", "floor_balcony"),
    ("court", "floor_courtyard"),
    ("patio", "floor_courtyard"),
    ("parking", "floor_parking"),
    ("garage", "floor_parking"),
    ("porch", "floor_parking"),
    ("drive", "driveway"),
)

#: Mesh-kind token -> surface class, for kinds that carry no room type.
_CLASS_BY_MESH_KIND = {
    "ceiling": "ceiling",
    "water": "water_body",
    "lawn": "lawn",
    "plants": "planting_bed",
    "foliage": "planting_bed",
    # The poché's long faces, split by which side a room lies on — see
    # build/solidify.py `side_classes`. Before that split there was one
    # `walls` mesh carrying both, and it could not be tagged at all.
    "wallface_external": "external_wall",
    "wallface_internal": "internal_wall",
    # Wall END faces. Beside an opening this is the reveal, whose finish
    # follows the FRAME rather than either wall side — a materials decision,
    # not a geometric one. Emitted as its own class so a library can dress it
    # distinctly, or alias it to `internal_wall` in one line if it does not
    # care. Folding it into external or internal here would be exactly the
    # guess the poché split exists to avoid.
    "wallface_reveal": "wallface_reveal",
    # The first 450 mm of an external wall: flamed granite or a harder
    # plaster, and doc 18 §5 records it as a strong Indian cue.
    "wallface_plinth": "plinth",
    "parapet": "parapet_coping",
}


def surface_class(name: str, room_kind: str | None = None) -> tuple[str | None, str]:
    """
    (surface class, provenance) for one mesh — or (None, "none") when the
    engine cannot honestly say.

    ── The refusals are the point ───────────────────────────────────────────
    `storey0_walls` carries only the tops and bottoms of wall pieces, buried
    under slabs; the visible faces were split out by `build/solidify.py`.
    Fixtures are furniture, not a building surface. Both get no tag.

    ── And so is the PROVENANCE ─────────────────────────────────────────────
    A class derived from evidence and a class filled in by a default are not
    the same claim, and a render cannot tell them apart by looking. An
    unnamed, unclassified room used to resolve silently to `floor_living` —
    which in the material library is vitrified 800, the most expensive floor
    in the catalogue — so a room the drawing never described was quietly
    rendered as the premium option. That is the same failure as an area
    figure quoted without its definition: a plausible value wearing the
    clothes of a known one.

    So every tag carries how it was reached:
      "measured" — the engine determined it (room kind, mesh kind, side split)
      "assumed"  — a default filled a gap the drawing did not answer
    and the writer emits both, so a material decision stays auditable.
    """
    tokens = f"_{name.lower()}_"
    # The room's own name, which is everything after `room<N>_`. Word tests
    # run against THIS and never against the whole mesh name — `storey0`
    # contains "store", so matching the full name typed every unnamed room on
    # the ground floor as a store cupboard. The material lookup below already
    # carries a scar from the same class of bug; this is the second.
    slug = ""
    match = re.search(r"_room\d+_(.*)$", tokens.strip("_"))
    if match:
        slug = match.group(1)

    # The roof is INFERRED, never drawn — see build/solidify.build_roof.
    # Its provenance is assumed by construction rather than by a gap in the
    # room classifier.
    if "_roof_" in tokens:
        return "roof", "assumed"
    if "_parapet_" in tokens:
        return "parapet_coping", "assumed"
    # The footprint is measured from named, registered stair rooms, but the
    # straight-flight direction and tread layout are inferred inside it.
    if "_stair_" in tokens:
        return "floor_stair", "assumed"
    for token, klass in _CLASS_BY_MESH_KIND.items():
        if f"_{token}_" in tokens:
            return klass, "measured"
    if "_wall_" in tokens:
        # A wall surface generated FOR a room faces into that room.
        return "internal_wall", "measured"
    if "_paving_" in tokens:
        for word, klass in _OUTDOOR_CLASS_BY_WORD:
            if word in slug:
                return klass, "measured"
        # An outdoor floor the drawing did not name. Hard ground is the safe
        # reading — it is what `_space_surface_kind` already decided — but it
        # is a default, and it says so.
        return "driveway", "assumed"
    if "_floor_" in tokens:
        kind = (room_kind or "").lower()
        klass = _FLOOR_CLASS_BY_ROOM_KIND.get(kind)
        if klass:
            return klass, "measured"
        # Also try the room's own name, which survives in the mesh slug even
        # when the classifier could not type it.
        for word, mapped in (("stair", "floor_stair"), ("lobby", "floor_lobby"),
                             ("foyer", "floor_lobby"), ("store", "floor_store"),
                             ("utility", "floor_utility"), ("pooja", "floor_pooja"),
                             ("puja", "floor_pooja"), ("wash", "floor_utility")):
            if word in slug:
                return mapped, "measured"
        return "floor_living", "assumed"
    return None, "none"


def _material_for(name: str) -> int:
    lowered = name.lower()
    for token, index in _MATERIAL_BY_NAME:
        # Mesh KIND is an underscore-delimited token. A substring check paints
        # an indoor `floor_room4_water-closet` as pool water merely because
        # its architectural label contains the word.
        if f"_{token}_" in f"_{lowered}_":
            return index
    return 0


def write_glb(meshes: dict[str, MeshBuilder], out_path: str | Path,
              room_kinds: dict[str, str] | None = None) -> dict:
    """
    Write one GLB containing a named node + mesh per entry.

    `room_kinds` maps a mesh name to the kind of room it belongs to, so a
    floor can be tagged `floor_bath` rather than a generic one. Optional: a
    caller that does not supply it still gets every other surface class, and
    floors fall back to the commonest.

    Returns a small manifest, so a caller can assert on what it produced without
    parsing the file back.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    buffer = bytearray()
    accessors: list[dict] = []
    buffer_views: list[dict] = []
    gltf_meshes: list[dict] = []
    nodes: list[dict] = []

    def add_view(payload: bytes, target: int) -> int:
        _pad(buffer)
        offset = len(buffer)
        buffer.extend(payload)
        buffer_views.append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(payload), "target": target}
        )
        return len(buffer_views) - 1

    for name, mesh in meshes.items():
        if not mesh.indices:
            continue

        pos_bytes = b"".join(struct.pack("<3f", *p) for p in mesh.positions)
        nrm_bytes = b"".join(struct.pack("<3f", *n) for n in mesh.normals)
        uv_bytes = b"".join(
            struct.pack("<2f", *_box_uv(p, n))
            for p, n in zip(mesh.positions, mesh.normals)
        )
        idx_bytes = b"".join(struct.pack("<I", i) for i in mesh.indices)

        xs = [p[0] for p in mesh.positions]
        ys = [p[1] for p in mesh.positions]
        zs = [p[2] for p in mesh.positions]

        pos_view = add_view(pos_bytes, 34962)
        nrm_view = add_view(nrm_bytes, 34962)
        uv_view = add_view(uv_bytes, 34962)
        idx_view = add_view(idx_bytes, 34963)

        accessors.append({
            "bufferView": pos_view, "componentType": _FLOAT, "count": len(mesh.positions),
            "type": "VEC3", "min": [min(xs), min(ys), min(zs)],
            "max": [max(xs), max(ys), max(zs)],
        })
        accessors.append({
            "bufferView": nrm_view, "componentType": _FLOAT,
            "count": len(mesh.normals), "type": "VEC3",
        })
        accessors.append({
            "bufferView": uv_view, "componentType": _FLOAT,
            "count": len(mesh.positions), "type": "VEC2",
        })
        accessors.append({
            "bufferView": idx_view, "componentType": _UINT,
            "count": len(mesh.indices), "type": "SCALAR",
        })

        base = len(accessors) - 4
        klass, provenance = surface_class(name, (room_kinds or {}).get(name))
        gltf_meshes.append({
            "name": name,
            # The surface class travels as glTF `extras`, which every loader
            # carries through untouched and no loader interprets — so a
            # renderer that knows the material library can bind, and one that
            # does not is unaffected. Absent when the engine cannot tell: see
            # `surface_class`, where the refusals are deliberate.
            #
            # `surfaceClassSource` rides alongside so a reviewer can separate
            # what was determined from what was defaulted. A render that puts
            # premium vitrified in a room the drawing never named should be
            # answerable for it.
            **({"extras": {"surfaceClass": klass,
                           "surfaceClassSource": provenance}} if klass else {}),
            "primitives": [{
                "attributes": {
                    "POSITION": base, "NORMAL": base + 1, "TEXCOORD_0": base + 2,
                },
                "indices": base + 3,
                # Material by mesh name: foliage and bark are their own colours,
                # everything else is the beige poché. Named meshes rather than
                # per-triangle materials keeps the writer simple and the seam
                # obvious — see cli.py, which puts vegetation in *_plants and
                # *_trunks meshes exactly so a garden does not render beige.
                "material": _material_for(name),
            }],
        })
        nodes.append({"name": name, "mesh": len(gltf_meshes) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "arcvia-reconstruct"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": gltf_meshes,
        "materials": _MATERIALS,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(buffer)}],
    }

    json_chunk = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
    _pad(json_chunk, 4, ord(" "))   # JSON pads with spaces, BIN pads with zeros
    bin_chunk = bytearray(buffer)
    _pad(bin_chunk, 4, 0)

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with out_path.open("wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, total))
        fh.write(struct.pack("<I4s", len(json_chunk), b"JSON"))
        fh.write(json_chunk)
        fh.write(struct.pack("<I4s", len(bin_chunk), b"BIN\x00"))
        fh.write(bin_chunk)

    return {
        "path": str(out_path),
        "bytes": total,
        "meshes": [m["name"] for m in gltf_meshes],
        "triangles": sum(m.triangles for m in meshes.values()),
        "vertices": sum(len(m.positions) for m in meshes.values()),
    }
