"""
What does a candidate frame's layer-scan pull actually contain?

The fusion guard disqualified candidates whose re-pulled walls segment into
several frames. On ALL PLANS that killed every good candidate. This prints the
sub-frame composition — wall counts, spans, bboxes — for the shortlisted
candidates of one sheet, so 'satellite callout' and 'second villa fused in'
stop being indistinguishable.

Run: .venv/Scripts/python.exe test/_probe_fusion.py <dxf-or-dwg> <frame-index> [...]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.elements import classify_room          # noqa: E402
from classify.units import rank_units                # noqa: E402
from hypothesise.pair import Face, join_corners, pair_faces  # noqa: E402
from ingest import blocks as blk                     # noqa: E402
from solve import layerscan                          # noqa: E402
from solve.frames import segment_frames              # noqa: E402
from vendor import cad_kernel as kernel              # noqa: E402

import cli                                           # noqa: E402

path = Path(sys.argv[1])
want = [int(a) for a in sys.argv[2:]]

if path.suffix.lower() == ".dwg":
    from ingest.dwg import to_dxf
    work = Path("A:/tmp/frameprobe")
    work.mkdir(parents=True, exist_ok=True)
    path, _ = to_dxf(path, work)

reading = kernel.read(str(path))
scale = reading["scale"]
ox, oy = reading["_origin"]
chosen = cli.default_wall_layers(reading)
verdict = rank_units(
    [s for s in reading["_segments"] if s.layer in chosen], reading["_origin"],
)
if verdict.decided and verdict.best:
    scale = verdict.best.scale

faces = [
    Face(ax=(s.x1 - ox) * scale, ay=(s.y1 - oy) * scale,
         bx=(s.x2 - ox) * scale, by=(s.y2 - oy) * scale, layer=s.layer)
    for s in reading["_segments"] if s.layer in chosen
]
all_walls = join_corners(pair_faces(faces))
frames = segment_frames(all_walls)
doc, _ = blk.open_dxf(str(path))
labels_all = [
    lb for lb in blk.room_labels(doc, scale, (ox, oy))
    if classify_room(lb.text) != "unknown"
]
placed = kernel.furniture(str(path), reading)["placements"]

for index in want:
    frame = frames[index]
    x0, y0, x1, y1 = frame.bbox
    print(f"\n== frame {index}: {len(frame.wall_indices)} bootstrap walls, "
          f"span {frame.span:.1f}, title {frame.title!r}, "
          f"bbox [{x0:.0f},{y0:.0f} .. {x1:.0f},{y1:.0f}]")

    contained = [
        g.index for g in frames
        if g is not frame
        and g.bbox[0] >= x0 and g.bbox[1] >= y0
        and g.bbox[2] <= x1 and g.bbox[3] <= y1
    ]
    print(f"   bbox fully contains {len(contained)} other frame(s): {contained[:12]}")

    within: dict[str, list] = {}
    for seg in reading["_segments"]:
        f = Face(ax=(seg.x1 - ox) * scale, ay=(seg.y1 - oy) * scale,
                 bx=(seg.x2 - ox) * scale, by=(seg.y2 - oy) * scale,
                 layer=seg.layer)
        if (min(f.ax, f.bx) >= x0 - 1 and max(f.ax, f.bx) <= x1 + 1
                and min(f.ay, f.by) >= y0 - 1 and max(f.ay, f.by) <= y1 + 1):
            within.setdefault(seg.layer, []).append(f)

    labs = [l for l in labels_all
            if x0 - 2 <= l.x <= x1 + 2 and y0 - 2 <= l.y <= y1 + 2]
    blocks = [p for p in placed
              if x0 - 1 <= p["position"]["x"] <= x1 + 1
              and y0 - 1 <= p["position"]["y"] <= y1 + 1]

    shortlist = layerscan.recommended(layerscan.scan(within)) | (set(chosen) & set(within))
    selected, _ = layerscan.select_within_frame(
        within, shortlist, labs, blocks, classify_room, kernel.guess_item,
    )
    if not selected:
        print("   scan chose nothing")
        continue
    pool = [f for name in sorted(selected) for f in within[name]]
    pulled = join_corners(pair_faces(pool))
    subs = segment_frames(pulled)
    print(f"   pull: {len(pulled)} walls from {sorted(selected)}")
    print(f"   segments into {len(subs)} sub-frame(s):")
    for s in subs:
        sx0, sy0, sx1, sy1 = s.bbox
        share = len(s.wall_indices) / len(pulled) * 100
        print(f"     {len(s.wall_indices):>5} walls ({share:4.1f}%)  "
              f"span {s.span:7.1f}  bbox [{sx0:.0f},{sy0:.0f} .. {sx1:.0f},{sy1:.0f}]")
