# Multi-storey — what is built, and what remains

Written 2026-08-22 by `aalev-35`. The roadmap's own assessment of this gap:
*"`storey0` is hardcoded. **A house has floors.** Storey registration is M6 in
the blueprint and unbuilt. Nothing below matters as much as this."*

Roughly half of it is now built. This records which half, so the rest can be
done without re-deriving anything — and so nobody rebuilds the finished parts.

---

## 0. Why it became urgent

`DOWN VILLA -WD 22-1-24.dxf` draws two floors of one villa side by side on one
sheet, 2.477 m apart. The engine merged them into a single flat building: 505 m²
of floor, 901 m of wall, a ₹3.25M bill of quantities for something that does not
exist — and it **passed the verification gate**. Nothing looked wrong at any
point.

---

## 1. Built and committed

| | What | Where |
|---|---|---|
| ✅ | **Separate the drawings on a sheet.** Axis-projection channel no wall crosses, guarded by `min_walls` both sides and a 2.0 m minimum side extent. | `solve/frames.py`, `2e25244` + `82c2f14` |
| ✅ | **Frame ancestry.** `Frame.cuts` — ordered, outermost first, `{axis, at, gap, side}`. Storey registration needs to know two frames came from one cut and which side each was on. | `solve/frames.py` |
| ✅ | **Read the sheet's plan titles.** `plan_titles()` — separate from `room_labels`, with legend rejection by character-height separation. | `ingest/blocks.py`, `cli.py` |
| ✅ | **Decide the grouping.** `register_storeys()` — congruence proposes, the title confirms, an unnamed member refuses the whole group. | `solve/storeys.py`, `067fa63` |
| ✅ | **Place a storey off zero.** `base_z` through `build_walls` and `build_fixtures`; `build_slabs` already had it. | `build/solidify.py`, `a8cbf97` |

The villa now reports, correctly:

```
STOREYS  2 storeys of ONE building:
         Lower Ground Floor Plan (z -3.0), Ground Floor Plan (z +0.0)
```

---

## 2. Measured facts — do not re-derive these

**Geometry cannot answer the grouping question.** Two storeys of one villa and
two identical villa units on a site plan are *the same picture*. An independent
pass built "two storeys 3 m apart" and "one house with a 3 m utility court" from
the same helper and compared the wall lists elementwise: **not similar inputs,
the same input.** So text confirms, or nothing does.

**Sheet position is inverted against storey order on the real drawing.** The
frame *higher* on the paper is `Lower Ground Floor Plan`; the one lower is
`Ground Floor Plan`. Anything that orders storeys by where they sit puts the
lawn upstairs. This is why `Frame.cuts` says `low`/`high` and never
`upper`/`lower`.

**`cli.py` used to delete every plan title.** Nine on the villa, all discarded
because the label filter keeps only text `classify_room` recognises. The obvious
fix is wrong and was tried: `classify_room("TERRACE PLAN")` already returns
`outdoor` and `"OFFICE PATIO (BELOW)"` returns `study`, which is how a sheet
title and a void marker became rooms.

**Layer names do not identify titles.** The villa's two real plan titles sit on
`A6 SANITARY WARE`; `SECOND FLOOR PLAN` sits on `tx`. Across the corpus a layer
literally called `title` carries about a third of them.

**Legend separation is measured in character heights, not metres.** Real titles
sit 73–78 char-heights from their nearest neighbour; a text-style sample block
sits 2.13–2.24. A factor of 33. Character heights because **the unit inference
is wrong on four of the seven drawings in this corpus** — distance and character
height scale together, so the ratio survives an error a metre threshold would
invert.

**`solve/layerscan.py` needs no change for this.** Frame scoping is done
entirely by the caller, which builds `within` from a bbox before handing it to
`select_within_frame`. Scoping to a stack is a pure `cli.py` change. (It has a
*separate* defect — see `PENDING-ARCVIA.md` — but not one that blocks this.)

**`Wall` is a plain non-frozen dataclass with public float fields**, so
`dataclasses.replace(w, ay=w.ay-dy, by=w.by-dy)` translates a wall from any
frame. Nothing here blocks on `hypothesise/pair.py`, which belongs to another
session.

**glTF is Y-up.** The vertical axis is `p[1]`. Reading `p[2]` gives depth, where
two storeys look identical and an assertion fails for the wrong reason.

---

## 3. What remains, in dependency order

### 3.1 Run the pipeline once per storey — the whole remaining job

`reconstruct()` handles exactly one frame end to end. Layer selection, room
labels, block placements, walls, spaces, openings and fixtures are all scoped to
`picked`, and the mesh assembly emits a fixed `storey0_walls` /
`storey0_floors` / `storey0_fixtures`.

**Do this in two commits, not one.**

1. **Extract the per-frame block into a function, changing nothing.** It runs
   from the second-pass layer selection to the mesh assembly. Shared inputs
   (`reading`, `doc`, `placed`, `scale`, origin) go in; a per-storey result comes
   out. Prove it by A/B against all seven real drawings — `frames[0]` output must
   be **byte-identical**. A refactor that is not proven identical is a refactor
   that has silently changed the building.
2. **Then loop it**, once per `Storey` in the stack, passing `base_z`, and merge
   into `storey{N}_walls` / `_floors` / `_fixtures`.

Keep it **opt-in** (`--storeys`) until it has run on a real drawing. Everything
built today defaults to off or to zero precisely so nothing regressed while it
was being built.

### 3.2 Registration in XY — the storeys must be superimposed

They are drawn *side by side* on the sheet and must be stacked *on top of each
other*. The datum is not obvious and is not solved here. Candidates, in the
order I would try them: a shared structural grid (translate so the wall
centrelines correlate best), the frame bbox corner, or the title block. **Whatever
is chosen must be reported**, because a mis-registered stack is a building with
its upper floor slid two metres sideways and it will look plausible in a render.

### 3.3 The gate

`solve/verify.py` belongs to another session and this needs its agreement.

- Every check has to declare whether it is **per-storey or per-building**. This
  is the shared-basis trap one level up, and it has already bitten once here: a
  site-*excluding* floor area against a site-*including* wall run gave 1.94 on a
  correct model.
- `wall-run-per-area` is per-storey. `plan-span` is per-storey. `enclosure` is
  per-storey. A whole-building total of any of them means nothing.
- **A new check is owed**: the merge passed the gate. Something should notice a
  "storey" whose rooms sit in two disjoint clusters 2.5 m apart.

### 3.4 Downstream

- `quantify/boq.py` — a two-storey model doubles every quantity. It must not
  double-count a shared floor/ceiling slab. Another session's file.
- `render/cameras.py` — the pole-of-inaccessibility solver runs on one
  footprint. Per storey, or it frames the gap between them.
- `render/plan_svg.py` — one SVG per storey, or one with layers.
- `packages/viewer` — **stairs do not exist**, so a viewer has no way to walk
  between floors. A storey selector is the honest answer for v1.
- There are **seven** `.get("elements", {})` sites across the codebase reading a
  model, including `daylight/factor.py:453`. All of them assume one storey's
  worth of elements. `daylight/` is in nobody's ownership list.

---

## 4. What a two-storey model will and will not do on the day it lands

Say this plainly to anyone who asks, because the gap will surprise them:

**Will** — carry both floors as real geometry at the right heights, quantify
both, render both, and report which is which by the drawing's own name.

**Will not** — connect them. Stairs do not exist, roofs do not exist, and a
walkthrough cannot get from one floor to the other except by a selector. A
double-height space will be modelled as two independent floors with a slab
between them, which is wrong and will look wrong.

---

## 5. The honest risk

The grouping rule refuses whenever the sheet does not name its plans, and **most
sheets in this corpus do not**. The villa is the good case. `ALL PLANS` holds
five villa types; `SITE PLAN FOR 3D` holds 37 drawings. On those, this produces
refusals rather than stacks — which is correct behaviour and also means the
feature does nothing for them.

That is the right trade (a wrong storey count is a commercial disaster and a
refusal is a question), but it should not be sold as "Arcvia does multi-storey".
It does multi-storey **on drawings that say what their floors are**.
