# Re-importing a revised DWG

Written 2026-08-22 by `aalev-35`, because the user reopened the decision.
This is a design, not an implementation. Nothing in it has been built.

---

## 0. The question, as the blueprint asks it

`docs/engine-blueprint.md:1013` puts it as a straight choice:

> **Round-trip** means `absorbPlanEdits`, `patches`, `locked`/`suppressed` and
> re-import all exist, so a revised DWG can be merged over a drawing the
> architect has already corrected by hand — but every studio edit has to survive
> a lossy projection (arcs are chorded on the way out and come back as N locked
> straight walls, permanently destroying the curve). **One-shot** means the model
> is discarded after import, the studio `Plan` is the only record, `absorb.ts`
> and half the provenance machinery are never built (roughly 10–12 days saved),
> and a revised drawing means re-importing from scratch and redoing every manual
> fix. Which?

The recorded answer was one-shot. It is worth saying plainly that this was a
*good* decision on the options as stated, and the argument that carried it — the
lossy projection — is correct and fatal. A round-trip that chords an arc on the
way out and reads back N straight walls does not merely fail to improve the
model; it **destroys information every time it runs**, and it does so silently,
which is this repo's characteristic failure mode.

---

## 1. Why both options are wrong

Both options share an assumption that is never stated: **that a human's
correction is an edit to geometry**, and therefore has to be projected back
through the model to survive.

Almost none of them are.

Go through what a person actually fixes after an import:

| What they do | Is it geometry? |
|---|---|
| "That layer is walls, that one is furniture" | No — a layer decision |
| "This room is the KITCHEN" | No — a label |
| "That is a door schedule, not 16 doors" | No — a suppression |
| "The drawing is in metres, not centimetres" | No — a unit decision |
| "These two frames are storeys of one villa" | No — a grouping |
| "This detected sofa is a bed" | No — a classification |
| "That wall is 230, not 115" | A **measurement**, not a shape |
| "Drag this wall 200 mm left" | **Yes** — and this is rare |

Seven of eight are *semantic*. They are decisions **about** geometry, not
geometry. Semantic decisions replay onto freshly-derived geometry losslessly,
because they never pass through the chording projection that kills the round
trip. The arc problem simply does not arise: we never write CAD back.

So the third option:

> **Re-import the geometry from scratch, every time. Never merge it. Replay the
> human decisions onto it, keyed by stable identity.**

The model stays derived and disposable — which is the whole strength of the
one-shot decision, kept. What survives a revision is not the model but the
**decision log**, which is small, human-readable, diffable, and never
projected through a lossy transform.

---

## 2. The one missing primitive, and it is one field

The schema is already built for this and nobody has noticed. From
`packages/building-model/src/schema.ts`:

```ts
export type Id = string
/** Derived from provenance so a re-import diffs instead of duplicating:
 *  'w:dxf:LATEST#2F3A' | 'w:pair:s3-f0-0117' | 'op:blk:D750#41' */

export interface Provenance {
  locked: boolean       // a human decided this — a re-solve MUST NOT overwrite it
  suppressed?: boolean  // a human deleted it — a re-import MUST NOT resurrect it
}
```

`locked` and `suppressed` are **exactly the replay primitives**, already
specified, already documented with the right semantics. They are declared and
used **nowhere** — grep the repo; the only hits are unrelated `locked` flags in
the studio's underlay.

And look at the ID format: `w:dxf:LATEST#2F3A`. That `#2F3A` is a **DXF entity
handle**. Whoever designed this schema knew exactly how identity was going to
survive a re-import.

**Measured, this session:** entity handles are present and readable —
`ezdxf` gives `e.dxf.handle` (`2862`, `CF12`, `CF13`, …) across 8,022 model-space
entities of the villa DXF. **The engine reads none of them.** `handle` appears
nowhere in `vendor/cad_kernel.py`, `ingest/` or `classify/`; the only matches in
the whole engine are Python file handles in `raster.py`.

That is the gap. Not ten days of merge engine — **one field, captured at ingest
and carried through.**

Why handles work: a CAD editor preserves an entity's handle across saves. Move a
wall and it keeps its handle; delete and redraw it and it gets a new one. That is
precisely the semantics identity needs — *"the same wall, moved"* is
distinguishable from *"a different wall"* by the file itself, with no geometric
guessing at all.

---

## 3. Identity, honestly — three tiers, not one

Handles solve identity for things that ARE entities. They do not solve it for
things the engine *derives*. Be honest about the tiers, because a design that
claims uniform stable identity will be wrong in the third tier and wrong
silently.

**Tier 1 — anchored. Identity is exact.**
Anything traceable to one source entity: a face line, a block placement, a text
label. `w:dxf:<sheet>#<handle>`. Survives any edit that does not delete and
redraw the entity.

**Tier 2 — derived from anchored parents. Identity is a set.**
A paired wall comes from two faces. Its identity is the *sorted pair of parent
handles*: `w:pair:#2F3A+#2F3B`. This is stable under moves, under re-runs of the
pairing pass, and under changes elsewhere in the drawing — which the current
`w:pair:s3-f0-0117` positional index is not. **Positional indices must not be
used for identity.** Insert one entity earlier in the file and every index below
it shifts, and every replayed decision lands on the wrong wall — silently, and
looking entirely plausible.

**Tier 3 — synthesised. No stable identity, and say so.**
`add_perimeter`'s derived ring has no parent entity; it is invented from a
morphological closing. Its identity cannot be stable and should not pretend to
be. Decisions about tier-3 elements are **re-derived, never replayed**, and the
report must say how many decisions were dropped for this reason rather than
quietly losing them.

---

## 4. What survives, what asks, what dies

The taxonomy is the deliverable. A re-import must produce this table for the
actual revision in front of it, not a success message.

| Decision | Keyed on | On re-import |
|---|---|---|
| Unit / scale | the source file | **Replays.** Also re-measured; a disagreement is a residual, not an overwrite |
| Wall-layer selection | layer names | **Replays.** Layer renamed → asks |
| Frame → storey grouping | frame identity | **Replays** if frames match; asks if the sheet was re-laid-out |
| Room name | room's bounding wall handle set | **Replays** if the room still closes from the same walls |
| Element suppressed | entity handle | **Replays.** This one matters most — a suppressed door schedule stays suppressed |
| Reclassification (sofa→bed) | block placement handle | **Replays** |
| Measurement override (thickness) | entity handle | **Replays**, and flags if the drawing now measures something different |
| Geometric nudge | entity handle + offset | **Replays if the parent moved rigidly**; asks otherwise |
| Anything on a tier-3 element | nothing | **Dropped, and counted in the report** |

The governing rule, and it is the same one the rest of this engine already
follows: **margin, not score, is the ask-a-human signal.** A replay that is
confident replays. A replay that is marginal goes to a review queue. A replay
that is impossible is *reported*, not dropped silently.

---

## 5. What to build, cheapest first

The point of this ordering is that **step 1 is worth doing even if nothing else
is ever built**, and each step after it is independently useful.

1. **Capture entity handles at ingest.** One field on the face/segment record,
   carried into `building.json`. No behaviour change, no risk. It makes every
   later step possible and it makes today's models debuggable — right now there
   is no way to point at a wall in the model and find it in the DXF. **1 day.**
2. **Stable IDs from handles**, tiers 1 and 2. Replaces positional indices.
   Immediately useful for the review queue (M5) and for storey registration,
   both of which need to name an element and have the name still mean something.
   **2 days.**
3. **The decision log.** A per-project append-only list of `{id, kind, value,
   who, when}`. Written by the studio when a human decides something. Nothing
   reads it yet. **2 days.**
4. **Replay on import**, with the taxonomy above and a report. **3 days.**
5. **Review queue for marginal replays** — folds into M5, which is already
   planned and unbuilt, rather than being separate work.

Roughly **8 days**, against the 10–12 estimated for the round-trip merge, and it
does not carry the lossy projection.

---

## 6. Not in scope, deliberately

- **No CAD write-back. Ever.** No DWG or DXF is emitted. This is what makes the
  arc problem disappear, and it is the load-bearing constraint of the whole
  design — the moment anything projects the model back to CAD, the blueprint's
  original objection returns in full.
- **No geometric diff of two drawings.** We do not compare old and new geometry
  to work out what moved. The file already knows, via handles. Attempting a
  geometric diff is how this becomes a ten-day merge engine again.
- **No conflict resolution UI in v1.** Marginal replays go to the existing
  review queue. If that queue does not exist yet, they go to a list in the
  report.
- **Curved walls stay chorded in the BUILD, not in the READ.** Unchanged by this
  design; noted only because the arc argument is what killed round-tripping and
  someone will ask.

---

## 7. What is most likely to be wrong here

Stated plainly so it can be checked rather than discovered.

1. **Handle stability across the round trip we do not control.** Handles survive
   AutoCAD saves. This pipeline converts DWG→DXF with LibreDWG, and it is
   **unverified whether LibreDWG preserves handles** across that conversion. If
   it does not, tier 1 collapses and the whole design needs a different anchor.
   **Test this before building step 1** — convert one DWG twice and compare
   handle sets. It is an afternoon, and everything depends on it.
2. **Revisions that re-draw rather than edit.** An architect who deletes a wing
   and redraws it produces all-new handles, and every decision on that wing is
   correctly but uselessly dropped. The design degrades to one-shot for that
   region. That is acceptable and must be *reported*, not hidden.
3. **Room identity is the weakest tier-2 case.** A room keyed on its bounding
   wall set loses identity when one partition is added. Possible mitigation:
   key on the largest stable subset plus centroid, accept a lower confidence,
   and send it to review. Not solved here.
4. **A decision log is a schema that will drift.** It has to version from day
   one or it becomes unreadable in three months.
