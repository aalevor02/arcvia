# Plangraph ground truth — where these files come from

Per-storey plan graphs extracted from **real BIM models** (IFC), not drawn for
this test. Each JSON carries what the architect's own authoring tool stored:

- `walls[]` — the wall **axis** (centreline polyline, metres, world XY), its
  **measured thickness** (sum of the material layer set), and `external`
  (the model's own Pset_WallCommon.IsExternal flag).
- `openings[]` — door/window world position, width and kind, keyed to the
  host wall's id (from the IfcRelVoids/IfcRelFills chain).
- `rooms[]` — the model's own IfcSpace footprints (inner-face polygons)
  with their real names.

Built 2026-08-25 by `A:\Research\BIM\extract_bim.py` + `plangraph.py`
(ifcopenshell) from the public IFC test models that ship in the web-ifc
repository (`engine_web-ifc/tests/ifcfiles/public`). Source buildings:

| fixture | building | authored in | walls | rooms |
|---|---|---|---|---|
| `kit-institute--Erdgeschoss` | KIT Institute (AC20-Institute-Var-2) | ArchiCAD | 29 | 18 |
| `revit22-apartment--BT-A_1010_OG01…` | German apartment block | Revit 22 | 59 | 28 |
| `nibs-office--Level_1` | NIBS Office_A (buildingSMART) | 2011-era BIM | 136 | 60 |

Why these three: orthogonal institutional, Revit-authored residential with
multi-layer exterior assemblies, and a large office floor — three authoring
cultures and two scales. The RWTH DigitalHub storey was evaluated and
**rejected** as a fixture: its walls are modelled as separate cavity skins
(several parallel thin walls per assembly), which turns the synthetic
double-line drawing into 4-6 parallel lines per wall and the solved rooms into
slivers. That is a real modelling style worth handling one day, but it measures
the synthesizer, not the engine.

These are ground truth for `test/test_plangraph.py`. Do not hand-edit; the
numbers in them are what the engine is scored against. Regenerate from
`A:\Research\BIM` if the extractor improves.

## `_synthetic--*` — AUTHORED fixtures, not ground truth

One file here is not a real building: `_synthetic--skew_diamond.json`, generated
by `A:\Research\BIM\tools\make_skew_fixture.py`. Every real building above is
orthogonal, so the non-axis-aligned path had no whole-pipeline coverage — which
is how a UV projection that stretched a 45° wall by 41.4% survived unnoticed.
The diamond is built so a failure is diagnostic rather than merely red: a 45°
envelope sits exactly on the projection's branch, one interior wall at 22.5° is
skew but off it, and two axis-aligned walls are controls.

**The `_synthetic--` prefix is load-bearing.** Anything that GLOBS a plangraph
directory must skip it, or an authored fixture gets counted as measured ground
truth — the corpus's own room-typing baseline was affected by exactly that and
now filters the prefix. This suite names its fixtures explicitly and never
globs, so it is safe by construction; keep it that way.
