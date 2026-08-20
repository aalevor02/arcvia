"""
Merge the per-drawing discovery scans into one build config, choosing the best
source for each individual floor.

Only two of the seven DWGs contain villa plans, and neither is a superset:

  ALL PLANS (16-4-24)   newer; the only drawing with Villa A-1 at all, and much
                        more complete on E-1 (second floor 170 wall segments
                        against 85) and on B/D
  LATEST DRAWINGS ...   older; but the only one whose C/E stack carries all four
                        floors

So the choice is per floor, not per drawing: take whichever revision actually
drew that floor. Each region records the DXF it came from and the builder opens
the right document for it.
"""
import json, glob, os, collections

WORK = r"A:\Projects\CasaAltinho\_work\cad"
DXFDIR = os.path.join(WORK, "dxf")
OUT = os.path.join(WORK, "villas.json")

scans = {}
for p in glob.glob(os.path.join(WORK, "scan_*.json")):
    name = os.path.basename(p)[len("scan_"):-len(".json")].replace("_", " ")
    # recover the real dxf filename
    cand = [f for f in os.listdir(DXFDIR)
            if f.lower().endswith(".dxf")
            and os.path.splitext(f)[0].replace(" ", "").lower() == name.replace(" ", "").lower()]
    if not cand:
        continue
    try:
        d = json.load(open(p))
    except Exception:
        continue
    if d:
        scans[os.path.join(DXFDIR, cand[0])] = d

print(f"{len(scans)} drawings with villa plans")

best = collections.defaultdict(dict)
for src, d in scans.items():
    for tid, rows in d.items():
        for r in rows:
            cur = best[tid].get(r["fid"])
            if cur is None or r["walls"] > cur["walls"]:
                best[tid][r["fid"]] = dict(r, src=src)

final = {}
for tid in sorted(best):
    rows = sorted(best[tid].values(), key=lambda r: r["fid"])
    final[tid] = rows
    print(f"\n=== {tid} === {len(rows)} floors")
    for r in rows:
        others = [d[tid] for s, d in scans.items() if s != r["src"] and tid in d]
        alt = None
        for o in others:
            for q in o:
                if q["fid"] == r["fid"]:
                    alt = q["walls"]
        mark = f"  (other revision: {alt}w)" if alt is not None else "  (only source)"
        print(f"  {r['fid']:14s} walls={r['walls']:4d} openings={r['openings']:3d} "
              f"{r['w']:5.1f}x{r['h']:5.1f}m  <- {os.path.basename(r['src'])[:28]}{mark}")

json.dump(final, open(OUT, "w"), indent=1)
print("\nwrote", OUT)
