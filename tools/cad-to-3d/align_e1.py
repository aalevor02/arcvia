import ezdxf, json, numpy as np, cv2
from ezdxf import recover
F=r"A:\Projects\CasaAltinho\_work\cad\dxf\LATEST DRAWINGS - SITE PLAN & ALL VILLAS  FOR 3D 24-11-23.dxf"
X0,X1=44145,44175
FLOORS=[("lower-ground",1570,1586),("stilt",1603,1623),("first",1647,1666),("second",1681,1700)]
WALL={"walls","A1 WALLS","NEW WALLS","Wall"}
doc,_=recover.readfile(F); msp=doc.modelspace()
def segs_of(e):
    out=[];t=e.dxftype()
    try:
        if t=="LINE": out.append(((e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)))
        elif t=="LWPOLYLINE":
            pts=[(p[0],p[1]) for p in e.get_points("xy")]
            if e.closed and len(pts)>2: pts.append(pts[0])
            out+=[(pts[i],pts[i+1]) for i in range(len(pts)-1)]
    except Exception: pass
    return out
raw={}
for name,y0,y1 in FLOORS:
    w=[]
    for e in msp:
        if e.dxf.layer not in WALL: continue
        for s in segs_of(e):
            if all(X0<=p[0]<=X1 and y0<=p[1]<=y1 for p in s): w.append(s)
    raw[name]=w

PIX=0.02; W,H=1400,1200
def raster(segs,ox,oy,thick=3):
    img=np.zeros((H,W),np.uint8)
    for a,b in segs:
        p=(int((a[0]-ox)/PIX)+150,int((a[1]-oy)/PIX)+150)
        q=(int((b[0]-ox)/PIX)+150,int((b[1]-oy)/PIX)+150)
        cv2.line(img,p,q,255,thick)
    return img
ref="first"
rx0=min(p[0] for s in raw[ref] for p in s); ry0=min(p[1] for s in raw[ref] for p in s)
ref_img=raster(raw[ref],rx0,ry0)
print(f"reference '{ref}' pixels={np.count_nonzero(ref_img)}")
origins={ref:(rx0,ry0)}
for name,_,_ in FLOORS:
    if name==ref: continue
    fx0=min(p[0] for s in raw[name] for p in s); fy0=min(p[1] for s in raw[name] for p in s)
    cands=[]
    for step,rng,base in ((0.10,4.6,(0,0)),):
        for dx in np.arange(-rng,rng+1e-9,step):
            for dy in np.arange(-rng,rng+1e-9,step):
                img=raster(raw[name],fx0+dx,fy0+dy)
                sc=int(np.count_nonzero(cv2.bitwise_and(img,ref_img)))
                cands.append((sc,dx,dy))
    cands.sort(reverse=True)
    print(f"\n{name}: top offsets (coarse 0.10 m over +-4.6 m)")
    for sc,dx,dy in cands[:6]: print(f"   overlap={sc:6d}  dx={dx:+.2f} dy={dy:+.2f}")
    _,bdx,bdy=cands[0]
    best=(-1,bdx,bdy)
    for dx in np.arange(bdx-0.12,bdx+0.121,0.02):
        for dy in np.arange(bdy-0.12,bdy+0.121,0.02):
            img=raster(raw[name],fx0+dx,fy0+dy)
            sc=int(np.count_nonzero(cv2.bitwise_and(img,ref_img)))
            if sc>best[0]: best=(sc,dx,dy)
    sc,dx,dy=best
    origins[name]=(fx0+dx,fy0+dy)
    print(f"   -> refined dx={dx:+.2f} dy={dy:+.2f} overlap={sc}")
json.dump({k:list(v) for k,v in origins.items()},open(r"A:\Projects\CasaAltinho\_work\cad\e1_origins.json","w"),indent=1)

# visual overlay
ov=np.zeros((H,W,3),np.uint8); ov[:]=255
cols={"lower-ground":(220,60,60),"stilt":(40,160,60),"first":(30,30,30),"second":(60,90,220)}
for name,_,_ in FLOORS:
    ox,oy=origins[name]
    img=raster(raw[name],ox,oy,2)
    m=img>0
    for c in range(3): ov[:,:,c][m]=(ov[:,:,c][m]*0.35+cols[name][c]*0.65).astype(np.uint8)
ov=cv2.flip(ov,0)
cv2.imwrite(r"A:\Projects\CasaAltinho\_work\cad\e1_align.png",ov)
print("\nwrote e1_align.png  (red=LG green=stilt black=first blue=second)")
