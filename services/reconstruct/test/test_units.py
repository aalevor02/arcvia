"""
Working out a drawing's unit from its walls.

Run:  .venv/Scripts/python.exe test/test_units.py

Synthetic throughout, because the answer has to be known exactly. A room drawn
as two-faced walls 0.23 m apart is in metres, full stop — and the same numbers
read as centimetres describe a 2.3 mm wall, which is the whole point.

── What this defends ───────────────────────────────────────────────────────────
A wrong unit is the most expensive silent failure this engine has. It does not
crash and it does not warn: it builds the villa a thousand times too small, or
reduces a 1,234 m site plan to a 12 m building with eleven rooms totalling
54.73 m² and a title block read as a room — and every downstream number, every
area, every clearance and the entire bill of quantities is confidently wrong.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.units import (  # noqa: E402
    DECISIVE_MARGIN,
    MIN_EVIDENCE,
    rank_units,
)

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


@dataclass
class Seg:
    """A raw wall-layer segment, in SOURCE units, as the kernel hands them over."""

    x1: float
    y1: float
    x2: float
    y2: float
    layer: str = "WALLS"


def building(rooms: int = 16, thickness: float = 0.23, unit_scale: float = 1.0):
    """
    A block of rooms drawn as two-faced walls, expressed in `1 / unit_scale`
    source units. `unit_scale=1.0` writes metres; 0.001 writes millimetres.

    The rooms share walls, which is what a real plan looks like and what gives
    pairing enough to work with.
    """
    per = 1.0 / unit_scale
    t = thickness * per
    w, h = 4.0 * per, 3.0 * per
    out: list[Seg] = []
    for k in range(rooms):
        x = k * w
        # Two faces per wall, four walls per room.
        out += [
            Seg(x, 0, x + w, 0), Seg(x + t, t, x + w - t, t),
            Seg(x, h, x + w, h), Seg(x + t, h - t, x + w - t, h - t),
            Seg(x, 0, x, h), Seg(x + t, t, x + t, h - t),
            Seg(x + w, 0, x + w, h), Seg(x + w - t, t, x + w - t, h - t),
        ]
    return out


print("-- the unit is read off the walls, at any scale --")
for label, scale in (("metres", 1.0), ("millimetres", 0.001),
                     ("centimetres", 0.01), ("feet", 0.3048)):
    verdict = rank_units(building(unit_scale=scale), (0.0, 0.0))
    ok(f"a drawing authored in {label} is read as {label}",
       verdict.decided and verdict.best.label == label,
       f"{verdict.best.label if verdict.best else 'none'}, {verdict.reason}")

print("\n-- and it is read from the WALLS, not the extents --")
# The defect this replaces: `_PLAUSIBLE = (3.0, 400.0)` in the vendored reader
# filters candidates by overall size, so a site plan larger than 400 m never
# gets metres offered at all. Twelve rooms in metres spans ~48 m; sixty spans
# ~240 m; a real site sheet exceeds the window entirely.
big = rank_units(building(rooms=120, unit_scale=1.0), (0.0, 0.0))
ok("a drawing far larger than any building is still read correctly",
   big.decided and big.best.label == "metres",
   f"{big.best.extent:.0f} m across, read as {big.best.label}")
ok("and its extent is nowhere in the decision",
   big.best.extent > 400.0, f"{big.best.extent:.0f} m")

print("\n-- the thickness it measures is a thickness a mason would build --")
metric = rank_units(building(thickness=0.23), (0.0, 0.0))
ok("a nine-inch wall measures 0.23 m",
   abs(metric.best.median_thickness - 0.23) < 0.005,
   f"{metric.best.median_thickness:.3f}")
half = rank_units(building(thickness=0.115), (0.0, 0.0))
ok("a four-and-a-half measures 0.115 m",
   abs(half.best.median_thickness - 0.115) < 0.005,
   f"{half.best.median_thickness:.3f}")

print("\n-- it refuses rather than guesses --")
# Margin and not score is this engine's ask-a-human signal, and a unit is
# exactly the kind of decision that must not be guessed confidently.
thin = rank_units(building(rooms=1)[:4], (0.0, 0.0))
ok("too little linework is refused, not answered",
   not thin.decided, thin.reason)
ok("and says so in words", "cannot tell you its own unit" in thin.reason
   or "margin" in thin.reason, thin.reason)

ok("nothing at all is refused", not rank_units([], (0.0, 0.0)).decided)
ok("and does not crash", rank_units([], (0.0, 0.0)).best is None)

print("\n-- the ranking is honest about what it considered --")
full = rank_units(building(), (0.0, 0.0))
ok("every candidate is reported, not just the winner",
   len(full.scores) == 5, str(len(full.scores)))
ok("ranked best first",
   all(full.scores[i].paired >= full.scores[i + 1].paired
       for i in range(len(full.scores) - 1)),
   str([s.paired for s in full.scores]))
ok("and the winner beats the runner-up decisively",
   full.margin >= DECISIVE_MARGIN,
   f"{full.margin:.1f}x, floor {DECISIVE_MARGIN}x")

report = full.as_dict()
ok("the report names how it decided", report["decidedBy"] == "wallThickness")
ok("and carries every candidate for a human to check",
   len(report["candidates"]) == 5)
ok("MIN_EVIDENCE is a real floor", MIN_EVIDENCE > 0)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
