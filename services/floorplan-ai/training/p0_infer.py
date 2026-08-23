"""
P0 — does a CubiCasa5K-trained model (clean line-drawings) transfer to a rendered
presentation plan? Runs the pretrained hg_furukawa model on one image and saves an
overlay of its WALL segmentation (room class 2) plus detected icons.

Usage: python p0_infer.py <image.png> <out_prefix> [--rotations]
"""
import sys, os
import numpy as np
import cv2
import torch
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "CubiCasa5k"))
from floortrans.models.hg_furukawa_original import hg_furukawa_original  # noqa: E402

ROOM_CLASSES = ["Background", "Outdoor", "Wall", "Kitchen", "Living Room", "Bed Room",
                "Bath", "Entry", "Railing", "Storage", "Garage", "Undefined"]
ICON_CLASSES = ["No Icon", "Window", "Door", "Closet", "Electrical Appliance", "Toilet",
                "Sink", "Sauna Bench", "Fire Place", "Bathtub", "Chimney"]
WALL = 2

WEIGHTS = os.path.join(HERE, "model_best_val_loss_var.pkl")


def load_checkpoint():
    # Prefer the safe loader (tensors only). A training checkpoint can carry
    # non-tensor globals that trip it; only then fall back to the full unpickler,
    # and only because this file is the CubiCasa authors' own published model
    # (their repo's linked Drive), not an arbitrary download.
    try:
        return torch.load(WEIGHTS, map_location="cpu", weights_only=True)
    except Exception as safe_err:
        print(f"  [weights_only=True failed: {type(safe_err).__name__}; "
              f"falling back for this trusted academic checkpoint]")
        return torch.load(WEIGHTS, map_location="cpu", weights_only=False)


def load_model():
    # Instantiate directly and SKIP init_weights(): it loads an ImageNet backbone
    # init from a relative path (for training), and we overwrite the whole state
    # dict with the trained CubiCasa checkpoint below, so it is pure waste — and
    # its file isn't shipped for inference anyway.
    model = hg_furukawa_original(n_classes=51)
    model.conv4_ = torch.nn.Conv2d(256, 44, bias=True, kernel_size=1)
    model.upsample = torch.nn.ConvTranspose2d(44, 44, kernel_size=4, stride=4)
    ckpt = load_checkpoint()
    state = ckpt["model_state"] if "model_state" in ckpt else ckpt
    model.load_state_dict(state)
    model.eval()
    return model


def to_tensor(bgr, long_edge=1024):
    h0, w0 = bgr.shape[:2]
    scale = long_edge / max(h0, w0)
    if scale < 1:
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    h, w = bgr.shape[:2]
    # the net downsamples/upsamples; keep dims a multiple of 32
    H, W = (h // 32) * 32, (w // 32) * 32
    bgr = cv2.resize(bgr, (W, H), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    rgb = 2.0 * (rgb / 255.0) - 1.0                       # [-1, 1]
    t = torch.from_numpy(rgb.transpose(2, 0, 1)).unsqueeze(0)
    return t, bgr


def main():
    img_path, out_prefix = sys.argv[1], sys.argv[2]
    bgr = cv2.imread(img_path)
    if bgr is None:
        raise SystemExit(f"could not read {img_path}")

    model = load_model()
    tensor, resized = to_tensor(bgr)
    H, W = resized.shape[:2]

    with torch.no_grad():
        pred = model(tensor)
        pred = F.interpolate(pred, size=(H, W), mode="bilinear", align_corners=True)

    rooms = F.softmax(pred[0, 21:21 + 12], dim=0).numpy()
    rooms_arg = np.argmax(rooms, axis=0)
    icons = F.softmax(pred[0, 21 + 12:], dim=0).numpy()
    icons_arg = np.argmax(icons, axis=0)

    wall_mask = (rooms_arg == WALL)
    wall_frac = float(wall_mask.mean())

    # --- overlay: walls in red, room fill faint, on the plan ---
    overlay = resized.copy()
    overlay[wall_mask] = (0, 0, 255)
    blended = cv2.addWeighted(resized, 0.55, overlay, 0.45, 0)
    cv2.imwrite(f"{out_prefix}_walls.png", blended)

    # --- room-class map (which pixels the model thinks are what) ---
    palette = np.array([
        (30, 30, 30), (90, 140, 90), (0, 0, 255), (200, 160, 60), (60, 160, 200),
        (60, 200, 160), (200, 60, 160), (160, 200, 60), (120, 120, 220),
        (200, 200, 60), (120, 80, 40), (100, 100, 100)], dtype=np.uint8)
    room_rgb = palette[np.clip(rooms_arg, 0, 11)]
    cv2.imwrite(f"{out_prefix}_rooms.png", cv2.addWeighted(resized, 0.4, room_rgb, 0.6, 0))

    # --- report ---
    print(f"image {os.path.basename(img_path)}  ({W}x{H})")
    print(f"  WALL pixels: {wall_frac*100:.2f}% of image")
    room_hist = {ROOM_CLASSES[i]: int((rooms_arg == i).sum()) for i in range(12)}
    room_hist = {k: v for k, v in sorted(room_hist.items(), key=lambda kv: -kv[1]) if v > 0}
    print("  room-class pixel counts:", room_hist)
    icon_hist = {ICON_CLASSES[i]: int((icons_arg == i).sum()) for i in range(1, 11)
                 if (icons_arg == i).sum() > 50}
    print("  icons detected (>50px):", icon_hist or "none")
    print(f"  wrote {out_prefix}_walls.png and {out_prefix}_rooms.png")


if __name__ == "__main__":
    main()
