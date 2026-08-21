"""
The raster branch of `reconstruct`.

── Why this is not a flag on the DXF path ──────────────────────────────────────
The DXF path is built on things a photograph does not have and cannot be given:
block definitions, layer tables, TEXT entities at known coordinates, a header
declaring its units. Threading `if is_raster` through two hundred lines of that
would put a branch in every one of them, and every one would be a place for the
two paths to drift.

What the two genuinely share is everything *after* the geometry exists — the
perimeter, rooms, slabs, the mesh builders, the verification gate. Those are
imported here rather than reimplemented, so a fix to room detection reaches both
paths by construction.

What a raster gives up, stated plainly rather than degraded quietly:
  * no furniture — there are no blocks to place, only outlines the studio's own
    furnishing pass reads on the client side
  * no openings — the detector reports gaps it will not classify as door or
    window, and hosting an unclassified gap would invent a door
  * rooms come from the detector, which named them, rather than from
    `polygonize` on the wall graph
"""

from __future__ import annotations

from pathlib import Path

from hypothesise.pair import join_corners, pair_faces, summarise
from hypothesise.perimeter import add_perimeter
from hypothesise.perimeter import summarise as perimeter_summary
from ingest import raster


def _polygon_area(loop) -> float:
    """Shoelace, unsigned. The detector's winding is not guaranteed."""
    total = 0.0
    for i in range(len(loop)):
        x0, y0 = loop[i]
        x1, y1 = loop[(i + 1) % len(loop)]
        total += x0 * y1 - x1 * y0
    return round(abs(total) / 2, 2)


def reconstruct_raster(
    input_path: str,
    out_dir: str,
    height: float = 2.7,
    detector_url: str | None = None,
    unit_scale: float | None = None,
    with_perimeter: bool = True,
) -> dict:
    """A photograph or scan of a floor plan -> walls, rooms, GLB."""
    from build.glb import MeshBuilder, write_glb
    from build.solidify import build_slabs, build_walls
    from solve import spaces as sp
    from solve import verify as vf

    source = Path(input_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    reading = raster.read(str(source), url=detector_url, unit_scale=unit_scale)

    # Faces are paired; walls the detector already paired are not paired again.
    #
    # This is the whole reason the adapter separates them. `pair_faces` is a
    # geometric operation with no idea what it has been handed — give it two
    # centrelines that happen to run parallel a metre apart and it will happily
    # produce one wall a metre thick down the middle of a corridor.
    paired = pair_faces(reading.faces) if reading.faces else []
    walls = join_corners(paired + reading.walls)

    if with_perimeter:
        walls = add_perimeter(walls)

    wall_stats = summarise(walls)
    wall_stats["perimeter"] = perimeter_summary(walls)
    wall_stats["fromDetector"] = len(reading.walls)
    wall_stats["pairedHere"] = len(paired)

    # Rooms come from the detector, not from the wall graph.
    #
    # ── Measured, and the opposite of what the DXF path does ────────────────
    # Polygonising the wall graph is right for a DXF, where every wall is an
    # exact line and the cycles close. On a raster it does not: run on the
    # villa, the graph closed 3 rooms totalling 18.5 m2 while the detector had
    # already found 8 — six of them *named* — covering the whole plan. The
    # difference is that the detector never needed the walls to close, because
    # it flood-fills regions and derives the walls from their edges, so a
    # doorway it could not bridge costs it nothing.
    #
    # The graph rooms are still computed, because `verify` judges the model
    # against them and a wall network that encloses nothing is worth knowing
    # about even when the floors come from elsewhere.
    graph_rooms = sp.detect_spaces(walls, labels=[], classify_room=lambda _t: "unknown")

    # Ground gets no floor slab.
    #
    # ── Restoring a decision lost when this module's partner was overwritten ──
    # The detector reports a lawn, a pool and a planting bed as regions, because
    # they *are* regions — enclosed by lines exactly as a bedroom is. It already
    # separates them from the building using the drawing's own labels, so the
    # answer arrives with the data and only has to be used.
    #
    # Left in, they become floor slabs: the villa grows a concrete lawn. The
    # same mistake reappeared independently in the BOQ an hour later, where it
    # tiled 93 m2 of garden in vitrified tile — which is the argument for
    # filtering once, here, rather than in each consumer.
    #
    # It lives in the builder rather than the adapter on purpose: the adapter's
    # job is to report what the drawing said, and deciding what becomes geometry
    # is a modelling choice. A caller that wants the site outline for a terrain
    # mesh still has it on `reading.rooms`.
    indoor = [
        room for room in reading.rooms
        if room.get("kind") != "outdoor" and len(room.get("polygon", [])) >= 3
    ]
    outdoor_count = sum(1 for r in reading.rooms if r.get("kind") == "outdoor")

    rooms = [
        sp.Space(
            index=i,
            loop=[(p["x"], p["y"]) for p in room["polygon"]],
            area=_polygon_area([(p["x"], p["y"]) for p in room["polygon"]]),
            gross_area=_polygon_area([(p["x"], p["y"]) for p in room["polygon"]]),
            perimeter=0.0,
            name=room.get("name"),
            kind=room.get("kind", "room"),
        )
        for i, room in enumerate(indoor)
    ]
    room_stats = sp.summarise(rooms)
    room_stats["fromWallGraph"] = len(graph_rooms)
    room_stats["outdoorExcluded"] = outdoor_count

    wall_mesh, floor_mesh = MeshBuilder(), MeshBuilder()
    wall_build = build_walls(wall_mesh, walls, [], height)
    slab_build = build_slabs(floor_mesh, rooms)

    # Verified against the *graph* rooms deliberately. The gate exists to catch a
    # wall network that contradicts its own input, and handing it rooms that did
    # not come from those walls would let it pass a model whose walls enclose
    # nothing at all.
    verdict = vf.check(
        input_segments=len(reading.faces) + len(reading.walls),
        walls=walls,
        spaces=graph_rooms,
        openings=[],
        unhosted=[],
        scale_candidates=None,
    )

    manifest = write_glb(
        {"storey0_walls": wall_mesh, "storey0_floors": floor_mesh},
        out / f"{source.stem}.glb",
    )

    return {
        "source": str(source),
        "ingest": "raster",
        "detector": reading.summary(),
        "walls": wall_stats,
        "rooms": room_stats,
        "detectorRooms": reading.rooms,
        "build": {**wall_build, **slab_build},
        "verify": verdict.as_dict() if hasattr(verdict, "as_dict") else verdict,
        "glb": manifest,
        # Surfaced because everything measured downstream inherits it, and a
        # scale read from one room with nothing to disagree with is a different
        # claim from one five rooms agreed on.
        "scale": {
            "metresPerUnit": reading.metres_per_unit,
            "samples": reading.scale_samples,
            "spread": reading.scale_spread,
            "trustworthy": reading.scale_trustworthy,
            # Every length in this model is this number multiplied by a fraction
            # of the image. If it is wrong the building is the wrong size —
            # uniformly, plausibly, and with nothing in the geometry to give it
            # away. A model at 0.9x scale renders beautifully and quantifies to
            # a bill of materials that is 10% short.
            #
            # `scale_trustworthy` existed and nothing consulted it, which made it
            # a comment with a type. Promoted to a blocking check so the gate
            # treats it the way it treats a wall network that encloses nothing.
            "warning": None if reading.scale_trustworthy else (
                f"Scale rests on {reading.scale_samples} printed dimension"
                f"{'' if reading.scale_samples == 1 else 's'}"
                + (" with nothing to disagree with"
                   if reading.scale_samples < 2 else
                   f" disagreeing by {(reading.scale_spread or 0):.0%}")
                + ". Confirm it against a known length before quantifying or quoting."
            ),
        },
        # The same shape the DXF path emits, so `deliverables` — cameras, the
        # plan drawing, the render manifest — works on a photograph with no
        # knowledge that it was one.
        "elements": {
            "walls": [w.as_dict() for w in walls],
            "spaces": [r.as_dict() for r in rooms],
            "openings": [],
            "fixtures": [],
        },
    }
