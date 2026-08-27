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


#: Loading the checkpoint needs memory this box does not always have. When the
#: live detector already holds a copy, a second one plus the OCR models exhausts
#: the allocator and onnxruntime raises "bad allocation" -- which surfaces as a
#: CRASHED FILE, so the runner reports exit 1 with no failing assertion. That is
#: indistinguishable from a real regression, and it has now cost two separate
#: investigations that both ended at "there was never a bug here".
#:
#: So the shortage is caught and NAMED. Skipped loudly, never passed: a suite
#: that reports success when it could not run is the exact failure this service
#: has spent the week being hardened against.
skipped = 0


def out_of_memory(error: BaseException) -> bool:
    return isinstance(error, MemoryError) or "bad allocation" in str(error).lower()


def note_skip(what: str, error: BaseException) -> None:
    global skipped
    skipped += 1
    print("")
    print("  SKIP  " + what + " -- not enough memory to load the checkpoint.")
    # The wrapper re-raises with the whole traceback in its message, so the
    # first 110 characters are the rapidocr import path and tell you nothing.
    cause = [line for line in str(error).splitlines() if line.strip()]
    print("        " + (cause[-1][:110] if cause else "no detail given"))
    print("        Something else is probably holding a model. These assertions")
    print("        are SKIPPED, not passed. Re-run with the detector stopped.")
    print("")


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
    try:
        loaded = seg.available()
    except Exception as error:  # noqa: BLE001
        if not out_of_memory(error):
            raise
        loaded = False
        note_skip("the stamped v6 artefact", error)
    else:
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

        # -- the input range must match the declared formula --------------------
        # The artefact declares `x = 2 * (rgb / 255) - 1`, so a correct tensor
        # spans [-1, 1]. The first version of preprocess() read `mean`/`std`
        # while the artefact carries `equivalent_mean`/`equivalent_std`, found
        # nothing, fell back to 0 and 1, and produced [0, 1] -- half the range.
        #
        # Nothing raised. Inference ran, the output was finite, and the class
        # distribution was plausible: it called this plan's BEDROOM a Living
        # Room at 33% and put Bed Room at 5%. With the range corrected the same
        # image gives Bed Room 26% and Living Room 13%, which matches the
        # drawing. A silently halved input is a wrong answer wearing a
        # confident face, and only ground truth exposes it.
        import numpy as _np  # noqa: PLC0415

        probe = _np.full((64, 64, 3), 255, dtype=_np.uint8)
        white = seg.preprocess(probe)
        black = seg.preprocess(_np.zeros((64, 64, 3), dtype=_np.uint8))
        check("white maps to the top of the declared range",
              abs(float(white.max()) - 1.0) < 1e-5, str(float(white.max())))
        check("black maps to the bottom of it, not to zero",
              abs(float(black.min()) + 1.0) < 1e-5, str(float(black.min())))
        check("so the span is 2.0, not the 1.0 an identity fallback would give",
              abs((float(white.max()) - float(black.min())) - 2.0) < 1e-5,
              str(float(white.max()) - float(black.min())))

        # A preprocess block this loader cannot read must REFUSE, because a
        # fallback that silently disagrees with the artefact is worse than none.
        saved = seg._normalisation
        try:
            seg._normalisation = {"colour_order": "RGB", "scale": "unknown-scheme"}
            seg.preprocess(probe)
            check("an unreadable preprocess block is refused", False, "it fell back")
        except seg.SegmentUnavailable as reason:
            check("an unreadable preprocess block is refused",
                  "does not understand" in str(reason), str(reason))
        finally:
            seg._normalisation = saved
else:
    print(f"  (skipped the stamped-artefact cases: {REAL} is not on this machine)")

# -- the whole point: this verdict does not move ------------------------------
# The vision adjudicator's railing verdict was measured non-deterministic —
# the same file through the same service gave 2 railings, then 1 boundary,
# then 0, then 1, at shifting locations. That verdict CHANGES GEOMETRY, so a
# client's balcony was open on one import and boxed in on the next. Asking
# twice and requiring agreement reduced the flicker and did not remove it.
#
# A checkpoint is deterministic. These assertions are the reason this backend
# exists, so they compare full results rather than counts: a count can match
# while the classification moved between two segments.
PLAN = r"A:\Tools\FloorplanModel\realdecks\49b4f5f96a40c7bddf27e09915de195e.png"
if Path(REAL).is_file() and Path(PLAN).is_file():
    import cv2  # noqa: PLC0415

    seg = fresh(FLOORPLAN_MODEL=REAL)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import main as detector  # noqa: PLC0415

    image = cv2.imread(PLAN)
    runs = []
    try:
        for _ in range(3):
            walls, _o, _r, _s = detector.detect_heuristic(image)
            walls, notes = seg.classify_walls(image, walls)
            runs.append([
                (w.kind, round(w.start.x, 4), round(w.start.y, 4)) for w in walls
            ])
    except Exception as error:  # noqa: BLE001
        if not out_of_memory(error):
            raise
        runs = []
        note_skip("the determinism cases", error)

if runs:
    check("the classification is identical across repeated runs",
          runs[0] == runs[1] == runs[2],
          f"{sum(1 for a, b in zip(runs[0], runs[1]) if a != b)} segments differed")
    railings = [k for k, _, _ in runs[0] if k == "railing"]
    check("and it actually found railings, so the above is not vacuous",
          len(railings) > 0, f"{len(railings)} railings")
    check("while leaving the rest as walls",
          sum(1 for k, _, _ in runs[0] if k == "wall") > len(railings),
          str(len(runs[0])))
elif not (Path(REAL).is_file() and Path(PLAN).is_file()):
    print("  (skipped the determinism cases: model or plan not on this machine)")

print(f"\n{passed} passed, {failed} failed"
      + (f", {skipped} SKIPPED -- this is NOT a clean run" if skipped else ""))
if failed:
    sys.exit(1)
if skipped:
    sys.exit(3)  # ran, but could not complete -- the runner reads this as blocked
