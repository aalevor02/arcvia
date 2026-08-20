"""
Reconstruct Villa A-1's lower ground and second floors from the brochure plans.

No DWG in the archive draws these two floors. Both appear as rendered plans in
the brochure, which are the architect's own drawings - so they are TRACED, not
invented. The result is still weaker evidence than the CAD floors and is marked
`reconstructed` all the way through to the published data file.

Scale and registration come from the floors that do exist in both forms: all
four A-1 plans sit on one sheet at one scale, so the CAD stilt floor calibrates
metres-per-pixel, and correlating the traced mask against the CAD wall raster
places it in the same coordinate frame.

Separating walls from everything else sharing their colour took three passes:

  1. threshold  - the wall grey runs to ~170 luminance; a lum<105 cut looks
                  sensible and excludes the walls themselves
  2. rectilinear - walls are long axis-aligned bands, furniture is compact, so
                  keep only pixels surviving a 45 px horizontal OR vertical
                  opening. This is what removes the beds and the sofas.
  3. largest component - drops the site boundary and anything else free-floating
"""
import numpy as np, cv2, json, os, sys
from PIL import Image

PLANS = r"A:\Web\Arcvia\apps\visualisation\public\plans"
WORK = r"A:\Projects\CasaAltinho\_work\cad"
LIN = 45          # px; ~0.64 m at this sheet scale
F2F, SLAB, CLEAR = 3.00, 0.35, 2.65


def wall_mask(path):
    im = np.array(Image.open(path).convert("RGB")).astype(np.int16)
    lum = 0.299 * im[:, :, 0] + 0.587 * im[:, :, 1] + 0.114 * im[:, :, 2]
    sat = im.max(axis=2) - im.min(axis=2)
    m = ((lum < 170) & (sat < 50)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    h = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (LIN, 1)))
    v = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, LIN)))
    w = ((h | v) > 0).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(w, 8)
    if n <= 1:
        return w
    areas = st[1:, cv2.CC_STAT_AREA]
    main = 1 + int(np.argmax(areas))
    out = (lab == main).astype(np.uint8)
    x, y, bw, bh, _ = st[main]
    for i in range(1, n):
        if i == main or st[i, cv2.CC_STAT_AREA] < areas.max() * 0.02:
            continue
        xi, yi, wi, hi, _ = st[i]
        if xi >= x and yi >= y and xi + wi <= x + bw and yi + hi <= y + bh:
            out |= (lab == i).astype(np.uint8)
    return out


def cad_raster(floor, mpp, shape):
    """Rasterise a CAD floor's walls at the same scale, for registration."""
    img = np.zeros(shape, np.uint8)
    xs = [p[0] for w in floor["walls"] for p in (w["a"], w["b"])]
    ys = [p[1] for w in floor["walls"] for p in (w["a"], w["b"])]
    ox, oy = min(xs), min(ys)
    for w in floor["walls"]:
        a = (int((w["a"][0] - ox) / mpp), int((w["a"][1] - oy) / mpp))
        b = (int((w["b"][0] - ox) / mpp), int((w["b"][1] - oy) / mpp))
        cv2.line(img, a, b, 1, max(2, int(w["t"] / mpp)))
    return img, ox, oy


B = json.load(open(os.path.join(WORK, "a1_building.json")))
cad = {f["id"]: f for f in B["floors"]}

# --- calibrate on the stilt floor, which exists in both raster and CAD --------
ref = cad["stilt"]
ry = [p[1] for w in ref["walls"] for p in (w["a"], w["b"])]
cad_h = max(ry) - min(ry)
ms = wall_mask(os.path.join(PLANS, "a1-stilt.webp"))
ys, xs = np.nonzero(ms)
MPP = cad_h / (ys.max() - ys.min())
print(f"calibration: {MPP:.5f} m/px  (stilt {cad_h:.2f} m over {ys.max()-ys.min()} px)")

PAIR = {"lower-ground": ("a1-lower-ground", "stilt"),
        "second": ("a1-second", "first")}

traced = {}
for fid, (img, anchor) in PAIR.items():
    m = wall_mask(os.path.join(PLANS, img + ".webp"))
    ys, xs = np.nonzero(m)
    crop = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    # register against the CAD floor it sits directly above or below: the villa
    # envelope is shared between levels, so the best overlap is unambiguous
    a = cad[anchor]
    ar, aox, aoy = cad_raster(a, MPP, (crop.shape[0] + 240, crop.shape[1] + 240))
    best, bo = -1, (0, 0)
    for dy in range(-60, 61, 4):
        for dx in range(-60, 61, 4):
            pad = np.zeros_like(ar)
            y0, x0 = 120 + dy, 120 + dx
            if y0 < 0 or x0 < 0 or y0 + crop.shape[0] > pad.shape[0] or x0 + crop.shape[1] > pad.shape[1]:
                continue
            pad[y0:y0 + crop.shape[0], x0:x0 + crop.shape[1]] = crop
            sc = int(np.count_nonzero(pad & ar))
            if sc > best:
                best, bo = sc, (dx, dy)
    ox = aox - (120 + bo[0]) * MPP
    oy = aoy - (120 + bo[1]) * MPP
    shift_x, shift_y = ox, oy
    print(f"{fid:14s} traced {crop.shape[1]}x{crop.shape[0]} px "
          f"({crop.shape[1]*MPP:.2f} x {crop.shape[0]*MPP:.2f} m)  "
          f"registered to {anchor}, overlap={best}")

    # Wall bands -> rectangles. Contour tracing is no use here: the network is
    # connected, so RETR_EXTERNAL returns one outline around the whole floor.
    # Instead recover the bands directly - a horizontal opening isolates the
    # horizontal walls, a vertical one the vertical walls, and each connected
    # band's bounding box IS a wall. Overlaps at junctions are harmless.
    polys = []
    for kern in ((LIN, 1), (1, LIN)):
        band = cv2.morphologyEx(crop, cv2.MORPH_OPEN,
                                cv2.getStructuringElement(cv2.MORPH_RECT, kern))
        nb, _, sb, _ = cv2.connectedComponentsWithStats(band, 8)
        for i in range(1, nb):
            bx, by, bw, bh, ba = sb[i]
            if ba * MPP * MPP < 0.08:
                continue
            if min(bw, bh) * MPP > 0.9:      # too fat to be a wall band
                continue
            x0 = bx * MPP + shift_x
            y0 = by * MPP + shift_y
            x1 = (bx + bw) * MPP + shift_x
            y1 = (by + bh) * MPP + shift_y
            polys.append([[round(x0, 3), round(y0, 3)], [round(x1, 3), round(y0, 3)],
                          [round(x1, 3), round(y1, 3)], [round(x0, 3), round(y1, 3)]])

    # slab outline: outer boundary of the traced wall network
    # A traced mask is sparser than CAD linework, so its outer contour dips into
    # every gap and under-reads the plate; the hull is the better estimate here.
    ys2, xs2 = np.nonzero(crop)
    big = cv2.convexHull(np.array([[[int(x), int(y)]] for x, y in zip(xs2, ys2)],
                                  dtype=np.int32))
    fp = [[round(float(p[0][0]) * MPP + shift_x, 3), round(float(p[0][1]) * MPP + shift_y, 3)]
          for p in cv2.approxPolyDP(big, 4.0, True)]
    area = cv2.contourArea(big) * MPP * MPP
    traced[fid] = dict(polys=polys, footprint=fp, area=round(area, 2))
    print(f"{'':14s} {len(polys)} wall polygons, slab {area:.1f} m2")

# --- assemble the four-floor building ---------------------------------------
LABEL = {"lower-ground": "Lower ground", "second": "Second"}
STACK = ["lower-ground", "stilt", "first", "second"]
floors = []
for i, fid in enumerate(STACK):
    if fid in cad:
        f = dict(cad[fid])
        f["index"] = i
        f["level"] = round(i * F2F, 3)
        f["reconstructed"] = None
    else:
        t = traced[fid]
        f = dict(id=fid, label=LABEL[fid], index=i, level=round(i * F2F, 3),
                 walls=[], wallPolys=t["polys"], openings=[], columns=[], labels=[],
                 footprint=t["footprint"], footprintArea=t["area"],
                 reconstructed="traced from the brochure floor plan; no DWG draws this level")
    floors.append(f)

B["floors"] = floors
B["note"] = ("Lower ground and second floors are traced from the brochure plans - "
             "no DWG in the archive draws them.")
json.dump(B, open(os.path.join(WORK, "a1_building.json"), "w"), indent=1)
print("\nfloors:", [(f["id"], f["level"], f["footprintArea"],
                     "TRACED" if f.get("reconstructed") else "cad") for f in floors])
