"""The segment backend refuses to guess, and says why.

No network, no real weights. The point of these assertions is not that the
backend detects anything -- it is that every way of being unable to run
produces a REASON rather than a wrong answer. The exported ONNX carries no
class map, so a consumer that hardcodes a 44-channel layout keeps running and
reads the wrong channel the first time anyone retrains. That failure has no
detection surface, which is why the refusals are the part worth testing.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

passed = 0
failed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {label}")
    else:
        failed += 1
        print(f"FAIL  {label}  {detail}")


def fresh(**env):
    """Re-import the module with a given environment, since it reads at import."""
    for key in ("FLOORPLAN_MODEL", "FLOORPLAN_CLASS_MAP"):
        os.environ.pop(key, None)
    os.environ.update({k: v for k, v in env.items() if v is not None})
    for name in list(sys.modules):
        if name == "segment":
            del sys.modules[name]
    import segment  # noqa: PLC0415
    return segment


# -- no weights at all --------------------------------------------------------
seg = fresh()
check("with no FLOORPLAN_MODEL it is unavailable, not crashed", seg.available() is False)
try:
    seg.load()
    check("and load() explains itself", False, "did not raise")
except seg.SegmentUnavailable as reason:
    check("and load() explains itself", "FLOORPLAN_MODEL is not set" in str(reason), str(reason))

# -- weights that are not there -----------------------------------------------
seg = fresh(FLOORPLAN_MODEL="A:/nowhere/absent.onnx")
try:
    seg.load()
    check("a missing weights file is named", False, "did not raise")
except seg.SegmentUnavailable as reason:
    check("a missing weights file is named", "is not a file" in str(reason), str(reason))

# -- the real checkpoint, which carries no class map --------------------------
# The STAMPED v6 artefact — the one that carries its own class map.
REAL = r"A:\Tools\FloorplanModel\kaggle\result6\p2\runs\floorplan_segment.onnx"
# The unstamped Aug-24 file, kept as the negative case: a real checkpoint
# that must be REFUSED rather than guessed at.
BARE = r"A:\Tools\FloorplanModel\runs\floorplan_segment.onnx"
if Path(BARE).is_file():
    seg = fresh(FLOORPLAN_MODEL=BARE)
    try:
        seg.load()
        check("a checkpoint with no class map is REFUSED", False,
              "it loaded, which means it guessed a layout")
    except seg.SegmentUnavailable as reason:
        text = str(reason)
        check("a checkpoint with no class map is REFUSED", "no class map" in text, text)
        # The refusal has to be actionable, or it just moves the problem.
        check("and the refusal says how to fix it",
              "metadata_props" in text and "FLOORPLAN_CLASS_MAP" in text, text)
        check("and says why guessing was not an option",
              "silently" in text or "wrong channel" in text, text)

    # -- a class map of the wrong width is the one stale-artefact case that
    # -- can be caught mechanically, so it must be.
    with tempfile.TemporaryDirectory() as tmp:
        wrong = Path(tmp) / "classes.json"
        wrong.write_text(json.dumps(["wall", "door", "window"]), encoding="utf-8")
        seg = fresh(FLOORPLAN_MODEL=BARE, FLOORPLAN_CLASS_MAP=str(wrong))
        try:
            seg.load()
            check("a class map that does not match the head width is REFUSED", False,
                  "it loaded a 3-class map against a 44-channel model")
        except seg.SegmentUnavailable as reason:
            text = str(reason)
            check("a class map that does not match the head width is REFUSED",
                  "44 channels" in text and "3 classes" in text, text)
            check("and it says the two are from different runs",
                  "different training run" in text, text)

    # -- a correct map loads, and describe() does not overstate what it knows
    with tempfile.TemporaryDirectory() as tmp:
        right = Path(tmp) / "classes.json"
        right.write_text(json.dumps([f"class{i}" for i in range(44)]), encoding="utf-8")
        seg = fresh(FLOORPLAN_MODEL=BARE, FLOORPLAN_CLASS_MAP=str(right))
        loaded = seg.available()
        check("a class map matching the head width loads", loaded is True)
        if loaded:
            described = seg.describe()
            check("describe() reports the class count", described.get("classes") == 44,
                  str(described))
            # The checkpoint declares no normalisation. Saying "assumed" rather
            # than reporting a number keeps a guess from reading as a fact.
            check("and reports normalisation as ASSUMED, not as a value",
                  described.get("normalisation") == "assumed", str(described))
else:
    print(f"  (skipped the unstamped cases: {BARE} is not on this machine)")

# -- the STAMPED artefact, where the relative-to-absolute resolve is the point --
if Path(REAL).is_file():
    seg = fresh(FLOORPLAN_MODEL=REAL)
    loaded = seg.available()
    check("the stamped v6 artefact loads", loaded is True)
    if loaded:
        classes = seg._classes
        idx = seg._extras.get("indices", {})
        # `railing_class_index: 8` is 8 WITHIN the rooms head, which starts at
        # 21. Channel 8 is a junction. A consumer reading the raw index as a
        # tensor channel is off by 21 on every symbol and confidently wrong,
        # with nothing in the output to show for it.
        check("railing resolves to an ABSOLUTE channel, not its relative index",
              idx.get("railing") == 29, str(idx))
        check("and channel 29 really is Railing", classes[29] == "Railing", classes[29])
        check("wall resolves the same way",
              idx.get("wall") == 23 and classes[23] == "Wall", str(idx))
        check("window resolves into the icons head",
              idx.get("window") == 34 and classes[34] == "Window", str(idx))
        check("the raw index would have read a junction",
              classes[8].startswith("junctions"), classes[8])
        check("junction channels are named positionally rather than left blank",
              all(classes[i] for i in range(21)), repr(classes[:2]))
        # The decoder dies on a multiple of 32 that is not a multiple of 64.
        check("the decoder's size constraint travels with the weights",
              seg._extras.get("dim_multiple") == 64, str(seg._extras.get("dim_multiple")))
        check("normalisation is DECLARED, not assumed",
              seg.describe().get("normalisation") == "declared", str(seg.describe()))
else:
    print(f"  (skipped the stamped-artefact cases: {REAL} is not on this machine)")

print(f"\n{passed} passed, {failed} failed")
if failed:
    sys.exit(1)
