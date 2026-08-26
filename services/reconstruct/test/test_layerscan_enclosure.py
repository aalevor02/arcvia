"""
A layer's pairing verdict does not decide whether it holds walls.

Run:  .venv/Scripts/python.exe test/test_layerscan_enclosure.py

── The real drawing behind this ──────────────────────────────────────────────
A Norwegian residential DWG a client actually uploaded
(`services/api/.data/uploads/cad/.../74ea2637....dwg`). Its wall faces are
split across two layers, so NEITHER pairs into walls on its own the way the
scanner expects:

    layer        segs   self-pairs   verdict                          rooms
    A-WALL        133   26 @ 0.150   WALLS                                0
    inne_gulv     179   37 @ 0.050   pairs, but not at wall thicknesses  11

`inne_gulv` is Norwegian for "inner floor"; it reads like floor-finish
hatching and the report said so. It is in fact the inner face of the
building's walls. Selecting on the verdict gave 3 rooms and a BLOCKED verify;
including the dismissed layer gives 33 rooms, 10 named, and a clean pass.

Two things are pinned here, on a synthetic drawing with the same SHAPE (the
real DWG is not a fixture — it is a client's file):

  * `encloses` measures what the verdict cannot — a layer of pure ink lines
    that happens to close rooms is reported as closing them;
  * the report's hint fires exactly when a dismissed layer out-encloses every
    endorsed one, and stays silent otherwise. A hint that cried wolf on
    ordinary drawings would be worse than no hint.

The refuted alternative is recorded in `layerscan.encloses`: measuring a
"gain" in PAIR COUNT from combining two layers does not work, because pairing
is greedy and exclusive — combining yields fewer pairs than the sum of the
solos while producing far better ones.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hypothesise.pair import Face  # noqa: E402
from solve import layerscan  # noqa: E402

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


def face(x0, y0, x1, y1, layer):
    return Face(ax=x0, ay=y0, bx=x1, by=y1, layer=layer)


# A 10 x 8 m box with a partition, drawn the way the real file draws it: the
# OUTER face of every wall on one layer, the INNER face on another. Neither
# layer pairs into a wall alone; together they are the building.
T = 0.2
OUTER, INNER = [], []
# Three sides, not four. Real wall-face linework arrives trimmed at every
# junction and opening, which is why the outer-face layer of the client's
# drawing pairs 26 walls and still closes nothing — a bare closed rectangle
# would close a room by itself and would not be the case under test.
for (x0, y0, x1, y1) in [(0, 0, 10, 0), (10, 0, 10, 8), (10, 8, 0, 8)]:
    OUTER.append(face(x0, y0, x1, y1, "A-WALL"))
# inner ring, inset by the wall thickness
for (x0, y0, x1, y1) in [(T, T, 10 - T, T), (10 - T, T, 10 - T, 8 - T),
                         (10 - T, 8 - T, T, 8 - T), (T, 8 - T, T, T)]:
    INNER.append(face(x0, y0, x1, y1, "inne_gulv"))
# a partition, both of its faces on the INNER layer, so that layer alone
# closes rooms while the outer layer closes nothing
INNER.append(face(5.0, T, 5.0, 8 - T, "inne_gulv"))
INNER.append(face(5.0 + T, T, 5.0 + T, 8 - T, "inne_gulv"))

# `encloses` skips anything under MIN_SEGMENTS, so pad both layers with the
# kind of short ink the scanner sees on a real sheet, well clear of the walls.
for i in range(12):
    OUTER.append(face(20 + i, 0, 20 + i, 0.3, "A-WALL"))
    INNER.append(face(20 + i, 2, 20 + i, 2.3, "inne_gulv"))

BY_LAYER = {"A-WALL": OUTER, "inne_gulv": INNER}

print("-- enclosure is measured per layer, independent of the verdict --")
enclosed = layerscan.encloses(BY_LAYER)
ok("the outer-face layer closes nothing alone",
   enclosed.get("A-WALL", -1) == 0, str(enclosed.get("A-WALL")))
ok("the inner-face layer closes rooms alone",
   enclosed.get("inne_gulv", 0) >= 1, str(enclosed.get("inne_gulv")))

# NOT asserted: that combining the two layers encloses at least as much as
# either alone. It is intuitive and it is FALSE — measured here, the combined
# pool encloses 0 where the inner layer alone encloses 1, because pairing is
# greedy and exclusive: adding the outer faces changes which pairs form and
# moves every centreline by half a thickness. That is the same effect that
# refuted the pair-count "gain" metric (see `layerscan.encloses`). Enclosure
# is a property of a POOL, never a quantity that adds up across layers, and a
# test asserting otherwise would be pinning a comfortable falsehood.

print("-- the report hint fires only when a dismissal is out-enclosed --")


def hint_fires(scores: list[dict]) -> bool:
    """The rule `_print_layers` applies, evaluated on its own."""
    dismissed = [s for s in scores
                 if s["verdict"] != "WALLS" and s.get("encloses", 0) > 0]
    endorsed = max((s.get("encloses", 0) for s in scores
                    if s["verdict"] == "WALLS"), default=0)
    return any(s["encloses"] > endorsed
               for s in sorted(dismissed, key=lambda r: -r["encloses"])[:3])


ok("fires on the real drawing's shape",
   hint_fires([
       {"name": "A-WALL", "verdict": "WALLS", "encloses": 0},
       {"name": "inne_gulv", "verdict": "pairs, but not at wall thicknesses",
        "encloses": 11},
   ]))
ok("silent when the endorsed layers already enclose more",
   not hint_fires([
       {"name": "A1 WALLS", "verdict": "WALLS", "encloses": 9},
       {"name": "A2 HATCH", "verdict": "pairs at inconsistent thicknesses",
        "encloses": 2},
   ]))
ok("silent when nothing is dismissed at all",
   not hint_fires([
       {"name": "A1 WALLS", "verdict": "WALLS", "encloses": 4},
       {"name": "A5 FALSE CEILING", "verdict": "WALLS", "encloses": 6},
   ]))
ok("silent when the dismissed layer encloses nothing either",
   not hint_fires([
       {"name": "A1 WALLS", "verdict": "WALLS", "encloses": 0},
       {"name": "A6 PLUMBING", "verdict": "no pairs", "encloses": 0},
   ]))

print("-- the blocked-build re-seed ranks by enclosure, and keeps the partners --")
import cli  # noqa: E402

REAL_SHAPE = {
    "scores": [
        {"name": "A-WALL", "verdict": "WALLS", "encloses": 0, "paired": 26},
        {"name": "A-SECTMBM", "verdict": "WALLS", "encloses": 0, "paired": 6},
        {"name": "inne_gulv", "verdict": "pairs, but not at wall thicknesses",
         "encloses": 11, "paired": 37},
    ]
}
_saved = cli.layer_report
try:
    cli.layer_report = lambda *a, **k: REAL_SHAPE
    seed = cli._enclosure_seed("x", "y")
    ok("the enclosing layer leads the seed", seed and seed[0] == "inne_gulv",
       str(seed))
    ok("the endorsed wall layers are kept as its partners",
       seed is not None and {"A-WALL", "A-SECTMBM"} <= set(seed), str(seed))

    # Nothing encloses anything: there is no better seed to offer, and
    # substituting a differently-wrong one would hide the diagnosis.
    cli.layer_report = lambda *a, **k: {"scores": [
        {"name": "A-WALL", "verdict": "WALLS", "encloses": 0, "paired": 26},
    ]}
    ok("returns None when no layer encloses anything",
       cli._enclosure_seed("x", "y") is None)
finally:
    cli.layer_report = _saved

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
