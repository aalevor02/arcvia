"""
Trace a rendered brochure floor plan into wall geometry.

Villa A-1's lower ground and second floors are drawn in no DWG in the archive,
but both appear as rendered plans in the brochure. Those are the architect's own
drawings, just raster instead of vector - so they are traced, not invented.

A marketing plan is in some ways easier than the CAD: walls are drawn as SOLID
dark bands, so the mask *is* the wall solid and there is no double-line pairing
to undo. The work is separating walls from everything else sharing that colour -
body text, furniture blobs, stair hatching, the north arrow, the site boundary.

Scale and position come from the floors that DO exist in CAD. All four A-1 plans
are drawn at one scale on one sheet, so tracing the CAD-built stilt plan and
comparing it to its own image gives metres-per-pixel, and correlating the traced
mask against the CAD wall mask gives the registration.
"""
import numpy as np, cv2, json, math, os
from PIL import Image

PLANS = r"A:\Web\Arcvia\apps\visualisation\public\plans"
WORK = r"A:\Projects\CasaAltinho\_work\cad"


def wall_mask(path, open_px=3, keep_ratio=0.06):
    """Binary mask of the wall bands only."""
    im = np.array(Image.open(path).convert("RGB")).astype(np.int16)
    lum = 0.299 * im[:, :, 0] + 0.587 * im[:, :, 1] + 0.114 * im[:, :, 2]
    sat = im.max(axis=2) - im.min(axis=2)
    # The wall grey runs to ~170 luminance in these renders. A lum<105 cut looks
    # reasonable and silently excludes the walls themselves; lum<130 catches them
    # only in patches, so the network fragments and "largest component" returns a
    # stray line. Above ~180 the site boundary joins the villa and the box jumps
    # from 593 to 787 px wide. 170 is the plateau where both plans agree.
    m = ((lum < 170) & (sat < 50)).astype(np.uint8)

    # A light opening clears body text without breaking the network. Anything
    # larger fragments the wall bands at their thin junctions, after which the
    # "largest component" is a stray boundary line rather than the villa.
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((open_px, open_px), np.uint8))

    # The walls are one connected network. Furniture blobs, the north arrow, the
    # title banner and the site boundary are separate components, so keeping the
    # largest component discards them all without naming any of them.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return m * 255
    areas = stats[1:, cv2.CC_STAT_AREA]
    main = 1 + int(np.argmax(areas))
    out = (lab == main).astype(np.uint8)

    # Absorb any other component that is a decent size AND sits inside the
    # network's box - detached wall stubs and the lift shaft read that way.
    x, y, w, h, _ = stats[main]
    big = areas.max()
    for i in range(1, n):
        if i == main:
            continue
        if stats[i, cv2.CC_STAT_AREA] < big * keep_ratio:
            continue
        xi, yi, wi, hi, _ = stats[i]
        if xi >= x - 8 and yi >= y - 8 and xi + wi <= x + w + 8 and yi + hi <= y + h + 8:
            out |= (lab == i).astype(np.uint8)
    return out * 255


def polys_from_mask(mask, mpp, ox, oy, min_area_m2=0.05):
    """Wall-band outlines as polygons in metres."""
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        if cv2.contourArea(c) * mpp * mpp < min_area_m2:
            continue
        ap = cv2.approxPolyDP(c, 2.0, True)
        if len(ap) < 3:
            continue
        out.append([[round(float(p[0][0]) * mpp - ox, 3),
                     round(float(p[0][1]) * mpp - oy, 3)] for p in ap])
    return out


def mask_to_metres(mask, mpp):
    ys, xs = np.nonzero(mask)
    return xs.min() * mpp, xs.max() * mpp, ys.min() * mpp, ys.max() * mpp


if __name__ == "__main__":
    # 1. calibrate on the floor that exists in both raster and CAD
    b = json.load(open(os.path.join(WORK, "a1_building.json")))
    cad = {f["id"]: f for f in b["floors"]}
    ref = cad["stilt"]
    rx = [p[0] for w in ref["walls"] for p in (w["a"], w["b"])]
    ry = [p[1] for w in ref["walls"] for p in (w["a"], w["b"])]
    cad_w, cad_h = max(rx) - min(rx), max(ry) - min(ry)

    ms = wall_mask(os.path.join(PLANS, "a1-stilt.webp"))
    ys, xs = np.nonzero(ms)
    px_w, px_h = xs.max() - xs.min(), ys.max() - ys.min()
    # Pixels are square, so calibrate on ONE axis. The long axis is used: the
    # raster includes the external stair and terrace the CAD floor does not, and
    # that discrepancy costs proportionally less over 1045 px than over 587.
    mpp = cad_h / px_h
    print(f"stilt  CAD {cad_w:.2f} x {cad_h:.2f} m   raster {px_w} x {px_h} px")
    print(f"       metres/pixel {mpp:.5f}  -> raster width reads {px_w*mpp:.2f} m")
    mpp_x = mpp_y = mpp
    cv2.imwrite(os.path.join(WORK, "trace_stilt.png"), ms)

    for name in ("a1-lower-ground", "a1-second"):
        m = wall_mask(os.path.join(PLANS, name + ".webp"))
        cv2.imwrite(os.path.join(WORK, f"trace_{name}.png"), m)
        ys, xs = np.nonzero(m)
        print(f"{name:18s} mask bbox {xs.max()-xs.min()} x {ys.max()-ys.min()} px  "
              f"-> {(xs.max()-xs.min())*mpp_x:.2f} x {(ys.max()-ys.min())*mpp_y:.2f} m")
