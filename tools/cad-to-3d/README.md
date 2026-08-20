# CAD → walkthrough

Turns an architect's DWG floor-plan set into a walkable, lightmap-baked glTF
model. Covers all five of Casa Altinho's villa types.

| Type | Units | Floors | Views | Polys | GLB |
|---|---|---|---|---|---|
| `e1` | E1 | 4 | 14 | 2 572 | 3.5 MB |
| `bd` | B2–B4, D1–D5 | 4 | 5 | 825 | 3.5 MB |
| `b1` | B1 | 4 | 4 | 740 | 3.4 MB |
| `ce` | C1–C4, E2, E3, A2, A3 | 4 | 3 | 874 | 3.4 MB |
| `a1` | A1 | 4 (2 CAD + **2 traced**) | 4 | 1 411 | 3.4 MB |

Villa A-1's **stilt and first** floors exist only in `ALL PLANS (16-4-24).dwg`; its
frame in `LATEST DRAWINGS` is a placeholder holding `ROOF`, `SURVEY`,
`A3 DIMENSION` and `COMPOUND WALL` linework with zero wall segments. Its **lower
ground and second floors are drawn in no DWG at all** and are traced from the
brochure plans instead - see *Tracing a raster plan* below. Those two levels are
marked `reconstructed` in `<type>_building.json`, carry a `(reconstructed)` suffix
in the published view list, and must not be presented as surveyed geometry.

## Two drawings, neither a superset

Only **two** of the seven DWGs contain villa plans, and the right source differs
per floor:

| | `ALL PLANS (16-4-24)` | `LATEST DRAWINGS ... 24-11-23` |
|---|---|---|
| Villa A-1 | the only drawing that has it | placeholder frame |
| E-1 second floor | 170 wall segments | 85 |
| E-1 stilt / first | 158 / 211 | 116 / 159 |
| C/E second floor | absent | the only source |

So `merge_sources.py` picks per floor, and each region records the DXF it came
from. Reading only the file whose name says "LATEST" costs Villa A-1 entirely and
halves E-1's top floor.

This exists because the Casa Altinho archive contains **no 3D geometry** — the
CAD is 2D and the renders are flat images. Rather than wait for an archviz
studio's `.blend`, the villas are generated from the drawings themselves.

## The four things that will bite you

**1. The shipped DXFs are empty.** Both were converted with LibreDWG 0.13.3,
which parses the AC1021 (AutoCAD 2007) container well enough to emit tables and
block definitions but silently drops model space. The result is a structurally
valid, semantically empty file — no error, 2 993 plausible-looking entities, and
no drawing. **Use LibreDWG 0.14** (`A:\Tools\LibreDWG\dwg2dxf.exe`), which lands
the R2007 fixes. The same file then yields 26 194 model-space entities.

**2. The drawing is in metres, not millimetres.** `$INSUNITS = 4` says
millimetres and is wrong. Wall faces sit 0.24 apart and rooms measure 6.76
across — a 240 mm masonry wall and a 6.76 m room, matching the brochure's
schedule. Trusting the flag builds the villa 1000× too small, and it will look
perfectly fine in the viewer, just inexplicably tiny.

**3. Walls are drawn as two face lines, not centrelines.** Extruding the lines
gives paper-thin walls that look wrong at every door reveal. The extractor pairs
parallel faces back into solids with real thickness.

**4. A single unpaired line is a railing, not a wall.** Extrude those to ceiling
height and every balcony becomes a sealed box, blacking out the rooms behind it.
The drawing annotates the real values: "Glass Railing ht.- 1.00 m".

## Pipeline

```bash
# once: DWG -> DXF with a converter that can actually read AC1021
A:/Tools/LibreDWG/dwg2dxf.exe -o out.dxf "LATEST DRAWINGS ... FOR 3D 24-11-23.dwg"
python make_sky.py            # sky HDR used as the bake's world lighting

python discover.py "<dxf>" scan_<name>.json   # per drawing
python merge_sources.py       # best source per floor -> villas.json
python build_villas.py        # walls, openings, slabs, labels -> <type>_building.json
python views.py e1            # solve standable cameras -> TS snippet

blender --background --python blender_build.py -- \
  e1_building.json ../../apps/visualisation/public/scenes/villa-e1.glb --bake 96
```

`sky.hdr` lives here, not in `public/`: it is the bake's light source, and the
published page never downloads it.

## Why each step is the way it is

**Plans are found by their own labels, not the sheet titles.** Every plan carries
a small `{\C2;VILLA - E1}` label with its floor-plan title ~5 units above it. The
big sheet titles sit *outside* their frames — "VILLA E2 TO E3" hangs directly
above the E-1 frame — so nearest-title matching identifies the wrong villa.

**Floor order comes from the titles, never from vertical position.** E-1's sheet
ascends (lower ground at the bottom); the B2–B4/D sheet descends
(`ROOF y1180 → SECOND 1215 → FIRST 1246 → UPPER GROUND 1280 → STILT 1313`).
Ordering by y stacks half the villas upside down. Stacking is then applied in a
canonical order: lower-ground < stilt < upper-ground < first < second.

**Floor alignment** is solved by raster cross-correlation, not by matching
corners: each plan is drawn at its own spot on the sheet and the floors have
different footprints, so there is no shared corner to trust. Correlating the wall
masks gives a sharp, isolated peak (34 888 against a 22 664 runner-up for E-1) —
that margin is what tells you the registration is real, and the script prints it.

**Openings** are clustered from the door/window linework and cut as prisms, not
assigned to specific walls. The linework sits on the wall faces, so which wall
"owns" it is ambiguous at junctions; cutting a prism through whatever is there is
independent of how cleanly the pairing went.

**Openings are cut arithmetically, not with booleans.** Every wall is a straight
box and every opening a prism crossing it, so each wall is emitted as the pieces
that survive the cut — jamb, jamb, lintel, sill. Boolean modifiers would be
slower and fail on the coplanar faces that occur wherever an opening sits flush
in a wall face.

**Slab tracing has two modes, because the villas do.** Detached villas (E-1, the
C/E types) draw a closed perimeter, so the outer contour of the linework is the
slab. Row villas (B and D) do not: the plan shows the unit between party walls
with the sides and garden edge left open, so there is no loop to trace and no
amount of morphological closing will invent one. When the traced contour covers
less than 45% of the wall network's bounding box, the slab falls back to the
convex hull of the linework.

**A plan's region takes its x from the wall cluster but its y from the band.** On
open levels the terrace, deck and pool surround extend well past the enclosed
rooms; bounding the region by the wall cluster cuts them off and `ce/first` loses
a third of its slab. A fixed margin is not the answer either — it inflates
`bd/stilt` to 477 m² by swallowing the neighbouring floor on the tightly stacked
B/D sheets. The title-derived band is already exactly one plan's vertical slice.

**Room labels are on different layers in the two revisions** — `tx` in the LATEST
set, `A3 TEXT (main Txt)` in ALL PLANS. Villa A-1 exists only in the latter, so
missing that layer silently costs it every viewpoint while everything else still
builds.

**Slabs are traced from the raw linework, not the paired walls.** Paired walls
get trimmed to their overlap and pull back from every corner, fragmenting the
network into 5–8 pieces. The raw faces plus the door/window lines — which fill
the gaps they themselves create in the exterior face — close into a single
contour whose area is stable across closing radii from 0.18 to 0.42 m.

**No blanket ceilings.** Floor N+1's slab *is* floor N's ceiling, covering exactly
the area that has a floor above. Balconies and terraces are then correctly left
open to the sky. The top floor's roof is clipped off the pool and open deck,
located from the top floor's own `POOL`/`DECK`/`TERRACE` labels.

**Camera positions are solved, not authored.** A room's text label sits wherever
the draughtsman had space, often hard against a wall. Each view is the
highest-clearance point inside the slab near its label, aimed at the *farthest*
unobstructed glazing — an interior shot wants a window in frame for depth and
daylight, and the nearest window just fills a 50° frame with the wall around it.

## Tracing a raster plan

`trace_a1.py` reconstructs a floor from a rendered brochure plan when no vector
drawing exists. These are still the architect's own drawings, so the geometry is
traced rather than invented - but it is weaker evidence than CAD and is flagged
as such everywhere it surfaces.

Scale and position come from the floors that exist in *both* forms. All four A-1
plans sit on one sheet at one scale, so the CAD stilt floor calibrates
metres-per-pixel (0.01413 m/px), and correlating each traced mask against the
CAD wall raster of the floor directly above or below places it in the same frame.

Separating walls from everything else sharing their colour took three passes:

1. **Threshold.** The wall grey runs to ~170 luminance. A `lum < 105` cut looks
   sensible and silently excludes the walls themselves, leaving only the darkest
   linework; `lum < 130` catches them in patches so the network fragments and
   "largest component" returns a stray boundary line. Above ~180 the site
   boundary joins the villa and the box jumps from 593 to 787 px wide. 170 is the
   plateau where both plans agree.
2. **Rectilinear filter.** Walls are long axis-aligned bands, furniture is
   compact, so keep only pixels surviving a 45 px horizontal *or* vertical
   opening. This is what removes the beds, sofas and the car.
3. **Largest component**, which drops the site boundary and anything else
   free-floating.

Wall geometry is then recovered as **rectangles, not contours**: the network is
connected, so `RETR_EXTERNAL` returns a single outline around the whole floor.
Opening horizontally isolates the horizontal walls and vertically the vertical
ones; each band's bounding box is a wall. Overlaps at junctions are harmless.

Traced floors carry `wallPolys` instead of `walls`, use the convex hull for their
slab (a traced mask is sparser than CAD linework, so its outer contour dips into
every gap), and get **no roof** - with no room labels there is no way to locate
the open-air edge, and roofing the whole plate seals a level that carries a pool
and a deck.

Result: lower ground traces to 96.0 m² against a published 106.32 (−9.7%), second
to 102.7 against 106.66 (**−3.7%**).

## The bake

`--bake N` runs a Cycles COMBINED bake into a 1024² atlas on a `lightmap_pack`
UV, then replaces every material with one that carries the result as **emissive
over a black base colour**.

That is deliberate. glTF has no lightmap channel. A bake carried as base colour
would be multiplied by the viewer's realtime key/fill/hemisphere rig and
double-expose; black albedo + emissive reproduces the bake exactly through
vanilla glTF. The cost is realtime specular, which an unfurnished plaster shell
was never going to show anyway.

A **sky dome** is added *after* the bake — an inward-facing sphere at r = 90 m
with an emissive gradient. The viewer hardcodes `scene.background = 0x11151c`, so
without it every window reads as night once the model is emissive-only. It goes
in after baking because at ~100,000 m² it would otherwise swallow almost the
entire lightmap atlas next to the villa's ~1,500 m².

Cost: ~1 min per villa on CPU, and 20 kB → ~3.5 MB per GLB. Still ~20× lighter
than the 75 MB Shapespark reference.

## Validation

Traced slab vs the brochure's independently published SBUA, per floor.
**15 of 18 within 20%.**

| | stilt | upper/lower ground | first | second |
|---|---|---|---|---|
| `e1` | +16.4% | +13.0% | **+4.8%** | +47.8% |
| `b1` | +6.3% | +5.3% | +10.1% | −14.6% |
| `bd` | +23.5% | +13.0% | −5.1% | −19.9% |
| `ce` | +5.8% | −6.2% | −9.8% | −21.6% |
| `a1` | −17.0% | −9.7% *(traced)* | −6.0% | −3.7% *(traced)* |

**Read the sign, not just the magnitude.** The traced slab is the whole floor
plate including balconies, terraces and pool decks; SBUA discounts those. So a
*positive* delta on an open level is expected and usually correct — E-1's second
floor at +47.8% is the pool deck and the 11.30 × 2.35 open deck being counted,
not an error. Only *negative* deltas indicate genuine under-capture.

On that reading the worst remaining under-captures are `ce/second` (−21.6%),
`bd/second` (−19.9%) and `a1/stilt` (−17.0%) — all levels drawn sparsely in the
source. Earlier revisions of this pipeline had four floors past −30%, the worst
at −50%; merging the two drawings and taking the region's y from the band fixed
those.

## Current state and what is missing

Baked shell: walls, openings, glazing planes, columns, slabs, parapets, roof,
sky dome. 633–1 873 polygons per villa.

Not yet built:
- **Furniture and materials.** Everything is untextured plaster and stone. The
  CAD carries `furn` (1 240 entities) and `sanitary` (418) that could be placed.
- **Stairs.** The `stairs` layer is read but not extruded; floor changes happen
  by jumping between named views.
- **Vector geometry for Villa A-1's lower ground and second floors.** They are
  traced from the brochure and read visibly coarser than the CAD floors - wall
  bands rather than crisp rooms, no openings cut, no room labels. If the
  architect releases those two plans as DWG they should replace the trace.
- **Residual under-capture** on `ce/second`, `bd/second` and `a1/stilt`, per the
  validation table.
- **Atlas resolution.** 1024² over a ~1,500 m² villa is roughly 4 cm per texel —
  fine for soft lighting, too coarse for crisp shadow edges. 2048² is a one-line
  change and about 4× the bake time.
- **Camera polish.** A few solved views still face a nearby wall. Furniture would
  change the answer, so this is worth doing after placement, not before.

## Files

| | |
|---|---|
| `discover.py <dxf> <out>` | finds each type's floor plans in one drawing |
| `merge_sources.py` | picks the best source per floor → `villas.json` |
| `build_villas.py` | walls, openings, columns, slabs, labels → `<type>_building.json` |
| `views.py <type>` | solves standable camera positions → TS snippet |
| `blender_build.py` | builds + optionally bakes + exports GLB |
| `trace_a1.py` | traces a rendered brochure plan into wall rectangles |
| `make_sky.py` | writes `sky.hdr`, the bake's world lighting |
| `render_e1.py`, `render_interior.py` | headless check renders (Cycles; EEVEE renders black in `--background`) |
| `build_e1.py`, `align_e1.py`, `views_e1.py`, `blender_build_e1.py` | the original single-villa scripts, kept as the readable reference implementation |
