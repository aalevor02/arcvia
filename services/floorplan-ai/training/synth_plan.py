"""
P1 — synthetic presentation-plan generator, with domain randomisation.

P0 showed a CubiCasa-trained model segments walls on our rendered decks but
hallucinates "wall" on watercolour trees and furniture it never trained on.
Fixing that needs pixel-exact labels in OUR domain, so this GENERATES the geometry
(every wall/room/opening/fixture known by construction), renders it deck-style, and
writes the exact mask beside it. The confusers (trees, furniture) are rendered ON
PURPOSE, labelled correctly (tree -> Outdoor, bed -> its room, never Wall) — that
mislabel is the whole lesson.

Domain randomisation: a real client deck is one point in a wide space — wall drawn
as solid poche OR double line, grey/black/brown, dark or cream paper, labelled in
any font, landscaped in green or teal, at any orientation, a bit noisy. Training on
one fixed look teaches the look, not the plan. So a per-sample Style varies all of
that while the geometry — and therefore the mask — stays exact. The model is forced
to learn what a wall IS, not what our renderer's wall looks like.

Deterministic: pass a seed. Output per sample id:
  <id>.png  <id>_rooms.npy  <id>_icons.npy  <id>_preview.png

Usage: python synth_plan.py <out_dir> [n] [start_seed]
"""
import os, sys, math, random
import numpy as np
import cv2

ROOM = {"Background": 0, "Outdoor": 1, "Wall": 2, "Kitchen": 3, "Living Room": 4,
        "Bed Room": 5, "Bath": 6, "Entry": 7, "Railing": 8, "Storage": 9,
        "Garage": 10, "Undefined": 11}
ICON = {"No Icon": 0, "Window": 1, "Door": 2, "Closet": 3, "Appliance": 4,
        "Toilet": 5, "Sink": 6, "Sauna": 7, "Fire Place": 8, "Bathtub": 9, "Chimney": 10}

ROOM_TYPES = [("Bed Room", 0.30), ("Living Room", 0.20), ("Kitchen", 0.12),
              ("Bath", 0.18), ("Storage", 0.10), ("Entry", 0.10)]

W, H = 1024, 768
MARGIN = 90


# ---------------------------------------------------------------------------
# Style — the randomised look of one sheet (geometry is unaffected)
# ---------------------------------------------------------------------------
class Style:
    def __init__(self, rng):
        # paper: white, cream, or a faint grey scan
        self.bg = rng.choice([(255, 255, 255), (252, 250, 244), (248, 248, 250),
                              (245, 243, 238), (255, 255, 255)])
        # wall ink: greys, near-black, warm brown
        self.wall_color = rng.choice([(110, 110, 110), (70, 70, 70), (40, 40, 40),
                                     (95, 105, 120), (80, 70, 60)])
        self.wall_t = rng.randint(5, 10)
        self.wall_mode = rng.choice(["solid", "solid", "double"])  # poche vs CAD lines
        self.ink = rng.choice([(70, 70, 70), (50, 50, 50), (90, 90, 100)])
        self.ink_w = rng.randint(1, 2)
        self.font = rng.choice([cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_DUPLEX,
                               cv2.FONT_HERSHEY_COMPLEX])
        self.label_scale = 0.38 + rng.random() * 0.16
        self.show_dim = rng.random() < 0.8
        self.label_top = rng.random() < 0.7
        # landscaping palette (BGR): green, teal-watercolour (Avarana), grey-green, autumn
        self.tree = rng.choice([(90, 175, 100), (150, 175, 120), (120, 150, 110),
                               (70, 130, 160), (90, 160, 175)])
        self.tree_density = rng.choice([0, 2, 3, 4, 5, 6])
        self.pool = rng.random() < 0.45
        self.pool_color = rng.choice([(230, 210, 150), (220, 180, 120), (200, 200, 210)])
        self.outdoor = rng.random() < 0.9   # sometimes the sheet is cropped to the building
        self.rot_k = rng.randint(0, 3)       # 90-degree turns (mask-exact)
        self.small_rot = (rng.random() - 0.5) * 8 if rng.random() < 0.4 else 0.0
        self.noise = rng.randint(0, 6)
        self.blur = rng.random() < 0.35


# ---------------------------------------------------------------------------
# Layout — recursive binary subdivision of the footprint into rooms
# ---------------------------------------------------------------------------
class Room:
    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.kind = None
    @property
    def w(self): return self.x1 - self.x0
    @property
    def h(self): return self.y1 - self.y0
    def area(self): return self.w * self.h


def subdivide(room, rng, depth, min_side=150):
    if depth <= 0 or (room.w < min_side * 2 and room.h < min_side * 2):
        return [room]
    horizontal = room.w < room.h if room.w != room.h else rng.random() < 0.5
    if horizontal:
        if room.h < min_side * 2:
            return [room]
        cut = rng.randint(int(room.y0 + min_side), int(room.y1 - min_side))
        a, b = Room(room.x0, room.y0, room.x1, cut), Room(room.x0, cut, room.x1, room.y1)
    else:
        if room.w < min_side * 2:
            return [room]
        cut = rng.randint(int(room.x0 + min_side), int(room.x1 - min_side))
        a, b = Room(room.x0, room.y0, cut, room.y1), Room(cut, room.y0, room.x1, room.y1)
    out = []
    for child in (a, b):
        if rng.random() < 0.25:
            out.append(child)
        else:
            out.extend(subdivide(child, rng, depth - 1, min_side))
    return out


def make_layout(rng):
    fx0 = MARGIN + rng.randint(-30, 40)
    fy0 = MARGIN + rng.randint(-30, 40)
    fx1 = W - MARGIN - rng.randint(-30, 40)
    fy1 = H - MARGIN - rng.randint(-30, 40)
    footprint = Room(fx0, fy0, fx1, fy1)
    rooms = subdivide(footprint, rng, depth=rng.randint(3, 5))
    rooms.sort(key=lambda r: -r.area())
    kinds = ["Living Room"]
    for _ in rooms[1:]:
        r = rng.random(); acc = 0
        for name, p in ROOM_TYPES:
            acc += p
            if r <= acc:
                kinds.append(name); break
        else:
            kinds.append("Storage")
    for room, kind in zip(rooms, kinds):
        room.kind = kind
    return footprint, rooms


# ---------------------------------------------------------------------------
# Render the plan AND the aligned masks from the same geometry
# ---------------------------------------------------------------------------
def _tree(img, rmask, cx, cy, r, st, rng):
    base = st.tree
    for _ in range(rng.randint(60, 110)):
        a = rng.random() * 2 * math.pi
        rr = r * (0.35 + 0.65 * rng.random())
        x, y = int(cx + rr * math.cos(a)), int(cy + rr * math.sin(a))
        rad = rng.randint(6, 16)
        jitter = rng.randint(-25, 25)
        col = tuple(int(np.clip(c + jitter, 0, 255)) for c in base)
        cv2.circle(img, (x, y), rad, col, -1)
        cv2.circle(rmask, (x, y), rad, ROOM["Outdoor"], -1)


def _wall_seg(img, rmask, a, b, st):
    t = st.wall_t * 2
    cv2.line(rmask, a, b, ROOM["Wall"], t)                 # mask: solid band always
    if st.wall_mode == "solid":
        cv2.line(img, a, b, st.wall_color, t)
    else:  # double line: fill then split with a paper-coloured centre line
        cv2.line(img, a, b, st.wall_color, t)
        cv2.line(img, a, b, st.bg, max(1, t - 4))


def _wall_rect(img, rmask, room, st, heavy=False):
    old_t = st.wall_t
    if heavy:
        st.wall_t += 2
    for (a, b) in [((room.x0, room.y0), (room.x1, room.y0)),
                   ((room.x0, room.y1), (room.x1, room.y1)),
                   ((room.x0, room.y0), (room.x0, room.y1)),
                   ((room.x1, room.y0), (room.x1, room.y1))]:
        _wall_seg(img, rmask, a, b, st)
    st.wall_t = old_t


def _furnish(img, imask, room, st, rng):
    cx, cy = (room.x0 + room.x1) // 2, (room.y0 + room.y1) // 2
    ink, w = st.ink, st.ink_w
    if room.kind == "Bed Room":
        bw, bh = min(room.w - 40, 150), min(room.h - 40, 110)
        cv2.rectangle(img, (cx - bw//2, cy - bh//2), (cx + bw//2, cy + bh//2), ink, w)
        cv2.line(img, (cx - bw//2, cy - bh//2 + 25), (cx + bw//2, cy - bh//2 + 25), ink, w)
    elif room.kind == "Living Room":
        cv2.rectangle(img, (cx - 70, cy + 20), (cx + 70, cy + 45), ink, w)
        cv2.rectangle(img, (cx - 40, cy - 40), (cx + 40, cy - 10), ink, w)
    elif room.kind == "Kitchen":
        cv2.rectangle(img, (room.x0 + 18, room.y0 + 18), (room.x0 + 60, room.y1 - 18), ink, w)
        _fixture(img, imask, cx, cy, "Sink", st)
        _fixture(img, imask, room.x0 + 40, room.y0 + 40, "Appliance", st)
    elif room.kind == "Bath":
        _fixture(img, imask, room.x0 + 30, room.y0 + 30, "Toilet", st)
        _fixture(img, imask, room.x1 - 35, room.y0 + 30, "Sink", st)
        _fixture(img, imask, cx, room.y1 - 35, "Bathtub", st)


def _fixture(img, imask, x, y, kind, st):
    ink, w = st.ink, st.ink_w
    if kind == "Toilet":
        cv2.ellipse(img, (x, y), (12, 16), 0, 0, 360, ink, w)
        cv2.circle(imask, (x, y), 16, ICON["Toilet"], -1)
    elif kind == "Sink":
        cv2.rectangle(img, (x - 14, y - 10), (x + 14, y + 10), ink, w)
        cv2.circle(imask, (x, y), 14, ICON["Sink"], -1)
    elif kind == "Bathtub":
        cv2.rectangle(img, (x - 40, y - 16), (x + 40, y + 16), ink, w)
        cv2.ellipse(img, (x, y), (34, 12), 0, 0, 360, ink, 1)
        cv2.rectangle(imask, (x - 40, y - 16), (x + 40, y + 16), ICON["Bathtub"], -1)
    elif kind == "Appliance":
        cv2.rectangle(img, (x - 12, y - 12), (x + 12, y + 12), ink, w)
        cv2.rectangle(imask, (x - 12, y - 12), (x + 12, y + 12), ICON["Appliance"], -1)


def _openings(img, rmask, imask, footprint, rooms, st, rng):
    for room in rooms:
        if rng.random() < 0.85:
            side = rng.choice(["t", "b", "l", "r"])
            gap = 34
            t = st.wall_t * 2 + 2
            if side in ("t", "b") and room.w > 100:
                dx = rng.randint(room.x0 + 30, room.x1 - 30 - gap)
                dy = room.y0 if side == "t" else room.y1
                cv2.line(img, (dx, dy), (dx + gap, dy), st.bg, t)
                cv2.line(rmask, (dx, dy), (dx + gap, dy), ROOM[room.kind], t)
                cv2.ellipse(img, (dx, dy), (gap, gap), 0, 0, 90, st.ink, 1)
                cv2.circle(imask, (dx + gap//2, dy), 14, ICON["Door"], -1)
            elif room.h > 100:
                dy = rng.randint(room.y0 + 30, room.y1 - 30 - gap)
                dx = room.x0 if side == "l" else room.x1
                cv2.line(img, (dx, dy), (dx, dy + gap), st.bg, t)
                cv2.line(rmask, (dx, dy), (dx, dy + gap), ROOM[room.kind], t)
                cv2.circle(imask, (dx, dy + gap//2), 14, ICON["Door"], -1)
    for _ in range(rng.randint(4, 8)):
        if rng.random() < 0.5:
            x = rng.randint(footprint.x0 + 40, footprint.x1 - 40)
            y = rng.choice([footprint.y0, footprint.y1])
            cv2.line(img, (x - 16, y), (x + 16, y), (180, 120, 40), 3)
            cv2.circle(imask, (x, y), 12, ICON["Window"], -1)
        else:
            y = rng.randint(footprint.y0 + 40, footprint.y1 - 40)
            x = rng.choice([footprint.x0, footprint.x1])
            cv2.line(img, (x, y - 16), (x, y + 16), (180, 120, 40), 3)
            cv2.circle(imask, (x, y), 12, ICON["Window"], -1)


def _label(img, room, st):
    if room.w < 70 or room.h < 45:
        return
    name = room.kind.upper()
    cx = (room.x0 + room.x1) // 2
    ty = room.y0 + 26 if st.label_top else (room.y0 + room.y1) // 2
    (tw, _), _ = cv2.getTextSize(name, st.font, st.label_scale, 1)
    cv2.putText(img, name, (cx - tw//2, ty), st.font, st.label_scale, (40, 40, 40), 1, cv2.LINE_AA)
    if st.show_dim:
        ft_w, ft_h = max(6, room.w // 30), max(6, room.h // 30)
        dim = f"{ft_w}'0\"X{ft_h}'0\""
        (dw, _), _ = cv2.getTextSize(dim, st.font, st.label_scale * 0.8, 1)
        cv2.putText(img, dim, (cx - dw//2, ty + 16), st.font, st.label_scale * 0.8,
                    (90, 90, 90), 1, cv2.LINE_AA)


def _postprocess(img, rmask, imask, st, rng):
    # exact 90-degree turns keep masks pixel-perfect
    if st.rot_k:
        img = np.rot90(img, st.rot_k).copy()
        rmask = np.rot90(rmask, st.rot_k).copy()
        imask = np.rot90(imask, st.rot_k).copy()
    # a small skew: linear on the image, nearest on the masks so labels stay integer
    if abs(st.small_rot) > 0.1:
        h, w = img.shape[:2]
        M = cv2.getRotationMatrix2D((w/2, h/2), st.small_rot, 1.0)
        img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR,
                             borderValue=st.bg)
        rmask = cv2.warpAffine(rmask, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
        imask = cv2.warpAffine(imask, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    # render noise (image only) — a scan/JPEG feel
    if st.blur:
        img = cv2.GaussianBlur(img, (3, 3), 0)
    if st.noise:
        n = np.zeros(img.shape, np.int16)
        cv2.randn(n, 0, st.noise)
        img = np.clip(img.astype(np.int16) + n, 0, 255).astype(np.uint8)
    return img, rmask, imask


def render(seed):
    rng = random.Random(seed)
    st = Style(rng)
    footprint, rooms = make_layout(rng)
    img = np.full((H, W, 3), st.bg, np.uint8)
    rmask = np.zeros((H, W), np.uint8)
    imask = np.zeros((H, W), np.uint8)

    if st.outdoor:
        cv2.rectangle(rmask, (footprint.x0 - MARGIN//2, footprint.y0 - MARGIN//2),
                      (footprint.x1 + MARGIN//2, footprint.y1 + MARGIN//2), ROOM["Outdoor"], -1)
        for _ in range(st.tree_density):
            side = rng.choice(["l", "r", "t", "b"])
            if side == "l": cx, cy = footprint.x0 - rng.randint(20, 55), rng.randint(footprint.y0, footprint.y1)
            elif side == "r": cx, cy = footprint.x1 + rng.randint(20, 55), rng.randint(footprint.y0, footprint.y1)
            elif side == "t": cx, cy = rng.randint(footprint.x0, footprint.x1), footprint.y0 - rng.randint(20, 55)
            else: cx, cy = rng.randint(footprint.x0, footprint.x1), footprint.y1 + rng.randint(20, 55)
            _tree(img, rmask, cx, cy, rng.randint(35, 60), st, rng)
        if st.pool:
            px = rng.randint(footprint.x0, footprint.x1 - 120)
            py = footprint.y1 + rng.randint(5, 30)
            cv2.rectangle(img, (px, py), (px + rng.randint(90, 150), py + rng.randint(40, 70)), st.pool_color, -1)
            cv2.rectangle(rmask, (px, py), (px + 150, py + 70), ROOM["Outdoor"], -1)

    for room in rooms:
        cv2.rectangle(rmask, (room.x0, room.y0), (room.x1, room.y1), ROOM[room.kind], -1)
    for room in rooms:
        _furnish(img, imask, room, st, rng)
    for room in rooms:
        _wall_rect(img, rmask, room, st)
    _wall_rect(img, rmask, footprint, st, heavy=True)
    _openings(img, rmask, imask, footprint, rooms, st, rng)
    for room in rooms:
        _label(img, room, st)

    return _postprocess(img, rmask, imask, st, rng)


# ---------------------------------------------------------------------------
_ROOM_PAL = np.array([(30,30,30),(90,150,90),(0,0,220),(210,170,60),(70,170,210),
                      (70,210,170),(210,70,170),(170,210,70),(130,130,230),
                      (210,210,70),(130,90,50),(110,110,110)], np.uint8)


def mask_vis(rmask, imask):
    vis = _ROOM_PAL[np.clip(rmask, 0, 11)]
    vis[imask == ICON["Door"]] = (0, 140, 255)
    vis[imask == ICON["Window"]] = (255, 200, 0)
    for k in ("Toilet", "Sink", "Bathtub", "Appliance"):
        vis[imask == ICON[k]] = (255, 0, 255)
    return vis


def main():
    out = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    os.makedirs(out, exist_ok=True)
    for i in range(n):
        seed = start + i
        img, rmask, imask = render(seed)
        base = os.path.join(out, f"plan_{seed:05d}")
        cv2.imwrite(base + ".png", img)
        np.save(base + "_rooms.npy", rmask)
        np.save(base + "_icons.npy", imask)
        preview = np.hstack([img, mask_vis(rmask, imask)])
        cv2.imwrite(base + "_preview.png", preview)
        wall_frac = float((rmask == ROOM["Wall"]).mean())
        print(f"plan_{seed:05d}: {img.shape[1]}x{img.shape[0]} "
              f"{len(np.unique(rmask))} classes, wall {wall_frac*100:.1f}%, "
              f"icons {sorted(set(np.unique(imask)) - {0})}")
    print(f"wrote {n} samples to {out}")


if __name__ == "__main__":
    main()
