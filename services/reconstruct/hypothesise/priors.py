"""
What real buildings measure — priors extracted from BIM ground truth.

── Where these numbers come from ─────────────────────────────────────────────
Not from this engine's drawings and not from a book. They are read out of the
BIM models architects actually shipped: 2,360 walls, 654 doors and 500 windows
with layer-set thicknesses, hosted openings and named rooms, extracted from
seven production IFC models (ArchiCAD and Revit authored — Dutch housing,
German apartment block, KIT institute, dental clinic, NIBS office) via
`A:\\Research\\BIM\\extract_bim.py`. Full distributions in
`A:\\Research\\BIM\\extracted\\priors.json`; the study is written up in
`A:\\Research\\BIM\\knowledge\\`.

The corpus is European. This engine's own measured corpus is Indian
residential (nine-inch brick, 0.23 m, window head at door head 2.1 m), and
where the two disagree the engine's defaults follow ITS drawings, not this
file — see the window note below. These priors are for SCORING candidates and
for defaults where a drawing says nothing at all, not for overruling what a
drawing says.

── A refuted check, recorded so it is not rebuilt ────────────────────────────
The obvious use — "warn when the paired thicknesses do not sit on standard
construction dimensions, because a unit error moves them off" — was measured
before being built, and it does not work. Against the 2,360-wall corpus with a
±12 mm tolerance on the standard set below:

    correct read      98.5% on-standard
    x2.54 misread     15.2%   <- the only factor it catches
    /2.54 misread     98.3%
    x1.27             92.4%
    /3.28 (feet)     100.0%

Scaled-DOWN misreads land in the dense low end of the standard set and pass;
the two real misread medians from the villa work (0.074 m and 0.092 m) are
both within 12 mm of a standard value. `solve/verify.py`'s room-area check
catches unit errors QUADRATICALLY and stays the right tool. Do not add an
on-standard-thickness gate; this paragraph is the measurement that says why.
"""

from __future__ import annotations

# ---- Walls ------------------------------------------------------------------

#: Thickness histogram peaks, metres -> share of the 2,360-wall corpus within
#: 5 mm of the peak. The two dominant modes are 115-125 mm (single brick /
#: heavy partition) and 50 mm (drylining skin — ArchiCAD models each leaf of a
#: cavity assembly as its own wall, so a 50 mm "wall" hugging a thicker one on
#: a drawing is a finish skin, not the wall).
WALL_THICKNESS_PEAKS: dict[float, float] = {
    0.050: 0.309, 0.100: 0.050, 0.115: 0.022, 0.120: 0.346, 0.150: 0.022,
    0.200: 0.047, 0.230: 0.018, 0.250: 0.017, 0.270: 0.035, 0.300: 0.046,
}

#: Exterior walls in the corpus: median 0.16 m, nothing below 0.06 m.
#: A 50 mm wall on the building outline is a lining, not the envelope.
EXTERIOR_MIN_THICKNESS = 0.06
EXTERIOR_MEDIAN_THICKNESS = 0.16

#: The standard construction dimensions the refuted check above was scored
#: against. A scoring function over this table was written and then REMOVED
#: for the same density reason the gate fell: below 0.2 m the entries sit
#: 15-25 mm apart, so at any tolerance wide enough to absorb raster
#: measurement error nearly every value in the plausible band scores as
#: on-standard and the weight is a constant. If a candidate-ranking nudge is
#: ever needed, build it against the sparser WALL_THICKNESS_PEAKS above and
#: validate it on a measured requirement from the consumer — do not resurrect
#: the dense-table version.
STANDARD_THICKNESSES = (
    0.05, 0.075, 0.09, 0.10, 0.115, 0.125, 0.15, 0.175,
    0.20, 0.23, 0.25, 0.27, 0.30, 0.35, 0.40,
)


# ---- Openings ---------------------------------------------------------------

#: Door leaf widths, metres. Median 0.915; the 0.90 bucket alone is a third of
#: the corpus. Anything in the single band is one leaf; the double band is a
#: double door, which is why a wall gap of 1.6-2.0 m with no window linework
#: should hypothesise a door and not a missing wall.
DOOR_WIDTH_SINGLE = (0.63, 1.20)
DOOR_WIDTH_DOUBLE = (1.60, 2.00)
DOOR_WIDTH_DEFAULT = 0.90
DOOR_HEIGHT_DEFAULT = 2.10          # modal 2.10-2.15, and matches op.DOOR_HEIGHT

#: Window sill: 0.90 m in 69% of the 471 windows with a measured sill; a sill
#: of 0.0 is floor-to-ceiling glazing, not an error. Window height: the
#: EUROPEAN modal is 1.5 m (head at 2.4 m). `openings.WINDOW_HEIGHT` stays at
#: 1.2 deliberately — this engine's Indian-residential drawings put window
#: heads level with door heads at 2.1 m, and 0.9 + 1.2 = 2.1. Use this value
#: only where the project is known to follow the European convention.
WINDOW_SILL_DEFAULT = 0.90
WINDOW_WIDTH_DEFAULT = 1.00
WINDOW_HEIGHT_EUROPEAN = 1.50

# ---- Storeys ----------------------------------------------------------------

#: Wall/storey heights, metres: residential peaks 2.7-3.0, institutional
#: 3.6-4.6. A "wall" under ~2.0 m is a parapet or knee wall — do not
#: hypothesise doors in it.
STOREY_HEIGHT_RESIDENTIAL = 2.70
STOREY_HEIGHT_INSTITUTIONAL = 3.60
MIN_DOOR_HOST_HEIGHT = 2.0
