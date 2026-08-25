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
import struct
from pathlib import Path

#: glTF component types
_FLOAT = 5126
_UINT = 5125


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

        self.add_quad(v(*c0, hi), v(*c1, hi), v(*c2, hi), v(*c3, hi))   # top
        self.add_quad(v(*c3, lo), v(*c2, lo), v(*c1, lo), v(*c0, lo))   # bottom
        self.add_quad(v(*c0, lo), v(*c1, lo), v(*c1, hi), v(*c0, hi))   # side
        self.add_quad(v(*c1, lo), v(*c2, lo), v(*c2, hi), v(*c1, hi))   # end
        self.add_quad(v(*c2, lo), v(*c3, lo), v(*c3, hi), v(*c2, hi))   # side
        self.add_quad(v(*c3, lo), v(*c0, lo), v(*c0, hi), v(*c3, hi))   # end

    def add_polygon_slab(
        self, loop: list[tuple[float, float]], z: float, thickness: float
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
        poly = Polygon(loop)
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
        self, loop: list[tuple[float, float]], z: float, up: bool = True
    ) -> None:
        """One triangulated polygon face, with an explicit facing direction."""
        from shapely.geometry import Polygon
        from shapely.ops import triangulate

        if len(loop) < 3:
            return
        poly = Polygon(loop)
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


def _material_for(name: str) -> int:
    lowered = name.lower()
    for token, index in _MATERIAL_BY_NAME:
        # Mesh KIND is an underscore-delimited token. A substring check paints
        # an indoor `floor_room4_water-closet` as pool water merely because
        # its architectural label contains the word.
        if f"_{token}_" in f"_{lowered}_":
            return index
    return 0


def write_glb(meshes: dict[str, MeshBuilder], out_path: str | Path) -> dict:
    """
    Write one GLB containing a named node + mesh per entry.

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
        idx_bytes = b"".join(struct.pack("<I", i) for i in mesh.indices)

        xs = [p[0] for p in mesh.positions]
        ys = [p[1] for p in mesh.positions]
        zs = [p[2] for p in mesh.positions]

        pos_view = add_view(pos_bytes, 34962)
        nrm_view = add_view(nrm_bytes, 34962)
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
            "bufferView": idx_view, "componentType": _UINT,
            "count": len(mesh.indices), "type": "SCALAR",
        })

        base = len(accessors) - 3
        gltf_meshes.append({
            "name": name,
            "primitives": [{
                "attributes": {"POSITION": base, "NORMAL": base + 1},
                "indices": base + 2,
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
