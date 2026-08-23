"""
The deck adapter's scale arithmetic, without a detector.

The HTTP calls to floorplan-ai need a running service and are exercised end to
end by hand; these pin the pure pieces the studio's confirm UI depends on — the
drawn span a printed size sits across, which anchor is offered first, and the
scale suggested as the confirmation's default. Those decide whether "the toilet
is 16 feet" produces the right building, so they are worth holding still.

Run:  .venv/Scripts/python.exe test/test_deck.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import deck_build as D  # noqa: E402

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


def rect(x0, y0, x1, y1):
    """A polygon in the detector's normalised {x,y} points."""
    return [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]


# ── The drawn span a printed size sits across ────────────────────────────────
# A square image: a room drawn 0.25 of the width across, printed 5 m, implies a
# scale of 20 m across the image. The panel's whole confirmation rests on this.
square = {
    "width": 1000, "height": 1000,
    "rooms": [{"name": "Bedroom", "kind": "room", "area": 0.1,
               "size": [5.0, 4.0], "polygon": rect(0.1, 0.1, 0.35, 0.3)}],
}
cands = D._confirm_candidates(square)
ok("a confirmable room reports its long side and drawn span",
   len(cands) == 1 and cands[0]["longSideMetres"] == 5.0)
ok("the implied scale is long side / drawn span",
   abs(cands[0]["impliedScale"] - 20.0) < 0.01, str(cands[0]["impliedScale"]))

# ── Aspect correction: a tall image must not stretch the building ────────────
# The scale is metres across the image WIDTH, but the detector normalises y by
# HEIGHT. On an image twice as tall as wide, a room's 0.2-of-height vertical span
# is 0.4 of the width in pixels, and THAT is what the metres divide by. Read
# naively as 0.2 it would call the building twice its true size. The vertical
# span (0.4) is now the long side, beating the 0.25 horizontal one.
tall = {
    "width": 500, "height": 1000,
    "rooms": [{"name": "Bedroom", "kind": "room", "area": 0.1,
               "size": [5.0, 4.0], "polygon": rect(0.1, 0.1, 0.35, 0.3)}],
}
tall_span = D._confirm_candidates(tall)[0]["drawnSpanFraction"]
ok("a vertical span is scaled into width units by the aspect",
   abs(tall_span - 0.4) < 0.01, f"{tall_span}")
ok("so the implied scale reflects the corrected span, not the raw fraction",
   abs(D._confirm_candidates(tall)[0]["impliedScale"] - 12.5) < 0.01)

# ── The anchor a small enclosed room beats a merged great-room ───────────────
# A big open-plan region carrying two names, and a small clean toilet. The
# toilet is the reliable anchor and must be offered first, even though the
# great-room is drawn larger.
mixed = {
    "width": 1000, "height": 1000,
    "rooms": [
        {"name": "Bedroom", "kind": "room", "area": 0.4, "also": ["Study", "Foyer"],
         "size": [5.6, 4.1], "polygon": rect(0.2, 0.1, 0.8, 0.6)},
        {"name": "Toilet", "kind": "room", "area": 0.03,
         "size": [1.8, 4.9], "polygon": rect(0.05, 0.3, 0.12, 0.55)},
    ],
}
mixed_cands = D._confirm_candidates(mixed)
ok("the small enclosed room is the first-offered anchor",
   mixed_cands[0]["room"] == "Toilet" and mixed_cands[0]["reliableAnchor"])
ok("the merged great-room is offered but not marked reliable",
   any(c["room"] == "Bedroom" and not c["reliableAnchor"] for c in mixed_cands))

# ── Suggested scale ignores the detector when it read too few dimensions ──────
# samples=1 is not trustworthy, so the suggestion comes from the reliable
# anchor's implied scale, not the lone merged vote the detector reported.
detection_thin = {**mixed, "scale": {"metres_per_unit": 8.95, "samples": 1, "spread": None}}
suggest = D._suggested_scale(detection_thin, mixed_cands)
toilet_scale = next(c for c in mixed_cands if c["room"] == "Toilet")["impliedScale"]
ok("a thin detector reading is overruled by the reliable anchor",
   abs(suggest - toilet_scale) < 0.01, f"suggest={suggest} toilet={toilet_scale}")

# When the detector DID agree across rooms, its own reading is trusted.
detection_trusted = {**mixed, "scale": {"metres_per_unit": 18.0, "samples": 4, "spread": 0.03}}
ok("a trustworthy detector reading is used as-is",
   D._suggested_scale(detection_trusted, mixed_cands) == 18.0)

# ── Filenames from captions ──────────────────────────────────────────────────
ok("a floor name becomes a clean stem", D._slug("Ground Floor Plan") == "ground-floor-plan")
ok("an empty caption still yields a stem", D._slug("") == "plan")
ok("punctuation collapses, not doubles", D._slug("A -- B") == "a-b")


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
