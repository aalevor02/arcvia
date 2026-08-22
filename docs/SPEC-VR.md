# VR — requirements

Written 2026-08-22 by `aalev-35`. **A specification, not an implementation.**
Nothing here is built, and it deliberately was not: there is no headset on this
machine, and a VR feature that has never been worn is a feature nobody can claim
works. This exists so that whoever does have a headset starts from measurements
rather than from scratch.

---

## 0. What VR is for here, and what it is not

An architect's client cannot read a floor plan. That is the whole premise of
Arcvia, and VR is the strongest possible version of it: standing in the room at
1:1 answers "is the kitchen big enough" in three seconds and no drawing ever
does.

So the deliverable is **scale fidelity**, not spectacle. This matters because it
is the one thing the competition structurally cannot do — `docs/reference-mnml.md`
settles that mnml.ai persists only `.png` per artifact, with no mesh, no scale
and no export. You cannot stand inside a PNG. Poché emits a real mesh in real
metres, so a VR mode is a few hundred lines away rather than a different product.

**Not in scope, and say so to clients:** VR is not a review tool, not a redline
tool, and not multi-user. It is "walk through it at full size".

---

## 1. The platform decision: WebXR, and nothing else

Arcvia is a web product with a Three.js viewer already shipping
(`packages/viewer/src/SceneViewer.ts`, three 0.171). WebXR is a browser API that
turns that same viewer into a headset session. A native Unity or Unreal build
would mean a second renderer, a second asset pipeline, a store submission, and a
second copy of every lighting decision already made here.

**Requirement V1.** VR is a mode of the existing viewer, entered from a button on
a published walkthrough. No separate app, no separate build, no separate URL.

Targets, in order: Meta Quest 3 / 3S standalone browser (the realistic device an
Indian developer's client will own or be lent), then desktop-tethered Chrome/Edge
with any OpenXR headset, then Vision Pro Safari. Android/iOS phone "cardboard"
mode is explicitly **not** a target — a phone in a holder has no positional
tracking, so it cannot deliver the one thing VR is for here.

---

## 2. The frame budget, which is the whole engineering problem

This is the requirement everything else bends around.

A flat viewer that drops to 30 fps looks cheap. A headset that drops below its
refresh rate makes people ill. Quest 3 runs at **72 Hz minimum, 90 Hz normal,
120 Hz optional**, and it renders **two eyes**. So:

> **Requirement V2.** 90 Hz sustained, both eyes, on Quest 3 standalone.
> **11.1 ms per frame for the pair.** Not an average — a floor.

Against that, five things in the current viewer are disqualifying as written.
None is hard to fix; all of them must be, and none can be discovered late.

**V2.1 — The render loop is on-demand and must not be.**
`SceneViewer` renders only when `needsRender` is set (it is set in eleven
places). That is exactly right for a still viewer on a laptop battery and
completely wrong for VR, where the headset drives the cadence. A WebXR session
must use `renderer.setAnimationLoop(...)` — `requestAnimationFrame` does not
fire at headset rate and does not carry the XR frame. **The loop has to fork:
on-demand for flat, continuous for XR.**

**V2.2 — Post-processing must be off in XR.**
`EffectComposer` and the AO pass run full-screen at composer resolution. In
stereo that is two full-screen passes per frame, and several Three.js post
effects are not stereo-correct at all — they sample a single camera's depth and
produce a different image per eye, which reads as depth conflict. **Disable the
composer on session start and restore it on exit.** Ambient occlusion is a
luxury; it is not worth 11 ms.

**V2.3 — Shadows need a budget, not a setting.**
`PCFSoftShadowMap` with a shadow-casting rig is affordable at 60 Hz mono and is
the first thing to fall over at 90 Hz stereo. Requirement: **baked lighting is
the default in VR.** The lightmap bake already exists (API and worker both), and
a baked scene with no realtime shadows is both faster and better-looking than a
realtime scene at a reduced quality. `setBakedLighting()` is already in the
viewer. This makes the unbuilt bake UI a **prerequisite** for VR, not a
neighbour.

**V2.4 — Pixel ratio is not the lever it is in flat mode.**
`setPixelRatio(min(devicePixelRatio, 2))` does nothing in a session; XR
resolution comes from the device via `renderer.xr.setFramebufferScaleFactor()`.
Requirement: ship at **1.0** and expose nothing to the user until measured.

**V2.5 — Measure on the device, never in the emulator.**
The Chrome WebXR emulator does not model GPU cost at all. A frame budget verified
in the emulator is not verified. **No VR work may be signed off from a desktop.**

---

## 3. Locomotion

**Requirement V3. Teleport is the default and cannot be removed.**
Smooth locomotion causes motion sickness in a substantial minority of people,
and the audience here is a client being shown their own house for the first time
— exactly the person who must not feel unwell.

`WalkController` already carries the useful half: `eyeHeight` (1.6 m) and a
`speed` of 2.68 m/s with a comment recording that real walking speed feels too
slow indoors. In VR neither applies — eye height comes from the headset's floor
tracking, and speed only matters if smooth locomotion is enabled at all.

- **V3.1** Teleport: point, arc, land. Snap to floor. Refuse targets outside a
  room (the room polygons exist in `building.json`; use them).
- **V3.2** Snap-turn in fixed increments (30° or 45°), never smooth yaw.
- **V3.3** Optional smooth locomotion, **off by default**, with a vignette on
  movement. If it ships without the vignette it should not ship.
- **V3.4** No forced camera movement of any kind. No cinematic fly-through in a
  headset. The guided tour that exists in `walkthrough-live.ts` must be disabled
  in XR or converted to a sequence of teleports the user triggers.

---

## 4. Scale, which is the actual product

**Requirement V4.** The model must be presented at true scale, and the viewer
must be able to prove it.

- **V4.1** One metre in `building.json` is one metre in the session. No global
  scale factor, ever, for any reason.
- **V4.2** Eye height comes from the headset, not from `eyeHeight`. A user who
  is 1.55 m tall must see the room as a 1.55 m person sees it — that is the
  entire value proposition and a hardcoded 1.6 m quietly destroys it.
- **V4.3** A door frame in the session must measure its `building.json` width.
  This is the acceptance test. It is also the honest one, because it fails
  loudly if any transform has crept in.

Note this is where the unit work matters: a drawing read at the wrong scale
produces a model that is internally consistent and a thousand times too small,
and **in VR that is not subtle — it is unmissable.** VR is, incidentally, the
best unit-verification tool this product will ever have.

---

## 5. What must exist before VR is worth starting

In dependency order. VR is not the next thing to build; it is downstream of
three things that are independently worth having.

1. **The lightmap bake UI.** V2.3 makes baked lighting the default in VR, and
   the bake currently has no way to be run from the product. Listed at 3–4 days.
2. **A published walkthrough people actually use.** VR is a button on that page.
   Publishing exists; the button has nowhere to live until it does.
3. **A triangle budget with a real number in it.** The villa GLB is 2,076
   triangles — trivially inside any budget. A furnished scene with the asset hub
   wired in is a completely different figure, and nobody has measured one. The
   number belongs in the asset curation, not discovered at the headset.

**Estimate once those exist: 6–10 days**, matching the roadmap. Split roughly:
2 d session lifecycle and the loop fork, 3 d teleport and controllers, 2 d the
performance pass on-device, 1–3 d comfort and settings.

---

## 6. Acceptance — how anyone knows it works

A VR feature cannot be signed off by looking at a screenshot. These are the
tests, and all of them require a headset:

| | Test | Pass |
|---|---|---|
| A1 | Frame timing over a 5-minute walk, Quest 3 standalone | 90 Hz sustained, **zero** dropped-frame spikes over 11.1 ms |
| A2 | Measure a door in-session against `building.json` | within 10 mm |
| A3 | Two users of different heights | each sees the room from their own eye height |
| A4 | Enter and exit XR three times | no leaked render target, no lost composer, flat mode identical to before |
| A5 | Teleport at every room in the villa | no target outside a room, no floor-through |
| A6 | 20 minutes continuous | no reported nausea from a first-time user |

A6 is the one that will be skipped and is the one that matters. Write it into
the definition of done.

---

## 7. Open questions, honestly

1. **Does the asset hub's furniture survive a triangle budget?** Unknown, and it
   determines whether VR needs a separate LOD pipeline. Measure during curation.
2. **Baked-only, or realtime as an option?** Recommendation: baked only in v1.
   Shipping a quality slider before the budget is measured is how a 90 Hz target
   becomes a 60 Hz apology.
3. **Does anyone in the target market own a headset?** Genuinely unclear, and it
   is a commercial question rather than a technical one. It should be asked
   before ten days go into this — a builder's sales office in Hyderabad with one
   Quest is a different proposition from an architect expecting clients to have
   their own. **This is the question that decides whether the rest of this
   document is worth acting on.**
