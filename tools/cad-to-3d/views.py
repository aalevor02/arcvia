"""
Choose walkthrough viewpoints for Villa E-1 that are actually standable.

A room's text label sits wherever the draughtsman had space for it, which is
often right up against a wall - drop a camera there and it renders a blank
surface. Instead: search the open space near the label for the point with the
most clearance, then aim down the longest clear sightline from it.
"""
import json, math

import sys
TID = sys.argv[1] if len(sys.argv) > 1 else "e1"
SRC = rf"A:\Projects\CasaAltinho\_work\cad\{TID}_building.json"
B = json.load(open(SRC))
EYE = 1.60

# Room label prefix -> (floor id, view id, display name)

# Rooms worth standing in, most interesting first. Matched against the CAD's own
# room labels, so a type that lacks one simply skips it.
ROOMS = [
    ("LIVING",        "living",   "Living area"),
    ("KITCHEN",       "kitchen",  "Kitchen"),
    ("DINING",        "dining",   "Dining area"),
    ("OPEN DECK",     "deck",     "Open deck"),
    ("MASTER BEDROOM", "master",  "Master bedroom"),
    ("BEDROOM-1",     "bed1",     "Bedroom 1"),
    ("BEDROOM-2",     "bed2",     "Bedroom 2"),
    ("BEDROOM-3",     "bed3",     "Bedroom 3"),
    ("BEDROOM-4",     "bed4",     "Bedroom 4"),
    ("FAMILY LOUNGE", "lounge",   "Family lounge"),
    ("FOYER",         "foyer",    "Foyer"),
    ("ENTRANCE",      "entrance", "Entrance"),
    ("CAR PARKING",   "parking",  "Car parking"),
    ("PASSAGE",       "passage",  "Passage"),
    ("VERANDAH",      "verandah", "Verandah"),
]

WANTED = []
_seen = set()
for _fl in B["floors"]:
    _hit = False
    for _pref, _vid, _name in ROOMS:
        if _vid in _seen:
            continue
        if any(l["t"].upper().startswith(_pref) for l in _fl["labels"]):
            WANTED.append((_fl["id"], _pref, _vid, f"{_name} ({_fl['label'].lower()})"))
            _seen.add(_vid)
            _hit = True
    # A traced floor carries no room labels - the brochure plan's text is not
    # extractable - but the visitor still needs somewhere to stand on it, so
    # give it one solved viewpoint marked as reconstructed.
    if not _hit and _fl.get("footprint"):
        _fl.setdefault("labels", []).append(
            dict(t="CENTRE", p=[sum(q[0] for q in _fl["footprint"]) / len(_fl["footprint"]),
                                sum(q[1] for q in _fl["footprint"]) / len(_fl["footprint"])]))
        _suffix = " (reconstructed)" if _fl.get("reconstructed") else ""
        WANTED.append((_fl["id"], "CENTRE", f"fl_{_fl['id']}",
                       f"{_fl['label']}{_suffix}"))


def seg_dist(p, a, b):
    """Distance from point p to segment ab."""
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = p[0] - a[0], p[1] - a[1]
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx, dy = a[0] + t * vx - p[0], a[1] + t * vy - p[1]
    return math.hypot(dx, dy)


def inside(p, poly):
    """Even-odd point-in-polygon."""
    x, y = p
    c = False
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay + 1e-12) + ax:
            c = not c
    return c


def ray_blocked(p, q, walls):
    """True if segment pq crosses a solid wall before reaching q."""
    for w in walls:
        a, b = w["a"], w["b"]
        d1x, d1y = q[0] - p[0], q[1] - p[1]
        d2x, d2y = b[0] - a[0], b[1] - a[1]
        den = d1x * d2y - d1y * d2x
        if abs(den) < 1e-9:
            continue
        t = ((a[0] - p[0]) * d2y - (a[1] - p[1]) * d2x) / den
        u = ((a[0] - p[0]) * d1y - (a[1] - p[1]) * d1x) / den
        if 0.02 < t < 0.92 and 0.0 <= u <= 1.0:
            return True
    return False


out = []
for fid, prefix, vid, name in WANTED:
    fl = next((f for f in B["floors"] if f["id"] == fid), None)
    if not fl:
        continue
    lab = next((l for l in fl["labels"] if l["t"].upper().startswith(prefix.upper())), None)
    if not lab:
        print(f"  [miss] {fid}/{prefix}")
        continue

    # Solid walls only. The 1 m parapets do not block a standing camera's view,
    # and treating them as blockers pushes the camera away from every balcony.
    walls = [w for w in fl["walls"] if not w.get("unpaired")]
    # Traced floors carry their walls as rectangles, not centrelines. Without
    # this the clearance solver sees an empty floor and parks the camera inside
    # a wall band.
    for poly in (fl.get("wallPolys") or []):
        for i in range(len(poly)):
            walls.append(dict(a=poly[i - 1], b=poly[i], t=0.10))
    poly = fl["footprint"]
    lx, ly = lab["p"]

    # 1. best-clearance point within 2.2 m of the label
    best_p, best_c = None, -1.0
    steps = 23
    for i in range(steps):
        for j in range(steps):
            x = lx - 2.2 + 4.4 * i / (steps - 1)
            y = ly - 2.2 + 4.4 * j / (steps - 1)
            if not inside((x, y), poly):
                continue           # a camera outside the building is never right
            c = min((seg_dist((x, y), w["a"], w["b"]) for w in walls), default=9.0)
            # prefer clearance, but do not wander far from the labelled room
            score = c - 0.18 * math.hypot(x - lx, y - ly)
            if score > best_c:
                best_c, best_p = score, (x, y)
    if best_p is None:
        print(f"  [miss] no interior point for {name}")
        continue
    px, py = best_p
    clear = min((seg_dist(best_p, w["a"], w["b"]) for w in walls), default=9.0)

    # 2. Aim at the nearest glazing. An interior shot wants a window in frame -
    #    that is what gives it depth and daylight. Aiming down the longest ray
    #    instead just points at whichever doorway happens to be open, and with
    #    door gaps in the wall loop most rays escape the building entirely.
    glaz = [o for o in fl["openings"] if o["kind"] in ("glazing", "window")]
    target, tdist = None, 0.0
    cands = []
    for o in glaz:
        d = math.hypot(o["c"][0] - px, o["c"][1] - py)
        if d < 2.5:
            continue      # a window this close just fills the frame with wall
        if ray_blocked((px, py), o["c"], walls):
            continue
        cands.append((d, o))
    if cands:
        # Farthest, not nearest. Aiming at the window beside you shows the wall
        # around it; aiming across the room shows the room, then the window.
        cands.sort(key=lambda c: -c[0])
        tdist, target = cands[0][0], cands[0][1]["c"]
    if target is None:
        cx = sum(q[0] for q in poly) / len(poly)
        cy = sum(q[1] for q in poly) / len(poly)
        target, tdist = [cx, cy], math.hypot(cx - px, cy - py)
    # The viewer documents "yaw 0 looks down -Z", heading (-sin y, 0, -cos y).
    # Plan +Y maps to glTF -Z, so a plan bearing theta becomes theta - 90.
    theta = math.degrees(math.atan2(target[1] - py, target[0] - px))
    yaw = int(round(theta - 90.0)) % 360
    reach = tdist

    z = fl["level"] + EYE
    # Blender Z-up -> glTF Y-up: (x, y, z) becomes (x, z, -y)
    out.append(dict(id=vid, name=name, floor=fid,
                    pos=[round(px, 2), round(z, 2), round(-py, 2)],
                    yaw=yaw, clear=round(clear, 2), reach=round(reach, 2)))
    print(f"{name:28s} {fid:13s} clearance {clear:4.2f} m  target {reach:5.2f} m  yaw {yaw:3d}")

print("\n      walkthrough: {")
print(f"        model: 'scenes/villa-{TID}.glb',")
print("        eyeHeight: 1.6,")
print("        views: [")
for v in out:
    p = v["pos"]
    print(f"          {{ id: '{v['id']}', name: '{v['name']}', "
          f"position: [{p[0]}, {p[1]}, {p[2]}], rotation: [{v['yaw']}, -2] }},")
print("        ],")
print("      },")
