# Trained detector — scope for watertight walls on rendered plans

**Status:** proposal / not started. Written 2026-08-24 after the deck pipeline v1
shipped (see [[arcvia-deck-reconstruction]] / commits c117181, c27748d, 4ab8319).

## The problem this solves, precisely

The deck path (`reconstruct deck survey|build`) turns a client's presentation PDF
into a scaled, labelled 3D model. On a **rendered, furnished, open-plan** sheet —
which is what clients actually send — the geometry is thin: rooms/floors and scale
come out right, but **walls are sparse**. Verified on the Avarana ground plan: 13
walls, no enclosure, because the open-plan great room has no partitions to trace
and the perimeter poché only partly survives (render: `ground_hero.png`).

This is not a tuning gap. Three heuristic prototypes (cluster-scale, flood-fill
scale, wall-keeping) all hit the same ceiling: **nothing local to a stroke
separates a wall from a bed, a dimension leader, or a level-marker box** on a
render. That separation has to be *learned*.

## What already exists, and why it is NOT the fix

`services/floorplan-ai` has a `yolo` backend behind `FLOORPLAN_BACKEND=yolo` +
`FLOORPLAN_MODEL=<weights>`. **It does not address this problem.** Read
`detect_yolo`: it still calls `detect_heuristic` for walls and rooms, and uses the
model only to add *symbol boxes* (doors, windows, furniture icons) on top —
"line extraction is a solved problem... the model earns its place on the symbols."

That was the right call for a clean CAD line-drawing. It is the wrong tool here:
the walls themselves are what fail on a render, and a box detector layered over
the same heuristic geometry inherits the same sparse walls.

## What is actually needed: room/wall **segmentation**, not box detection

Match the engine's existing room-first philosophy (walls follow from rooms). A
pixel-segmentation model predicts, per pixel, one of: `wall`, `room-interior`,
`opening` (door/window), `outdoor`, `background`. From those masks:

- room-interior components → room polygons (replaces `enclosed_regions` on renders)
- wall mask → centrelines → the same `WallSegment` list the pipeline already emits
- opening mask → door/window hosts (a capability the heuristic path drops entirely)

Crucially, **the `/detect` contract does not change** (`walls`, `objects`, `rooms`,
`scale`). So the deck→GLB flow, the engine `raster` path, and the studio panel all
consume the new detector unchanged. This is a new backend *mode* — call it
`segment` — beside `heuristic` and `yolo`, selected by the same `FLOORPLAN_BACKEND`
env. OCR (`labels.py`) and the scale-confirm math stay exactly as they are; the
model replaces geometry extraction, not label reading.

## The data problem — and the decisive advantage we have

A segmentation model is only as good as its labelled plans, and this is where it
usually dies. Two sources:

1. **CubiCasa5K** — ~5,000 floor plans annotated with rooms, walls and icons
   (Kalervo et al., 2019; permissively licensed). The standard starting point.
   **Domain gap:** these are clean line drawings, not watercolour/furnished
   presentation renders. A model trained only on them will transfer poorly to the
   decks clients send — exactly our target.

2. **Synthetic renders from our own pipeline — the killer move.** Arcvia already
   *renders* plans (the Blender render farm, see [[propall-teardown]] /
   [[arcvia-render-throughput]]). Run it backwards for training: take known
   floor-plan geometry (we have DWG/DXF reconstructions and the studio editor's
   planar graph) → render it in the presentation style (poché fills, furniture
   blocks, watercolour landscaping, dimension text) → and because we generated the
   geometry, the **ground-truth wall/room/opening masks come for free, pixel-exact**.

   This gives *unlimited labelled data in the exact target domain*. It is the
   difference between hoping CubiCasa transfers and training on the thing we
   actually get. Recommend: pre-train on CubiCasa5K, fine-tune on synthetic
   renders, hold out a handful of real client decks (Avarana, Casa Altinho) for
   honest evaluation.

## Model & runtime

- **Model:** a compact segmentation net — U-Net or YOLOv8-seg — with 5–6 classes.
  Small enough for CPU inference; the target is one plan image, not video.
- **Runtime:** export to **ONNX** and run through onnxruntime, exactly as
  `labels.py` already runs RapidOCR. No new serving infra, no GPU at inference.
  This matters: **this machine has an Intel Arc GPU, no NVIDIA** (see
  [[intel-arc-gpu-readback]] / [[nvidia-nim-hosted-api]]), so CPU-ONNX is the only
  local inference path — and it is enough for single images.
- **Keep the OCR quarantine.** floorplan-ai's env already carries onnxruntime for
  RapidOCR; a seg model reuses it. Do NOT pull training deps (torch, ultralytics)
  into the serving env — train elsewhere, ship only the `.onnx`.

## Training compute — the one hard dependency

**No NVIDIA GPU on this box**, so training is not local. Options, cheapest first:
a rented cloud GPU box (a few hours of an A10/T4 fine-tunes a small seg net for
tens of dollars); or a managed training run. Inference stays local and free. This
is the only line item that costs money and the only thing that cannot be done on
this machine.

## Phases

- **P0 — baseline (cheap, ~1 day).** Run an existing CubiCasa5K-pretrained model on
  the Avarana + Casa Altinho plans. Measures out-of-the-box transfer and settles
  U-Net vs YOLOv8-seg. No training. Decides whether P1 is worth it.
- **P1 — synthetic data generator (~half the total effort).** A script off the
  render farm: geometry → styled render + mask set. This is the real work and the
  real value; it is reusable and it is ours.
- **P2 — train (cloud GPU).** Pre-train CubiCasa5K → fine-tune synthetic → export
  ONNX. Iterate against the held-out real decks.
- **P3 — wire the `segment` backend.** New geometry-from-masks path in the
  detector behind `FLOORPLAN_BACKEND=segment`; validate the deck→GLB flow end to
  end; ship. `heuristic` stays the default and the fallback.

**Estimate:** ~1–2 focused weeks, dominated by P1 (the generator), plus a small
cloud-GPU spend in P2.

## Honest ceiling

This targets *rendered presentation plans*, our actual input. It will not make an
arbitrary phone photo of a plan watertight, and it should not claim to. On the
decks clients send, synthetic-domain fine-tuning is the credible route to the
90%+ wall completeness the heuristic cannot reach — because it learns the one
thing the heuristic never can: what is a wall and what is furniture.

## Boundaries / coordination

Detector + engine geometry = this session's lane (floorplan-ai, reconstruct). The
studio panel already consumes the unchanged `/detect` + deck contract, so a
shipped `segment` backend needs **no** studio change — confirm with the studio
session before assuming that still holds at ship time. The synthetic generator
touches the render farm; scope its geometry source (studio planar graph vs DWG
reconstructions) before building.
