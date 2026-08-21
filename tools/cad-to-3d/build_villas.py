"""
Build every villa type discovered by discover.py into a building description.

Generalises build_e1.py: same wall pairing, opening clustering, slab tracing and
label pickup, run per type over the regions in villas.json.

Floor stacking order is canonical, NOT the order the plans appear on the sheet -
E-1's sheet ascends and the B2-B4/D sheet descends, so sheet order would stack
half the villas upside down.
"""
import ezdxf, math, json, re, sys, os
import numpy as np, cv2
from ezdxf import recover

DEFAULT_DXF = r"A:\Projects\CasaAltinho\_work\cad\dxf\LATEST DRAWINGS - SITE PLAN & ALL VILLAS  FOR 3D 24-11-23.dxf"
CFG = r"A:\Projects\CasaAltinho\_work\cad\villas.json"
OUTDIR = r"A:\Projects\CasaAltinho\_work\cad"

WALL = {"walls", "A1 WALLS", "NEW WALLS", "Wall"}
OPEN = {"doors & windows", "A4 DOOR WIN", "door", "WINDOW", "WINDOW1"}
COL = {"A1 COLUMN", "column", "columns"}
FURN = {"furn", "A5 FURN", "CONCEPT 1"}
SANI = {"sanitary", "GEYSER"}
STAIR = {"stairs", "Steps"}
# Room labels live on different layers in the two revisions: "tx" in the
# LATEST set, "A3 TEXT (main Txt)" in ALL PLANS. Villa A-1 exists only in the
# latter, so missing this layer silently costs it every viewpoint.
TXT = {"tx", "A3 TEXT", "text", "A3 TEXT (main Txt)", "A3 TEXT 1"}

F2F, SLAB, CLEAR = 3.00, 0.35, 2.65
# lower ground sits below the stilt; upper ground above it
STACK = ["lower-ground", "stilt", "upper-ground", "first", "second"]

NAMES = {"a1": "Villa A-1", "b1": "Villa B-1", "bd": "Villa B-2/3/4 & D-1..D-5",
         "ce": "Villa C1-C4, E2, E3, A2, A3", "e1": "Villa E-1"}

FMT = re.compile(r"\\[A-Za-z][^;\\]*;|[{}]")

# Floors can come from different revisions of the drawing set - neither DWG is a
# superset - so documents are opened on demand and cached.
_DOCS = {}


def modelspace(path):
    if path not in _DOCS:
        print(f"  [open] {os.path.basename(path)}")
        d, _ = recover.readfile(path)
        _DOCS[path] = d.modelspace()
    return _DOCS[path]


def segs_of(e):
    out = []
    t = e.dxftype()
    try:
        if t == "LINE":
            out.append(((e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)))
        elif t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points("xy")]
            if e.closed and len(pts) > 2:
                pts.append(pts[0])
            out += [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
        elif t == "POLYLINE":
            pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
            out += [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    except Exception:
        pass
    return out


def L(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def pair_walls(segs):
    """Match parallel wall faces back into solid walls (centreline + thickness)."""
    S = [(a, b) for a, b in segs if L(a, b) > 0.12]
    info = []
    for a, b in S:
        d = L(a, b)
        ux, uy = (b[0] - a[0]) / d, (b[1] - a[1]) / d
        info.append(dict(a=a, b=b, d=d, u=(ux, uy), th=math.atan2(uy, ux) % math.pi))
    cands = []
    n = len(info)
    for i in range(n):
        for j in range(i + 1, n):
            A, B = info[i], info[j]
            dth = abs(A["th"] - B["th"])
            dth = min(dth, math.pi - dth)
            if dth > math.radians(2.0):
                continue
            ux, uy = A["u"]
            nx, ny = -uy, ux
            off = (B["a"][0] - A["a"][0]) * nx + (B["a"][1] - A["a"][1]) * ny
            if not (0.07 <= abs(off) <= 0.50):
                continue
            pb = sorted([(B["a"][0] - A["a"][0]) * ux + (B["a"][1] - A["a"][1]) * uy,
                         (B["b"][0] - A["a"][0]) * ux + (B["b"][1] - A["a"][1]) * uy])
            lo, hi = max(0.0, pb[0]), min(A["d"], pb[1])
            if hi - lo < 0.25:
                continue
            cands.append((hi - lo, -abs(off), i, j, lo, hi, off))
    cands.sort(reverse=True)
    used, walls = set(), []
    for ov, negt, i, j, lo, hi, off in cands:
        if i in used or j in used:
            continue
        used.add(i)
        used.add(j)
        A = info[i]
        ux, uy = A["u"]
        nx, ny = -uy, ux
        cx, cy = A["a"][0] + nx * off / 2, A["a"][1] + ny * off / 2
        ext = abs(off) / 2      # meet at corners instead of leaving a notch
        walls.append(dict(a=(cx + ux * (lo - ext), cy + uy * (lo - ext)),
                          b=(cx + ux * (hi + ext), cy + uy * (hi + ext)),
                          t=round(abs(off), 3)))
    for i, A in enumerate(info):
        if i in used or A["d"] < 0.8:
            continue
        walls.append(dict(a=A["a"], b=A["b"], t=0.10, unpaired=True))
    return walls


def opening_prisms(opens):
    segs = [(a, b) for a, b in opens if L(a, b) > 0.04]
    n = len(segs)
    par = list(range(n))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            hit = False
            for p in segs[i]:
                for q in segs[j]:
                    if math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                a, b = find(i), find(j)
                if a != b:
                    par[a] = b
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    for idxs in groups.values():
        P = [p for i in idxs for p in segs[i]]
        (cx, cy), (w, h), ang = cv2.minAreaRect(np.array(P, dtype=np.float32))
        length, depth = max(w, h), min(w, h)
        if not (0.55 <= length <= 8.0) or depth > 1.0:
            continue
        axis = ang if w >= h else ang + 90.0
        out.append(dict(c=[round(float(cx), 3), round(float(cy), 3)],
                        length=round(float(length), 3), depth=round(float(depth), 3),
                        angle=round(float(axis) % 180.0, 2)))
    return out


def footprint(raw, ox, oy):
    """Floor slab outline.

    Detached villas (E-1, the C/E types) draw a closed perimeter, so the outer
    contour of the linework is the slab. Row villas (B and D) do not: the plan
    shows the unit between party walls with the sides and garden edge left open,
    so there is no loop to trace and no amount of closing will invent one. When
    the traced contour covers less than 45% of the wall network's box, fall back
    to the convex hull of the linework.
    """
    PIX, PAD = 0.02, 25
    pts = [p for s in raw for p in s]
    mnx, mny = min(p[0] for p in pts), min(p[1] for p in pts)
    mxx, mxy = max(p[0] for p in pts), max(p[1] for p in pts)
    boxarea = (mxx - mnx) * (mxy - mny)
    W = int((mxx - mnx) / PIX) + 2 * PAD
    H = int((mxy - mny) / PIX) + 2 * PAD
    img = np.zeros((H, W), np.uint8)
    for a, b in raw:
        cv2.line(img, (int((a[0] - mnx) / PIX) + PAD, int((a[1] - mny) / PIX) + PAD),
                 (int((b[0] - mnx) / PIX) + PAD, int((b[1] - mny) / PIX) + PAD), 255, 3)
    img = cv2.morphologyEx(img, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    cnts, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    def to_poly(contour):
        ap = cv2.approxPolyDP(contour, 0.05 / PIX, True)
        return [[round(float(p[0][0] - PAD) * PIX + mnx - ox, 3),
                 round(float(p[0][1] - PAD) * PIX + mny - oy, 3)] for p in ap]

    if cnts:
        c = max(cnts, key=cv2.contourArea)
        area = cv2.contourArea(c) * PIX * PIX
        if boxarea > 0 and area / boxarea >= 0.45:
            return to_poly(c), area, "contour"
    allpts = np.array([[[int((p[0] - mnx) / PIX) + PAD, int((p[1] - mny) / PIX) + PAD]]
                       for p in pts], dtype=np.int32)
    hull = cv2.convexHull(allpts)
    return to_poly(hull), cv2.contourArea(hull) * PIX * PIX, "hull"


def pieces(segs, gap=0.12, min_len=0.25, max_len=4.5):
    """Cluster loose linework into individual objects.

    Furniture on a plan is a scatter of small closed outlines - a bed, a sofa, a
    WC. Connected-component clustering recovers one object per cluster, and its
    minimum-area rectangle gives position, footprint and rotation, which is all
    the massing needs.
    """
    S = [(a, b) for a, b in segs if L(a, b) > 0.01]
    n = len(S)
    if not n:
        return []
    par = list(range(n))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i

    # spatial hash so this stays linear-ish on the busier floors
    cell = max(gap, 0.05)
    buckets = {}
    for i, (a, b) in enumerate(S):
        for p in (a, b):
            buckets.setdefault((int(p[0] / cell), int(p[1] / cell)), []).append(i)
    for (cx, cy), idxs in list(buckets.items()):
        near = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                near += buckets.get((cx + dx, cy + dy), [])
        for i in idxs:
            for j in near:
                if i >= j:
                    continue
                if any(math.hypot(p[0] - q[0], p[1] - q[1]) < gap
                       for p in S[i] for q in S[j]):
                    a, b = find(i), find(j)
                    if a != b:
                        par[a] = b
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out = []
    for idxs in groups.values():
        P = [p for i in idxs for p in S[i]]
        if len(P) < 4:
            continue
        (cx, cy), (w, h), ang = cv2.minAreaRect(np.array(P, dtype=np.float32))
        lo, hi = min(w, h), max(w, h)
        if hi < min_len or hi > max_len or lo < 0.08:
            continue
        out.append(dict(c=[round(float(cx), 3), round(float(cy), 3)],
                        w=round(float(w), 3), d=round(float(h), 3),
                        angle=round(float(ang) % 360.0, 1)))
    return out


def classify(op, poly):
    if not poly:
        return "door"
    d = abs(cv2.pointPolygonTest(np.array(poly, dtype=np.float32),
                                 (float(op["c"][0]), float(op["c"][1])), True))
    if d < 0.80:
        return "glazing" if op["length"] >= 1.9 else "window"
    return "door"


def harvest(reg):
    msp = modelspace(reg.get("src", DEFAULT_DXF))
    x0, x1, y0, y1 = reg["x0"], reg["x1"], reg["y0"], reg["y1"]

    def ins(p):
        return x0 <= p[0] <= x1 and y0 <= p[1] <= y1

    W, O, C, R, Lb = [], [], [], [], []
    Fu, Sa, St = [], [], []
    for e in msp:
        lay = e.dxf.layer
        if lay in WALL or lay in OPEN or lay in COL:
            for s in segs_of(e):
                if all(ins(p) for p in s):
                    R.append(s)
                    if lay in WALL:
                        W.append(s)
                    elif lay in OPEN:
                        O.append(s)
            if lay in COL and e.dxftype() == "LWPOLYLINE":
                p = [(q[0], q[1]) for q in e.get_points("xy")]
                if all(ins(q) for q in p):
                    C.append(p)
        elif lay in FURN:
            for s in segs_of(e):
                if all(ins(p) for p in s):
                    Fu.append(s)
        elif lay in SANI:
            for s in segs_of(e):
                if all(ins(p) for p in s):
                    Sa.append(s)
        elif lay in STAIR:
            for s in segs_of(e):
                if all(ins(p) for p in s):
                    St.append(s)
        elif lay in TXT and e.dxftype() in ("TEXT", "MTEXT"):
            try:
                s = e.dxf.text if e.dxftype() == "TEXT" else e.text
                p = e.dxf.insert
                s = re.sub(r"\s+", " ", FMT.sub("", s).replace("\\P", " ")).strip()
                if s and len(s) > 2 and ins((p.x, p.y)):
                    Lb.append(dict(t=s, p=[p.x, p.y]))
            except Exception:
                pass
    return W, O, C, R, Lb, Fu, Sa, St


PIX = 0.02


def raster(segs, ox, oy, w=1300, h=1300, thick=3):
    img = np.zeros((h, w), np.uint8)
    for a, b in segs:
        cv2.line(img, (int((a[0] - ox) / PIX) + 120, int((a[1] - oy) / PIX) + 120),
                 (int((b[0] - ox) / PIX) + 120, int((b[1] - oy) / PIX) + 120), 255, thick)
    return img


cfg = json.load(open(CFG))
targets = sys.argv[1:] or list(cfg.keys())
summary = {}

for tid in targets:
    regions = cfg.get(tid) or []
    regions = [r for r in regions if r["fid"] in STACK]
    if not regions:
        print(f"{tid}: nothing to build")
        continue
    regions.sort(key=lambda r: STACK.index(r["fid"]))

    raw = {r["fid"]: harvest(r) for r in regions}
    # register the floors onto a common origin: each plan is drawn at its own
    # spot on the sheet, and the footprints differ, so there is no shared corner
    # to trust. Correlating the wall masks is what actually locks them together.
    ref = max(regions, key=lambda r: len(raw[r["fid"]][0]))["fid"]
    rx = min(p[0] for s in raw[ref][0] for p in s)
    ry = min(p[1] for s in raw[ref][0] for p in s)
    ref_img = raster(raw[ref][0], rx, ry)
    origins = {}
    for r in regions:
        fid = r["fid"]
        fx = min(p[0] for s in raw[fid][0] for p in s)
        fy = min(p[1] for s in raw[fid][0] for p in s)
        if fid == ref:
            origins[fid] = (rx, ry)
            continue
        best, bo, second = -1, (fx, fy), -1
        for dx in np.arange(-3.0, 3.01, 0.10):
            for dy in np.arange(-3.0, 3.01, 0.10):
                sc = int(np.count_nonzero(cv2.bitwise_and(
                    raster(raw[fid][0], fx + dx, fy + dy), ref_img)))
                if sc > best:
                    second, best, bo = best, sc, (fx + dx, fy + dy)
                elif sc > second:
                    second = sc
        origins[fid] = bo
        margin = best / max(second, 1)
        print(f"  {tid}/{fid:13s} aligned dx={bo[0]-fx:+.2f} dy={bo[1]-fy:+.2f} "
              f"overlap={best} (x{margin:.2f} over runner-up)")

    floors = []
    for idx, r in enumerate(regions):
        fid = r["fid"]
        W, O, C, R, Lb, Fu, Sa, St = raw[fid]
        ox, oy = origins[fid]
        walls = pair_walls(W)
        poly, area, how = footprint(R, ox, oy)
        prisms = opening_prisms(O)
        kinds = {}
        for op in prisms:
            k = classify(dict(op, c=[op["c"][0] - ox, op["c"][1] - oy]), poly)
            op["kind"] = k
            kinds[k] = kinds.get(k, 0) + 1
        floors.append(dict(
            id=fid, label=r["label"], index=idx, level=round(idx * F2F, 3),
            walls=[dict(a=[round(w["a"][0] - ox, 3), round(w["a"][1] - oy, 3)],
                        b=[round(w["b"][0] - ox, 3), round(w["b"][1] - oy, 3)],
                        t=w["t"], unpaired=bool(w.get("unpaired"))) for w in walls],
            openings=[dict(kind=op["kind"],
                           c=[round(op["c"][0] - ox, 3), round(op["c"][1] - oy, 3)],
                           length=op["length"], depth=op["depth"], angle=op["angle"])
                      for op in prisms],
            columns=[[[round(q[0] - ox, 3), round(q[1] - oy, 3)] for q in c] for c in C],
            labels=[dict(t=l["t"], p=[round(l["p"][0] - ox, 3), round(l["p"][1] - oy, 3)])
                    for l in Lb],
            furniture=[dict(kind="furn", c=[round(q["c"][0] - ox, 3), round(q["c"][1] - oy, 3)],
                            w=q["w"], d=q["d"], angle=q["angle"]) for q in pieces(Fu, gap=0.28)],
            sanitary=[dict(kind="sani", c=[round(q["c"][0] - ox, 3), round(q["c"][1] - oy, 3)],
                           w=q["w"], d=q["d"], angle=q["angle"])
                      for q in pieces(Sa, gap=0.22, max_len=2.2)],
            stairs=[dict(c=[round(q["c"][0] - ox, 3), round(q["c"][1] - oy, 3)],
                         w=q["w"], d=q["d"], angle=q["angle"])
                    for q in pieces(St, gap=0.45, min_len=1.2, max_len=13.0)],
            footprint=poly, footprintArea=round(area, 2)))
        print(f"  {tid}/{fid:13s} lvl {idx*F2F:5.2f}m  walls={len(walls):3d} "
              f"furn={len(floors[-1]['furniture']):3d} sani={len(floors[-1]['sanitary']):2d} "
              f"stair={len(floors[-1]['stairs']):2d} "
              f"openings={len(prisms):3d} {kinds}  cols={len(C):2d} labels={len(Lb):2d} "
              f"slab={area:6.1f} m2 ({how})")

    b = dict(name=NAMES.get(tid, tid), typeId=tid, project="Casa Altinho", units="m",
             floorToFloor=F2F, slab=SLAB, clear=CLEAR, floors=floors)
    out = f"{OUTDIR}\\{tid}_building.json"
    json.dump(b, open(out, "w"), indent=1)
    summary[tid] = dict(floors=len(floors),
                        walls=sum(len(f["walls"]) for f in floors),
                        openings=sum(len(f["openings"]) for f in floors))
    print(f"  -> {out}\n")

print("summary:", json.dumps(summary, indent=1))
