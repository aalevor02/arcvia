# Trained-detector training scripts (P0 / P1)

The segmentation-detector track scoped in `docs/DESIGN-TRAINED-DETECTOR.md`. These
are the experiment scripts, version-controlled here so they survive; the heavy rig
(torch venv, the CubiCasa repo, the 209 MB weights) lives OUTSIDE the repo at
`A:\Tools\FloorplanModel` (kept out of the serving env on purpose — torch must not
enter floorplan-ai's runtime venv).

## The rig (on A:, not in git)

```
A:\Tools\FloorplanModel\
  .venv\                          # python 3.12, torch CPU + cv2 + gdown (experiment only)
  CubiCasa5k\                     # git clone of CubiCasa/CubiCasa5k (model code)
  model_best_val_loss_var.pkl     # 209 MB CubiCasa pretrained weights (gdown from their Drive)
  p0_infer.py  synth_plan.py      # == the copies in this folder
```

If the rig is gone (e.g. A: cleaned), rebuild it:
```
py -3.12 -m venv A:\Tools\FloorplanModel\.venv
A:\Tools\FloorplanModel\.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
A:\Tools\FloorplanModel\.venv\Scripts\python -m pip install numpy scipy scikit-image shapely matplotlib opencv-python gdown tqdm
git clone --depth 1 https://github.com/CubiCasa/CubiCasa5k.git A:\Tools\FloorplanModel\CubiCasa5k
A:\Tools\FloorplanModel\.venv\Scripts\python -m gdown 1gRB7ez1e4H7a9Y09lLqRuna0luZO5VRK -O A:\Tools\FloorplanModel\model_best_val_loss_var.pkl
```

## p0_infer.py — DONE (verdict: proceed)

Runs the CubiCasa pretrained model zero-shot on one plan image, overlays its wall
segmentation + icons. Gotchas already handled in the code: CubiCasa's `torch==1.0`
is dead on 3.12 (modern torch runs the net — it's pure torch.nn); skip
`init_weights()` (loads a training-only backbone by relative path; we overwrite the
whole state dict anyway); `torch.load` tries `weights_only=True` first.
```
cd A:\Tools\FloorplanModel
.venv\Scripts\python p0_infer.py <plan.png> <out_prefix>
```
Result: traces walls better than the heuristic on the Avarana rasters AND detects
toilet/sink/bathtub/door/window; only fails on render-only false positives
(watercolour trees, furniture). That gap is what P1 fixes.

## synth_plan.py — DONE (P1 generator, domain-randomised)

Generates deck-style floor plans procedurally with pixel-exact CubiCasa-class masks
(rooms + icons). A per-sample `Style` domain-randomises the look (wall solid/double,
colours, paper, fonts, tree palettes, pool, 90° orientation + skew, noise) while
geometry — and mask — stay exact. ~100 ms/sample.
```
.venv\Scripts\python synth_plan.py <out_dir> [n] [start_seed]
```
Per sample: `<id>.png`, `<id>_rooms.npy` (12 room classes), `<id>_icons.npy`
(11 icon classes), `<id>_preview.png` (render | mask).

## What's left (P1 tail + P2)

1. Mix a few REAL decks (Avarana, Casa Altinho) into the fine-tune set; hold out
   others for honest transfer eval.
2. **P2 — the fine-tune.** Needs a CLOUD GPU (no NVIDIA on this box; inference is
   local CPU-ONNX). Fine-tune the CubiCasa multi-task net (or a compact U-Net) on
   synthetic + real, export ONNX.
3. Wire a `segment` backend in `main.py` behind `FLOORPLAN_BACKEND=segment` — the
   `/detect` contract is unchanged, so the deck flow and studio UI need no change.
   Shape door/window output like the DXF path's `openings` so codecheck binds.
