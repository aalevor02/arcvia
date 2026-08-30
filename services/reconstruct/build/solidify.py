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


def side_classes(walls, spaces) -> dict[int, tuple[bool, bool]]:
    """
    For each wall, whether its RIGHT and LEFT faces look into a room.

    ── Why the poché has to be split at all ─────────────────────────────────
    Every wall solid lands in one mesh, so the outside face of the envelope
    and the inside face of every room arrive on the same triangles. Those are
    different materials in every library — sand-faced plaster outside, putty
    and emulsion inside — so a renderer handed that mesh cannot dress the
    building correctly, and tagging the mesh either way would be a guess it
    could not tell was a guess.

    The test is the same one `quantify/areas.py` uses to decide whether a wall
    is an internal partition, applied per FACE instead of per wall: step half
    a thickness past the face at the wall's midpoint and ask whether that
    point lands inside a room. A face with a room in front of it is internal;
    a face with nothing is looking outdoors.

    Returns {wall_index: (right_faces_room, left_faces_room)} where RIGHT is
    the +n side of a->b, matching `MeshBuilder.add_box_from_segment`'s own
    right-hand normal convention. Walls absent from the map were not
    classified and should be left whole.
    """
    from shapely.geometry import Point, Polygon

    polys = []
    for space in spaces or ():
        loop = getattr(space, "loop", None) or []
        if len(loop) < 3:
            continue
        poly = Polygon([(float(p[0]), float(p[1])) for p in loop])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty:
            polys.append(poly)
    if not polys:
        return {}

    out: dict[int, tuple[bool, bool]] = {}
    for index, wall in enumerate(walls):
        dx, dy = wall.bx - wall.ax, wall.by - wall.ay
        length = math.hypot(dx, dy)
        if length < 1e-9 or wall.thickness <= 0:
            continue
        dx, dy = dx / length, dy / length
        nx, ny = dy, -dx                       # RIGHT-hand normal, as the box uses
        offset = getattr(wall, "offset", 0.0) or 0.0
        # Probe from the BODY's centre, not the axis: a composite wall's solid
        # is displaced by `offset` (see hypothesise/pair.py Wall.offset), and
        # probing from the axis would step out of the wrong face.
        cx = (wall.ax + wall.bx) / 2 - dy * offset
        cy = (wall.ay + wall.by) / 2 + dx * offset
        reach = wall.thickness / 2 + 0.05
        right = Point(cx + nx * reach, cy + ny * reach)
        left = Point(cx - nx * reach, cy - ny * reach)
        out[index] = (
            any(p.contains(right) for p in polys),
            any(p.contains(left) for p in polys),
        )
    return out


#: How far a plinth band rises above finished ground, metres.
#:
#: The band where an Indian building meets the ground is faced differently
#: from the wall above it — flamed granite or a harder plaster — and doc 18 §5
#: records it as a strong regional cue: get it wrong and a Kerala villa reads
#: as a generic box. 450-600 mm is the range; 0.45 is the low end, chosen
#: because a band that is too SHORT reads as a skirting and a band that is too
#: tall reads as a half-height wall, and only the second is obviously wrong.
PLINTH_HEIGHT = 0.45


#: A balcony guard's height above its slab, metres.
#:
#: The same number as PARAPET_HEIGHT below, and deliberately a separate name:
#: they are the same height for the same bye-law reason but they are different
#: things, and a later revision to one should not silently move the other.
#: apps/studio/src/plan/types.ts carries 1.0 for its `railing` wall type and
#: says "Agree with the engine" in as many words — these two builders can
#: produce the same building from the same drawing, and a parapet whose height
#: depends on which path drew it is a discrepancy a client notices and nobody
#: can explain. If you change this, change that.
RAILING_HEIGHT = 1.0

#: A railing's thickness when the drawing does not measure one. Matches
#: `hypothesise/pair.DEFAULT_THICKNESS`, which is what an unpaired line already
#: carries — this constant exists to say the choice was noticed, not to differ.
RAILING_THICKNESS = 0.115

#: How close an unpaired line must sit to a balcony's boundary to be that
#: balcony's guard, metres. Generous enough to survive the half-thickness
#: offset between a drawn line and the room polygon derived from it, tight
#: enough that a line crossing the middle of a balcony is not swept up.
RAILING_EDGE_TOLERANCE = 0.35

#: How close a PAIRED wall has to run to an unpaired line before that line is
#: considered already built. See `_railing_edges` — this is the guard against
#: coincident geometry, not a tuning knob.
RAILING_COVERED_TOLERANCE = 0.40


def _space_name(space) -> str:
    """A space's name, whether it arrives as an object or a dict."""
    name = getattr(space, "name", None)
    if name is None and isinstance(space, dict):
        name = space.get("name")
    return str(name or "").strip().lower()


def _space_loop(space):
    loop = getattr(space, "loop", None)
    if loop is None and isinstance(space, dict):
        loop = space.get("loop")
    return loop or []


def _railing_edges(walls, spaces) -> dict[int, float]:
    """
    Which unpaired lines are a balcony's guard, and how thick to build each.

    ── The gap this closes ──────────────────────────────────────────────────
    `build_walls` skips every unpaired wall, and that is right: extruding a
    single line to ceiling height turns a balcony into a sealed box and blacks
    out the rooms behind it. But "not a full-height wall" was implemented as
    "no geometry at all", so the CAD path builds balconies with nothing at the
    edge — a slab you could walk off, three metres up. The studio's importer
    already builds these at guard height off the adjudicator's verdict; this
    path never had a verdict to read, so it built nothing.

    ── Why the room NAME decides, and not the line ──────────────────────────
    Nothing local to an unpaired stroke separates a balcony guard from a wall
    the architect happened to draw with one line. Length, layer and thickness
    were all considered and all of them are shared with genuine single-line
    walls, which the villa's own exterior is largely made of. The engine's
    reliable signal for what a region IS has always been what the architect
    wrote inside it — the same reasoning that makes OCR room labels the only
    dependable bed-versus-wall signal in the raster detector.

    So this asks one question: does this line lie on the edge of a space the
    architect named a balcony, verandah, deck, sit-out or terrace? The
    vocabulary is imported from `quantify/areas.py` rather than restated,
    because that list is grounded in the RERA area definitions and a second
    copy would drift from it.

    A drawing with no such room gets no railings and is bit-identical to
    before. That is the point: this cannot regress a plan it does not
    recognise.

    ── The guard that matters most ──────────────────────────────────────────
    91% of the derived perimeter ring lies on top of linework the architect
    drew (see hypothesise/perimeter.py). Those covered lines are unpaired, and
    a balcony's outer edge is exactly where the ring runs. Building a railing
    there would put a 1.0 m box INSIDE the ring's full-height box — coincident
    faces, which is the z-fighting that the black-pockets investigation spent
    days on. Touching boxes are fine; coincident ones are not.

    So an unpaired line with a near-parallel paired wall running alongside it
    is treated as already built and skipped. It costs a few real railings on
    drawings where the ring happens to trace the balcony edge, and that is the
    right trade: a missing guard is visible and fixable, z-fighting reads as a
    rendering bug somewhere else entirely.

    Returns {wall_index: thickness}. Absent means "leave it skipped".
    """
    if not spaces:
        return {}

    try:
        from shapely.geometry import LineString, Polygon
        from shapely.strtree import STRtree
    except Exception:  # pragma: no cover - shapely is a hard dependency
        return {}

    from quantify.areas import BALCONY_WORDS, TERRACE_WORDS

    guarded_words = tuple(BALCONY_WORDS) + tuple(TERRACE_WORDS)

    rings = []
    for space in spaces:
        name = _space_name(space)
        if not any(word in name for word in guarded_words):
            continue
        loop = _space_loop(space)
        if len(loop) < 3:
            continue
        try:
            poly = Polygon([(float(p[0]), float(p[1])) for p in loop])
        except Exception:
            continue
        if poly.is_valid and poly.area > 0:
            rings.append(poly.exterior)

    if not rings:
        return {}

    # Paired walls are the "already built" set. The perimeter ring is among
    # them (it is emitted paired=True precisely so it gets extruded), which is
    # what makes this check catch the coincidence case.
    built = []
    built_index = []
    for index, wall in enumerate(walls):
        if not wall.paired or wall.length <= 1e-6:
            continue
        built.append(LineString([(wall.ax, wall.ay), (wall.bx, wall.by)]))
        built_index.append(index)
    built_tree = STRtree(built) if built else None

    edges: dict[int, float] = {}
    for index, wall in enumerate(walls):
        if wall.paired or wall.length < 0.30:
            continue
        line = LineString([(wall.ax, wall.ay), (wall.bx, wall.by)])

        # On a guarded room's boundary? Measure the whole line, not just its
        # midpoint: a line that clips a corner of the balcony is not its edge.
        on_edge = any(
            line.distance(ring) <= RAILING_EDGE_TOLERANCE
            and ring.buffer(RAILING_EDGE_TOLERANCE).intersection(line).length
            >= 0.60 * line.length
            for ring in rings
        )
        if not on_edge:
            continue

        # Already built by something full-height running alongside it?
        if built_tree is not None:
            covered = False
            for hit in built_tree.query(line.buffer(RAILING_COVERED_TOLERANCE)):
                other = built[int(hit)]
                if other.distance(line) > RAILING_COVERED_TOLERANCE:
                    continue
                # Near-parallel only. A wall meeting this one end-on at a
                # corner is not covering it, and excluding by distance alone
                # would drop every railing that touches a building.
                if _near_parallel(line, other) and (
                    other.buffer(RAILING_COVERED_TOLERANCE)
                    .intersection(line)
                    .length
                    >= 0.60 * line.length
                ):
                    covered = True
                    break
            if covered:
                continue

        thickness = wall.thickness if wall.thickness > 1e-6 else RAILING_THICKNESS
        edges[index] = thickness

    return edges


def _near_parallel(a, b, degrees: float = 12.0) -> bool:
    """Whether two 2-point LineStrings run within `degrees` of parallel."""
    (ax0, ay0), (ax1, ay1) = a.coords[0], a.coords[-1]
    (bx0, by0), (bx1, by1) = b.coords[0], b.coords[-1]
    ua = math.hypot(ax1 - ax0, ay1 - ay0)
    ub = math.hypot(bx1 - bx0, by1 - by0)
    if ua < 1e-9 or ub < 1e-9:
        return False
    dot = ((ax1 - ax0) * (bx1 - bx0) + (ay1 - ay0) * (by1 - by0)) / (ua * ub)
    # abs: faces are traced in arbitrary directions, same as in pair.py.
    return abs(dot) >= math.cos(math.radians(degrees))


def build_walls(
    mesh: MeshBuilder,
    walls,
    openings,
    height: float,
    base_z: float = 0.0,
    internal_mesh: MeshBuilder | None = None,
    external_mesh: MeshBuilder | None = None,
    reveal_mesh: MeshBuilder | None = None,
    plinth_mesh: MeshBuilder | None = None,
    spaces=None,
) -> dict:
    """
    Extrude walls, splitting each around the openings it hosts.

    Unpaired walls are skipped. A single unpaired line is usually a railing, and
    extruding one to ceiling height turns a balcony into a sealed box that
    blacks out the rooms behind it.

    When `spaces` and both face meshes are supplied, each wall's two long faces
    are routed by whether a room lies in front of them — see `side_classes`.
    Everything else (ends, tops, bottoms) stays in `mesh`, because an end cap
    is a reveal rather than a wall surface and belongs to neither class.
    """
    by_wall: dict[int, list] = {}
    for opening in openings:
        by_wall.setdefault(opening.wall, []).append(opening)

    pieces = 0
    solids = 0
    lintels = 0
    aprons = 0
    skipped = 0
    railings = 0

    sides = (side_classes(walls, spaces)
             if spaces is not None and internal_mesh is not None
             and external_mesh is not None else {})

    # An unpaired line on a named balcony's edge is that balcony's guard. It
    # is built here rather than left out, at guard height rather than at
    # ceiling height — the two wrong answers this sits between. See
    # `_railing_edges` for why the room's NAME is the signal and what stops it
    # doubling up on the perimeter ring.
    guards = _railing_edges(walls, spaces)

    for index, wall in enumerate(walls):
        if not wall.paired:
            if index in guards:
                mesh.add_box_from_segment(
                    wall.ax, wall.ay, wall.bx, wall.by,
                    guards[index], RAILING_HEIGHT, base_z=base_z,
                )
                railings += 1
                pieces += 1
                continue
            skipped += 1
            continue

        # Route each long face by what stands in front of it. Unclassified
        # walls pass None and land whole in `mesh`, exactly as before.
        right_face = left_face = None
        end_face = reveal_mesh
        if index in sides:
            right_room, left_room = sides[index]
            right_face = internal_mesh if right_room else external_mesh
            left_face = internal_mesh if left_room else external_mesh

        # ── The plinth band ────────────────────────────────────────────────
        # An external wall is faced differently for its first 450 mm. Slicing
        # is safe here for a measured reason: two boxes stacked at a butt
        # joint present OPPOSED faces, and this module's own black-pixel study
        # puts that at zero — it is COINCIDENT boxes that z-fight, not
        # touching ones.
        def emit(a, b, z, h, _wall=wall, _r=right_face, _l=left_face,
                 _e=end_face):
            band = PLINTH_HEIGHT
            wants = plinth_mesh is not None and external_mesh is not None and (
                _r is external_mesh or _l is external_mesh
            )
            if not wants or z > base_z + 1e-6 or h <= band + 1e-6:
                _segment(mesh, _wall, a, b, z, h, _r, _l, _e)
                return
            # Lower slice: only the OUTWARD faces become plinth. An internal
            # face has no plinth — the band is a facade feature.
            _segment(mesh, _wall, a, b, z, band,
                     plinth_mesh if _r is external_mesh else _r,
                     plinth_mesh if _l is external_mesh else _l,
                     _e)
            _segment(mesh, _wall, a, b, z + band, h - band, _r, _l, _e)

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
                emit(cursor, start, base_z, height)
                pieces += 1
                solids += 1

            head = hole.sill + hole.height
            if height - head > 0.01:
                emit(start, end, base_z + head, height - head)
                pieces += 1
                lintels += 1

            if hole.sill > 0.01:
                emit(start, end, base_z, hole.sill)
                pieces += 1
                aprons += 1

            cursor = end

        if length - cursor > 0.01:
            emit(cursor, length, base_z, height)
            pieces += 1
            solids += 1

    return {
        "pieces": pieces,
        "solids": solids,
        "lintels": lintels,
        "aprons": aprons,
        "skippedUnpaired": skipped,
        # Reported separately from `pieces` on purpose. A railing is the one
        # thing here built from a line the pairer could NOT confirm, so a
        # reader checking a model against its drawing needs to see how many
        # there are without digging: "3 railings" is checkable against the
        # plan, "482 pieces" is not.
        "railings": railings,
    }


def _segment(mesh: MeshBuilder, wall, start: float, end: float,
             base: float, height: float,
             right_face: MeshBuilder | None = None,
             left_face: MeshBuilder | None = None,
             end_face: MeshBuilder | None = None) -> None:
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

    # A composite wall's body sits `offset` metres to the left of its axis
    # (see Wall.offset). Applied here — where the axis becomes a solid — and
    # nowhere upstream, so the room graph never learns the body moved.
    offset = getattr(wall, "offset", 0.0) or 0.0
    ox, oy = -dy * offset, dx * offset

    mesh.add_box_from_segment(
        wall.ax + dx * start + ox, wall.ay + dy * start + oy,
        wall.ax + dx * end + ox, wall.ay + dy * end + oy,
        thickness, height, base_z=base,
        right_face=right_face, left_face=left_face, end_face=end_face,
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

        # ---- The drawing said one thing and the measurement built another ---
        #
        # No geometry when the footprint outvoted the architect's own block
        # label. The placement STAYS in `elements.fixtures` with its verdict,
        # alternatives and signals — that is what a reviewer needs to correct
        # it, and deleting it would be the silent drop this codebase keeps
        # getting bitten by. It simply does not become an object.
        #
        # Measured on DOWN VILLA: three placements of a block named "plant 1".
        # Two resolve to `plant`; one resolves to `bed-queen`, and a two-metre
        # bed was built in the middle of the plan.
        #
        # `needsReview` was tried here first and REVERTED, because it is the
        # wrong gate: all three carry margins in one band (0.03 and 0.06), so
        # filtering on it removed the phantom bed AND both correct plants — one
        # wrong object avoided at the cost of two right ones. `nameOverridden`
        # separates them exactly: the two right answers agree with the label,
        # the wrong one contradicts it.
        #
        # This is the module docstring's own rule, applied one stage later:
        # "An absent sofa is a gap someone notices; a wrong sofa is a gap
        # nobody does."
        if placement.get("nameOverridden"):
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


#: A parapet's height above the roof slab, metres. Doc 29 §3's ASSUME default.
#:
#: Indian flat roofs are used — laundry, water tanks, sleeping out — so a
#: parapet is near-universal and a roof without one reads as a slab someone
#: could walk off. 1.0 m is the common built height and it is also what the
#: bye-laws expect for a usable terrace.
PARAPET_HEIGHT = 1.0

#: How far the roof oversails the walls it covers, metres. A flat RCC roof is
#: poured past the wall face to throw water clear; without it the roof edge
#: sits exactly on the wall plane and z-fights it.
ROOF_OVERHANG = 0.05


STAIR_MAX_RISER = 0.18
STAIR_MIN_GOING = 0.25
STAIR_MAX_GOING = 0.30
STAIR_MIN_WIDTH = 0.80
STAIR_EDGE_CLEARANCE = 0.10
STAIR_FLIGHT_GAP = 0.10
STAIR_OVERLAP_MIN = 0.25
STAIR_RECTANGULARITY_MIN = 0.85
STAIR_RISER_LINE_MIN = 5
STAIR_RISER_SPACING = (0.20, 0.35)
STAIR_MARKER_CLEARANCE = 0.80
STAIR_LANDING_EDGE_RANGE = (0.70, 1.60)


def _marked_riser_runs(faces, shift=(0.0, 0.0)):
    """Repeated, evenly spaced parallel segments that can be tread/riser marks."""
    buckets = {}
    seen = set()
    projected = []
    for face in faces or ():
        ax = float(face.ax) + shift[0]
        ay = float(face.ay) + shift[1]
        bx = float(face.bx) + shift[0]
        by = float(face.by) + shift[1]
        key = tuple(sorted(((round(ax, 3), round(ay, 3)),
                            (round(bx, 3), round(by, 3)))))
        if key in seen:
            continue
        seen.add(key)
        length = math.hypot(bx - ax, by - ay)
        if not 0.80 <= length <= 3.00:
            continue
        ux, uy = (bx - ax) / length, (by - ay) / length
        if ux < -1e-6 or (abs(ux) <= 1e-6 and uy < 0):
            ux, uy = -ux, -uy
        nx, ny = -uy, ux
        u0, u1 = ax * ux + ay * uy, bx * ux + by * uy
        v0, v1 = ax * nx + ay * ny, bx * nx + by * ny
        ulo, uhi = sorted((u0, u1))
        v = (v0 + v1) / 2
        angle = math.atan2(uy, ux)
        item = {
            "axis": (ux, uy), "normal": (nx, ny),
            "ulo": ulo, "uhi": uhi, "v": v, "length": length,
        }
        projected.append(item)
        bucket = (
            round(angle / math.radians(2)),
            # CAD wall faces around one flight vary by roughly 0.1 m at their
            # ends. A 0.30 m bin keeps those fragments together; the later
            # even-spacing, paired-flight, marker, landing, and upper-floor
            # checks still decide whether the group is stair evidence.
            round(length / 0.30),
            round(((ulo + uhi) / 2) / 0.30),
        )
        buckets.setdefault(bucket, []).append(item)

    runs = []
    for items in buckets.values():
        items = sorted(items, key=lambda item: item["v"])
        sequence = []
        for item in items:
            if not sequence:
                sequence = [item]
                continue
            gap = item["v"] - sequence[-1]["v"]
            expected = (
                sum(sequence[i + 1]["v"] - sequence[i]["v"]
                    for i in range(len(sequence) - 1)) / (len(sequence) - 1)
                if len(sequence) > 1 else None
            )
            minimum = (max(STAIR_RISER_SPACING[0], expected - 0.035)
                       if expected is not None else STAIR_RISER_SPACING[0])
            maximum = (min(STAIR_RISER_SPACING[1], expected + 0.035)
                       if expected is not None else STAIR_RISER_SPACING[1])
            if gap < minimum:
                # Paired wall faces and duplicated ceiling linework can put a
                # second segment 100-190 mm beside a true riser. It is too
                # close to the run's measured going; ignore it without
                # breaking the evenly spaced sequence already in progress.
                continue
            if gap <= maximum:
                sequence.append(item)
            else:
                if len(sequence) >= STAIR_RISER_LINE_MIN:
                    runs.append(sequence)
                sequence = [item]
        if len(sequence) >= STAIR_RISER_LINE_MIN:
            runs.append(sequence)

    result = []
    for sequence in runs:
        gaps = [sequence[i + 1]["v"] - sequence[i]["v"]
                for i in range(len(sequence) - 1)]
        going = sum(gaps) / len(gaps)
        if max(abs(gap - going) for gap in gaps) > 0.035:
            continue
        result.append({
            "axis": sequence[0]["axis"],
            "normal": sequence[0]["normal"],
            "ulo": sum(item["ulo"] for item in sequence) / len(sequence),
            "uhi": sum(item["uhi"] for item in sequence) / len(sequence),
            "vmin": sequence[0]["v"],
            "vmax": sequence[-1]["v"],
            "going": going,
            "count": len(sequence),
            "positions": [item["v"] for item in sequence],
        })
    return result, projected


def _marker_projection(marker, run, shift=(0.0, 0.0)):
    x = float(marker.x) + shift[0]
    y = float(marker.y) + shift[1]
    ux, uy = run["axis"]
    nx, ny = run["normal"]
    return x * ux + y * uy, x * nx + y * ny


def _point_from_projection(axis, normal, u, v):
    return (u * axis[0] + v * normal[0],
            u * axis[1] + v * normal[1])


def _measured_dogleg_evidence(
    lower_faces, upper_faces, lower_markers, upper_markers,
    lower_shift=(0.0, 0.0), upper_shift=(0.0, 0.0),
):
    """One dog-leg core proven by paired riser runs, UP/DOWN, and a landing edge."""
    lower_runs, lower_segments = _marked_riser_runs(lower_faces, lower_shift)
    upper_runs, _upper_segments = _marked_riser_runs(upper_faces, upper_shift)
    lower_up = [marker for marker in lower_markers or ()
                if float(getattr(marker, "level", -1)) == 0.0]
    upper_down = [marker for marker in upper_markers or ()
                  if float(getattr(marker, "level", -1)) == 1.0]

    candidates = []
    for first_index, first in enumerate(lower_runs):
        for second in lower_runs[first_index + 1:]:
            if abs(first["axis"][0] * second["axis"][0]
                   + first["axis"][1] * second["axis"][1]) < 0.995:
                continue
            if (abs(first["going"] - second["going"]) > 0.035
                    or abs(first["vmin"] - second["vmin"]) > 0.08
                    or abs(first["vmax"] - second["vmax"]) > 0.08):
                continue
            bands = sorted((first, second), key=lambda run: run["ulo"])
            gap = bands[1]["ulo"] - bands[0]["uhi"]
            if not 0.0 <= gap <= 0.25:
                continue
            umin, umax = bands[0]["ulo"], bands[1]["uhi"]
            nearby = []
            for marker in lower_up:
                mu, mv = _marker_projection(marker, first, lower_shift)
                if (umin - STAIR_MARKER_CLEARANCE <= mu <= umax + STAIR_MARKER_CLEARANCE
                        and first["vmin"] - STAIR_MARKER_CLEARANCE <= mv
                        <= first["vmax"] + STAIR_MARKER_CLEARANCE):
                    nearby.append((marker, mu, mv))
            if not nearby:
                continue
            marker, _mu, marker_v = min(
                nearby,
                key=lambda item: min(abs(item[2] - first["vmin"]),
                                     abs(item[2] - first["vmax"])),
            )
            marker_at_min = abs(marker_v - first["vmin"]) < abs(marker_v - first["vmax"])
            landing_side = 1 if marker_at_min else -1
            landing_edges = []
            for segment in lower_segments:
                if abs(segment["axis"][0] * first["axis"][0]
                       + segment["axis"][1] * first["axis"][1]) < 0.995:
                    continue
                overlap = max(0.0, min(segment["uhi"], umax)
                              - max(segment["ulo"], umin))
                if overlap < (umax - umin) * 0.70:
                    continue
                edge_gap = ((segment["v"] - first["vmax"])
                            if landing_side > 0
                            else (first["vmin"] - segment["v"]))
                if STAIR_LANDING_EDGE_RANGE[0] <= edge_gap <= STAIR_LANDING_EDGE_RANGE[1]:
                    landing_edges.append((edge_gap, segment["v"]))
            if not landing_edges:
                continue
            landing_depth, landing_far_v = min(landing_edges)
            if landing_side > 0:
                start_v = first["vmin"] - first["going"]
                landing_near_v = first["vmax"]
            else:
                start_v = first["vmax"] + first["going"]
                landing_near_v = first["vmin"]
            candidates.append({
                "axis": first["axis"], "normal": first["normal"],
                "bands": bands, "umin": umin, "umax": umax,
                "startV": start_v, "landingNearV": landing_near_v,
                "landingFarV": landing_far_v,
                "riserVmin": first["vmin"], "riserVmax": first["vmax"],
                "going": (first["going"] + second["going"]) / 2,
                "riserLines": min(first["count"], second["count"]),
                "flightWidths": [band["uhi"] - band["ulo"] for band in bands],
                "flightGap": gap, "landingDepth": landing_depth,
            })

    confirmed = []
    for candidate in candidates:
        for run in upper_runs:
            if abs(run["axis"][0] * candidate["axis"][0]
                   + run["axis"][1] * candidate["axis"][1]) < 0.995:
                continue
            if (abs(run["going"] - candidate["going"]) > 0.035
                    or run["count"] < candidate["riserLines"]):
                continue
            if (abs(run["vmin"] - candidate["riserVmin"]) > 0.15
                    or abs(run["vmax"] - candidate["riserVmax"]) > 0.15):
                continue
            for marker in upper_down:
                mu, mv = _marker_projection(marker, run, upper_shift)
                vlo = min(candidate["startV"], candidate["landingFarV"])
                vhi = max(candidate["startV"], candidate["landingFarV"])
                if (candidate["umin"] - STAIR_MARKER_CLEARANCE <= mu
                        <= candidate["umax"] + STAIR_MARKER_CLEARANCE
                        and vlo - STAIR_MARKER_CLEARANCE <= mv
                        <= vhi + STAIR_MARKER_CLEARANCE):
                    confirmed.append(candidate)
                    break
            if candidate in confirmed:
                break
    return confirmed


def build_marked_stairs(
    lower_faces, upper_faces, lower_markers, upper_markers, rise: float,
    base_z: float = 0.0, lower_shift=(0.0, 0.0), upper_shift=(0.0, 0.0),
):
    """Build a measured dog-leg only when both floors corroborate its riser marks."""
    evidence = _measured_dogleg_evidence(
        lower_faces, upper_faces, lower_markers, upper_markers,
        lower_shift, upper_shift,
    )
    if len(evidence) != 1:
        reason = ("no unique paired UP/DOWN riser-line core"
                  if not evidence else
                  f"{len(evidence)} paired UP/DOWN riser-line cores are ambiguous")
        return {}, {"stairs": 0, "refused": [reason], "layouts": [],
                    "verticalOpenings": [], "assumed": None}
    item = evidence[0]
    per_flight = item["riserLines"]
    risers = per_flight * 2
    if rise <= 0 or rise / risers > STAIR_MAX_RISER:
        return {}, {"stairs": 0,
                    "refused": [f"measured {risers}-riser stair exceeds {STAIR_MAX_RISER:.2f} m maximum riser"],
                    "layouts": [], "verticalOpenings": [], "assumed": None}

    axis, normal = item["axis"], item["normal"]
    direction = 1.0 if item["landingNearV"] > item["startV"] else -1.0
    px, py = normal[0] * direction, normal[1] * direction
    centres = [(band["ulo"] + band["uhi"]) / 2 for band in item["bands"]]
    mesh = MeshBuilder()
    first_start = _point_from_projection(axis, normal, centres[0], item["startV"])
    for step in range(per_flight):
        ax = first_start[0] + px * item["going"] * step
        ay = first_start[1] + py * item["going"] * step
        mesh.add_box_from_segment(
            ax, ay, ax + px * item["going"], ay + py * item["going"],
            item["flightWidths"][0], rise * (step + 1) / risers,
            base_z=base_z,
        )
    landing_near = _point_from_projection(
        axis, normal, (item["umin"] + item["umax"]) / 2,
        item["landingNearV"],
    )
    landing_far = _point_from_projection(
        axis, normal, (item["umin"] + item["umax"]) / 2,
        item["landingFarV"],
    )
    mesh.add_box_from_segment(
        *landing_near, *landing_far, item["umax"] - item["umin"],
        rise / 2, base_z=base_z,
    )
    second_start = _point_from_projection(
        axis, normal, centres[1], item["landingNearV"],
    )
    for step in range(per_flight):
        ax = second_start[0] - px * item["going"] * step
        ay = second_start[1] - py * item["going"] * step
        mesh.add_box_from_segment(
            ax, ay, ax - px * item["going"], ay - py * item["going"],
            item["flightWidths"][1],
            rise * (per_flight + step + 1) / risers,
            base_z=base_z,
        )
    v0, v1 = sorted((item["startV"], item["landingFarV"]))
    loop = [
        _point_from_projection(axis, normal, item["umin"], v0),
        _point_from_projection(axis, normal, item["umax"], v0),
        _point_from_projection(axis, normal, item["umax"], v1),
        _point_from_projection(axis, normal, item["umin"], v1),
    ]
    layout = {
        "type": "dog-leg-u", "source": "measured-riser-lines",
        "risers": [per_flight, per_flight], "going": round(item["going"], 3),
        "flightWidths": [round(value, 3) for value in item["flightWidths"]],
        "flightGap": round(item["flightGap"], 3),
        "landingDepth": round(item["landingDepth"], 3),
        "landingHeight": round(base_z + rise / 2, 3),
    }
    return {"stair_marked_riser_core": mesh}, {
        "stairs": 1, "refused": [], "layouts": [layout],
        "verticalOpenings": [{"loop": [[round(x, 4), round(y, 4)] for x, y in loop],
                              "source": "measured-riser-lines"}],
        "assumed": "opposing flight direction and tread solids are inferred; riser spacing, flight widths, landing edge, and core position are measured",
    }


def _named_stair_polygons(spaces, shift=(0.0, 0.0)):
    """Stair-labelled room polygons in registered plan coordinates."""
    from shapely.affinity import translate
    from shapely.geometry import Polygon

    found = []
    for space in spaces or ():
        name = str(getattr(space, "name", None) or "")
        if not re.search(r"\bstairs?(?:\s*(?:case|well))?\b", name, re.I):
            continue
        loop = getattr(space, "loop", None) or []
        if len(loop) < 3:
            continue
        poly = Polygon(loop)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty:
            found.append((space, translate(poly, xoff=shift[0], yoff=shift[1])))
    return found


def _straight_stair(
    rectangle,
    run_edge: int,
    run_length: float,
    width: float,
    risers: int,
    rise: float,
    base_z: float,
):
    """One inferred straight flight, or None when the core cannot contain it."""
    usable_run = run_length - 2 * STAIR_EDGE_CLEARANCE
    usable_width = width - 2 * STAIR_EDGE_CLEARANCE
    if (
        usable_width < STAIR_MIN_WIDTH
        or usable_run < risers * STAIR_MIN_GOING
    ):
        return None

    going = min(STAIR_MAX_GOING, usable_run / risers)
    flight_run = going * risers
    a = rectangle[run_edge]
    b = rectangle[(run_edge + 1) % 4]
    dx, dy = (b[0] - a[0]) / run_length, (b[1] - a[1]) / run_length
    cx = sum(point[0] for point in rectangle) / 4
    cy = sum(point[1] for point in rectangle) / 4
    start_x = cx - dx * flight_run / 2
    start_y = cy - dy * flight_run / 2

    mesh = MeshBuilder()
    for step in range(risers):
        ax = start_x + dx * going * step
        ay = start_y + dy * going * step
        bx = ax + dx * going
        by = ay + dy * going
        mesh.add_box_from_segment(
            ax, ay, bx, by, usable_width, rise * (step + 1) / risers,
            base_z=base_z,
        )
    return mesh, {
        "type": "straight",
        "risers": risers,
        "going": round(going, 3),
        "flightWidth": round(usable_width, 3),
    }


def _dogleg_stair(
    rectangle,
    run_edge: int,
    run_length: float,
    width: float,
    risers: int,
    rise: float,
    base_z: float,
):
    """Two parallel opposing flights and a half-height landing, or None."""
    first_risers = risers // 2
    second_risers = risers - first_risers
    if first_risers < 1:
        return None

    usable_run = run_length - 2 * STAIR_EDGE_CLEARANCE
    usable_width = width - 2 * STAIR_EDGE_CLEARANCE
    flight_width = STAIR_MIN_WIDTH
    landing_depth = flight_width
    landing_width = 2 * flight_width + STAIR_FLIGHT_GAP
    flight_run_available = usable_run - landing_depth
    if (
        usable_width < landing_width
        or flight_run_available
        < max(first_risers, second_risers) * STAIR_MIN_GOING
    ):
        return None

    first_going = min(
        STAIR_MAX_GOING, flight_run_available / first_risers,
    )
    second_going = min(
        STAIR_MAX_GOING, flight_run_available / second_risers,
    )
    first_run = first_going * first_risers
    second_run = second_going * second_risers

    a = rectangle[run_edge]
    b = rectangle[(run_edge + 1) % 4]
    dx, dy = (b[0] - a[0]) / run_length, (b[1] - a[1]) / run_length
    nx, ny = -dy, dx
    cx = sum(point[0] for point in rectangle) / 4
    cy = sum(point[1] for point in rectangle) / 4
    landing_near_x = cx + dx * (usable_run / 2 - landing_depth)
    landing_near_y = cy + dy * (usable_run / 2 - landing_depth)
    landing_far_x = landing_near_x + dx * landing_depth
    landing_far_y = landing_near_y + dy * landing_depth
    side_offset = (STAIR_FLIGHT_GAP + flight_width) / 2
    landing_height = rise * first_risers / risers

    mesh = MeshBuilder()
    first_start_x = landing_near_x - dx * first_run - nx * side_offset
    first_start_y = landing_near_y - dy * first_run - ny * side_offset
    for step in range(first_risers):
        ax = first_start_x + dx * first_going * step
        ay = first_start_y + dy * first_going * step
        bx = ax + dx * first_going
        by = ay + dy * first_going
        mesh.add_box_from_segment(
            ax, ay, bx, by, flight_width,
            rise * (step + 1) / risers,
            base_z=base_z,
        )

    mesh.add_box_from_segment(
        landing_near_x, landing_near_y,
        landing_far_x, landing_far_y,
        landing_width, landing_height,
        base_z=base_z,
    )

    second_start_x = landing_near_x + nx * side_offset
    second_start_y = landing_near_y + ny * side_offset
    for step in range(second_risers):
        ax = second_start_x - dx * second_going * step
        ay = second_start_y - dy * second_going * step
        bx = ax - dx * second_going
        by = ay - dy * second_going
        mesh.add_box_from_segment(
            ax, ay, bx, by, flight_width,
            rise * (first_risers + step + 1) / risers,
            base_z=base_z,
        )

    return mesh, {
        "type": "dog-leg-u",
        "risers": [first_risers, second_risers],
        "goings": [round(first_going, 3), round(second_going, 3)],
        "flightWidth": flight_width,
        "flightGap": STAIR_FLIGHT_GAP,
        "landingDepth": landing_depth,
        "landingHeight": round(base_z + landing_height, 3),
    }


def build_stairs(
    lower_spaces,
    upper_spaces,
    rise: float,
    base_z: float = 0.0,
    lower_shift=(0.0, 0.0),
    upper_shift=(0.0, 0.0),
) -> tuple[dict[str, MeshBuilder], dict]:
    """Straight or dog-leg flights where adjacent plans prove one stair core."""
    lower = _named_stair_polygons(lower_spaces, lower_shift)
    upper = _named_stair_polygons(upper_spaces, upper_shift)
    meshes: dict[str, MeshBuilder] = {}
    refused = []
    vertical_openings = []
    layouts = []

    if rise <= 0:
        return {}, {
            "stairs": 0,
            "refused": ["storey rise is not positive"],
            "layouts": [],
            "verticalOpenings": [],
            "assumed": None,
        }

    # Absence is evidence too. A connection with zero stairs and zero refusals
    # reads as though stair recovery was never attempted, which hid the real
    # villa's unpaired `DOWN` marker. Direction words alone do not prove a
    # physical stair core; report the missing named room instead of guessing.
    if not lower or not upper:
        if not lower and not upper:
            reason = (
                "neither adjacent storey has an explicitly named stair room"
            )
        elif not lower:
            reason = "lower storey has no explicitly named stair room"
        else:
            reason = "upper storey has no explicitly named stair room"
        return {}, {
            "stairs": 0,
            "refused": [reason],
            "layouts": [],
            "verticalOpenings": [],
            "assumed": None,
        }

    candidates = []
    upper_claimants: dict[int, int] = {}
    for space, lower_poly in lower:
        matches = []
        for upper_space, upper_poly in upper:
            shared = lower_poly.intersection(upper_poly)
            smaller = min(lower_poly.area, upper_poly.area)
            overlap = shared.area / smaller if smaller > 1e-9 else 0.0
            if overlap >= STAIR_OVERLAP_MIN and not shared.is_empty:
                matches.append((overlap, upper_space, shared))
                key = id(upper_space)
                upper_claimants[key] = upper_claimants.get(key, 0) + 1
        candidates.append((space, lower_poly, matches))

    for space, lower_poly, matches in candidates:
        if not matches:
            refused.append(f"{space.name or 'STAIR'} has no aligned stair above")
            continue

        if len(matches) > 1:
            names = ", ".join(
                str(candidate.name or "STAIR")
                for _overlap, candidate, _shared in
                sorted(matches, key=lambda item: item[0], reverse=True)
            )
            refused.append(
                f"{space.name or 'STAIR'} matches multiple aligned stair rooms "
                f"above ({names}); connection is ambiguous"
            )
            continue

        _overlap, upper_space, shared = matches[0]
        if upper_claimants.get(id(upper_space), 0) > 1:
            refused.append(
                f"{space.name or 'STAIR'} shares {upper_space.name or 'STAIR'} "
                "above with multiple lower stair rooms; connection is ambiguous"
            )
            continue
        if shared.geom_type == "MultiPolygon":
            shared = max(shared.geoms, key=lambda geom: geom.area)
        rotated_rectangle = shared.minimum_rotated_rectangle
        rectangularity = (
            shared.area / rotated_rectangle.area
            if rotated_rectangle.area > 1e-9 else 0.0
        )
        if rectangularity < STAIR_RECTANGULARITY_MIN:
            refused.append(
                f"{space.name or 'STAIR'} needs a shaped or turning flight: "
                f"shared core is only {rectangularity:.0%} rectangular"
            )
            continue
        rectangle = list(rotated_rectangle.exterior.coords)[:4]
        edges = [
            (math.dist(rectangle[i], rectangle[(i + 1) % 4]), i)
            for i in range(4)
        ]
        run_length, run_edge = max(edges)
        width = min(length for length, _index in edges)
        risers = max(1, math.ceil(rise / STAIR_MAX_RISER))
        built = _straight_stair(
            rectangle, run_edge, run_length, width, risers, rise, base_z,
        )
        if built is None:
            built = _dogleg_stair(
                rectangle, run_edge, run_length, width, risers, rise, base_z,
            )
        if built is None:
            longest_flight = risers - risers // 2
            dogleg_run = (
                2 * STAIR_EDGE_CLEARANCE
                + STAIR_MIN_WIDTH
                + longest_flight * STAIR_MIN_GOING
            )
            dogleg_width = (
                2 * STAIR_EDGE_CLEARANCE
                + 2 * STAIR_MIN_WIDTH
                + STAIR_FLIGHT_GAP
            )
            refused.append(
                f"{space.name or 'STAIR'} cannot fit a straight or dog-leg/U "
                f"stair: shared core {run_length:.2f} x {width:.2f} m; "
                f"dog-leg minimum is {dogleg_run:.2f} x {dogleg_width:.2f} m "
                f"for {risers} risers"
            )
            continue

        mesh, layout = built
        meshes[f"stair_room{space.index}_{_room_mesh_slug(space)}"] = mesh
        layouts.append({
            "lowerRoom": space.index,
            "upperRoom": upper_space.index,
            **layout,
        })
        vertical_openings.append({
            "lowerRoom": space.index,
            "upperRoom": upper_space.index,
        })

    return meshes, {
        "stairs": len(meshes),
        "refused": refused,
        "layouts": layouts,
        "verticalOpenings": vertical_openings,
        "assumed": (
            "flight form, direction, tread layout, and any intermediate "
            "landing are inferred inside two measured, registered stair-room "
            "footprints"
        ) if meshes else None,
    }


def open_stair_cores(
    lower_meshes: dict[str, MeshBuilder],
    upper_meshes: dict[str, MeshBuilder],
    stair_report: dict,
    *, lower_spaces=None, upper_spaces=None,
    lower_shift=(0.0, 0.0), upper_shift=(0.0, 0.0),
    lower_ceiling_z=None, upper_base_z=None,
) -> list[str]:
    """Remove generated horizontal caps only for stair pairs actually built."""
    removed = []
    for opening in stair_report.get("verticalOpenings", ()):
        if opening.get("loop"):
            if (lower_spaces is None or upper_spaces is None
                    or lower_ceiling_z is None or upper_base_z is None):
                continue
            from shapely.affinity import translate
            from shapely.geometry import Polygon

            core = Polygon(opening["loop"])

            def parts(geometry):
                if geometry.is_empty:
                    return []
                return ([geometry] if geometry.geom_type == "Polygon"
                        else list(geometry.geoms))

            def cut(spaces, meshes, shift, ceiling):
                for space in spaces:
                    poly = Polygon(space.loop)
                    if not poly.is_valid:
                        poly = poly.buffer(0)
                    poly = translate(poly, xoff=shift[0], yoff=shift[1])
                    if poly.intersection(core).area <= 0.01:
                        continue
                    prefix = ((f"ceiling_room{space.index}_",)
                              if ceiling else
                              (f"floor_room{space.index}_", f"paving_room{space.index}_",
                               f"water_room{space.index}_", f"lawn_room{space.index}_"))
                    key = next((name for name in list(meshes)
                                if name.startswith(prefix)), None)
                    if key is None:
                        continue
                    replacement = MeshBuilder()
                    for polygon in parts(poly.difference(core)):
                        exterior = list(polygon.exterior.coords)[:-1]
                        holes = [list(ring.coords)[:-1] for ring in polygon.interiors]
                        if ceiling:
                            replacement.add_polygon_face(
                                exterior, lower_ceiling_z, up=False, holes=holes,
                            )
                        else:
                            replacement.add_polygon_slab(
                                exterior, upper_base_z - SLAB_THICKNESS,
                                SLAB_THICKNESS, holes=holes,
                            )
                    if replacement.indices:
                        meshes[key] = replacement
                    else:
                        meshes.pop(key, None)
                    removed.append(f"{key}: measured partial opening")

            cut(lower_spaces, lower_meshes, lower_shift, True)
            cut(upper_spaces, upper_meshes, upper_shift, False)
            continue
        lower_prefix = f"ceiling_room{opening['lowerRoom']}_"
        upper_prefix = f"floor_room{opening['upperRoom']}_"
        for meshes, prefix in (
            (lower_meshes, lower_prefix),
            (upper_meshes, upper_prefix),
        ):
            for name in list(meshes):
                if name.startswith(prefix):
                    meshes.pop(name)
                    removed.append(name)
    return removed


def build_roof(spaces, height: float, base_z: float = 0.0,
               parapet: bool = True) -> tuple[dict, dict]:
    """
    A flat roof over the indoor footprint, with a parapet.

    ── Why this is an ASSUMPTION, and says so ───────────────────────────────
    A floor plan does not draw the roof. What it gives is the footprint, and
    everything above the wall head — flat or pitched, parapet or eave, tile or
    RCC — is inference. Most Indian residential IS flat RCC with a parapet
    (doc 18's `roof_rcc_coba_screed`), so that is both the honest fallback and
    the common case, but it is still a guess: the meshes are tagged
    `surfaceClassSource: assumed` and a pitched-roof building will be wrong
    until form recovery exists. Being wrong LOUDLY is the point — a model with
    no roof at all is silently wrong in a way no reviewer can see.

    ── Why it is OFF by default ─────────────────────────────────────────────
    `render/cameras.py::isometric_view` is a cutaway: it works because there
    has never been a roof to look through. Adding one unconditionally would
    put a lid on every existing isometric and the renders would quietly become
    useless. So the caller asks for it, and a renderer that wants an interior
    view hides the `roof*` meshes rather than never having them.

    Returns ({mesh name: MeshBuilder}, report).
    """
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    indoor = []
    for space in spaces or ():
        if _space_is_outdoor(space):
            continue
        loop = getattr(space, "loop", None) or []
        if len(loop) < 3:
            continue
        poly = Polygon([(float(p[0]), float(p[1])) for p in loop])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty:
            indoor.append(poly)

    if not indoor:
        return {}, {"roof": 0, "reason": "no indoor rooms to cover"}

    # Rooms meet ON wall centrelines, so their union already covers half of
    # every wall. Growing it by a wall's half-thickness plus the oversail
    # closes the gap over the envelope and throws water clear of the face.
    footprint = unary_union(indoor).buffer(0.15 + ROOF_OVERHANG,
                                           join_style=2).buffer(0)
    if footprint.geom_type == "MultiPolygon":
        footprint = max(footprint.geoms, key=lambda g: g.area)
    if footprint.is_empty:
        return {}, {"roof": 0, "reason": "footprint did not resolve"}

    ring = list(footprint.exterior.coords)[:-1]
    top = base_z + height

    meshes: dict[str, MeshBuilder] = {}
    slab = MeshBuilder()
    slab.add_polygon_slab(ring, top, SLAB_THICKNESS)
    meshes["roof"] = slab

    built_parapet = 0
    if parapet:
        wall_mesh = MeshBuilder()
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
            if math.hypot(bx - ax, by - ay) < 1e-6:
                continue
            wall_mesh.add_box_from_segment(
                ax, ay, bx, by, 0.115, PARAPET_HEIGHT,
                base_z=top + SLAB_THICKNESS,
            )
            built_parapet += 1
        if wall_mesh.indices:
            meshes["parapet"] = wall_mesh

    return meshes, {
        "roof": 1,
        "parapet": built_parapet,
        "area": round(footprint.area, 2),
        "height": round(top, 3),
        "assumed": "flat RCC roof with a parapet; the plan does not draw one",
    }
