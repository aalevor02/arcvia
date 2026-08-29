"""
The element classifier.

Run:  .venv/Scripts/python.exe -m test.test_classify

The case worth protecting is the third block below: the *same* footprint
resolving to different objects in different rooms. That is the whole reason
context is a signal and not a tie-breaker, and it is the behaviour that silently
regresses first if someone tunes the priors without a test watching.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from classify.elements import (  # noqa: E402
    REVIEW_MARGIN,
    classify_footprint,
    classify_layer,
    classify_room,
)
from vendor.cad_kernel import guess_item  # noqa: E402
from ingest.blocks import RoomLabel, usable_room_labels  # noqa: E402

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


def classify(**kw):
    kw.setdefault("guess_item", guess_item)
    return classify_footprint(**kw)


labels = [
    RoomLabel(0, 0, "MEDIA ROOM"),
    RoomLabel(1, 1, "PUJA"),
    RoomLabel(2, 2, "Ground Floor Plan"),
    RoomLabel(3, 3, "3.40 x 4.20"),
]
kept = usable_room_labels(labels)
ok("unknown custom room labels are retained", [x.text for x in kept] == ["MEDIA ROOM", "PUJA"])


# ---- Room names, as drawings actually write them --------------------------
print("\n-- room kinds --")
for name, expect in [
    ("BEDROOM-1", "bedroom"),
    ("TOILET-01", "bathroom"),
    ("WALK - IN", "dressing"),
    ("VERANDAH (Double height)", "outdoor"),
    ("FOYER", "circulation"),
    ("KITCHEN", "kitchen"),
    ("MBR", "bedroom"),
    ("GARDEN GROUND", "outdoor"),
    ("", "unknown"),
]:
    got = classify_room(name)
    ok(f"{name!r} -> {expect}", got == expect, got)


# ---- Layer names, which follow no convention ------------------------------
print("\n-- layer hints --")
for layer, expect in [
    ("A1 WALLS", "wall"),
    ("NEW WALLS", "wall"),
    ("doors & windows", "opening"),
    ("A4 DOOR WIN", "opening"),
    ("FURNITURE", "furniture"),
    ("SANITARY", "sanitary"),
    ("DIM", "annotation"),
    ("defpoints", "annotation"),
    ("KITCHEN PLATFORM", "joinery"),
]:
    got = classify_layer(layer)
    ok(f"{layer!r} -> {expect}", got == expect, got)


# ---- THE HEADLINE: one footprint, three rooms, three answers --------------
# A 2.0 x 0.6 m box pressed against a wall. Nothing about the geometry says
# what it is. Only the room does.
print("\n-- same footprint, different rooms --")
box = dict(width=2.0, depth=0.6, layer="FURNITURE", against_wall=True, block=None)

kitchen = classify(**box, room_name="KITCHEN")
bedroom = classify(**box, room_name="BEDROOM-1")
living = classify(**box, room_name="LIVING ROOM")

ok("in a kitchen it is a counter", kitchen.item == "counter", str(kitchen.item))
ok("in a bedroom it is not a counter", bedroom.item != "counter", str(bedroom.item))
ok("in a bedroom it is storage", bedroom.item in {"wardrobe", "chest", "bookshelf"},
   str(bedroom.item))
ok("in a living room it is neither", living.item not in {"counter"}, str(living.item))
ok("and the three do not all agree",
   len({kitchen.item, bedroom.item, living.item}) > 1,
   f"{kitchen.item} / {bedroom.item} / {living.item}")


# ---- Named blocks: the architect's own label ------------------------------
print("\n-- block names --")
tv = classify(width=1.2, depth=0.08, block="TV", layer="FURNITURE", room_name="LIVING")
ok("a TV block is found", tv.item == "tv", str(tv.item))
ok("and it is treated as wall-mounted", tv.signals["footprint"]["wallMounted"] is True)

shelf = classify(width=0.9, depth=0.35, block="BOOK SHELF", layer="FURNITURE",
                 room_name="STUDY", against_wall=True)
ok("a bookshelf block is found", shelf.item == "bookshelf", str(shelf.item))

tv_unit = classify(width=1.8, depth=0.45, block="TV UNIT", layer="FURN",
                   room_name="LIVING ROOM", against_wall=True)
ok("a TV unit is not the same as a TV", tv_unit.item == "tv-unit", str(tv_unit.item))

door = classify(width=0.75, depth=0.1, block="D750", layer="A4 DOOR WIN",
                room_name="BEDROOM-1")
ok("a sized door block is an opening, not furniture", door.label == "opening", door.label)
ok("and it keeps the catalogue id", door.item == "door", str(door.item))

window = classify(width=1.2, depth=0.1, block="W1200", layer="WINDOW1",
                  room_name="BEDROOM-1")
ok("a sized window block is an opening", window.label == "opening", window.label)


# ---- Short names the kernel refuses but that are real words ---------------
# `_MEANINGLESS` rejects two- and three-letter names as keyboard noise, which
# is right for `VXCBX` and wrong for `TV`. `_BLOCK_HINTS` carries rules for
# `tv`, `wc` and `wb` that are unreachable for the bare name.
print("\n-- short aliases --")
ok("the kernel really does refuse 'TV'", guess_item("TV") is None)
ok("and refuses 'WC'", guess_item("WC") is None)
ok("and refuses 'WB'", guess_item("WB") is None)

ok("but the classifier rescues TV", tv.item == "tv", str(tv.item))
ok("and says it used an alias", tv.signals["block"]["viaAlias"] is True)

wc = classify(width=0.37, depth=0.66, block="WC", layer="SANITARY",
              room_name="TOILET-02", against_wall=True)
ok("WC resolves to a toilet", wc.item == "wc", str(wc.item))

wb = classify(width=0.55, depth=0.42, block="WB", layer="SANITARY",
              room_name="TOILET-02", against_wall=True)
ok("WB resolves to a basin", wb.item == "basin", str(wb.item))

ac = classify(width=0.9, depth=0.3, block="AC", layer="FURNITURE",
              room_name="BEDROOM-1")
ok("an AC symbol is annotation, not an object", ac.label == "annotation", ac.label)

ok("a genuinely meaningless short name is still refused",
   classify(width=1.0, depth=1.0, block="VXCBX", layer="FURNITURE",
            room_name="LIVING").signals["block"]["item"] is None)


# ---- Exact aliases established from source geometry -----------------------
print("\n-- source-evidence aliases --")
deck_table = classify(width=1.401, depth=1.400, block="A$C47227FD2",
                      layer="A5 FURN", room_name="DECK", against_wall=True)
ok("the observed deck set resolves to a four-seat dining table",
   deck_table.item == "dining-table-4", str(deck_table.item))
ok("the deck set records that its exact alias supplied the identity",
   deck_table.signals["block"]["viaAlias"] is True)

tufted_chair = classify(width=0.871, depth=0.714, block="A$C6AB358AA",
                        layer="0", room_name="BEDROOM")
ok("the observed tufted chair resolves to an armchair",
   tufted_chair.item == "armchair", str(tufted_chair.item))

foyer_chair = classify(width=0.380, depth=0.445, block="CNCNC",
                       layer="A5 FURN", room_name="FOYER", against_wall=True)
ok("the repeated foyer block resolves to a dining chair",
   foyer_chair.item == "dining-chair", str(foyer_chair.item))

unseen_anonymous = classify(width=1.401, depth=1.400, block="A$C47227FD3",
                            layer="A5 FURN", room_name="DECK", against_wall=True)
ok("a neighbouring anonymous id does not inherit an evidence alias",
   unseen_anonymous.signals["block"]["item"] is None,
   str(unseen_anonymous.signals["block"]))


# ---- Anonymous blocks: what signal 3 exists for ---------------------------
# `guess_item` correctly refuses these. The footprint still identifies them.
print("\n-- anonymous blocks --")
ok("the kernel refuses to guess at an AutoCAD anonymous block",
   guess_item("A$C4F2A1B0") is None)
ok("and refuses keyboard mash", guess_item("dfgfg") is None)

anon_bed = classify(width=1.8, depth=2.0, block="A$C4F2A1B0", layer="FURNITURE",
                    room_name="BEDROOM-2")
ok("an unnamed 1.8 x 2.0 box in a bedroom is a bed",
   anon_bed.item in {"bed-queen", "bed-king"}, str(anon_bed.item))
ok("its block signal is empty, so the footprint did the work",
   anon_bed.signals["block"]["item"] is None)

anon_wc = classify(width=0.37, depth=0.66, block="dfgfg", layer="SANITARY",
                   room_name="TOILET-01", against_wall=True)
ok("an unnamed small box in a toilet is sanitary ware",
   anon_wc.item in {"wc", "basin"}, str(anon_wc.item))


# ---- Cross-room impossibilities are suppressed ----------------------------
print("\n-- implausible combinations --")
bed_in_kitchen = classify(width=1.8, depth=2.0, layer="FURNITURE",
                          room_name="KITCHEN", block=None)
ok("a bed-sized box in a kitchen is not confidently a bed",
   bed_in_kitchen.item not in {"bed-queen", "bed-king"} or bed_in_kitchen.needs_review,
   f"{bed_in_kitchen.item} margin={bed_in_kitchen.margin:.3f}")


# ---- Annotation never becomes an object -----------------------------------
print("\n-- annotation --")
dim = classify(width=3.4, depth=0.02, layer="DIM", room_name="BEDROOM-1", block=None)
ok("a dimension layer is annotation", dim.label == "annotation", dim.label)
ok("and never yields an item", dim.item is None)


# ---- The review signal is margin, not score -------------------------------
print("\n-- review signal --")
ok("a confident verdict does not ask for review",
   not classify(width=2.1, depth=0.9, block="3 ST SOFA", layer="FURNITURE",
                room_name="LIVING ROOM").needs_review)

nothing = classify(width=0.03, depth=0.03, layer="FURNITURE", room_name="LIVING",
                   block=None)
ok("an implausible footprint returns unknown, not a guess",
   nothing.label in {"unknown", "fixture"},
   f"{nothing.label}/{nothing.item} score={nothing.score:.3f}")
ok("and unknown always asks for review",
   nothing.label != "unknown" or nothing.needs_review)

sofa = classify(width=2.1, depth=0.9, block="3 ST SOFA", layer="FURNITURE",
                room_name="LIVING ROOM")
ok("a verdict carries its runners-up", len(sofa.alternatives) >= 2,
   str([a for a, _ in sofa.alternatives[:3]]))
ok("the verdict serialises", set(sofa.as_dict()) == {
    "label", "item", "confidence", "signals", "needsReview"})
ok(f"REVIEW_MARGIN is a real threshold ({REVIEW_MARGIN})", 0 < REVIEW_MARGIN < 1)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
