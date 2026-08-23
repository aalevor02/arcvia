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

# ---- Classification: the words that route a label ------------------------

ok("a pool is outdoor", L.classify("SWIMMING POOL") == "outdoor")
ok("a lawn is outdoor", L.classify("LAWN") == "outdoor")
ok("a wardrobe is a fitting, not a room", L.classify("WARDROBE") == "fitting")
ok("a bedroom is a room", L.classify("BEDROOM") == "room")
ok("a fitting word wins a compound label", L.classify("BEDROOM WARDROBE") == "fitting")
ok("a section mark is noise", L.classify("SECTION A-A") in ("noise", "room"))


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
