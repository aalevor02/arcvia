"""
Scale inferred from the drawing, for plans that print no dimensions.

The failure guarded against is silent and total: a wrong metres-per-unit
produces a building that is entirely plausible and entirely the wrong size, and
every area, quantity and compliance check downstream inherits it without
complaint. `classify/units.py` records the same failure from the CAD side — a
12.3 m building that verified clean and was really 1,234 m.

    python test/test_plan_scale.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plan_scale import (  # noqa: E402
    AGREEMENT,
    InferredScale,
    Refusal,
    door_candidates,
    infer_scale_from_features,
    wall_candidates,
)

passed = 0
failed = 0


def ok(label: str, condition: bool, extra: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {label}{'  ' + str(extra) if extra else ''}")
    else:
        failed += 1
        print(f"FAIL  {label}{'  ' + str(extra) if extra else ''}")


# A 12 m wide plan drawn across the full image width, so metres_per_unit = 12.
MPU = 12.0
WALL_230 = 0.230 / MPU      # a nine-inch wall, normalised against image width
WALL_115 = 0.115 / MPU
DOOR_900 = 0.900 / MPU      # an internal door leaf, normalised


def near(value: float, expected: float, tolerance: float = 0.02) -> bool:
    return abs(value - expected) <= tolerance * expected


# ---- Candidates ------------------------------------------------------------

_walls = wall_candidates([WALL_230] * 5)
ok("four masonry rulers each produce a reading", len(_walls) == 4, str(len(_walls)))
ok("the true scale is among them",
   any(near(c.metres_per_unit, MPU) for c in _walls))

# One absurdly thick hatched wall must not move the answer.
_noisy = wall_candidates([WALL_230] * 9 + [WALL_230 * 40])
ok("thickness uses the median, not every wall",
   any(near(c.metres_per_unit, MPU) for c in _noisy))

ok("no walls, no candidates", wall_candidates([]) == [])
ok("nonsense thickness is ignored", wall_candidates([0.0, -1.0]) == [])
ok("every door votes", len(door_candidates([DOOR_900] * 3)) == 9,
   str(len(door_candidates([DOOR_900] * 3))))

# ---- The happy path --------------------------------------------------------

got = infer_scale_from_features([WALL_230] * 8, [DOOR_900] * 6)
ok("a wall and doors agree on a scale", isinstance(got, InferredScale),
   getattr(got, "detail", ""))
if isinstance(got, InferredScale):
    ok("the agreed scale is the true one", near(got.metres_per_unit, MPU),
       f"{got.metres_per_unit:.3f} vs {MPU}")
    ok("the method is marked inferred, not measured", got.method == "inferred")
    ok("the reviewer is told which rulers agreed",
       any("230" in n for n in got.agreed) and any("900" in n for n in got.agreed),
       "/".join(got.agreed))
    ok("spread is reported and tight",
       got.spread is not None and got.spread <= AGREEMENT, str(got.spread))

    # The degeneracy that forced Ruler.prior to exist. 200/230 = 0.87 and
    # 750/900 = 0.83, so wall-200 + door-750 lands on a second internally
    # consistent scale with the SAME count across the SAME two kinds. Counting
    # cannot separate them, and more doors do not help — every door feeds both
    # clusters equally. Only the prior does.
    false_scale = 0.200 / WALL_230
    ok("the wall-200/door-750 conspiracy loses to the prior",
       not near(got.metres_per_unit, false_scale, 0.05),
       f"false reading would be {false_scale:.2f}")

partition = infer_scale_from_features([WALL_115] * 8, [DOOR_900] * 5)
ok("a plan of partition walls also resolves",
   isinstance(partition, InferredScale)
   and near(partition.metres_per_unit, MPU),
   getattr(partition, "detail", getattr(partition, "metres_per_unit", "")))

# ---- Refusals, which are the point ----------------------------------------

no_features = infer_scale_from_features([], [])
ok("nothing to measure refuses",
   isinstance(no_features, Refusal) and no_features.reason == "no-features")

# One kind of ruler is not evidence: a wall thickness alone is consistent with
# four scales differing by 2x, and nothing in the drawing chooses between them.
# This is the case that most tempts a fallback and where a fallback does most
# damage.
walls_only = infer_scale_from_features([WALL_230] * 20, [])
ok("walls alone refuse",
   isinstance(walls_only, Refusal)
   and walls_only.reason == "no-cross-kind-agreement",
   getattr(walls_only, "reason", "returned a scale"))

doors_only = infer_scale_from_features([], [DOOR_900] * 20)
ok("doors alone refuse",
   isinstance(doors_only, Refusal)
   and doors_only.reason == "no-cross-kind-agreement",
   getattr(doors_only, "reason", "returned a scale"))

contradictory = infer_scale_from_features([WALL_230] * 6, [DOOR_900 * 3] * 6)
ok("contradictory evidence refuses", isinstance(contradictory, Refusal),
   f"invented {getattr(contradictory, 'metres_per_unit', '')}")

ok("no refusal carries a scale",
   all(not hasattr(r, "metres_per_unit")
       for r in (no_features, walls_only, doors_only)))

# ---- Scale invariance ------------------------------------------------------

# The same building drawn at half the size on the sheet must come back at twice
# the metres-per-unit. That is what the number means.
big = infer_scale_from_features([WALL_230] * 6, [DOOR_900] * 4)
small = infer_scale_from_features([WALL_230 / 2] * 6, [DOOR_900 / 2] * 4)
ok("the answer scales with the drawing",
   isinstance(big, InferredScale) and isinstance(small, InferredScale)
   and near(small.metres_per_unit, big.metres_per_unit * 2),
   f"{getattr(big, 'metres_per_unit', '?')} then "
   f"{getattr(small, 'metres_per_unit', '?')}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
