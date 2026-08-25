"""
Turning the semantic model into meshes.

── Openings are cut arithmetically, never with a boolean ─────────────────────
The obvious way to put a hole in a wall is a boolean difference against a box.
It is also the way that fails: an opening cut into a wall face produces coplanar
faces, which is precisely the case boolean modifiers handle worst — they leave
z-fighting slivers, non-manifold edges, or silently do nothing.

A wall with openings is instead *split*. Between the openings there are solid
pieces at full height; above each opening there is a lintel; below a window
there is an apron. Every piece is an ordinary box with exact coordinates, so the
result cannot fail and cannot produce a degenerate face. It is also faster and
trivially testable, because the piece count is arithmetic: n openings in a wall
give n+1 solid pieces, n lintels, and one apron per opening with a sill.

── The pieces are named ──────────────────────────────────────────────────────
Every piece carries an id so a later stage can point at it — a residual that
says "this lintel is 40 mm too low" needs something to reference, and a
Cryptomatte mask needs something to key on.
"""

from __future__ import annotations

import math
import re
import unicodedata

from .glb import MeshBuilder

#: Slab thickness. Thin enough not to eat headroom, thick enough to read as a
#: floor rather than a plane when the camera is near it.
SLAB_THICKNESS = 0.12

#: Room finish surfaces are deliberately separate from structural masonry.
#: One millimetre keeps the paint face in front of the wall without changing a
#: room dimension anyone can measure.
FINISH_PROUD = 0.001

#: Walls the engine derived rather than read. Kept as a name because two
#: separate modules test for it and a typo in either fails silently.
DERIVED_PERIMETER = "<derived:perimeter>"

#: How much thinner and shorter to build a derived perimeter segment than its
#: recorded size.
#:
#: ── Why a two-millimetre number is load-bearing ──────────────────────────────
#: 91% of the derived ring lies on top of a wall that was already drawn and is
#: already extruded, so the mesh contains pairs of boxes sharing a face plane.
#: Renders of the villa came back with large pure-black surfaces, and the
#: obvious readings were both wrong. It is not a missing roof — a missing roof
#: opens the interior to the sky, which is MORE light. It is not a sealed
#: lightless volume either: a box built strictly inside another box renders
#: nothing at all, measured, zero black pixels. Nor is it inverted normals; no
#: box in the villa has negative signed volume.
#:
#: It is z-fighting. The renderer needs faces that are COPLANAR to within half a
#: millimetre, co-oriented, and overlapping — and coincident boxes produce
#: exactly that. Measured on the villa isometric, black pixels at luminance <= 8:
#:
#:     as built                       18,174
#:     ring 1 mm thinner and shorter     911
#:     ring 20 mm thinner and shorter    854
#:     ring not built at all             930
#:
#: So breaking coplanarity beats deleting the ring, and keeps all 57 segments,
#: all 23 rooms and every square metre of envelope. Both axes are required:
#: thinner alone leaves 11,708 and shorter alone leaves 5,160, because a wall
#: box shares its top face with its neighbour as well as its sides.
#:
#: 2 mm rather than 20: it is four times the 0.5 mm coplanarity threshold, and
#: small enough that no quantity, clearance or camera solve can notice. Nothing
#: reads this back — the schedule prices `Wall.thickness`, which is untouched.
RING_INSET = 0.002


def build_walls(
    mesh: MeshBuilder,
    walls,
    openings,
    height: float,
    base_z: float = 0.0,
) -> dict:
    """
    Extrude walls, splitting each around the openings it hosts.

    Unpaired walls are skipped. A single unpaired line is usually a railing, and
    extruding one to ceiling height turns a balcony into a sealed box that
    blacks out the rooms behind it.
    """
    by_wall: dict[int, list] = {}
    for opening in openings:
        by_wall.setdefault(opening.wall, []).append(opening)

    pieces = 0
    solids = 0
    lintels = 0
    aprons = 0
    skipped = 0

    for index, wall in enumerate(walls):
        if not wall.paired:
            skipped += 1
            continue

        length = wall.length
        holes = sorted(by_wall.get(index, []), key=lambda o: o.along)

        # Cursor walks the wall, emitting a solid piece before each hole.
        cursor = 0.0
        for hole in holes:
            start = max(0.0, hole.along - hole.width / 2)
            end = min(length, hole.along + hole.width / 2)
            if end <= start:
                continue

            if start - cursor > 0.01:
                _segment(mesh, wall, cursor, start, base_z, height)
                pieces += 1
                solids += 1

            head = hole.sill + hole.height
            if height - head > 0.01:
                _segment(mesh, wall, start, end, base_z + head, height - head)
                pieces += 1
                lintels += 1

            if hole.sill > 0.01:
                _segment(mesh, wall, start, end, base_z, hole.sill)
                pieces += 1
                aprons += 1

            cursor = end

        if length - cursor > 0.01:
            _segment(mesh, wall, cursor, length, base_z, height)
            pieces += 1
            solids += 1

    return {
        "pieces": pieces,
        "solids": solids,
        "lintels": lintels,
        "aprons": aprons,
        "skippedUnpaired": skipped,
    }


def _segment(mesh: MeshBuilder, wall, start: float, end: float,
             base: float, height: float) -> None:
    """One box, from `start` to `end` along the wall, `base` to `base+height`."""
    dx, dy = wall.bx - wall.ax, wall.by - wall.ay
    length = (dx * dx + dy * dy) ** 0.5
    if length < 1e-9 or height <= 0:
        return
    dx, dy = dx / length, dy / length

    thickness = wall.thickness
    if wall.layer == DERIVED_PERIMETER:
        thickness -= RING_INSET
        height -= RING_INSET / 2
        if thickness <= 0 or height <= 0:
            return

    mesh.add_box_from_segment(
        wall.ax + dx * start, wall.ay + dy * start,
        wall.ax + dx * end, wall.ay + dy * end,
        thickness, height, base_z=base,
    )


#: Room kinds and name-words that mean a floor is open ground, not building
#: interior — so its slab is grass, not stone. Mirrors quantify/schedules.py's
#: OUTDOOR_WORDS; kept local so build/ does not depend on quantify/.
_OUTDOOR_WORDS = ("lawn", "garden", "patio", "deck", "terrace", "balcony",
                  "court", "pool", "barbeque", "barbecue", "driveway", "parking")
_WATER_WORDS = ("pool", "swimming", "pond", "fountain", "water feature")
_LAWN_WORDS = ("lawn", "garden", "planting", "landscape")
_PAVING_WORDS = ("patio", "deck", "terrace", "balcony", "court",
                 "barbeque", "barbecue", "driveway", "parking")


def _space_is_outdoor(space) -> bool:
    if str(getattr(space, "kind", "") or "").lower() == "outdoor":
        return True
    name = str(getattr(space, "name", "") or "").lower()
    return any(word in name for word in _OUTDOOR_WORDS)


def _space_surface_kind(space) -> str:
    """The honest ground material class for one room or site region."""
    name = str(getattr(space, "name", "") or "").lower()
    if any(word in name for word in _PAVING_WORDS):
        return "paving"
    if any(word in name for word in _WATER_WORDS):
        return "water"
    if any(word in name for word in _LAWN_WORDS):
        return "lawn"
    if _space_is_outdoor(space):
        # A deck, terrace, balcony, court or unnamed outdoor region is hard
        # ground. Calling every outdoor polygon lawn made the villa's decks
        # green and would turn a pool surround into turf.
        return "paving"
    return "floor"


def build_slabs(mesh: MeshBuilder, spaces, base_z: float = 0.0,
                lawn: "MeshBuilder | None" = None) -> dict:
    """
    A floor slab per room, at the finished face.

    An OUTDOOR room's slab — a lawn, a patio, a garden — goes into `lawn` when
    it is supplied, so the GLB can paint it green rather than the beige of a
    tiled interior floor. A beige lawn was half of what made the garden read as
    a warehouse. Indoor floors are unchanged.
    """
    built = 0
    lawned = 0
    for space in spaces:
        target = mesh
        if lawn is not None and _space_is_outdoor(space):
            target = lawn
            lawned += 1
        target.add_polygon_slab(space.loop, base_z - SLAB_THICKNESS, SLAB_THICKNESS)
        built += 1
    return {"slabs": built, "thickness": SLAB_THICKNESS, "lawn": lawned}


def _room_mesh_slug(space) -> str:
    """A stable, readable suffix for one room's GLB mesh name."""
    raw = str(getattr(space, "name", None) or getattr(space, "kind", None) or "room")
    ascii_name = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:48]
    return slug or "room"


def build_room_slabs(spaces, base_z: float = 0.0) -> tuple[dict[str, MeshBuilder], dict]:
    """
    Build one addressable floor mesh per room.

    `build_slabs` remains the aggregate primitive for callers that genuinely
    want one material bucket. The reconstruction GLB uses this split form: a
    bedroom carpet and a hall tile have to be different objects before any
    editor can stop either finish at the doorway.

    Names carry all three identities a downstream consumer needs:

      floor_room3_master-bedroom
      lawn_room7_garden

    The caller prefixes the storey. The numeric index is unambiguous even when
    a drawing contains three rooms all labelled BEDROOM; the slug lets the
    deck-design reader match a render caption without fetching building.json.
    Outdoor slabs remain `lawn_*`, `paving_*` or `water_*`, so dressing an
    interior floor cannot paint a garden as timber or a pool as carpet merely
    because all of them are horizontal polygons.
    """
    meshes: dict[str, MeshBuilder] = {}
    site_counts = {"lawn": 0, "paving": 0, "water": 0}

    for space in spaces:
        kind = _space_surface_kind(space)
        key = f"{kind}_room{space.index}_{_room_mesh_slug(space)}"
        target = MeshBuilder()
        target.add_polygon_slab(
            space.loop,
            base_z - SLAB_THICKNESS,
            SLAB_THICKNESS,
        )
        if target.indices:
            meshes[key] = target
        if kind in site_counts:
            site_counts[kind] += 1

    return meshes, {
        "slabs": len(meshes),
        "thickness": SLAB_THICKNESS,
        **site_counts,
        "roomMeshes": len(meshes),
    }


def _boundary_intervals(space, wall) -> list[tuple[float, float]]:
    """Runs of ``wall`` that actually bound ``space``, measured from wall.a."""
    length = wall.length
    if length < 1e-9:
        return []
    dx, dy = (wall.bx - wall.ax) / length, (wall.by - wall.ay) / length
    intervals: list[tuple[float, float]] = []
    loop = space.loop
    for a, b in zip(loop, loop[1:] + loop[:1]):
        ex, ey = b[0] - a[0], b[1] - a[1]
        edge_length = math.hypot(ex, ey)
        if edge_length < 1e-9:
            continue
        ex, ey = ex / edge_length, ey / edge_length
        if abs(ex * dx + ey * dy) < 0.995:
            continue
        # Room cycles and wall axes are nominally coincident. The tolerance is
        # the same corner-join tolerance used to attribute Space.bounded_by.
        da = abs((a[0] - wall.ax) * -dy + (a[1] - wall.ay) * dx)
        db = abs((b[0] - wall.ax) * -dy + (b[1] - wall.ay) * dx)
        if max(da, db) > 0.055:
            continue
        ta = (a[0] - wall.ax) * dx + (a[1] - wall.ay) * dy
        tb = (b[0] - wall.ax) * dx + (b[1] - wall.ay) * dy
        lo, hi = max(0.0, min(ta, tb)), min(length, max(ta, tb))
        if hi - lo > 0.01:
            intervals.append((lo, hi))

    if not intervals:
        return []
    intervals.sort()
    merged = [intervals[0]]
    for lo, hi in intervals[1:]:
        old_lo, old_hi = merged[-1]
        if lo <= old_hi + 0.01:
            merged[-1] = (old_lo, max(old_hi, hi))
        else:
            merged.append((lo, hi))
    return merged


def _finish_face(mesh: MeshBuilder, wall, start: float, end: float,
                 base: float, height: float, side: float) -> None:
    """One single-sided finish quad facing into its room."""
    if end - start < 0.01 or height <= 0:
        return
    length = wall.length
    dx, dy = (wall.bx - wall.ax) / length, (wall.by - wall.ay) / length
    # Left normal. `side` selects the side containing the room.
    nx, ny = -dy * side, dx * side
    offset = wall.thickness / 2 + FINISH_PROUD
    ax = wall.ax + dx * start + nx * offset
    ay = wall.ay + dy * start + ny * offset
    bx = wall.ax + dx * end + nx * offset
    by = wall.ay + dy * end + ny * offset

    def v(x, y, z):
        return (x, z, -y)

    lo, hi = base, base + height
    # add_quad(a,b,b',a') faces the RIGHT side of a->b after plan->glTF.
    # Reverse it when the room is on the left so every material is visible from
    # inside even though glTF materials remain correctly single-sided.
    if side > 0:
        mesh.add_quad(v(bx, by, lo), v(ax, ay, lo),
                      v(ax, ay, hi), v(bx, by, hi))
    else:
        mesh.add_quad(v(ax, ay, lo), v(bx, by, lo),
                      v(bx, by, hi), v(ax, ay, hi))


def build_room_finishes(spaces, walls, openings, height: float,
                        base_z: float = 0.0) -> tuple[dict[str, MeshBuilder], dict]:
    """Build opening-aware wall faces and a ceiling mesh for every indoor room.

    Structural walls remain one mesh. These are finish layers only: addressable
    by room, proud of the measured wall face, and cut around the exact openings
    already used by ``build_walls``. That lets a bedroom wear wallpaper without
    painting the hall side of its shared wall or covering its door.
    """
    from shapely.geometry import Polygon

    meshes: dict[str, MeshBuilder] = {}
    by_wall: dict[int, list] = {}
    for opening in openings:
        by_wall.setdefault(opening.wall, []).append(opening)

    wall_faces = 0
    ceilings = 0
    for space in spaces:
        if _space_is_outdoor(space):
            continue
        slug = f"room{space.index}_{_room_mesh_slug(space)}"
        wall_mesh = MeshBuilder()
        poly = Polygon(space.loop)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            continue
        centre = poly.representative_point()

        candidates = space.bounded_by or list(range(len(walls)))
        for wall_index in candidates:
            if wall_index < 0 or wall_index >= len(walls):
                continue
            wall = walls[wall_index]
            if not wall.paired or wall.length < 1e-9:
                continue
            dx = (wall.bx - wall.ax) / wall.length
            dy = (wall.by - wall.ay) / wall.length
            cross = dx * (centre.y - wall.ay) - dy * (centre.x - wall.ax)
            side = 1.0 if cross >= 0 else -1.0

            for interval_lo, interval_hi in _boundary_intervals(space, wall):
                holes = sorted(by_wall.get(wall_index, []), key=lambda o: o.along)
                cursor = interval_lo
                for hole in holes:
                    start = max(interval_lo, hole.along - hole.width / 2)
                    end = min(interval_hi, hole.along + hole.width / 2)
                    if end <= start:
                        continue
                    if start - cursor > 0.01:
                        _finish_face(wall_mesh, wall, cursor, start, base_z, height, side)
                        wall_faces += 1
                    head = hole.sill + hole.height
                    if height - head > 0.01:
                        _finish_face(wall_mesh, wall, start, end,
                                     base_z + head, height - head, side)
                        wall_faces += 1
                    if hole.sill > 0.01:
                        _finish_face(wall_mesh, wall, start, end,
                                     base_z, hole.sill, side)
                        wall_faces += 1
                    cursor = max(cursor, end)
                if interval_hi - cursor > 0.01:
                    _finish_face(wall_mesh, wall, cursor, interval_hi,
                                 base_z, height, side)
                    wall_faces += 1

        if wall_mesh.indices:
            meshes[f"wall_{slug}"] = wall_mesh

        ceiling = MeshBuilder()
        # Underside only: a first-person camera sees the ceiling, while the
        # existing roofless isometric/plan cameras see its culled back face and
        # can still inspect furniture. A solid slab here would hide the design.
        ceiling.add_polygon_face(space.loop, base_z + height, up=False)
        if ceiling.indices:
            meshes[f"ceiling_{slug}"] = ceiling
            ceilings += 1

    return meshes, {
        "finishWallMeshes": sum(1 for name in meshes if name.startswith("wall_")),
        "finishWallFaces": wall_faces,
        "ceilingMeshes": ceilings,
        "ceilingThickness": 0.0,
    }


#: Catalogue items that are greenery, not furniture. A box is the right
#: stand-in for a bed — it answers "does it fit" — and the wrong one for a
#: plant, which has no straight edges and which a client reads as a block of
#: stone the moment it is beige. These get foliage geometry and a green
#: material instead. `plant` is the one the reconstruction actually produces
#: today; the rest are here so a studio-authored tree or hedge lands correctly
#: through the same path.
_VEGETATION = {"plant", "tree", "tree-small", "shrub", "hedge", "planter-outdoor"}


def _build_planting(plants: MeshBuilder, trunks: MeshBuilder, item: str,
                    px: float, py: float, w: float, d: float, h: float,
                    base_z: float) -> None:
    """
    A stylised plant: a canopy of a few squashed spheres, on a trunk if it is
    tall enough to have one.

    Coarse on purpose — this is the reconstruction's dimensioned stand-in, the
    same role the box played, just shaped like a plant. The real GLB swap
    (Definition.meshUrl) still replaces it later without anything here changing.
    A tree gets a bare trunk and a layered crown; a low plant is a single
    rounded clump sitting on the ground, which is what a potted plant or a
    shrub actually looks like from across a room.
    """
    radius = max(w, d) / 2

    tall = h >= 2.0  # a tree, versus a shrub or a potted plant
    if tall:
        clear = h * 0.4                      # bare trunk up to the crown
        trunk_r = max(0.04, w * 0.05)
        # A trunk is a thin vertical box; add_box_from_segment needs a segment,
        # so give it a hair of length along x.
        trunks.add_box_from_segment(
            px - trunk_r, py, px + trunk_r, py,
            trunk_r * 2, clear, base_z=base_z,
        )
        crown_base = base_z + clear
        crown_h = h - clear
        cr = radius * 0.95
        for (dx, dz, cy, k) in (
            (0.0, 0.0, crown_base + crown_h * 0.35, 1.0),
            (cr * 0.4, cr * 0.2, crown_base + crown_h * 0.62, 0.72),
            (-cr * 0.35, -cr * 0.25, crown_base + crown_h * 0.55, 0.66),
        ):
            plants.add_sphere(px + dx, py + dz, cy, cr * k, squash=0.85)
    else:
        # A single clump. Sit its bottom on the ground and let it rise to h.
        r = min(radius, h / 2) if h > 0 else radius
        r = max(r, 0.12)
        plants.add_sphere(px, py, base_z + h - r, r, squash=0.9)


def build_fixtures(mesh: MeshBuilder, placements, dims: dict,
                   base_z: float = 0.0,
                   plants: "MeshBuilder | None" = None,
                   trunks: "MeshBuilder | None" = None) -> dict:
    """
    A box per identified fixture, at the catalogue's own dimensions — except
    greenery, which gets foliage geometry into `plants`/`trunks` when those are
    supplied.

    Boxes, not models — a correctly *dimensioned* stand-in is what makes
    clearances checkable, which is the job at this stage. `Definition.meshUrl`
    is the seam where a real GLB replaces one without anything else changing.
    Vegetation is the exception the seam did not cover: a beige box is a
    passable stand-in for a wardrobe and an embarrassing one for a garden, so
    a plant is drawn as a plant here rather than waiting for a GLB that the
    reconstruction path never applies.
    """
    import math

    built = 0
    skipped = 0
    planted = 0

    for placement in placements:
        item = placement.get("item")
        if placement.get("label") != "fixture" or not item:
            skipped += 1
            continue
        spec = dims.get(item)
        if not spec or spec["placement"] not in ("floor", "wall"):
            skipped += 1
            continue

        px = placement["position"]["x"]
        py = placement["position"]["y"]
        rot = placement.get("rotation", 0.0) or 0.0

        # The catalogue gives width across the front and depth away from the
        # wall; the box is drawn along its own local axes and then rotated.
        w, d, h = spec["w"], spec["d"], spec["h"]
        base = spec["mount"] or 0.0

        if item in _VEGETATION and plants is not None and trunks is not None:
            _build_planting(plants, trunks, item, px, py, w, d, h, base_z + base)
            planted += 1
            built += 1
            continue

        ax = px - math.cos(rot) * w / 2
        ay = py - math.sin(rot) * w / 2
        bx = px + math.cos(rot) * w / 2
        by = py + math.sin(rot) * w / 2

        mesh.add_box_from_segment(ax, ay, bx, by, d, h, base_z=base_z + base)
        built += 1

    return {"fixtures": built, "skipped": skipped, "planted": planted}
