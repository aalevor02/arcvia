"""
The engine against buildings whose true dimensions are KNOWN.

Run:  .venv/Scripts/python.exe test/test_plangraph.py     (~1 minute)

── What this is ──────────────────────────────────────────────────────────────
Every other test here checks the engine against itself — constants, invariants,
golden fixtures the engine once produced. None of them can say how much of a
*building* the pipeline recovers, because for a real DWG nobody knows the true
wall list. For a BIM model somebody does: the architect's own tool stored every
wall as axis + measured thickness, every door with its host, every room with
its name. `test/fixtures/plangraph/` carries three real buildings' storeys in
exactly that form (see the README there for provenance).

So this test renders each storey the way a draughtsman would put it on a sheet
— each wall becomes its two face lines offset ±thickness/2, doors become gaps
in both faces with a "DOOR" text beside them, windows keep their linework —
and runs the real pipeline over the result:

    pair_faces → from_text_labels → add_perimeter → join_corners → detect_spaces

then scores the output against what the BIM model says is actually there.

── The two failure shapes this exists to catch ───────────────────────────────
* **The doorway leak.** A 2.1 m double-door gap is wider than MERGE_GAP
  (1.5 m), so the two spans of the wall never rejoin and every room on either
  side leaks through the doorway: measured on the KIT storey, recall 0.87 and
  ZERO rooms. `from_text_labels` bridging is what closes it — 14 rooms from the
  identical linework. The no-bridge canary at the bottom pins that behaviour:
  if a change to MERGE_GAP or the bridging path re-opens the leak, the canary
  flips from 0 and says the assumption moved.

* **Silent recall drift.** Pairing changes are usually judged on one villa.
  These thresholds are measured baselines across three authoring cultures
  (ArchiCAD institutional / Revit residential / 2011-era office); a change that
  trades one building's recall for another's shows up here as a number, not an
  anecdote.

── What the numbers mean, so nobody "fixes" them upward blindly ──────────────
Recall is centreline coverage by PAIRED walls only, with the derived perimeter
excluded — the ring retraces walls at its own thickness and would otherwise
launder pairing losses (measured: including it flatters the Revit storey from
0.615 to 0.875, because that building's multi-layer exterior assemblies do not
pair and the envelope is recovered by add_perimeter instead. That is the
engine working as designed, and also exactly the thing to keep visible).
Thickness error is near-zero BY CONSTRUCTION where pairing succeeds — the gap
between synthesized faces IS the true thickness — so the assertion is exact:
any measured error means the centreline maths moved.

Room areas: ground-truth rooms are inner-face polygons; solved rooms are
finished-face (inset from centrelines), so the areas agree to a few percent
where subdivision is right, and the ratio bands are set from measurement, not
from hope. Room COUNTS under-shoot the truth (14/18, 13/28, 22/60): rooms
whose doors carry no gap on the sheet or whose partitions did not pair merge
into neighbours. That is today's honest baseline — ratchet the floors up when
the engine improves; do not treat them as targets already met.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hypothesise import openings as op  # noqa: E402
from hypothesise.pair import Face, join_corners, pair_faces  # noqa: E402
from hypothesise.perimeter import add_perimeter  # noqa: E402
from solve import verify as vf  # noqa: E402
from solve.spaces import detect_spaces  # noqa: E402

try:
    from shapely.geometry import Polygon
except ImportError:  # pragma: no cover
    print("SKIP  shapely unavailable")
    sys.exit(0)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "plangraph"
DERIVED_PERIMETER = "<derived:perimeter>"

passed = 0
failed = 0


def ok(label: str, cond: bool, extra: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


class Label:
    """A TEXT entity as ingest would hand it over."""

    def __init__(self, x: float, y: float, text: str):
        self.x, self.y, self.text = x, y, text


# ---- Rendering ground truth back into a drawing -----------------------------


def gt_walls(doc: dict) -> list[tuple]:
    """(a, b, thickness, id) for every pairable ground-truth wall segment."""
    out = []
    for w in doc["walls"]:
        t = w.get("thickness")
        # The pairing stage's own admissible band. Ground truth outside it
        # (glass balustrades at 25 mm, one 460 mm plinth) is unrecoverable by
        # face pairing BY DESIGN and would only dilute the recall number.
        if t is None or not (0.05 <= t <= 0.45):
            continue
        for a, b in zip(w["pts"], w["pts"][1:]):
            if math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.5:
                out.append((tuple(a), tuple(b), t, w["id"]))
    return out


def synthesise_sheet(doc: dict) -> tuple[list[Face], list[Label]]:
    """
    The double-line drawing a CAD sheet would carry for these walls.

    Two deliberate realism choices, both measured before being chosen:

    * Only DOORS (and raw pass-through voids) cut the wall faces. A drawn
      window keeps its sill and frame lines across the wall band, so its
      linework survives — cutting windows too erased the KIT storey's
      ribbon-glazed facades entirely (24 windows x 1.5 m on an 18 m wall)
      and scored the pairing stage on a drawing no architect ever drew.

    * Faces longer than 6 m are split mid-run with a 4 cm gap, because real
      CAD linework arrives fragmented at junctions and `merge_collinear`
      exists to reassemble it. A test that hands the engine unbroken faces
      never exercises that stage.
    """
    faces: list[Face] = []
    labels: list[Label] = []

    openings_by_wall: dict[str, list[dict]] = {}
    for o in doc.get("openings", []):
        if o.get("kind") not in ("door", "openingelement"):
            continue
        if o.get("wall") and o.get("width"):
            openings_by_wall.setdefault(o["wall"], []).append(o)

    for a, b, t, wid in gt_walls(doc):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        dx, dy = dx / n, dy / n
        px, py = -dy, dx

        # A doorway appears TWICE in the ground truth: the structural opening
        # (IfcOpeningElement — 2.15 m where a sidelight flanks the door) and
        # the leaf (IfcDoor.OverallWidth, 0.9 m), at the same spot. What a
        # sheet draws as a GAP is the leaf; the sidelight keeps its frame
        # lines across the wall exactly as a window does. Cutting the full
        # structural width instead removed 73% of one real partition (5.86 m,
        # two such doorways) and no bridging can span what has no stubs left —
        # so overlapping records collapse to the NARROWEST, the leaf.
        raw = []
        for o in sorted(openings_by_wall.get(wid, []), key=lambda o: o["xy"]):
            ox, oy = o["xy"]
            along = (ox - a[0]) * dx + (oy - a[1]) * dy
            if 0 < along < n:
                raw.append((along, o["width"]))
        raw.sort()
        cuts = []
        for along, w in raw:
            if cuts and along - w / 2 < cuts[-1][1]:
                prev_lo, prev_hi, prev_along = cuts[-1]
                if w < prev_hi - prev_lo:
                    cuts[-1] = (max(0.0, along - w / 2),
                                min(n, along + w / 2), along)
                continue
            cuts.append((max(0.0, along - w / 2), min(n, along + w / 2), along))
        for lo, hi, along in cuts:
            labels.append(Label(a[0] + dx * along + px * 0.6,
                                a[1] + dy * along + py * 0.6, "DOOR"))
        cuts = [(lo, hi) for lo, hi, _ in cuts]

        spans, cursor = [], 0.0
        for lo, hi in cuts:
            if lo > cursor + 0.05:
                spans.append((cursor, lo))
            cursor = max(cursor, hi)
        if cursor < n - 0.05:
            spans.append((cursor, n))
        if not spans:
            spans = [(0.0, n)]

        fragmented = []
        for lo, hi in spans:
            if hi - lo > 6.0:
                mid = (lo + hi) / 2
                fragmented += [(lo, mid - 0.02), (mid + 0.02, hi)]
            else:
                fragmented.append((lo, hi))

        for side in (+0.5, -0.5):
            ox, oy = px * t * side, py * t * side
            for lo, hi in fragmented:
                faces.append(Face(
                    ax=a[0] + dx * lo + ox, ay=a[1] + dy * lo + oy,
                    bx=a[0] + dx * hi + ox, by=a[1] + dy * hi + oy,
                    layer="WALLS",
                ))
    return faces, labels


# ---- Scoring ----------------------------------------------------------------


def centreline_recall(gt: list[tuple], walls) -> tuple[float, float, float]:
    """
    (recall, median |thickness error|, fraction of samples with error > 3 cm).

    Samples every 25 cm of ground-truth centreline; a sample is covered when a
    PAIRED, non-perimeter wall runs within 15 cm at a compatible angle. The
    derived ring is excluded — see the module docstring for the measured reason.
    """
    covered = total = 0.0
    errors: list[float] = []
    for a, b, t, _wid in gt:
        n = math.hypot(b[0] - a[0], b[1] - a[1])
        dx, dy = (b[0] - a[0]) / n, (b[1] - a[1]) / n
        samples = max(2, int(n / 0.25))
        for i in range(samples):
            s = (i + 0.5) * n / samples
            x, y = a[0] + dx * s, a[1] + dy * s
            total += n / samples
            best = None
            for w in walls:
                if not w.paired or w.layer == DERIVED_PERIMETER:
                    continue
                wdx, wdy = w.bx - w.ax, w.by - w.ay
                wl = math.hypot(wdx, wdy)
                if wl < 1e-9:
                    continue
                wdx, wdy = wdx / wl, wdy / wl
                if abs(wdx * dx + wdy * dy) < math.cos(math.radians(8)):
                    continue
                along = (x - w.ax) * wdx + (y - w.ay) * wdy
                if along < -0.1 or along > wl + 0.1:
                    continue
                d = math.hypot(x - (w.ax + wdx * along), y - (w.ay + wdy * along))
                if d <= 0.15 and (best is None or d < best[0]):
                    best = (d, w.thickness)
            if best is not None:
                covered += n / samples
                errors.append(abs(best[1] - t))
    errors.sort()
    return (
        covered / total if total else 0.0,
        errors[len(errors) // 2] if errors else float("inf"),
        (sum(1 for e in errors if e > 0.03) / len(errors)) if errors else 1.0,
    )


def matched_one_to_one(doc: dict, spaces) -> tuple[int, int]:
    """
    Ground-truth rooms matched 1:1 by a solved space at >= 50% overlap.

    The metric that raw counts cannot fake: a courtyard read as a room, or a
    room split in two, inflates the solved count while THIS number stands
    still — it was what showed the assemble experiment's "lost 8 rooms" to be
    mostly lost fakes (hypothesise/assemble.py tells that story).
    """
    solved = []
    for s in spaces:
        if len(s.loop) >= 3:
            poly = Polygon(s.loop)
            solved.append(poly if poly.is_valid else poly.buffer(0))
    gt = []
    for r in doc.get("rooms", []):
        if len(r.get("poly", [])) < 3:
            continue
        g = Polygon(r["poly"])
        if not g.is_valid:
            g = g.buffer(0)
        if not g.is_empty and g.area > 1.2:
            gt.append(g)
    pairs = []
    for gi, g in enumerate(gt):
        for si, p in enumerate(solved):
            if p.intersects(g):
                overlap = g.intersection(p).area / g.area
                if overlap >= 0.5:
                    pairs.append((overlap, gi, si))
    pairs.sort(reverse=True)
    used_g, used_s = set(), set()
    matched = 0
    for _overlap, gi, si in pairs:
        if gi in used_g or si in used_s:
            continue
        used_g.add(gi)
        used_s.add(si)
        matched += 1
    return matched, len(gt)


def gt_room_area(doc: dict) -> tuple[int, float]:
    count, area = 0, 0.0
    for r in doc.get("rooms", []):
        if len(r.get("poly", [])) < 3:
            continue
        poly = Polygon(r["poly"])
        if poly.is_valid and poly.area > 1.2:
            count += 1
            area += poly.area
    return count, area


def run_pipeline(doc: dict):
    faces, labels = synthesise_sheet(doc)
    walls = pair_faces(faces)
    walls, holes, unhosted = op.from_text_labels(labels, walls)
    walls = add_perimeter(walls)
    walls = join_corners(walls)
    spaces = detect_spaces(walls)
    verdict = vf.check(input_segments=len(faces), walls=walls, spaces=spaces,
                       openings=holes, unhosted=unhosted)
    return faces, walls, holes, unhosted, spaces, verdict


# ---- The baselines ----------------------------------------------------------
#
# Measured, then set a step BELOW the measurement so floating-point noise
# cannot flap them. Two generations so far:
#
#   2026-08-25, first baseline:
#     kit-institute    recall 0.961  rooms 14/18  area x1.058
#     revit22          recall 0.615  rooms 13/28  area x1.037
#     nibs-office      recall 0.832  rooms 22/60  area x0.797
#
#   2026-08-26, after the corner-door end-extension in `from_text_labels`
#   (`_end_gap_candidate`): the dominant leak was a door flush against a
#   crossing wall — a gap between one wall's END and a perpendicular wall's
#   path, invisible to the collinear gap rule. Bridging it recovered most of
#   the missing rooms on every fixture, and the villa A/B was byte-identical
#   (the extension never fires there — its doors resolve from blocks and
#   collinear gaps first):
#     kit-institute    recall 1.000  rooms 26/18  area x1.029  unhosted 0
#     revit22          recall 0.690  rooms 32/28  area x0.994  unhosted 0
#     nibs-office      recall 0.881  rooms 61/60  area x0.885  unhosted 0
#
# Room counts now sit a little ABOVE truth — corridors and cores split at
# extended walls — hence the ceiling: over-splitting is cheap to tolerate but
# runaway splitting would hide under a floor-only assertion. revit22's recall
# is scored against per-leaf ground truth its multi-layer assemblies cannot
# match one-to-one (see hypothesise/assemble.py for the measured story);
# against assembly-merged truth the same run scores 0.919.
#
# A number going UP is an improvement: raise the floor to just under the new
# measurement. A number going DOWN is a regression in wall recovery, bridging,
# corner joining or room derivation — the fixture names which building's
# authoring style broke.

#   2026-08-26 again, after the synthesiser learned that a doorway's TWO
#   ground-truth records (structural opening incl. sidelight, and the leaf)
#   are one gap of LEAF width — a sheet draws sidelight frames across the
#   wall band like a window, and cutting the 2.15 m structural width had
#   destroyed partitions no bridging could reach (73% of one 5.86 m wall):
#     kit-institute    recall 1.000  rooms 27/18  area x1.028
#     revit22          recall 0.712  rooms 30/28  area x1.001  outliers 0.000
#     nibs-office      recall 0.922  rooms 69/60  area x0.885

#   2026-08-26 (third): `join_corners` now prefers a crossing that lands ON
#   the other wall over a nearer near-miss (ON_SEGMENT_TOLERANCE). polygonize
#   nodes exact touches, not near misses, so a 3 cm miss that won on reach
#   was leaking cycles. nibs matched 47 -> 48, and the REAL villa gained four
#   rooms and three names (21/14 -> 25/17) with its gate still clean.

CASES = [
    # (fixture, gt_wall_segments, min_recall, max_frac_err_3cm,
    #  room_count_band, area_ratio_band, min_matched_1to1)
    ("kit-institute--Erdgeschoss.json", 29, 0.99, 0.02, (24, 32), (0.95, 1.15),
     16),
    ("revit22-apartment--BT-A_1010_OG01_RDOK_3_000.json", 59, 0.69, 0.02,
     (28, 38), (0.94, 1.08), 22),
    ("nibs-office--Level_1.json", 136, 0.90, 0.02, (58, 75), (0.80, 1.05),
     47),
    # A SKEW plan, and the only one. Every fixture above is orthogonal because
    # every real building in the ground-truth set is, so the non-axis-aligned
    # path had no whole-pipeline coverage at all — which is how a UV
    # projection that stretched a 45-degree wall by 41.4% survived. This is an
    # AUTHORED fixture (see the `_synthetic--` prefix and the README), not a
    # real building: it is a diamond envelope at 45 degrees exactly on the
    # projection's branch, one interior wall at 22.5 degrees that is skew but
    # OFF the branch, and two axis-aligned controls — so a failure separates
    # "the branch" from "the projection".
    ("_synthetic--skew_diamond.json", 8, 0.99, 0.02, (7, 10), (0.95, 1.05), 8),
]

for (name, expect_gt, min_recall, max_bad, (min_rooms, max_rooms),
     (area_lo, area_hi), min_matched) in CASES:
    doc = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    tag = name.split("--")[0]

    gt = gt_walls(doc)
    ok(f"{tag}: fixture intact", len(gt) == expect_gt,
       f"{len(gt)} pairable gt walls")

    faces, walls, holes, unhosted, spaces, verdict = run_pipeline(doc)
    recall, thick_err, frac_bad = centreline_recall(gt, walls)

    ok(f"{tag}: centreline recall >= {min_recall}", recall >= min_recall,
       f"measured {recall:.3f}")
    # Exact by construction — the synthesized face gap IS the true thickness,
    # so any median error at all means the centreline maths moved.
    ok(f"{tag}: paired thickness is exact", thick_err <= 1e-6,
       f"median err {thick_err:.2e}")
    ok(f"{tag}: thickness outliers <= {max_bad:.0%}", frac_bad <= max_bad,
       f"measured {frac_bad:.3f}")

    n_rooms, gt_area = gt_room_area(doc)
    solved_area = sum(s.area for s in spaces)
    ratio = solved_area / gt_area if gt_area else 0.0
    ok(f"{tag}: rooms in [{min_rooms}, {max_rooms}]",
       min_rooms <= len(spaces) <= max_rooms,
       f"{len(spaces)} solved of {n_rooms} true")
    ok(f"{tag}: room area within [{area_lo}, {area_hi}] of truth",
       area_lo <= ratio <= area_hi, f"x{ratio:.3f} ({solved_area:.0f} m2)")
    matched, gt_count = matched_one_to_one(doc, spaces)
    ok(f"{tag}: true rooms matched 1:1 >= {min_matched}",
       matched >= min_matched, f"{matched}/{gt_count}")

    # Every labelled door resolves — collinear gap, corner extension, or a
    # plain host. Measured 0 unhosted on all three fixtures; one coming back
    # means a bridging path stopped reaching a door it used to reach.
    ok(f"{tag}: every door label hosts", unhosted == 0,
       f"{len(holes)} openings, {unhosted} unhosted")
    ok(f"{tag}: gate passes", verdict.ok,
       f"{len(verdict.blocking)} blocking / {len(verdict.warnings)} warnings")


# ---- The no-bridge canary ---------------------------------------------------
# KIT's door-leaf gaps (~1.0 m) rejoin through MERGE_GAP without any label,
# but its 2.1 m open pass-throughs (openings with no leaf) exceed it, and
# without label bridging those leak enough cycles that the storey solves only
# HALF its rooms (measured: 13 against 26-27 with bridging; back when the
# synthetic sheet cut full structural widths it was ZERO). If this ratio
# collapses toward parity, the doorway-leak assumption has moved (MERGE_GAP
# grew, or corner joining learned to span gaps): re-measure the three cases
# above and re-set their floors, because bridging is then doing different work.
doc = json.loads((FIXTURES / CASES[0][0]).read_text(encoding="utf-8"))
faces, _labels = synthesise_sheet(doc)
unbridged = detect_spaces(join_corners(pair_faces(faces)))
ok("kit-institute: without bridging, wide pass-throughs still halve the rooms",
   0 < len(unbridged) <= 14, f"{len(unbridged)} rooms vs 26 bridged")


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
