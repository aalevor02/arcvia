"""
Dwelling assignment: which rooms make one flat.

Run:  .venv/Scripts/python.exe test/test_dwellings.py

The fixture is a floor with two flats off a shared corridor and a stairwell:

     BATH(3)
  LIVING(0) HALL(1) BED(2)          flat A — a STAR: hall is the only
  ───────── d ──────────────        connector, the shatter trap
  CORRIDOR(6)          TREPPENRAUM(7)
  ── d ──────
  WOHNEN(4) | KUECHE(5)             flat B
  BALCONY(8)                        door from WOHNEN
  STORE(9)                          no door at all

The two traps this encodes, both hit while writing the algorithm:
* A shared corridor has already MERGED the flats through its own doors, so
  testing "does it bridge two components" on the intact graph proves nothing —
  the test must CUT the candidate first (articulation form).
* An in-unit hallway is ALSO an articulation point: cutting flat A's hall
  leaves LIVING, BED and BATH as three singletons. Promotion therefore demands
  at least two sides that look like DWELLINGS (two or more rooms, at least one
  not circulation) — the corridor's sides are whole flats, the hall's sides
  are single rooms.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantify.dwellings import assign_units  # noqa: E402

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


def square(x, y, w, h):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def wall(x0, y0, x1, y1):
    return {"a": {"x": x0, "y": y0}, "b": {"x": x1, "y": y1},
            "thickness": 0.1, "paired": True, "confidence": 1.0}


def door(wall_index, along):
    return {"kind": "door", "wall": wall_index, "along": along, "width": 0.9,
            "height": 2.1, "sill": 0.0, "source": "test", "confidence": 1.0}


MODEL = {
    "elements": {
        "walls": [
            wall(4, 0, 4, 4),        # 0: LIVING | HALL
            wall(6, 0, 6, 4),        # 1: HALL | BED
            wall(4, 4, 6, 4),        # 2: HALL | BATH
            wall(0, 0, 10, 0),       # 3: flat A | CORRIDOR
            wall(5, -6, 5, -2),      # 4: WOHNEN | KUECHE
            wall(0, -2, 10, -2),     # 5: CORRIDOR | flat B
            wall(10, -2, 10, 0),     # 6: CORRIDOR | TREPPENRAUM
            wall(0, -6, 5, -6),      # 7: WOHNEN | BALCONY
        ],
        "spaces": [
            {"index": 0, "name": "LIVING", "kind": "unknown", "area": 16.0,
             "loop": square(0, 0, 4, 4)},
            {"index": 1, "name": "HALL", "kind": "circulation", "area": 8.0,
             "loop": square(4, 0, 2, 4)},
            {"index": 2, "name": "BED", "kind": "bedroom", "area": 16.0,
             "loop": square(6, 0, 4, 4)},
            {"index": 3, "name": "BATH", "kind": "bathroom", "area": 4.0,
             "loop": square(4, 4, 2, 2)},
            {"index": 4, "name": "WOHNEN", "kind": "unknown", "area": 20.0,
             "loop": square(0, -6, 5, 4), "boundedBy": [4, 5, 7]},
            {"index": 5, "name": "KUECHE", "kind": "kitchen", "area": 20.0,
             "loop": square(5, -6, 5, 4), "boundedBy": [4, 5]},
            {"index": 6, "name": "CORRIDOR", "kind": "circulation", "area": 20.0,
             "loop": square(0, -2, 10, 2)},
            {"index": 7, "name": "TREPPENRAUM", "kind": "circulation", "area": 4.0,
             "loop": square(10, -2, 2, 2)},
            {"index": 8, "name": "BALCONY", "kind": "outdoor", "area": 6.0,
             "loop": square(0, -8, 5, 2)},
            {"index": 9, "name": "STORE", "kind": "unknown", "area": 2.0,
             "loop": square(11, 2, 1, 2)},
        ],
        "openings": [
            door(0, 2.0),            # LIVING - HALL
            door(1, 2.0),            # HALL - BED
            door(2, 1.0),            # HALL - BATH
            door(3, 5.0),            # HALL - CORRIDOR (flat A front door)
            door(4, 2.0),            # WOHNEN - KUECHE
            door(5, 2.5),            # CORRIDOR - WOHNEN (flat B front door)
            door(6, 1.0),            # CORRIDOR - TREPPENRAUM
            door(7, 2.5),            # WOHNEN - BALCONY
        ],
    }
}

result = assign_units(MODEL)[0]
units = {tuple(u["rooms"]): u for u in result["units"]}

print("-- two flats emerge, and neither is shattered --")
ok("exactly two units", len(result["units"]) == 2,
   str([u["rooms"] for u in result["units"]]))
ok("flat A is LIVING+HALL+BED+BATH, hall NOT promoted to common",
   (0, 1, 2, 3) in units)
ok("flat B is WOHNEN+KUECHE", (4, 5) in units)

print("-- the corridor and the stair belong to the building --")
ok("corridor promoted by the articulation test", 6 in result["common"],
   str(result["common"]))
ok("stairwell common by name", 7 in result["common"])

print("-- attachments and leftovers are explicit --")
ok("balcony attached to flat B via its door",
   units.get((4, 5), {}).get("balconies") == [8])
ok("doorless STORE is unassigned, not guessed",
   result["unassigned"] == [9], str(result["unassigned"]))

print("-- a villa stays one unit --")
villa = {
    "elements": {
        "walls": MODEL["elements"]["walls"][:4],
        "spaces": MODEL["elements"]["spaces"][:4],
        "openings": [door(0, 2.0), door(1, 2.0), door(2, 1.0)],
    }
}
solo = assign_units(villa)[0]
ok("one unit, all four rooms", len(solo["units"]) == 1
   and solo["units"][0]["rooms"] == [0, 1, 2, 3])
ok("nothing common, nothing unassigned",
   solo["common"] == [] and solo["unassigned"] == [])

print("-- a unit composes straight into the area statement --")
from quantify.areas import area_statement  # noqa: E402
from quantify.dwellings import unit_model  # noqa: E402

flat_b = next(u for u in result["units"] if u["rooms"] == [4, 5])
per_flat = area_statement(unit_model(MODEL, 0, flat_b))["storeys"][0]
figures = {f["definition"]: f for f in per_flat["figures"]}
# WOHNEN 20 + KUECHE 20 + their shared partition (4 m x 0.1 m = 0.4).
# The wall to the corridor has unit rooms on ONE side only -> external -> 0.
ok("flat B RERA = rooms + own partition only",
   figures["RERA_2k"]["valueM2"] == 40.40, str(figures["RERA_2k"]["valueM2"]))
ok("flat B IS 3861 excludes the kitchen",
   figures["IS3861_carpet"]["valueM2"] == 20.00,
   str(figures["IS3861_carpet"]["valueM2"]))
ok("flat B balcony rides along as its own line",
   figures["exclusive_balcony_verandah"]["valueM2"] == 6.00)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
