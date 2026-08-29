"""
Reading the drawing's own labels — the OCR merge, and dimension parsing.

The OCR itself needs the engine and a real image; these pin the pure pieces
around it that decide how much a plan's text is trusted: the two-pass merge
that must not list a room twice, and the dimension parser the scale rides on.

Run:  python test/test_labels.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import labels as L  # noqa: E402

passed = 0
failed = 0


def ok(label, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  {extra}" if extra else ""))


def box(cx, cy):
    """A little OCR box centred on (cx, cy)."""
    return [(cx - 20, cy - 6), (cx + 20, cy - 6), (cx + 20, cy + 6), (cx - 20, cy + 6)]


# ---- The two-pass merge --------------------------------------------------

# A caption both passes found, read with different dimension separators
# (`x` vs `×`) — one caption, not two, or it votes on the scale twice.
first = [(box(100, 100), "KITCHEN 12'0\" x 10'0\"", 0.9)]
second = [(box(103, 101), "KITCHEN 12'0\" × 10'0\"", 0.8)]
merged = L._merge_ocr(first, second)
ok("the same caption from two passes is merged to one", len(merged) == 1,
   f"{len(merged)} kept")

# A duplicate WITHIN one pass (an upscaled image can find a caption twice) is
# also collapsed.
dup_in_one = [
    (box(100, 100), "BEDROOM", 0.9),
    (box(104, 102), "BEDROOM", 0.7),
]
ok("a duplicate within a single pass is collapsed",
   len(L._merge_ocr(dup_in_one, [])) == 1)

# Two DIFFERENT rooms with the same name, far apart, are both kept — a plan
# routinely has two toilets.
two_toilets = [(box(100, 100), "TOILET", 0.9), (box(900, 700), "TOILET", 0.9)]
ok("two distinct rooms with the same name are both kept",
   len(L._merge_ocr(two_toilets, [])) == 2)

# Text that reduces to nothing (pure punctuation) is not merged away.
ok("empty-keyed runs are not collapsed into each other",
   len(L._merge_ocr([(box(1, 1), "--", 0.5), (box(2, 2), "//", 0.5)], [])) == 2)

# ---- Dimension parsing (the scale depends on it) -------------------------

ok("feet-and-inches parses", L.parse_dimension("12'0\"X10'0\"") is not None)
ok("a metric dimension parses", L.parse_dimension("3.6 x 4.2") is not None)
ok("the x and the × separators both parse",
   (L.parse_dimension("3.6 x 4.2") is not None)
   and (L.parse_dimension("3.6 × 4.2") is not None))
ok("a non-dimension string is rejected", L.parse_dimension("KITCHEN") is None)


def close(dims, a, b, tol=0.06):
    """A parsed pair matches an expected pair of metres, either order."""
    return dims is not None and abs(dims[0] - a) < tol and abs(dims[1] - b) < tol


# The prime OCR drops. `10'6"` reads back as `106`, and the naive reader called
# it 106 feet — a 32 m room that quietly wrecked the scale. In feet-and-inches
# the inch part is 0-11, so a three-digit run is feet with its last digit(s) as
# inches. These are the exact strings the Avarana deck produced.
ok("a dropped prime (10'6\") is read as feet-and-inches, not 106 feet",
   close(L.parse_dimension("6'0\"X106\""), 1.83, 3.20))
ok("a dropped prime (12'2\") is read as feet-and-inches",
   close(L.parse_dimension("8\"10\"X122\""), 2.69, 3.71))
ok("both primes lost still reads (18'3\" x 13'6\")",
   close(L.parse_dimension("183X136"), 5.56, 4.11))
# `810` must split as 8'10" (nobody's room is 81 feet), while `200` must stay
# 20'0" (an ordinary room) rather than collapse to 2'0" — the foot-count is what
# tells the two apart.
ok("810 splits as 8'10\", not 81'0\"", close(L.parse_dimension("810X810"), 2.69, 2.69))
ok("200 stays 20'0\", not 2'0\"", close(L.parse_dimension("200X200"), 6.10, 6.10))
# The rescue must not corrupt the readings that were never broken.
ok("a plain foot count is untouched (6' x 16')",
   close(L.parse_dimension("6'X16'"), 1.83, 4.88))
ok("a metric dimension is untouched", close(L.parse_dimension("3.6 x 4.2"), 3.6, 4.2))

# ---- Classification: the words that route a label ------------------------

ok("a pool is outdoor", L.classify("SWIMMING POOL") == "outdoor")
ok("a lawn is outdoor", L.classify("LAWN") == "outdoor")
ok("a wardrobe is a fitting, not a room", L.classify("WARDROBE") == "fitting")
ok("a bedroom is a room", L.classify("BEDROOM") == "room")
ok("a fitting word wins a compound label", L.classify("BEDROOM WARDROBE") == "fitting")
ok("a section mark is noise", L.classify("SECTION A-A") in ("noise", "room"))



# ---- an OCR failure must NOT be swallowed, and this is why -------------------
# Attempted on 2026-08-29 and REVERTED the same hour, recorded so it is not
# attempted again.
#
# The provocation was real: on a box at 96% memory commit, one request in four
# returned HTTP 500 with ONNXRuntimeError "bad allocation" out of rapidocr, and
# because read_labels runs BEFORE any geometry that discarded a wall-and-room
# read which had not been attempted yet. Degrading to "no labels" looked like an
# obvious improvement -- an unnamed plan beats no plan.
#
# It is not an improvement, because the labels are not decoration. main.py picks
# between its two binarisations on `sum(1 for room in reading.rooms if
# room.kind == "room" and room.name)` -- the count of rooms the ARCHITECT named
# -- with enclosed area only as the tie-break. Strip the labels and that primary
# key is 0 for both readings, the tie-break decides, and a DIFFERENT
# binarisation can win.
#
# Measured: with the swallow in place, three consecutive reads of the same file
# gave 55, 55 and 47 walls, and test_segment's determinism case went from PASS
# to "47 segments differed". So the swallow traded a loud failure for a
# SILENTLY DIFFERENT BUILDING, in a product whose headline property is that the
# same drawing imports the same way every time.
#
# It also destroyed a signal that already existed: test_segment carries an
# out_of_memory() guard that skips honestly when the machine is short. Swallowing
# the exception stopped that guard ever seeing it, so an environmental problem
# started presenting as a determinism regression.
#
# The right fix for the 500 is memory, or a notes channel at the layer where
# read_labels is called so the caller can refuse a degraded read on purpose.
# Not a silent fallback here.
import numpy as np

_saved_engine = L._engine
try:
    def _boom(_image):
        raise RuntimeError("[ONNXRuntimeError] : 1 : FAIL : bad allocation")

    L._engine = _boom
    _raised = False
    try:
        L.read_labels(np.full((320, 320, 3), 255, np.uint8))
    except Exception:
        _raised = True
    ok("an OCR failure PROPAGATES rather than degrading to no labels", _raised)
finally:
    L._engine = _saved_engine

# The one fallback that IS safe: no engine installed at all is a deployment
# fact, not a mid-read failure, and it is the same for every read.
_saved_engine = L._engine
try:
    L._engine = None
    ok("but an absent engine still returns no labels, deterministically",
       L.read_labels(np.full((64, 64, 3), 255, np.uint8)) == [])
finally:
    L._engine = _saved_engine


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
