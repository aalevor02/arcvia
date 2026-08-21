"""
Download a curated set of CC0 furniture from Poly Haven.

Everything here is CC0 (public domain) - no attribution required and no licence
to track, which is the reason this library was chosen over Sketchfab. The set is
deliberately small: each asset's textures are embedded in every villa GLB that
uses it, so breadth costs bandwidth on a sales page.

Poly Haven has no modern bed and no sanitary ware (its "toilet" search returns a
plunger and drain cleaner), so beds, counters, WCs and basins stay as massing.
"""
import json, os, io, urllib.request, hashlib

OUT = r"A:\Projects\CasaAltinho\_work\cad\assets"
RES = "1k"

# massing kind -> Poly Haven slug
WANT = {
    "sofa": "Sofa_01",
    "chair": "painted_wooden_chair_01",
    "table": "WoodenTable_01",
    "low_table": "CoffeeTable_01",
    "armchair": "ArmChair_01",
    "tv": "Television_01",
    "plant": "potted_plant_02",
    "plant_b": "calathea_orbifolia_01",
    "lamp": "desk_lamp_arm_01",
}


def get(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return os.path.getsize(dest)
    req = urllib.request.Request(url, headers={"User-Agent": "arcvia-cad-to-3d/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r, open(dest, "wb") as f:
        data = r.read()
        f.write(data)
    return len(data)


total = 0
manifest = {}
for kind, slug in WANT.items():
    try:
        req = urllib.request.Request(f"https://api.polyhaven.com/files/{slug}",
                                     headers={"User-Agent": "arcvia-cad-to-3d/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            files = json.loads(r.read().decode("utf-8"))
        entry = files["gltf"][RES]["gltf"]
    except Exception as e:
        print(f"{kind:10s} {slug:26s} FAILED ({e})")
        continue

    folder = os.path.join(OUT, slug)
    n = get(entry["url"], os.path.join(folder, os.path.basename(entry["url"])))
    for rel, meta in (entry.get("include") or {}).items():
        n += get(meta["url"], os.path.join(folder, rel.replace("/", os.sep)))
    total += n
    manifest[kind] = dict(slug=slug,
                          gltf=os.path.join(folder, os.path.basename(entry["url"])))
    print(f"{kind:10s} {slug:26s} {n/1024:7.0f} KB")

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print(f"\n{len(manifest)} assets, {total/1024/1024:.2f} MB -> {OUT}")
print("Licence: CC0 (Poly Haven). No attribution required.")
