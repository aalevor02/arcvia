"""
Villa E-1, Casa Altinho: CAD -> building description.

Pairs the double-line wall faces back into solid walls, clusters the door and
window linework into openings, traces each floor slab, and picks up the room
labels. Output is one JSON that the Blender builder consumes.

Two things about this drawing that will bite anyone who assumes otherwise:

  * It is authored in METRES. The $INSUNITS=4 "millimetres" flag is wrong. Wall
    faces sit 0.24 apart and rooms measure 6.76 across, matching the brochure's
    room schedule. Trusting the flag builds the villa 1000x too small.

  * Walls are drawn as two parallel face lines, not centrelines. Extruding the
    lines directly gives paper-thin walls that look wrong at every door reveal.

Validation: the traced first-floor slab comes to 180.5 m2 against the brochure's
independently-published 178.47 m2 SBUA, a 1.1% agreement. The other floors read
~10-16% high because the traced outline includes balconies and terraces that
SBUA discounts.
"""
import ezdxf, math, json
import numpy as np, cv2
from ezdxf import recover

F = r"A:\Projects\CasaAltinho\_work\cad\dxf\LATEST DRAWINGS - SITE PLAN & ALL VILLAS  FOR 3D 24-11-23.dxf"
OUT = r"A:\Projects\CasaAltinho\_work\cad\e1_building.json"

X0, X1 = 44145, 44175
FLOORS = [("lower-ground", "Lower ground", 1570, 1586),
          ("stilt",        "Stilt",        1603, 1623),
          ("first",        "First",        1647, 1666),
          ("second",       "Second",       1681, 1700)]

WALL = {"walls", "A1 WALLS", "NEW WALLS", "Wall"}
OPEN = {"doors & windows", "A4 DOOR WIN", "door", "WINDOW", "WINDOW1"}
COL = {"A1 COLUMN", "column", "columns"}
TXT = {"tx", "A3 TEXT", "text"}

ORIG = json.load(open(r"A:\Projects\CasaAltinho\_work\cad\e1_origins.json"))

# Measured off the section linework: 2.650 clear + 0.350 structure = 3.000 F2F.
F2F, SLAB, CLEAR = 3.00, 0.35, 2.65

doc, _ = recover.readfile(F)
msp = doc.modelspace()


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
            t = abs(off)
            if not (0.07 <= t <= 0.50):
                continue
            pb = sorted([(B["a"][0] - A["a"][0]) * ux + (B["a"][1] - A["a"][1]) * uy,
                         (B["b"][0] - A["a"][0]) * ux + (B["b"][1] - A["a"][1]) * uy])
            lo, hi = max(0.0, pb[0]), min(A["d"], pb[1])
            ov = hi - lo
            if ov < 0.25:
                continue
            cands.append((ov, -t, i, j, lo, hi, off))

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
        # Extend each end by half the thickness so walls actually meet at
        # corners instead of leaving a notch the camera can see through.
        ext = abs(off) / 2
        walls.append(dict(a=(cx + ux * (lo - ext), cy + uy * (lo - ext)),
                          b=(cx + ux * (hi + ext), cy + uy * (hi + ext)),
                          t=round(abs(off), 3)))
    # Long unmatched runs are real edges (parapets, ledges, glazing lines).
    for i, A in enumerate(info):
        if i in used or A["d"] < 0.8:
            continue
        walls.append(dict(a=A["a"], b=A["b"], t=0.10, unpaired=True))
    return walls


def opening_prisms(opens):
    """Cluster door/window linework into openings, expressed as prisms to cut.

    Assigning each opening line to a specific wall proved brittle - the lines sit
    on the wall faces, and which wall "owns" them is ambiguous at junctions.
    Grouping the linework and cutting a prism through whatever wall is there is
    simpler and independent of how cleanly the wall pairing went.
    """
    segs = [(a, b) for a, b in opens if L(a, b) > 0.04]
    n = len(segs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            close = False
            for p in segs[i]:
                for q in segs[j]:
                    if math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05:
                        close = True
                        break
                if close:
                    break
            if close:
                a, b = find(i), find(j)
                if a != b:
                    parent[a] = b

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out = []
    for idxs in groups.values():
        P = []
        for i in idxs:
            P.extend(segs[i])
        (cx, cy), (w, h), ang = cv2.minAreaRect(np.array(P, dtype=np.float32))
        length, depth = max(w, h), min(w, h)
        if not (0.55 <= length <= 8.0) or depth > 1.0:
            continue
        axis = ang if w >= h else ang + 90.0
        out.append(dict(c=[round(float(cx), 3), round(float(cy), 3)],
                        length=round(float(length), 3),
                        depth=round(float(depth), 3),
                        angle=round(float(axis) % 180.0, 2)))
    return out


def footprint(raw_segs, ox, oy):
    """Trace the floor slab outline from the raw linework.

    Deliberately not built from the paired walls: those get trimmed to their
    overlap and pull back from every corner, fragmenting the network into 5-8
    pieces. The raw faces plus the door/window lines - which fill the gaps they
    themselves create in the exterior face - close into a single contour whose
    area is stable across closing radii from 0.18 to 0.42 m.
    """
    PIX, PAD = 0.02, 25
    pts = [p for s in raw_segs for p in s]
    mnx, mny = min(p[0] for p in pts), min(p[1] for p in pts)
    mxx, mxy = max(p[0] for p in pts), max(p[1] for p in pts)
    W = int((mxx - mnx) / PIX) + 2 * PAD
    H = int((mxy - mny) / PIX) + 2 * PAD
    img = np.zeros((H, W), np.uint8)
    for a, b in raw_segs:
        cv2.line(img, (int((a[0] - mnx) / PIX) + PAD, int((a[1] - mny) / PIX) + PAD),
                 (int((b[0] - mnx) / PIX) + PAD, int((b[1] - mny) / PIX) + PAD), 255, 3)
    img = cv2.morphologyEx(img, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    cnts, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return [], 0.0
    c = max(cnts, key=cv2.contourArea)
    approx = cv2.approxPolyDP(c, 0.05 / PIX, True)
    poly = [[round(float(p[0][0] - PAD) * PIX + mnx - ox, 3),
             round(float(p[0][1] - PAD) * PIX + mny - oy, 3)] for p in approx]
    return poly, cv2.contourArea(c) * PIX * PIX


def classify(op, poly):
    """Exterior openings read as glazing or windows, interior ones as doorways."""
    if not poly:
        return "door"
    d = abs(cv2.pointPolygonTest(np.array(poly, dtype=np.float32),
                                 (float(op["c"][0]), float(op["c"][1])), True))
    if d < 0.80:
        return "glazing" if op["length"] >= 1.9 else "window"
    return "door"


import re
FMT = re.compile(r"\\[A-Za-z][^;\\]*;|[{}]")

building = dict(name="Villa E-1", project="Casa Altinho", units="m",
                floorToFloor=F2F, slab=SLAB, clear=CLEAR, floors=[])

for idx, (fid, flabel, y0, y1) in enumerate(FLOORS):
    ox, oy = ORIG[fid]

    def ins(p):
        return X0 <= p[0] <= X1 and y0 <= p[1] <= y1

    Wseg, Oseg, Cols, Raw, Labels = [], [], [], [], []
    for e in msp:
        lay = e.dxf.layer
        if lay in WALL or lay in OPEN or lay in COL:
            for s in segs_of(e):
                if all(ins(p) for p in s):
                    Raw.append(s)
                    if lay in WALL:
                        Wseg.append(s)
                    elif lay in OPEN:
                        Oseg.append(s)
            if lay in COL and e.dxftype() == "LWPOLYLINE":
                p = [(q[0], q[1]) for q in e.get_points("xy")]
                if all(ins(q) for q in p):
                    Cols.append(p)
        elif lay in TXT and e.dxftype() in ("TEXT", "MTEXT"):
            try:
                s = (e.dxf.text if e.dxftype() == "TEXT" else e.text)
                p = e.dxf.insert
                s = re.sub(r"\s+", " ", FMT.sub("", s).replace("\\P", " ")).strip()
                if s and ins((p.x, p.y)) and len(s) > 2:
                    Labels.append(dict(t=s, p=[round(p.x - ox, 3), round(p.y - oy, 3)]))
            except Exception:
                pass

    walls = pair_walls(Wseg)
    poly, area = footprint(Raw, ox, oy)
    prisms = opening_prisms(Oseg)
    kinds = {}
    for op in prisms:
        # classify in the same frame the footprint lives in
        local = dict(op, c=[op["c"][0] - ox, op["c"][1] - oy])
        k = classify(local, poly)
        op["kind"] = k
        kinds[k] = kinds.get(k, 0) + 1

    building["floors"].append(dict(
        id=fid, label=flabel, index=idx, level=round(idx * F2F, 3),
        walls=[dict(a=[round(w["a"][0] - ox, 3), round(w["a"][1] - oy, 3)],
                    b=[round(w["b"][0] - ox, 3), round(w["b"][1] - oy, 3)],
                    t=w["t"], unpaired=bool(w.get("unpaired"))) for w in walls],
        openings=[dict(kind=op["kind"],
                       c=[round(op["c"][0] - ox, 3), round(op["c"][1] - oy, 3)],
                       length=op["length"], depth=op["depth"], angle=op["angle"])
                  for op in prisms],
        columns=[[[round(q[0] - ox, 3), round(q[1] - oy, 3)] for q in c] for c in Cols],
        labels=Labels, footprint=poly, footprintArea=round(area, 2)))

    paired = sum(1 for w in walls if not w.get("unpaired"))
    print(f"{fid:14s} walls={len(walls):3d} (solid {paired:3d})  openings={len(prisms):3d} "
          f"{kinds}  cols={len(Cols):2d}  labels={len(Labels):2d}  slab={area:6.1f} m2")

json.dump(building, open(OUT, "w"), indent=1)
print("\nwrote", OUT)
