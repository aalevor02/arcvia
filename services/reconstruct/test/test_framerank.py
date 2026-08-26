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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cli import (  # noqa: E402
    automatic_wall_layer_candidate,
    best_eligible_graded_index,
    best_graded_index,
    contained_frame_count,
    enclosure_retry_improves,
    fallback_frame_note,
    fallback_wall_layer_candidate,
    unresolved_unit_guidance,
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
ok("a coherent zero grade beats a disqualified zero grade",
   best_eligible_graded_index(
       [(0, 0, 0.0), (0, 0, 0.0)], ["fused", None],
   ) == 1)
ok("all errors still fall back to the incumbent",
   best_eligible_graded_index(
       [(0, 0, 0.0), (0, 0, 0.0)], ["fused", "bad envelope"],
   ) == 0)

print("\n-- a fused candidate cannot win against any real plan --")
# The LATEST DRAWINGS trap: an 11-wall stray cluster spanning the sheet graded
# at 77 named rooms BEFORE the fusion guard. The guard zeroes it, and zero
# loses to the weakest genuine plan.
ok("zeroed fusion loses to a 1-named plan",
   best_graded_index([(0, 0, 0.0), (1, 1, 20.2)]) == 1)

print("\n-- wall-layer and scope preflight --")
ok("false ceilings remain eligible wall evidence",
   automatic_wall_layer_candidate("A5 FALSE CEILING"))
ok("generic layer zero remains eligible",
   automatic_wall_layer_candidate("0"))
ok("opening layers never enter wall fitting",
   not automatic_wall_layer_candidate("doors & windows"))
ok("furniture layers never enter wall fitting",
   not automatic_wall_layer_candidate("furn"))
ok("a huge unknown layer without wall evidence is not fitted",
   not fallback_wall_layer_candidate(
       "ESMajor", 8242,
       SimpleNamespace(verdict="WALLS", paired_fraction=0.021),
   ))
ok("a small unknown partitions supplement remains eligible",
   fallback_wall_layer_candidate(
       "MISC", 120, SimpleNamespace(verdict="no pairs"),
   ))
ok("a large measured wall-like fallback remains eligible",
   fallback_wall_layer_candidate(
       "A5 FALSE CEILING", 900,
       SimpleNamespace(verdict="WALLS", paired_fraction=0.5),
   ))

class _Frame:
    def __init__(self, bbox):
        self.bbox = bbox


_outer = _Frame((0, 0, 20, 20))
_inner = _Frame((2, 2, 8, 8))
_overlap = _Frame((18, 18, 24, 24))
ok("a bbox containing another drawing is rejected before fitting",
   contained_frame_count(_outer, [_outer, _inner, _overlap]) == 1)
ok("mere overlap is not containment",
   contained_frame_count(_overlap, [_outer, _inner, _overlap]) == 0)

print("\n-- enclosure retry must improve without changing scale --")
_blocked = {
    "scale": 1.0,
    "rooms": {"count": 3, "named": 2},
    "verify": {"blocking": 1},
}
_recovered = {
    "scale": 1.0,
    "rooms": {"count": 33, "named": 10},
    "verify": {"blocking": 0},
}
ok("a same-scale enclosure recovery may replace a blocked build",
   enclosure_retry_improves(_blocked, _recovered))
_wrong_scale = {
    "scale": 0.001,
    "rooms": {"count": 1, "named": 1},
    "verify": {"blocking": 0},
}
ok("a retry cannot change units to escape verification",
   not enclosure_retry_improves(_blocked, _wrong_scale))
_less_evidence = {
    "scale": 1.0,
    "rooms": {"count": 4, "named": 1},
    "verify": {"blocking": 0},
}
ok("a retry cannot lose named-room evidence",
   not enclosure_retry_improves(_blocked, _less_evidence))

print("\n-- a blocked build points to the unresolved unit first --")
_unit_ask = SimpleNamespace(
    decided=False,
    best=SimpleNamespace(label="metres", scale=1.0),
)
ok("a different near-threshold unit is named in repair guidance",
   "metres (scale 1)" in unresolved_unit_guidance(_unit_ask, 0.01))
_unit_decided = SimpleNamespace(
    decided=True,
    best=SimpleNamespace(label="metres", scale=1.0),
)
ok("decided or matching units leave the reviewer on layer repair",
   unresolved_unit_guidance(_unit_decided, 0.01)
   == "Review the wall layers before building 3D."
   and unresolved_unit_guidance(_unit_ask, 1.0)
   == "Review the wall layers before building 3D.")

print("\n-- a drawing's title can say it is not a building --")
# Used to EXPLAIN `openings-present`, never to produce a finding and never in
# ranking. A site layout draws footprints, plots and roads; it carries no doors
# because doors are not what it is for.
from solve.verify import is_site_layout_title  # noqa: E402

ok("the sheet that cost a day is recognised",
   is_site_layout_title("REVISED SITE PLAN"))
ok("as are the other layout drawings",
   all(is_site_layout_title(t) for t in
       ("MASTER PLAN", "LAYOUT PLAN", "KEY PLAN", "SITE PLAN WITH GARDEN LEVELS")))

# The qualifier carries the meaning, not the word "plan" — these two differ
# only in what precedes it, and demoting a floor plan would be far worse than
# failing to explain a site plan.
ok("a floor plan is not a site layout",
   not any(is_site_layout_title(t) for t in
           ("GROUND FLOOR PLAN", "FIRST FLOOR PLAN", "Lower Ground Floor Plan")))
ok("a real corpus title that merely starts with BLOCK is not one",
   not is_site_layout_title("BLOCK - A FINAL CONCEPT PLANS"))
ok("no title is not a site layout",
   not is_site_layout_title(None) and not is_site_layout_title(""))

print("\n-- a fallback frame says it is a fallback --")
# `best_eligible_graded_index` returns the wall-count incumbent when nothing
# grades cleanly, which is right — a broken grade cannot promote anything. The
# defect was that nobody was told, so a fallback read exactly like a decision.
#
# The real case, with its real error strings: on `SITE PLAN FOR 3D` all four
# candidates errored, the incumbent was the 833 m site layout that BLOCKS, and
# frame 2 — rejected for the mildest reason of the four — builds a model that
# PASSES with 15 hosted doors.


class _Frame:
    def __init__(self, index, title, walls):
        self.index, self.title = index, title
        self.wall_indices = list(range(walls))


_site = _Frame(0, "REVISED SITE PLAN", 471)
_f1 = _Frame(1, None, 240)
_f2 = _Frame(2, None, 162)
_all_errored = [
    (_site, 0, 0, 0.0, 105, "scope contains 3 independently framed drawings"),
    (_f1, 0, 0, 0.0, 55, "reconstructed rooms split across a 5.83 m gap"),
    (_f2, 0, 0, 0.0, 110, "reconstructed rooms split across a 10.82 m gap"),
]

_note = fallback_frame_note(_all_errored, _site)
ok("an all-errored grade says the pick was not a choice",
   "wall-count fallback rather than a choice" in _note)
ok("and names the rejected frames as flags the operator can type",
   "--frame 1" in _note and "--frame 2" in _note, _note)
ok("carrying each one's reason",
   "10.82 m gap" in _note and "5.83 m gap" in _note)
ok("the incumbent does not list itself", "--frame 0" not in _note)

# Silence is the important half: this must not fire on the ordinary path, or
# every clean build grows a warning nobody reads and the real one is lost.
_one_clean = [(_site, 5, 9, 90.0, 105, None)] + _all_errored[1:]
ok("a single clean grade silences it", fallback_frame_note(_one_clean, _site) == "")
ok("nothing graded is not a fallback", fallback_frame_note([], _site) == "")
ok("an incumbent with no alternatives says nothing",
   fallback_frame_note([_all_errored[0]], _site) == "")

# A whole envelope-coverage paragraph would bury the frame numbers, which are
# the part that has to be read.
_long = [(_site, 0, 0, 0.0, 1, "x" * 400), (_f1, 0, 0, 0.0, 1, "y" * 400)]
ok("a long error is trimmed, not printed whole",
   len(fallback_frame_note(_long, _site)) < 300,
   str(len(fallback_frame_note(_long, _site))))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
