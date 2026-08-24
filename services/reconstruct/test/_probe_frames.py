"""
Which frame should be frames[0]? Measure the candidates before changing the rule.

The backlog records frame *selection* as open: `frames[0]` is whichever cluster
has the most wall segments, and on a many-drawing sheet that is a guess — dense
elevation linework outranks a sparse floor plan. The direction it names is the
one layer selection already learned: optimise NAMED ROOMS, not room count. The
reverted attempt in `cli.py` (see the "TRIED, MEASURED, AND REVERTED" block)
adds the discipline: any new rule must be judged by the building it produces —
rooms and enclosed area — not by which frame it picks.

This probe prints, for every frame on every sheet given:

  - the current rank (wall count), span, title
  - how many room labels `classify_room` recognises inside its bbox
  - whether a plan title landed in it

and marks where the current rule and a label-informed rule disagree. It changes
nothing; it exists so the ranking constant is measured rather than chosen.

Run: .venv/Scripts/python.exe test/_probe_frames.py [--grade] <dxf-or-dwg> [...]

`--grade` additionally reconstructs the top candidate frames the way the
pipeline would — per-frame layer scan, pair, join, perimeter, spaces — and
reports rooms / named / largest / enclosed area for each. Slow; that is the
point of running it per-sheet in parallel.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.elements import classify_room          # noqa: E402
from classify.units import rank_units                # noqa: E402
from hypothesise.pair import Face, join_corners, pair_faces  # noqa: E402
from hypothesise.perimeter import add_perimeter      # noqa: E402
from ingest import blocks as blk                     # noqa: E402
from solve import layerscan                          # noqa: E402
from solve.frames import segment_frames              # noqa: E402
from solve.spaces import detect_spaces               # noqa: E402
from vendor import cad_kernel as kernel              # noqa: E402

import cli                                           # noqa: E402


def as_dxf(path: Path) -> Path:
    """DWG converts through the same gate the pipeline uses."""
    if path.suffix.lower() != ".dwg":
        return path
    from ingest.dwg import to_dxf

    work = Path("A:/tmp/frameprobe")
    work.mkdir(parents=True, exist_ok=True)
    converted, _receipt = to_dxf(path, work)
    return converted


def grade_frame(frame, reading, scale, origin, chosen, labels, placements):
    """
    Reconstruct ONE frame the way `_solve_frame` would, and measure the result.

    Mirrors cli.py's per-frame pass: all segments in the bbox grouped by layer,
    the layer scan's own shortlist and search, sorted-pool pairing, the
    perimeter, then spaces. Any divergence from that flow grades a building the
    pipeline will not build — the exact mistake the layerscan fix closed.
    """
    ox, oy = origin
    x0, y0, x1, y1 = frame.bbox

    within: dict[str, list] = {}
    for seg in reading["_segments"]:
        face = Face(
            ax=(seg.x1 - ox) * scale, ay=(seg.y1 - oy) * scale,
            bx=(seg.x2 - ox) * scale, by=(seg.y2 - oy) * scale, layer=seg.layer,
        )
        if (min(face.ax, face.bx) >= x0 - 1 and max(face.ax, face.bx) <= x1 + 1
                and min(face.ay, face.by) >= y0 - 1 and max(face.ay, face.by) <= y1 + 1):
            within.setdefault(seg.layer, []).append(face)

    # cli._labels_in keeps only labels the classifier recognises; mirror it, or
    # fit_of scores against annotations the pipeline never sees.
    in_frame = [
        l for l in labels
        if classify_room(l.text) != "unknown"
        and x0 - 2 <= l.x <= x1 + 2 and y0 - 2 <= l.y <= y1 + 2
    ]
    # `kernel.furniture` already origin-shifts and scales its positions —
    # re-applying the transform here displaced every block out of its frame,
    # which silently zeroed the openings term of every grade in the first
    # corpus survey. Compare the stored coordinates directly.
    blocks = [
        p for p in placements
        if x0 - 1 <= p["position"]["x"] <= x1 + 1
        and y0 - 1 <= p["position"]["y"] <= y1 + 1
    ]

    shortlist = layerscan.recommended(layerscan.scan(within)) | (set(chosen) & set(within))
    selected, _trace = layerscan.select_within_frame(
        within, shortlist, in_frame, blocks, classify_room, kernel.guess_item,
    )
    if not selected:
        selected = set(chosen) & set(within)
        if not selected:
            return {"walls": 0, "rooms": 0, "named": 0, "largest": 0.0, "area": 0.0}

    pool = [f for name in sorted(selected) for f in within[name]]
    walls = add_perimeter(join_corners(pair_faces(pool)))
    spaces = detect_spaces(walls, labels=in_frame, classify_room=classify_room)
    lo, hi = layerscan.ROOM_AREA
    rooms = [s for s in spaces if lo <= s.area <= hi]
    return {
        "walls": len(walls),
        "rooms": len(rooms),
        "named": sum(1 for s in rooms if s.name),
        "largest": round(max((s.area for s in spaces), default=0.0), 2),
        "area": round(sum(s.area for s in rooms), 2),
        "layers": sorted(selected),
    }


def probe(path: Path, grade: bool = False) -> None:
    dxf = as_dxf(path)
    reading = kernel.read(str(dxf))
    scale = reading["scale"]
    ox, oy = reading["_origin"]

    # The CLI's own flow: chosen layers, measured units, then frames.
    chosen = cli.default_wall_layers(reading)
    verdict = rank_units(
        [s for s in reading["_segments"] if s.layer in chosen],
        reading["_origin"],
    )
    if verdict.decided and verdict.best:
        scale = verdict.best.scale

    faces = [
        Face(ax=(s.x1 - ox) * scale, ay=(s.y1 - oy) * scale,
             bx=(s.x2 - ox) * scale, by=(s.y2 - oy) * scale, layer=s.layer)
        for s in reading["_segments"]
        if s.layer in chosen
    ]
    walls = join_corners(pair_faces(faces))
    frames = segment_frames(walls)

    doc, _ = blk.open_dxf(str(dxf))
    labels = blk.room_labels(doc, scale, (ox, oy))
    titles = cli._real_plan_titles(blk.plan_titles(doc, scale, (ox, oy)))

    named = [l for l in labels if classify_room(l.text) != "unknown"]

    print(f"\n==== {path.name}  ({len(frames)} frames, "
          f"{len(named)} recognised room labels on the sheet)")
    header = (f"  {'#':>3} {'walls':>5} {'span':>7} {'rooms':>5} "
              f"{'title':<40}")
    print(header)

    rows = []
    for frame in frames:
        x0, y0, x1, y1 = frame.bbox
        inside = [l for l in named if x0 <= l.x <= x1 and y0 <= l.y <= y1]
        title = next(
            (t.text for t in titles if x0 <= t.x <= x1 and y0 <= t.y <= y1),
            None,
        )
        rows.append((frame, len(inside), title))
        print(f"  {frame.index:>3} {len(frame.wall_indices):>5} "
              f"{frame.span:>7.1f} {len(inside):>5} {title or '-':<40}")

    current = rows[0]
    by_rooms = max(rows, key=lambda r: (r[1], len(r[0].wall_indices)))
    if by_rooms[0].index != current[0].index:
        print(f"  >> DISAGREES: walls pick #{current[0].index} "
              f"({current[1]} rooms, {current[2] or 'untitled'}); "
              f"labels pick #{by_rooms[0].index} "
              f"({by_rooms[1]} rooms, {by_rooms[2] or 'untitled'})")
    else:
        print(f"  >> agree: #{current[0].index}")

    if grade:
        placements = kernel.furniture(str(dxf), reading)["placements"]
        # The disputed frames plus the strongest few by each rule — bounded, so
        # a 37-frame sheet grades a handful, not all of them.
        candidates: list = []
        for r in sorted(rows, key=lambda r: -len(r[0].wall_indices))[:3]:
            candidates.append(r)
        for r in sorted(rows, key=lambda r: -r[1])[:3]:
            if r not in candidates:
                candidates.append(r)
        print(f"\n  {'#':>3} {'rooms':>5} {'named':>5} {'largest':>8} "
              f"{'area':>8} {'walls':>5}  graded reconstruction")
        for frame, label_count, title in candidates:
            g = grade_frame(frame, reading, scale, (ox, oy), chosen, labels,
                            placements)
            print(f"  {frame.index:>3} {g['rooms']:>5} {g['named']:>5} "
                  f"{g['largest']:>8.1f} {g['area']:>8.1f} {g['walls']:>5}  "
                  f"labels={label_count} {title or '-'}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--grade"]
    want_grade = "--grade" in sys.argv[1:]
    for arg in args:
        probe(Path(arg), grade=want_grade)
