"""Room naming: the classifier, and what happens to labels that never land.

WHY THIS FILE EXISTS
--------------------
41% of spaces across the built corpus carry `kind: unknown`, and the obvious reading is
that the name→kind classifier has gaps. **Measured across 51 built models — 792 spaces,
470 named — that reading is wrong:** every one of the 322 unknowns is UNNAMED, and there
are zero disagreements between a space's stored kind and a fresh `classify_room(name)`.
The classifier has never failed a name it was given.

So the constraint is upstream, in naming, and it used to report nothing at all: a label
the drawing printed and the model dropped left no trace, and the resulting room was
indistinguishable from one the drawing never labelled.

These tests therefore do two things: lock the classifier's current behaviour in place so a
future "improvement" cannot silently regress it, and assert that unplaced labels are
counted rather than discarded.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from classify.elements import classify_room            # noqa: E402
from solve.spaces import Space, summarise              # noqa: E402

PASSED = FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}  {detail}")


@dataclass
class L:
    """A room label, shaped like the ones `detect_spaces` consumes."""
    text: str
    x: float = 0.0
    y: float = 0.0


def space(index: int, name: str | None, area: float = 10.0) -> Space:
    return Space(index=index, loop=[(0, 0), (1, 0), (1, 1), (0, 1)],
                 area=area, gross_area=area, perimeter=4.0, name=name)


# Every distinct room label the 51 built models actually contain, with the kind the
# classifier assigns today. Locked in so a future edit has to be deliberate.
GOLDEN = [
    ("BED ROOM", "bedroom"), ("MASTER BED ROOM", "bedroom"),
    ("TOILET", "bathroom"), ("BATH", "bathroom"), ("W.C.", "bathroom"),
    ("shower", "bathroom"),
    ("KITCHEN", "kitchen"), ("UTILITY", "kitchen"),
    ("DINING", "dining"), ("LIVING", "living"), ("HALL", "living"),
    ("HOME OFFICE", "study"), ("STUDY", "study"),
    ("PASSAGE", "circulation"), ("FOYER", "circulation"), ("STAIR", "circulation"),
    ("DECK", "outdoor"), ("OFFICE PATIO", "outdoor"), ("Enclosed Balcony", "outdoor"),
    ("LAWN", "outdoor"), ("SWIMMING POOL", "unknown"),
    ("WALKIN", "dressing"), ("WALK-IN", "dressing"), ("DRESSING", "dressing"),
    ("STORE", "store"), ("CAR PARK", "parking"),
]

# Labels that must NOT be classified as a room kind. Title blocks and annotations reach
# the label pool, and a classifier that guessed at them would name rooms after the
# architect.
MUST_STAY_UNKNOWN = [
    "Architect", "Project", "VILLAS AT ASSAGAON", "Melville D'Souza",
    "Mr. Bennet & Bernard Custom Homes", "Provision for home lift",
    "Barbeque", "BAR", "DUCT", "SERVANT ROOM",
]


def main() -> int:
    print("CLASSIFIER — behaviour locked, not changed")
    for name, expected in GOLDEN:
        got = classify_room(name)
        check(f"{name!r} -> {expected}", got == expected, f"got {got!r}")

    print("\nFALLBACK — unknown is preserved, never guessed past")
    check("None -> unknown", classify_room(None) == "unknown")
    check("empty string -> unknown", classify_room("") == "unknown")
    check("whitespace -> unknown", classify_room("   ") == "unknown")
    check("an unrecognised word -> unknown",
          classify_room("ZZQX") == "unknown", classify_room("ZZQX"))

    print("\nNO FALSE POSITIVES — annotation text must not become a room kind")
    for name in MUST_STAY_UNKNOWN:
        got = classify_room(name)
        # SERVANT ROOM and DUCT are real rooms with no kind in the vocabulary; the
        # point is only that nothing invents one for them.
        check(f"{name!r} is not misclassified", got == "unknown", f"got {got!r}")

    print("\nSUMMARISE — backwards compatible without labels")
    spaces = [space(0, "LIVING", 30.0), space(1, None, 4.0), space(2, "TOILET", 2.0)]
    plain = summarise(spaces)
    check("returns the original keys unchanged",
          set(plain) == {"count", "totalArea", "named", "largest", "smallest"},
          sorted(plain))
    check("counts rooms and names", plain["count"] == 3 and plain["named"] == 2)
    check("no label keys appear when labels are not passed",
          "labelsOffered" not in plain)

    print("\nSUMMARISE — label accounting when labels ARE passed")
    labels = [L("LIVING"), L("TOILET"), L("BED ROOM"), L("PASSAGE"), L("Architect")]
    acc = summarise(spaces, labels=labels)
    check("labelsOffered counts every label", acc["labelsOffered"] == 5,
          str(acc.get("labelsOffered")))
    check("labelsPlaced counts the names that reached a space",
          acc["labelsPlaced"] == 2, str(acc.get("labelsPlaced")))
    check("labelsUnplaced counts the rest", acc["labelsUnplaced"] == 3,
          str(acc.get("labelsUnplaced")))
    check("unplacedNames names them, so the loss is legible",
          set(acc["unplacedNames"]) == {"BED ROOM", "PASSAGE", "Architect"},
          str(acc.get("unplacedNames")))
    check("the original keys survive alongside",
          acc["count"] == 3 and acc["named"] == 2)

    print("\nEDGE CASES")
    check("no labels offered is not an error",
          summarise(spaces, labels=[])["labelsUnplaced"] == 0)
    check("every label placed leaves nothing unplaced",
          summarise(spaces, labels=[L("LIVING"), L("TOILET")])["labelsUnplaced"] == 0)
    empty = summarise([], labels=[L("LIVING")])
    check("no spaces at all still accounts for the labels",
          empty["labelsUnplaced"] == 1 and empty["count"] == 0, str(empty))
    check("and keeps the no-enclosure warning", "warning" in empty)
    big = summarise(spaces, labels=[L(f"ROOM {i}") for i in range(40)])
    check("unplacedNames is capped at 25", len(big["unplacedNames"]) == 25,
          str(len(big["unplacedNames"])))
    check("but the COUNT is not capped", big["labelsUnplaced"] == 40,
          str(big["labelsUnplaced"]))

    print()
    if FAILED:
        print(f"FAILED: {FAILED} of {PASSED + FAILED}")
        return 1
    print(f"ALL {PASSED} CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
