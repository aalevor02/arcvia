# Curation and asset scale — handoff

Written 2026-08-28. Covers what the hub can actually dress, and the scale
defect that made hub assets the wrong size in a room.

---

## 0. The defect, and that it is fixed

`condition_asset.py` documents its own rule: without `--width/--depth/--height`
it **"keeps the model's authored scale"**. The catalogue ingest
(`tools/asset-ingest/from-hub.mjs`) always passes those three, because a
catalogue slot is authoritative about size.

`services/api/src/lib/assetHub.js` — the on-demand path, and the only way a
non-catalogue hub asset reaches a room — **passed none of them**. So every one
of the ~3,500 hub models outside the 64 catalogue slots arrived at whatever
scale its author happened to work in.

It is silent by construction. Nothing errors, the GLB is valid, the render
succeeds. The first symptom is a bathtub the length of a street in a client's
walkthrough.

**Measured, before the fix**, straight from the hub:

| asset | authored | as metres | reality |
|---|---|---|---|
| Bathtub | 186.2 units | 186 m | 1.86 m |
| Sideboard | 100.6 units | 101 m | 1.01 m |
| realistic leather sofa | 78.6 units | 79 m | 1.99 m |
| Mid Century Teak Credenza | 1350 units | 1350 m | 1.35 m |

Fixed by `tools/asset-ingest/scale.mjs`, wired into `assetHub.js`. Verified
end to end through the real `conditionModel()` path: the bathtub above now
conditions to **1.861 × 0.714 × 0.894 m**, with the conditioner reporting
`"scale": 0.01` — the centimetre correction.

---

## 1. How scale.mjs decides

There is no dimension metadata to read. A hub `.asset.json` carries ref, name,
licence, authors, polycount, bytes — and no size. Poly Haven publishes
dimensions in millimetres but the harvest never persisted them, and Sketchfab,
the largest source, does not publish size at all.

So the only evidence at conditioning time is the geometry and the name:

1. **Measure** the model, honouring glTF node transforms. This is not optional —
   exporters routinely put a unit conversion on a node rather than baking it
   into vertices, which is exactly the case that matters. All eight corners are
   transformed, because under rotation the box of the transformed corners is
   correct and transforming min/max alone is not.
2. **Band** the name against a plausible real-world size for that kind of thing.
3. **Test** each unit reading (m, cm, mm, in) against the band. Feet are
   deliberately excluded: 0.3048 sits close enough to a third of a metre to turn
   confident answers into ambiguous ones.
4. **Resolve** — exactly one reading passes, or it refuses.

It never falls back to "assume metres". That assumption *is* the bug.

**The policy lives in one function**, `resolve()`, so it can be changed without
touching anything else. Today: one candidate wins, zero or several refuse.

Only the uniform unit factor crosses into Blender (--scale 0.01 for
centimetres). The glTF-side axis-aligned bounding box is deliberately not used
as a Blender target box: node rotations and the coordinate-frame conversion can
change that box in ways no fixed axis permutation repairs. Measured on a real
wardrobe, the outside box was 1.416 x 2.365 x 1.778 while Blender imported
1.604 x 2.283 x 0.678. Passing per-axis targets would silently shrink an
already-correct model to 78%; passing the inferred factor 1 is a no-op.

Old conditioned sidecars are accepted only when they carry the current scale
algorithm version. Ambiguous, unknown, or unmeasurable assets are refused
instead of falling back to authored scale.
---

## 2. What it actually achieves — measured, not assumed

Against the real hub (800 dirs sampled for the recall figure):

```
IN SCOPE (name matches an archviz band):  230
RESOLVED:                                 151/230 = 65.7%

REFUSALS (in-scope only):
  no-plausible-unit   64    e.g. Bunk bed (0.18 x 0.10 x 0.05)
  ambiguous           15    e.g. Low Poly Wire Mirror (48.00 x 48.00 x 0.55)
```

**Read that denominator carefully.** 65.7% is of assets whose *name* matches an
archviz band. Across the whole hub the resolve rate is 20.5%, and the gap is not
a failure — it is the next section.

### What is NOT claimed

**The correctness of the 151 is unmeasured.** They resolve *decisively*, which
is not the same as *correctly*. A known weak spot is small objects, where the
2.54x gap between metres and inches is small relative to a wide band:

    Bread   raw largest 1.2  ->  in  ->  3.0 cm     almost certainly wrong

Metres would put it at 1.2 m, outside the food band's 0.5 m ceiling, so inches
won by elimination rather than by evidence. Tightening small-object bands, or
demanding a margin rather than mere membership, is the obvious next move — and
it needs a labelled sample to evaluate against, which does not exist yet.

---

## 3. The hub is mostly not archviz content

This is the finding that reframes the curation problem, and it was a surprise.

Of **3,597 hub models, 723 (20.1%) have an archviz-relevant name.** The most
frequent words among the rest:

    kitbash:57  sword:46  rifle:37  building:36  knife:35  gun:31  pistol:28
    axe:25  spaceship:24  shotgun:23  sniper:21  grenade:18  turret:18
    shuriken:17  scifi:17  tank:16  rocket:11

The hub was harvested for game assets (Kenney, Poly Pizza, Sketchfab) and it
shows. **The catalogue's ceiling from the existing hub is roughly 700 models,
not 3,600** — about 11x the current 64 slots, not 56x.

### What the hub can dress, by category

| category | models | | category | models |
|---|---|---|---|---|
| chair | 106 | | door | 31 |
| decor | 99 | | bookshelf | 29 |
| table | 96 | | sofa | 29 |
| car | 73 | | bed | 25 |
| cabinet | 49 | | tree | 25 |
| lamp | 42 | | sanitary | 23 |
| planter | 41 | | rug | 11 |

And the thin end, which is where harvesting effort should go:

    wardrobe 9   tv 8   bath 6   appliance 6   armchair 5   fridge 5
    window 3   person 2

By source, of the archviz-relevant 723: polypizza 338, thebasemesh 163,
polyhaven 130, sketchfab 90, kenney 2.

**Actionable:** a bedroom needs a wardrobe and there are nine; a kitchen needs
appliances and there are six. Those categories are the binding constraint on
dressing a real Indian residential plan, not the total model count.

---

## 4. What was NOT done, and why

**D5 Render's asset library was not copied.** It is licensed content and Arcvia
is a commercial product. Separately, D5 has no API, CLI or scripting interface —
only a silent *installer* command line — so it cannot be driven by the render
queue even if licensing were solved. See the memory note
`arcvia-d5-render-rejected`; this was evaluated and closed, do not re-litigate.

**Nothing was integrated for wall-line identification**, because D5 has nothing
to integrate: it never reads floor plans. That problem is already solved here by
the trained classifier, live and confirmed on `:8090`:

    "classifier": { "state": "ready", "mIoU": 0.8009,
                    "trained_from": "kaggle rayanamal/arcvia-p2-finetune v6",
                    "beats live product 4/5 markups" }

---

## 4a. Scale for plans that print no dimensions

`services/floorplan-ai/plan_scale.py`, wired into `main.py` as `deduce_scale()`.

Before this, `PlanScale` came from exactly one place: `labels.infer_scale`,
which reads the sizes the architect **printed** in the rooms. Good method, and
it stays primary. But a brochure page, a scan, or a photo of a drawing prints
nothing, and those returned `scale=None` — leaving everything downstream
unitless. No areas, no bill of quantities, no compliance predicate, and
furniture that cannot be checked for fit because there is nothing to fit it
against.

**The rule that makes it work: a ruler must be LOW-VARIANCE, not merely
known-size.** A sofa is a known size and a terrible ruler — real sofas run
1.5–2.6 m and the error goes straight into the scale. A nine-inch brick wall is
230 mm because that is what a brick is. A door leaf is 900 mm because that is
what the joinery shop makes. So this rules with masonry and joinery, and
deliberately does *not* import `classify/catalogue_dims.py` even though it is
generated and available: those are nominal sizes for placing things, not
tolerances for measuring with.

Evidence must agree **across kinds** — a thickness reading and a door reading
landing on the same scale are two independent measurements. No extent window is
used, because `classify/units.py` already documents why that is a trap ("a site
plan is not a building").

### Two defects found while building it, both recorded in the code

1. **The 200/750 conspiracy.** 200/230 = 0.87 and 750/900 = 0.83, so a
   wall-200 + door-750 reading lands on a second internally-consistent scale
   with the *same* number of readings across the *same* two kinds. Counting
   cannot separate them, and more doors do not help — every extra door feeds
   both clusters equally. Only a prior on which buildings are common does. That
   is why `Ruler.prior` exists.
2. **Cluster chaining.** Admitting a candidate within `AGREEMENT` of the
   *running median* lets a cluster walk: each new reading is close to the median
   it just helped move. It pulled a 10.4 reading into a 12.0 cluster and
   reported 13% spread against an 8% threshold — a cluster that by its own
   definition did not agree. Fixed by bounding the whole span.

`PlanScale` now carries `method: "measured" | "inferred"` and `agreed[]`,
defaulted so existing consumers see the shape they always saw. **A deduced
scale and a measured one are not the same claim**, and anything quoting an area
should be able to say which it had. 19/19 tests.

Studio preserves that provenance. A measured scale may auto-calibrate an
uncalibrated underlay; an inferred scale is shown with the rulers that agreed
but is never marked calibrated or applied automatically. The reviewer must
calibrate against a known dimension before areas, quantities, or furniture fit
are treated as authoritative.
## 4b. Resizing an asset to the space the plan has

`tools/asset-ingest/fit.mjs`. Scaling a model to fill a gap is one line and
almost always wrong. Which objects stretch is domain knowledge:

| mode | categories | behaviour |
|---|---|---|
| **rigid** | Doors & windows, Bathroom | never resized. A door leaf is 900 mm; if it does not fit that is a finding about the *plan*. Refuses with how much it is over by. |
| **stepped** | Seating, Beds, Tables, Storage, Kitchen | swap to the largest variant that fits — a short wall wants a 2-seat sofa, not a squashed 3-seat. |
| **elastic** | Decor, Lighting, Outdoor | genuinely made-to-length. Resized uniformly, within per-category limits. |

Unknown categories default to **stepped**, the cautious middle. Scaling is
always uniform — stretching one axis deforms a product into something no
manufacturer sells. 25/25 tests.

The expensive failure is the elastic one, because it is invisible: a stretched
sofa renders beautifully.

## 5. Next

1. **Harvest the thin categories** — wardrobe, appliance, fridge, window, tv,
   bath. Poly Haven and The Base Mesh are the metric-honest sources.
2. **Widen the catalogue** past 64 slots against the ~700 usable models, using
   `from-hub.mjs`, which already scores name and footprint and already refuses
   below threshold.
3. **Label a sample** of scale verdicts so §2's correctness can be measured
   instead of assumed. Without it, band tightening is guesswork.
4. **Consider a margin rule** in `resolve()` — prefer a reading comfortably
   inside the band over one that only just qualifies.
