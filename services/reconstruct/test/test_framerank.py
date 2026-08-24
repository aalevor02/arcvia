"""
Which graded frame becomes frames[0].

Run:  .venv/Scripts/python.exe test/test_framerank.py

── What this defends ───────────────────────────────────────────────────────────
`frames[0]` used to be whichever cluster carried the most wall segments, and on
a many-drawing sheet that promoted elevation linework over the floor plan. The
replacement grades a shortlist of candidates through the pipeline's own
per-frame layer scan and picks by NAMED rooms — measured across the six-sheet
corpus on 2026-08-24, where raw label count and unnamed room count were each
shown to lie (a label cluster over no closable walls grades 11 labels / 0
rooms; elevations close hatching into unnamed boxes).

The decision itself is `cli.best_graded_index`, pure over (named, rooms, area)
rows so it can be tested without a drawing. Two properties are load-bearing:

  * Ties resolve to the EARLIEST row. The shortlist is built wall-count-first,
    so a grade that cannot separate the candidates changes nothing — the
    incumbent behaviour is the tie-break, not a new guess.
  * A disqualified candidate (its scope fuses several drawings — see the
    ranking pass in `reconstruct`) is passed in as all zeros, so it can win
    only if every candidate is disqualified, in which case the tie rule hands
    the pick back to the wall-count leader.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cli import best_graded_index  # noqa: E402

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


print("-- named rooms decide --")
ok("most named wins over more rooms",
   best_graded_index([(0, 11, 394.1), (10, 15, 361.1)]) == 1)
ok("most named wins over more area",
   best_graded_index([(5, 6, 66.5), (2, 2, 27.5), (0, 0, 900.0)]) == 0)

print("\n-- the villa, as graded on 2026-08-24 --")
# Lower Ground (13 named) over Ground (9 named): the flagship pick is
# unchanged by the ranking, which is the regression the reverted attempt
# demanded be measured.
ok("lower ground stays frames[0]",
   best_graded_index([(13, 15, 253.25), (9, 15, 241.71), (0, 2, 6.1)]) == 0)

print("\n-- tie-breaks --")
ok("named tie falls to rooms",
   best_graded_index([(5, 6, 100.0), (5, 9, 80.0)]) == 1)
ok("named+rooms tie falls to area",
   best_graded_index([(5, 6, 100.0), (5, 6, 120.0)]) == 1)
ok("full tie keeps the earliest — the wall-count incumbent",
   best_graded_index([(4, 4, 50.0), (4, 4, 50.0), (4, 4, 50.0)]) == 0)
ok("all disqualified keeps the earliest",
   best_graded_index([(0, 0, 0.0), (0, 0, 0.0)]) == 0)

print("\n-- a fused candidate cannot win against any real plan --")
# The LATEST DRAWINGS trap: an 11-wall stray cluster spanning the sheet graded
# at 77 named rooms BEFORE the fusion guard. The guard zeroes it, and zero
# loses to the weakest genuine plan.
ok("zeroed fusion loses to a 1-named plan",
   best_graded_index([(0, 0, 0.0), (1, 1, 20.2)]) == 1)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
