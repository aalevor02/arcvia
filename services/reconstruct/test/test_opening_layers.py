"""
Openings drawn as linework, not blocked.

Run:  .venv/Scripts/python.exe test/test_opening_layers.py

The fixture is the real symbol this emitter was written for, measured off
`SITE PLAN FOR 3D 16-02-24.dxf`. Each of that sheet's 15 windows is drawn on
layer `WINDOW1` as:

    two 2.00 m lines running ALONG the wall, 0.23 m apart — which is the
    wall's own thickness, so they are its two faces —
    plus one 0.60 m line ACROSS the opening.

45 lines, 15 windows. The emitter has to turn 3 lines into 1 opening of 2.00 m
and must not turn the 0.60 m cross-tick into a third window of its own.

What each case here is defending:

* PROJECT, THEN MERGE. The two face lines are 0.23 m apart in free space and
  would need a proximity rule to cluster; projected onto their shared host wall
  they occupy the SAME range and merge with no such rule.
* Two windows on opposite faces of one partition are also 0.23 m apart. Any
  proximity rule loose enough to join one window's own lines joins these two as
  well; projection keeps them apart, because they land at different positions
  along the wall.
* The cross-tick is rejected on ANGLE, not on length. A 0.60 m minimum width
  would also reject a genuine 600 mm ventilator.
* A layer naming both doors and windows refuses rather than guessing, and says
  so — `A4 DOOR WIN` is a real layer in this corpus.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hypothesise.openings import (  # noqa: E402
    MAX_LABELLED_GAP, from_opening_layers, is_opening_layer, opening_layer_kind,
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


class W:
    def __init__(self, ax, ay, bx, by):
        self.ax, self.ay, self.bx, self.by = ax, ay, bx, by

    @property
    def length(self):
        return math.hypot(self.bx - self.ax, self.by - self.ay)


class Seg:
    def __init__(self, ax, ay, bx, by, layer):
        self.ax, self.ay, self.bx, self.by, self.layer = ax, ay, bx, by, layer


print("-- a layer name pre-selects and never decides --")
ok("WINDOW1 is a window layer", opening_layer_kind("WINDOW1") == "window")
ok("door is a door layer", opening_layer_kind("door") == "door")
ok("A4 DOOR WIN names both, so it refuses",
   opening_layer_kind("A4 DOOR WIN") is None)
ok("as does 'doors & windows'", opening_layer_kind("doors & windows") is None)
ok("but it is still recognised AS an opening layer",
   is_opening_layer("A4 DOOR WIN") and is_opening_layer("doors & windows"))
ok("a wall layer is neither", opening_layer_kind("A1 WALLS") is None
   and not is_opening_layer("A1 WALLS"))
ok("WIN only counts as a whole word", not is_opening_layer("TWIN BED"))
ok("and WINDING is not a window", not is_opening_layer("WINDING PATH"))

print("\n-- the real symbol: three lines, one window --")
# A 6 m wall running north. The window sits from 1.0 to 3.0 m along it.
WALL = W(0, 0, 0, 6)
symbol = [
    Seg(-0.115, 1.0, -0.115, 3.0, "WINDOW1"),   # outer face
    Seg(+0.115, 1.0, +0.115, 3.0, "WINDOW1"),   # inner face
    Seg(-0.30, 2.0, +0.30, 2.0, "WINDOW1"),     # the cross tick
]
issues: list[dict] = []
out, unhosted = from_opening_layers(symbol, [WALL], issues=issues)
ok("three lines make ONE opening", len(out) == 1, str(len(out)))
ok("it is a window", out and out[0].kind == "window")
ok("2.00 m wide, measured off the linework",
   out and abs(out[0].width - 2.0) < 1e-9, f"{out[0].width:.3f}" if out else "-")
ok("centred at 2.00 m along the wall",
   out and abs(out[0].along - 2.0) < 1e-9, f"{out[0].along:.3f}" if out else "-")
ok("hosted on the wall it was drawn in", out and out[0].wall == 0)
ok("nothing went unhosted", unhosted == 0, str(unhosted))
ok("and it is marked as the weaker evidence it is",
   out and out[0].source == "openingLayer" and out[0].confidence < 0.92,
   f"{out[0].confidence}" if out else "-")

print("\n-- the cross tick is refused on ANGLE, not on length --")
ok("the tick is recorded, not silently dropped",
   any(i.get("reason") == "crosses-walls-but-runs-along-none" for i in issues),
   str([i.get("reason") for i in issues]))
# It crosses a wall rather than missing every wall, and those are different
# facts about the drawing: one is linework that was never an opening, the other
# is an opening whose wall was not reconstructed. Only the second is a loss.
ok("and it did not inflate the unhosted count", unhosted == 0)
ok("the refusal says a wall was near, just not parallel",
   any(i.get("reason") == "crosses-walls-but-runs-along-none"
       and i.get("nearestWallDistance") is not None for i in issues))

print("\n-- the wall is chosen BY orientation, not just by nearness --")
# The measured failure: in a dense run the nearest wall to a symbol's midpoint
# is often a PERPENDICULAR partition, and against that wall the tick looks like
# a glazing line and the glazing line looks like a tick. Hosting the midpoint
# first and grading the angle afterwards produced 13 windows of 0.60 m and 5 of
# 2.00 m on a sheet whose truth is 15 of 2.00 m.
PARTITION = W(-0.05, 2.0, -1.5, 2.0)          # meets the wall at the window
near_partition = [
    Seg(-0.115, 1.0, -0.115, 3.0, "WINDOW1"),
    Seg(+0.115, 1.0, +0.115, 3.0, "WINDOW1"),
]
pw, _ = from_opening_layers(near_partition, [WALL, PARTITION])
ok("the glazing run still hosts on its own wall",
   len(pw) == 1 and pw[0].wall == 0, str([(o.wall, round(o.width, 2)) for o in pw]))
ok("with its true 2.00 m width, not the partition's reading",
   pw and abs(pw[0].width - 2.0) < 1e-9,
   f"{pw[0].width:.3f}" if pw else "-")

# The proof that length was not the discriminator: a genuine 600 mm ventilator
# drawn ALONG the wall is the same length as the tick and must survive.
vent = [Seg(-0.115, 4.0, -0.115, 4.6, "WINDOW1"),
        Seg(+0.115, 4.0, +0.115, 4.6, "WINDOW1")]
vout, _ = from_opening_layers(vent, [WALL])
ok("a 600 mm ventilator along the wall IS an opening", len(vout) == 1)
ok("and keeps its measured width",
   vout and abs(vout[0].width - 0.6) < 1e-9,
   f"{vout[0].width:.3f}" if vout else "-")

print("\n-- projection separates what proximity would merge --")
# Two windows on OPPOSITE faces of one 0.23 m partition, at different places
# along it. In free space their nearest lines are 0.23 m apart — the same gap
# that separates a single window's own two faces.
pair = [
    Seg(-0.115, 0.5, -0.115, 2.0, "WINDOW1"),
    Seg(-0.115, 3.5, -0.115, 5.0, "WINDOW1"),
]
pout, _ = from_opening_layers(pair, [WALL])
ok("two runs at different positions stay two openings", len(pout) == 2,
   str(len(pout)))
ok("and each keeps its own width",
   sorted(round(o.width, 3) for o in pout) == [1.5, 1.5],
   str(sorted(round(o.width, 3) for o in pout)))

print("\n-- refusals are recorded with their reason --")
amb = [Seg(-0.115, 1.0, -0.115, 3.0, "A4 DOOR WIN")]
ai: list[dict] = []
aout, _ = from_opening_layers(amb, [WALL], issues=ai)
ok("an ambiguous layer yields no opening", aout == [])
ok("and says why", any(i.get("reason") == "layer-names-both-door-and-window"
                       for i in ai), str(ai))

far = [Seg(50.0, 1.0, 50.0, 3.0, "WINDOW1")]
fi: list[dict] = []
fout, funhosted = from_opening_layers(far, [WALL], issues=fi)
ok("linework with no wall near it is unhosted", funhosted == 1 and fout == [])
ok("and the refusal carries the distance to the nearest wall",
   any(i.get("reason") == "no-wall-within-host-radius"
       and i.get("nearestWallDistance") is not None for i in fi), str(fi))

wide = [Seg(-0.115, 0.1, -0.115, 0.1 + MAX_LABELLED_GAP + 1.0, "WINDOW1")]
wi: list[dict] = []
wout, _ = from_opening_layers(wide, [W(0, 0, 0, 40)], issues=wi)
ok("an implausibly wide run is refused", wout == [])
ok("and names the band it failed",
   any(i.get("reason") == "implausible-width" for i in wi), str(wi))

print("\n-- a run wider than its wall is not an opening in that wall --")
# Why this guard earns its place, from the real drawing: an opening drawn as a
# GAP in a wall run has no wall at its own midpoint, by construction. On
# `SITE PLAN FOR 3D` frame 2 a 2.00 m window sits between a 0.52 m stub and a
# 0.75 m stub, collinear with both and touching each at an endpoint. Hosting by
# midpoint can therefore settle a 2 m run on a half-metre stub beside the gap,
# and the clamp would then place it outside the wall without complaint.
STUB = W(0, 0, 0, 0.52)
wide_run = [Seg(-0.115, 0.0, -0.115, 2.0, "WINDOW1"),
            Seg(+0.115, 0.0, +0.115, 2.0, "WINDOW1")]
si: list[dict] = []
sout, _ = from_opening_layers(wide_run, [STUB], issues=si)
ok("a 2.00 m run does not become an opening in a 0.52 m stub", sout == [],
   str([(round(o.width, 2), o.wall) for o in sout]))
ok("and the refusal names the wall it was too wide for",
   any(i.get("reason") == "host-wall-too-short"
       and i.get("hostWallLength") == 0.52 for i in si), str(si))
# The mirror: the same run on a wall long enough to hold it is fine.
fits, _ = from_opening_layers(wide_run, [W(0, -1, 0, 4)])
ok("the same run in a wall long enough IS an opening", len(fits) == 1)

print("\n-- an opening drawn AS the gap in a wall run --")
# The shape that motivated bridging, taken from the measured case: a window
# occupies y 2.0..4.0 of a wall that runs y 0..2.0 and then resumes y 4.0..8.0.
# There is no wall at the opening's midpoint, by construction, so every host
# test here fails on it — and the wall above begins 1.00 m away, which loses to
# HOST_RADIUS of 0.9 by ten centimetres. That looks like a tolerance and is not
# one: widening the radius hosts the window on a wall it does not sit in.
from hypothesise.openings import bridge_opening_runs  # noqa: E402
from hypothesise.pair import Wall  # noqa: E402


def wall(ax, ay, bx, by):
    return Wall(ax=ax, ay=ay, bx=bx, by=by, thickness=0.23, paired=True,
                confidence=0.9, layer="Wall")


BELOW, ABOVE = wall(0, 0, 0, 2.0), wall(0, 4.0, 0, 8.0)
run = [Seg(-0.115, 2.0, -0.115, 4.0, "WINDOW1"),
       Seg(+0.115, 2.0, +0.115, 4.0, "WINDOW1")]

ok("the run cannot host while the wall is interrupted",
   from_opening_layers(run, [BELOW, ABOVE])[0] == [])

bridged_walls, bridges = bridge_opening_runs(run, [BELOW, ABOVE])
ok("one bridge is made", len(bridges) == 1, str(bridges))
ok("two walls become one", len(bridged_walls) == 1, str(len(bridged_walls)))
ok("and it spans the whole run", bridged_walls and
   abs(bridged_walls[0].length - 8.0) < 1e-6,
   f"{bridged_walls[0].length:.3f}" if bridged_walls else "-")
ok("the bridge records the gap it closed",
   bridges and abs(bridges[0]["gap"] - 2.0) < 1e-6, str(bridges))

after, after_unhosted = from_opening_layers(run, bridged_walls)
ok("and now the window hosts", len(after) == 1 and after_unhosted == 0)
ok("at its true 2.00 m width",
   after and abs(after[0].width - 2.0) < 1e-9,
   f"{after[0].width:.3f}" if after else "-")
ok("centred in the gap, not at the wall's middle",
   after and abs(after[0].along - 3.0) < 1e-6,
   f"{after[0].along:.3f}" if after else "-")

print("\n-- a bridge needs the gap to be the one the run lies in --")
# Without this a 0.60 m ventilator closes a 2 m doorway elsewhere and reports
# it as its own. The run and the gap may differ by up to a wall thickness,
# because the run is drawn on a FACE and the gap is measured between
# CENTRELINES — 2.00 against 2.116 on the real drawing — and by no more.
tick = [Seg(-0.115, 2.7, -0.115, 3.3, "WINDOW1")]      # 0.6 m, inside a 2 m gap
ti: list[dict] = []
tw, tb = bridge_opening_runs(tick, [BELOW, ABOVE], issues=ti)
ok("a 0.60 m run does not close a 2.00 m gap", tb == [], str(tb))
ok("the walls are left alone", len(tw) == 2)
ok("and the mismatch is recorded",
   any(i.get("reason") == "gap-does-not-match-run" for i in ti), str(ti))

print("\n-- an intact wall is never bridged --")
intact = [Seg(-0.115, 2.0, -0.115, 4.0, "WINDOW1")]
iw, ib = bridge_opening_runs(intact, [wall(0, 0, 0, 8.0)])
ok("a run whose wall is whole makes no bridge", ib == [])
ok("and the wall list is unchanged", len(iw) == 1)

print("\n-- nothing in, nothing out --")
ok("no segments is not an error", from_opening_layers([], [WALL]) == ([], 0))
ok("segments but no walls are all unhosted",
   from_opening_layers(symbol, [])[1] == 3,
   str(from_opening_layers(symbol, [])[1]))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
