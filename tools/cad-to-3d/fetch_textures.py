"""
Download CC0 PBR surface textures from Poly Haven.

Flat base colours are what make the shell read as painted cardboard. The
reference walkthrough this is measured against ships ~24 MB of texture; these
are the same class of asset, CC0, at 1k.

Diffuse + roughness + normal per material. No displacement: the geometry is
extruded plan linework with no subdivision to displace.
"""
import json, os, urllib.request

OUT = r"A:\Projects\CasaAltinho\_work\cad\textures"
RES = "1k"

WANT = {
    "floor_stone":  "marble_01",
    "floor_timber": "wood_floor_deck",
    "wall_plaster": "beige_wall_001",
    "ceiling":      "painted_plaster_wall",
    "counter":      "granite_tile_02",
    "column":       "concrete_wall_008",
}
MAPS = ("Diffuse", "Rough", "nor_gl")


def get(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return os.path.getsize(dest)
    req = urllib.request.Request(url, headers={"User-Agent": "arcvia-cad-to-3d/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    open(dest, "wb").write(data)
    return len(data)


manifest, total = {}, 0
for key, slug in WANT.items():
    try:
        req = urllib.request.Request(f"https://api.polyhaven.com/files/{slug}",
                                     headers={"User-Agent": "arcvia-cad-to-3d/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            files = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"{key:14s} {slug:22s} FAILED ({e})")
        continue
    entry = {}
    n = 0
    for m in MAPS:
        block = files.get(m, {}).get(RES, {})
        pick = block.get("jpg") or block.get("png")
        if not pick:
            continue
        dest = os.path.join(OUT, slug, os.path.basename(pick["url"]))
        n += get(pick["url"], dest)
        entry[m] = dest
    if not entry.get("Diffuse"):
        print(f"{key:14s} {slug:22s} no diffuse at {RES}")
        continue
    manifest[key] = dict(slug=slug, **entry)
    total += n
    print(f"{key:14s} {slug:22s} {n/1024:7.0f} KB  maps={list(entry)}")

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print(f"\n{len(manifest)} textures, {total/1024/1024:.2f} MB -> {OUT}")
print("Licence: CC0 (Poly Haven).")
