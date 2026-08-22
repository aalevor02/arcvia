"""
Does `fit_of` grade on a different basis from the one the pipeline builds?

The backlog records this as the live hypothesis behind `layerscan` choosing
`A1 WALLS HIDDEN + A7 COMPOUND WALL` (5 rooms, one 274.84 m² blob) over
`A1 WALLS HIDDEN + A5 FALSE CEILING` (18 rooms) on the villa's ground floor,
and says to confirm it before changing anything. This confirms or refutes it.

`fit_of` pairs and joins, then detects spaces. The pipeline pairs, joins,
**adds the envelope**, then detects spaces. If the ranking flips when the
perimeter is present, the selector is grading a building it is not going to
build.

Run: .venv/Scripts/python.exe test/_probe_layerscan.py <dxf>
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hypothesise import openings as op  # noqa: E402
from hypothesise.pair import Face, join_corners, pair_faces  # noqa: E402
from hypothesise.perimeter import add_perimeter  # noqa: E402
from classify.elements import classify_room  # noqa: E402
from solve import layerscan  # noqa: E402
from solve.frames import segment_frames  # noqa: E402
from solve.spaces import detect_spaces  # noqa: E402
from vendor import cad_kernel as kernel  # noqa: E402
from ingest import blocks as blk  # noqa: E402

path = sys.argv[1]
reading = kernel.read(path)
scale = reading["scale"]
ox, oy = reading["_origin"]

faces = [
    Face(ax=(s.x1 - ox) * scale, ay=(s.y1 - oy) * scale,
         bx=(s.x2 - ox) * scale, by=(s.y2 - oy) * scale, layer=s.layer)
    for s in reading["_segments"]
]
all_walls = join_corners(pair_faces(faces))
frames = segment_frames(all_walls)
print(f"{len(frames)} frames")

doc, _ = blk.open_dxf(path)
all_labels = blk.room_labels(doc, scale, (ox, oy))
placed = kernel.furniture(path, reading)["placements"]
footprints = blk.block_footprints(doc, scale)


def within_frame(bbox):
    x0, y0, x1, y1 = bbox
    by_layer: dict[str, list] = {}
    for f in faces:
        if (min(f.ax, f.bx) >= x0 - 1 and max(f.ax, f.bx) <= x1 + 1
                and min(f.ay, f.by) >= y0 - 1 and max(f.ay, f.by) <= y1 + 1):
            by_layer.setdefault(f.layer, []).append(f)
    labels = [l for l in all_labels if x0 <= l.x <= x1 and y0 <= l.y <= y1]
    blocks = []
    for p in placed:
        px = (p["position"]["x"] - ox) * scale
        py = (p["position"]["y"] - oy) * scale
        if x0 <= px <= x1 and y0 <= py <= y1:
            q = dict(p)
            q["position"] = {"x": px, "y": py}
            blocks.append(q)
    return by_layer, labels, blocks


def grade(pool, labels, blocks, perimeter: bool):
    """`fit_of`'s own measurement, optionally on the pipeline's basis."""
    walls = join_corners(pair_faces(pool))
    if perimeter:
        walls = add_perimeter(walls)
    lo, hi = layerscan.ROOM_AREA
    spaces = [s for s in detect_spaces(walls, labels=labels, classify_room=classify_room)
              if lo <= s.area <= hi]
    holes, unhosted = op.from_sized_blocks(blocks, walls, kernel.guess_item)
    named = sum(1 for s in spaces if s.name)
    all_spaces = detect_spaces(walls, labels=labels, classify_room=classify_room)
    return {
        "walls": len(walls), "rooms": len(spaces), "named": named,
        "doors": len(op.dedupe(holes)), "unhosted": unhosted,
        "largest": round(max((s.area for s in all_spaces), default=0.0), 2),
        "score": layerscan.Fit(len(walls), len(spaces), named,
                               len(op.dedupe(holes)), unhosted).score,
    }


for index, frame in enumerate(frames):
    by_layer, labels, blocks = within_frame(frame.bbox)
    if not labels:
        continue
    shortlist = layerscan.recommended(layerscan.scan(by_layer))
    if len(shortlist) < 2:
        continue
    print(f"\n=== frame {index}  {frame.title or '(untitled)'} "
          f"  shortlist={sorted(shortlist)}")

    sets = []
    names = sorted(shortlist)
    for a in names:
        sets.append((a,))
        for b in names:
            if b > a:
                sets.append((a, b))

    rows = []
    for combo in sets:
        pool = [f for name in combo for f in by_layer[name]]
        if len(pool) < 8:
            continue
        rows.append((combo, grade(pool, labels, blocks, False),
                     grade(pool, labels, blocks, True)))

    print(f"  {'layer set':<44} {'WITHOUT perimeter':>26}   {'WITH perimeter':>26}")
    print(f"  {'':<44} {'rooms named score':>26}   {'rooms named score largest':>26}")
    for combo, without, with_ in sorted(rows, key=lambda r: r[1]["score"], reverse=True):
        label = " + ".join(c[:20] for c in combo)
        print(f"  {label:<44} "
              f"{without['rooms']:>5} {without['named']:>5} {str(without['score']):>14}   "
              f"{with_['rooms']:>5} {with_['named']:>5} {str(with_['score']):>14} "
              f"{with_['largest']:>8.1f}")

    best_without = max(rows, key=lambda r: r[1]["score"])[0]
    best_with = max(rows, key=lambda r: r[2]["score"])[0]
    verdict = "SAME" if best_without == best_with else "*** FLIPS ***"
    print(f"  best without = {best_without}")
    print(f"  best with    = {best_with}   {verdict}")
