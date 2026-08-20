"""
Find every villa type's floor plans in the CAD and emit a build config.

Each plan on these sheets is stacked: the villa label at the bottom
(`{\\C2;VILLA - E1}`), its floor-plan title ~5 units above it, and the drawing
above that. So a plan's band runs from just above its title to just below the
next title up.

Two things that make the obvious shortcuts wrong:

  * Do NOT identify a plan by the nearest big sheet title. Those sit outside
    their own frames - "VILLA E2 TO E3" hangs directly above the E-1 frame.

  * Do NOT infer floor order from vertical position. E-1's sheet ascends
    (lower ground at the bottom); the B2-B4/D sheet descends (roof at the top of
    the stack means STILT is the *highest* y). Ordering by y stacks half the
    villas upside down. The floor-plan titles are the only trustworthy signal.

Writes villas.json.
"""
import ezdxf, re, json, collections
from ezdxf import recover

import sys, os

DXFDIR = r"A:\Projects\CasaAltinho\_work\cad\dxf"
F = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    DXFDIR, "LATEST DRAWINGS - SITE PLAN & ALL VILLAS  FOR 3D 24-11-23.dxf")
OUT = sys.argv[2] if len(sys.argv) > 2 else r"A:\Projects\CasaAltinho\_work\cad\villas.json"
print("source:", os.path.basename(F))

WALL = {"walls", "A1 WALLS", "NEW WALLS", "Wall"}
OPENL = {"doors & windows", "A4 DOOR WIN", "door", "WINDOW", "WINDOW1"}
FMT = re.compile(r"\\[A-Za-z][^;\\]*;|[{}]")

TYPE_OF = [
    (re.compile(r"VILLA\s*-?\s*E[-\s]?1\b", re.I), "e1"),
    (re.compile(r"VILLA\s*TYPE\s*-\s*B1\b", re.I), "b1"),
    (re.compile(r"VILLA\s*-?\s*A[-\s]?1\b", re.I), "a1"),
    (re.compile(r"B\s*2\s*TO\s*B?\s*4|D\s*1\s*TO\s*D?\s*5", re.I), "bd"),
    (re.compile(r"C\s*1\s*TO\s*C\s*4|A\s*2\s*&?\s*A?3|E\s*2\s*TO\s*E?\s*3", re.I), "ce"),
]

# order matters: LOWER GROUND must be tested before GROUND
FLOOR_PAT = [
    (re.compile(r"ROOF", re.I), "roof", "Roof"),
    (re.compile(r"LOWER\s*GROUND", re.I), "lower-ground", "Lower ground"),
    (re.compile(r"UPPER\s*GROUND|GROUND\s*FLOOR", re.I), "upper-ground", "Upper ground"),
    (re.compile(r"STILT", re.I), "stilt", "Stilt"),
    (re.compile(r"FIRST\s*FLOOR", re.I), "first", "First"),
    (re.compile(r"SECOND\s*FLOOR", re.I), "second", "Second"),
]

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
    except Exception:
        pass
    return out


walls, opens = [], []
texts = []
for e in msp:
    lay = e.dxf.layer
    if lay in WALL:
        walls.extend(segs_of(e))
    elif lay in OPENL:
        opens.extend(segs_of(e))
    t = e.dxftype()
    if t in ("TEXT", "MTEXT"):
        try:
            raw = e.dxf.text if t == "TEXT" else e.text
            p = e.dxf.insert
            h = e.dxf.height if t == "TEXT" else e.dxf.char_height
            s = re.sub(r"\s+", " ", FMT.sub("", raw).replace("\\P", " ")).strip()
            if s:
                texts.append(dict(s=s, raw=raw, x=p.x, y=p.y, h=h))
        except Exception:
            pass

# floor-plan titles: small text naming a floor and the word PLAN/FLOOR
titles = []
for t in texts:
    if t["h"] > 3:
        continue
    if not re.search(r"PLAN|FLOOR", t["s"], re.I):
        continue
    for pat, fid, flabel in FLOOR_PAT:
        if pat.search(t["s"]):
            titles.append(dict(fid=fid, label=flabel, x=t["x"], y=t["y"], s=t["s"]))
            break

vlabels = [t for t in texts
           if "\\C2" in t["raw"] and re.search(r"VILLA", t["s"], re.I) and t["h"] < 3]

print(f"{len(titles)} floor-plan titles, {len(vlabels)} per-plan villa labels")

# group titles into sheet columns
titles.sort(key=lambda t: t["x"])
cols, cur = [], []
for t in titles:
    if cur and t["x"] - cur[-1]["x"] > 25:
        cols.append(cur)
        cur = []
    cur.append(t)
if cur:
    cols.append(cur)
print(f"{len(cols)} sheet columns\n")

REJECT = []


def plan_cluster(segs, cell=2.5):
    """The plan's wall work inside a band.

    A floor plan is not one connected blob: detached balconies, parapets and the
    pool surround sit apart from the main body, and an open level like E-1's
    second floor fragments badly. So take the largest cluster, then absorb any
    other cluster whose box overlaps it once expanded - which pulls in the
    outriggers without pulling in the neighbouring stack.
    """
    import math as _m
    cells = collections.defaultdict(list)
    for i, (a, b) in enumerate(segs):
        for p in (a, b):
            cells[(int(_m.floor(p[0] / cell)), int(_m.floor(p[1] / cell)))].append(i)
    par = {c: c for c in cells}

    def f(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a

    for c in list(cells):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (c[0] + dx, c[1] + dy)
                if n in cells:
                    ra, rb = f(c), f(n)
                    if ra != rb:
                        par[ra] = rb
    g = collections.defaultdict(set)
    for c in cells:
        g[f(c)].update(cells[c])
    if not g:
        return []

    def box(idxs):
        xs = [p[0] for i in idxs for p in segs[i]]
        ys = [p[1] for i in idxs for p in segs[i]]
        return min(xs), max(xs), min(ys), max(ys)

    groups = sorted(g.values(), key=len, reverse=True)
    keep = set(groups[0])
    bx0, bx1, by0, by1 = box(groups[0])
    PAD = 4.0
    for grp in groups[1:]:
        if len(grp) < 4:
            continue
        x0, x1, y0, y1 = box(grp)
        if x1 >= bx0 - PAD and x0 <= bx1 + PAD and y1 >= by0 - PAD and y0 <= by1 + PAD:
            keep |= grp
            bx0, bx1 = min(bx0, x0), max(bx1, x1)
            by0, by1 = min(by0, y0), max(by1, y1)
    return [segs[i] for i in keep]


out = collections.defaultdict(list)
for col in cols:
    col.sort(key=lambda t: t["y"])
    cx = sum(t["x"] for t in col) / len(col)
    # dedupe titles at nearly the same height (sheets repeat "STILT PLAN")
    ded = []
    for t in col:
        if ded and abs(t["y"] - ded[-1]["y"]) < 8 and t["fid"] == ded[-1]["fid"]:
            continue
        ded.append(t)

    for i, t in enumerate(ded):
        y0 = t["y"] + 3.0
        y1 = (ded[i + 1]["y"] - 6.0) if i + 1 < len(ded) else t["y"] + 34.0
        if y1 - y0 < 6:
            continue
        x0, x1 = cx - 26, cx + 26
        band = [s for s in walls if all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in s)]
        if len(band) < 12:
            REJECT.append((t["fid"], round(cx), round(t["y"]), f"only {len(band)} wall segs"))
            continue
        # The band is a horizontal slice of the sheet and catches dimension
        # lines, elevations and the neighbouring stack. The plan itself is the
        # largest connected cluster of wall work inside it.
        W = plan_cluster(band)
        if len(W) < 12:
            REJECT.append((t["fid"], round(cx), round(t["y"]), f"cluster only {len(W)}"))
            continue
        xs = [p[0] for s in W for p in s]
        ys = [p[1] for s in W for p in s]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if not (4 <= w <= 26 and 4 <= h <= 26):
            REJECT.append((t["fid"], round(cx), round(t["y"]), f"size {w:.1f}x{h:.1f}"))
            continue
        # type from the nearest villa label below the title
        tid = None
        best = None
        bd = 1e9
        for v in vlabels:
            if not (x0 <= v["x"] <= x1):
                continue
            d = t["y"] - v["y"]
            if -1.0 < d < 12.0 and d < bd:
                bd, best = d, v
        if best:
            for pat, ty in TYPE_OF:
                if pat.search(best["s"]):
                    tid = ty
                    break
        if tid is None:
            # Some stacks (A2&A3) carry no per-plan label at all. Fall back to
            # the nearest big sheet title above the column - which is safe here
            # only because we already have the band, so a wrong title cannot
            # move the geometry, just mislabel it.
            bt, btd = None, 1e9
            for v in texts:
                if v["h"] < 20 or not re.search(r"VILLA", v["s"], re.I):
                    continue
                if not (cx - 150 <= v["x"] <= cx + 60):
                    continue
                d = v["y"] - t["y"]
                if 0 < d < 330 and d < btd:
                    btd, bt = d, v
            if bt:
                for pat, ty in TYPE_OF:
                    if pat.search(bt["s"]):
                        tid = ty
                        break
        if tid is None:
            REJECT.append((t["fid"], round(cx), round(t["y"]), "no villa label"))
            continue
        O = [s for s in opens if all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in s)]
        # x from the wall cluster (sheet columns sit far apart, so this is safe);
        # y from the BAND, not the cluster. On open levels the terrace and pool
        # surround extend well past the enclosed rooms, and taking y from the
        # wall cluster cuts them off - ce/first loses a third of its slab that
        # way. The band is already exactly one plan's vertical slice, so it
        # cannot bleed into the neighbouring floor the way a fixed margin does
        # on the tightly-stacked B/D sheets.
        out[tid].append(dict(fid=t["fid"], label=t["label"], sheetX=round(cx, 1),
                             x0=round(min(xs) - 1.5, 1), x1=round(max(xs) + 1.5, 1),
                             y0=round(y0, 1), y1=round(y1, 1),
                             walls=len(W), openings=len(O),
                             w=round(w, 1), h=round(h, 1)))

# each type may be drawn on more than one sheet; keep the most complete copy
final = {}
for tid, rows in out.items():
    bysheet = collections.defaultdict(list)
    for r in rows:
        bysheet[r["sheetX"]].append(r)
    best = max(bysheet.values(),
               key=lambda rs: (len({r["fid"] for r in rs if r["fid"] != "roof"}),
                               sum(r["walls"] for r in rs)))
    best = [r for r in best if r["fid"] != "roof"]
    seen, keep = set(), []
    for r in sorted(best, key=lambda r: -r["walls"]):
        if r["fid"] in seen:
            continue
        seen.add(r["fid"])
        keep.append(r)
    final[tid] = sorted(keep, key=lambda r: r["fid"])
    print(f"=== {tid} ===  sheet x{keep[0]['sheetX']}  ({len(bysheet)} sheet(s) drawn)")
    for r in final[tid]:
        print(f"  {r['fid']:14s} {r['label']:14s} x {r['x0']:9.1f}..{r['x1']:9.1f} "
              f"y {r['y0']:8.1f}..{r['y1']:8.1f}  {r['w']:5.1f}x{r['h']:5.1f}m  "
              f"walls={r['walls']:4d} openings={r['openings']:3d}")

if REJECT:
    print(f"\n{len(REJECT)} bands rejected:")
    for fid, cx, y, why in REJECT:
        print(f"  {fid:14s} sheet x{cx} y{y}  -> {why}")

json.dump(final, open(OUT, "w"), indent=1)
print("\nwrote", OUT)
