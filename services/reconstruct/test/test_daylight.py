"""
Daylight, checked against answers that do not come from this code.

── Why this file is the point of the feature, not an accessory to it ──────────
Daylight factor was deferred once with a specific reason: a daylight number that
has never been checked against a known-correct case is a liability in a document
an architect signs. That reason has not gone away. What changed is that the
reference values turned out to be derivable rather than findable — the CIE
overcast sky has a defined luminance distribution, so simple cases have closed
forms anybody can re-derive and check.

So the assertions below fall into two kinds, and only the first kind is worth
much:

  AGAINST A CLOSED FORM   the answer exists independently of this code. If the
                          integrator is wrong these fail, and nothing about how
                          confidently it was written matters.
  AGAINST A DIRECTION     "a bigger window is brighter", "a deeper room is
                          darker". These cannot catch a scale error — every
                          number could be 10x wrong and still ordered correctly
                          — but they catch sign errors and swapped arguments,
                          which is most of what actually goes wrong in a
                          geometric predicate.

Where a test is only of the second kind it says so, so nobody reads the pass
count as more validation than it is.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daylight import factor, sky

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


# ══ the sky ═════════════════════════════════════════════════════════════════
print("\n-- sky: the distribution itself --")

ok("horizon luminance is a third of the zenith",
   abs(sky.luminance(0.0 + 1e-12) - 1 / 3) < 1e-6,
   f"{sky.luminance(1e-12):.6f}")
ok("zenith luminance is the zenith luminance",
   abs(sky.luminance(math.pi / 2) - 1.0) < 1e-9,
   f"{sky.luminance(math.pi / 2):.6f}")

# Below the horizon is not a dim sky, it is not the sky. Letting the formula run
# past zero ADDS light for every downward ray, so a more enclosed room would come
# out brighter — a sign error that looks like a plausible number.
ok("below the horizon contributes nothing, rather than negative luminance",
   sky.luminance(-0.1) == 0.0 and sky.luminance(-1.5) == 0.0)


print("\n-- sky: the integrator against a closed form --")
# THE ASSERTION THIS WHOLE FEATURE RESTS ON.
#
#   E_h = ∫∫ L_z (1 + 2 sin θ)/3 · sin θ · cos θ dθ dφ  =  7π L_z / 9
#
# Derived in sky.py's docstring in four lines anybody can check. If the numerical
# integrator disagrees with it, every daylight factor this module produces is
# wrong by the same factor and nothing else in this file would notice.
unobstructed = sky.horizontal_illuminance(lambda a, z: True)
error = abs(unobstructed - sky.UNOBSTRUCTED_HORIZONTAL) / sky.UNOBSTRUCTED_HORIZONTAL
ok("the full hemisphere integrates to 7 pi / 9",
   error < 1e-3, f"{unobstructed:.6f} vs {sky.UNOBSTRUCTED_HORIZONTAL:.6f}, rel {error:.2e}")

# Convergence, not just accuracy. A quadrature that happened to land close at one
# resolution and did not improve with more samples would be agreeing by luck, and
# the single-resolution assertion above cannot tell the difference.
coarse = abs(sky.horizontal_illuminance(lambda a, z: True, rings=30, sectors=120)
             - sky.UNOBSTRUCTED_HORIZONTAL)
fine = abs(sky.horizontal_illuminance(lambda a, z: True, rings=120, sectors=480)
           - sky.UNOBSTRUCTED_HORIZONTAL)
ok("and converges as the sample count rises, so the agreement is not luck",
   fine < coarse / 4, f"coarse {coarse:.2e} -> fine {fine:.2e}")

# A closed form for half the sky: the distribution is rotationally symmetric, so
# any half-hemisphere delivers exactly half. Independent of the first case
# because it tests the azimuth handling, which a full hemisphere cannot.
half = sky.horizontal_illuminance(lambda a, z: z < math.pi)
ok("half the azimuths deliver half the light",
   abs(half - unobstructed / 2) / unobstructed < 2e-3,
   f"{half:.6f} vs {unobstructed / 2:.6f}")

ok("an unobstructed point is 100% daylight factor by definition",
   abs(sky.daylight_factor(sky.UNOBSTRUCTED_HORIZONTAL) - 100.0) < 1e-9)
ok("a sealed point is 0%", sky.daylight_factor(0.0) == 0.0)


# ══ geometry ════════════════════════════════════════════════════════════════
print("\n-- geometry: the working-plane grid --")

SQUARE = [(0.0, 0.0), (6.0, 0.0), (6.0, 4.0), (0.0, 4.0)]

points = factor.sample_points(SQUARE, spacing=0.5)
ok("a 6x4 room grids at 0.5 m into 12x8 points",
   len(points) == 96, str(len(points)))
ok("and every one is inside the room",
   all(factor._inside(SQUARE, x, y) for x, y in points))

# An L-shape puts its centroid inside the notch. A daylight factor computed from
# a centroid outside the room is a confident number about the garden.
L_SHAPE = [(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (2.0, 2.0), (2.0, 6.0), (0.0, 6.0)]
cx = sum(p[0] for p in L_SHAPE) / len(L_SHAPE)
cy = sum(p[1] for p in L_SHAPE) / len(L_SHAPE)
ok("an L-shaped room's centroid lies OUTSIDE it, which is why a grid is used",
   not factor._inside(L_SHAPE, cx, cy), f"centroid ({cx:.2f}, {cy:.2f})")
ok("but its grid points are all inside",
   all(factor._inside(L_SHAPE, x, y) for x, y in factor.sample_points(L_SHAPE, 0.5)))

# A room smaller than one grid cell must still produce a point, or it silently
# reports as undetermined and looks like a reading failure rather than a cupboard.
TINY = [(0.0, 0.0), (0.3, 0.0), (0.3, 0.3), (0.0, 0.3)]
ok("a room smaller than the grid still yields its centroid",
   len(factor.sample_points(TINY, 0.6)) == 1)


print("\n-- geometry: what a ray can leave through --")

# One 2 m window in the south wall (y = 0), sill 0.9, head 2.1.
WINDOW = factor.Aperture(ax=2.0, ay=0.0, bx=4.0, by=0.0, sill=0.9, head=2.1)
ok("aperture area is width x (head - sill)",
   abs(WINDOW.area - 2.0 * 1.2) < 1e-9, f"{WINDOW.area:.3f}")

see = factor.visibility(3.0, 1.0, [WINDOW])
# Straight at the window, at an altitude that clears the sill from 0.85 m up.
ok("a ray aimed at the window at a rising angle escapes",
   see(math.radians(20), math.radians(-90)))
# The same ray aimed away from it does not.
ok("the same ray aimed at the opposite wall does not",
   not see(math.radians(20), math.radians(90)))
# Steep enough and the ray passes over the head of the window into the wall
# above it. Getting this backwards is the classic sill/head swap and it makes
# every room brighter the taller its ceiling.
ok("a ray steep enough to pass above the head is blocked",
   not see(math.radians(75), math.radians(-90)))
ok("a ray below the sill line is blocked",
   not see(math.radians(0.5), math.radians(-90)))


# ══ direction-only checks ═══════════════════════════════════════════════════
# From here the assertions are of the SECOND kind: they test ordering, not
# magnitude. They would all pass if every number were ten times too large.
print("\n-- daylight: directional checks (ordering only, NOT magnitude) --")


def room_model(width, depth, window_width, sill=0.9, head=2.1):
    """A single rectangular room with one window centred in its south wall."""
    walls = [{"a": {"x": 0.0, "y": 0.0}, "b": {"x": width, "y": 0.0},
              "thickness": 0.23, "paired": True}]
    offset = (width - window_width) / 2
    return {
        "elements": {
            "walls": walls,
            "openings": [{"wall": 0, "offset": offset, "width": window_width,
                          "sill": sill, "height": head - sill}],
            "spaces": [{
                "name": "room", "kind": "bedroom",
                "polygon": [{"x": 0.0, "y": 0.0}, {"x": width, "y": 0.0},
                            {"x": width, "y": depth}, {"x": 0.0, "y": depth}],
            }],
        }
    }


base = factor.evaluate(room_model(6.0, 4.0, 2.0), rings=30, sectors=90)
wide = factor.evaluate(room_model(6.0, 4.0, 4.0), rings=30, sectors=90)
deep = factor.evaluate(room_model(6.0, 9.0, 2.0), rings=30, sectors=90)

ok("a room with a window gets a number", base["computed"] == 1, str(base["computed"]))
b = base["rooms"][0]["averageDaylightFactor"]
w = wide["rooms"][0]["averageDaylightFactor"]
d = deep["rooms"][0]["averageDaylightFactor"]

ok("doubling the window raises the daylight factor", w > b, f"{b:.2f} -> {w:.2f}")
ok("more than doubling the depth lowers it", d < b, f"{b:.2f} -> {d:.2f}")
ok("every figure is a plausible percentage, not a ratio or a fraction",
   0.0 < b < 100.0 and 0.0 < w < 100.0, f"base {b:.2f}, wide {w:.2f}")

# The sky component must dominate a shallow room with a decent window. If the
# split-flux IRC ever exceeds the measured SC in a well-lit room, the formula has
# been fed the wrong units and the total is an invention.
first = base["rooms"][0]
ok("the measured sky component exceeds the formula's reflected component",
   first["skyComponent"] > first["internallyReflected"],
   f"SC {first['skyComponent']:.2f} vs IRC {first['internallyReflected']:.2f}")


print("\n-- daylight: what it refuses to answer --")
# THE DECISION THIS FEATURE TURNS ON. The villa carries 8 openings across 23
# spaces. Reporting 0% for the other 15 would put a fabricated defect in front of
# an architect; dropping them would lose the one case the check exists to catch.
blind = room_model(6.0, 4.0, 2.0)
blind["elements"]["openings"] = []
result = factor.evaluate(blind, rings=20, sectors=60)

ok("a room with no opening is UNDETERMINED, not zero",
   result["rooms"][0]["undetermined"] and result["rooms"][0]["averageDaylightFactor"] is None,
   str(result["rooms"][0]["averageDaylightFactor"]))
ok("and it is still listed, not dropped", len(result["rooms"]) == 1)
ok("and it says which of the two things it means",
   "may mean none was read" in result["rooms"][0]["reason"])
ok("the verdict is 'undetermined', never a band",
   result["rooms"][0]["verdict"] == "undetermined")

ok("every computed room carries its assumptions",
   all(r["assumptions"] for r in base["rooms"] if not r["undetermined"]))
ok("including that the externally reflected component is zero",
   any("conservative" in a for a in base["rooms"][0]["assumptions"]))
ok("the report never claims compliance",
   all("complies" not in c for c in base["caveats"])
   and any("Not a compliance check" in c for c in base["caveats"]))


print("\n-- daylight: the independent second number --")
# Today's whole lesson in one assertion. Every fault found in this codebase on
# 2026-08-22 was a measurement that was correct and insufficient, and not one
# fell to more scrutiny of the first number; each fell to a second, independent
# one. `bre_average` is that second number for daylight.
#
# It is asserted as a BAND, not an equality, because the two methods are
# different decompositions of the same physics and there is no reason they should
# agree exactly. A band still catches what matters: a factor-of-ten scale error,
# a percent-versus-fraction slip, or a sign error would all leave it.
for w, d, ww in ((6.0, 4.0, 2.0), (6.0, 4.0, 4.0), (6.0, 9.0, 2.0), (4.0, 3.0, 1.5)):
    r = factor.evaluate(room_model(w, d, ww), rings=30, sectors=90)["rooms"][0]
    ratio = r["averageDaylightFactor"] / r["breAverage"]
    ok(f"{w:.0f}x{d:.0f} m room: the two methods agree to within a factor of two",
       1.0 < ratio < 2.0,
       f"per-point {r['averageDaylightFactor']:.2f} vs BRE {r['breAverage']:.2f}, ratio {ratio:.2f}")

# And the direction is asserted, because it is the half that matters to a reader.
# This module reads HIGH against the figure a planning authority quotes, so an
# unqualified "conservative" would be the more dangerous half of a true statement.
r = factor.evaluate(room_model(6.0, 4.0, 2.0), rings=30, sectors=90)["rooms"][0]
ok("and this module is the HIGHER of the two, which the caveats must say",
   r["averageDaylightFactor"] > r["breAverage"])
ok("the caveats do say it, and say the threshold consequence",
   any("1.3-1.8x lower" in c and "straddle" in c
       for c in factor.evaluate(room_model(6.0, 4.0, 2.0), rings=20, sectors=60)["caveats"]))


print("\n-- the model's actual schema, which the first draft guessed wrong --")
# THE BUG THIS SECTION EXISTS FOR. The module was written against `polygon` and
# `offset`. The engine writes `loop` and `along`. Nothing raised: every
# `.get(key, default)` quietly returned its default, so `evaluate` reported
#
#     rooms 0   computed 0   undetermined 0
#
# on a model holding 23 rooms. An empty report is not a recognisable failure —
# it reads as a building with no rooms rather than as a reader with no eyes, and
# it would have passed every direction-only test above, because those build their
# own fixtures in the spelling the module expected.
ENGINE_SPACE = {"name": "BED ROOM", "kind": "bedroom", "area": 24.0,
                "loop": [[0.0, 0.0], [6.0, 0.0], [6.0, 4.0], [0.0, 4.0]]}
STUDIO_SPACE = {"name": "BED ROOM", "kind": "bedroom", "area": 24.0,
                "polygon": [{"x": 0.0, "y": 0.0}, {"x": 6.0, "y": 0.0},
                            {"x": 6.0, "y": 4.0}, {"x": 0.0, "y": 4.0}]}
ok("the engine's `loop` spelling is read",
   len(factor.room_polygon(ENGINE_SPACE)) == 4, str(factor.room_polygon(ENGINE_SPACE)))
ok("and the studio's `polygon` spelling still is",
   factor.room_polygon(STUDIO_SPACE) == factor.room_polygon(ENGINE_SPACE))

WALL = [{"a": {"x": 0.0, "y": 0.0}, "b": {"x": 6.0, "y": 0.0},
         "thickness": 0.23, "paired": True}]
ok("an opening positioned by `along` lands where `offset` would have",
   factor.apertures_of([{"wall": 0, "along": 2.0, "width": 2.0, "sill": 0.9,
                         "height": 1.2, "kind": "window"}], WALL)[0].ax == 2.0)

print("\n-- what counts as glazing, which is the whole villa result --")
# Every one of the villa's 8 openings is a door. Counting doors as apertures
# would have produced a full daylight report for a building whose windows were
# never read: 23 rooms, each with a plausible percentage, every number an
# artefact of treating a doorway as glass. It would have looked like the feature
# working, which is the failure mode this codebase keeps finding.
doors = [{"wall": 0, "along": 2.0, "width": 0.9, "sill": 0.0, "height": 2.1,
          "kind": "door"}]
windows = [{"wall": 0, "along": 2.0, "width": 2.0, "sill": 0.9, "height": 1.2,
            "kind": "window"}]
ok("a door is not a daylight aperture", factor.apertures_of(doors, WALL) == [])
ok("a window is", len(factor.apertures_of(windows, WALL)) == 1)

villa_like = {"elements": {"walls": WALL, "openings": doors, "spaces": [ENGINE_SPACE]}}
report = factor.evaluate(villa_like, rings=20, sectors=60)
ok("a model with doors but no windows reports 0 glazed openings",
   report["glazedOpenings"] == 0 and report["openings"] == 1,
   f"{report['glazedOpenings']}/{report['openings']}")
ok("its rooms are undetermined, not zero and not missing",
   len(report["rooms"]) == 1 and report["undetermined"] == 1
   and report["rooms"][0]["averageDaylightFactor"] is None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
