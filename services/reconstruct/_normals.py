"""
Does each triangle's winding agree with the normal it carries?

The obvious check — count how many normals point up and how many down — cannot
find an inside-out box, and that is worth stating because it was tried first and
looked reassuring. Flipping a closed solid inverts every face, so its up count
and its down count simply swap and the ratio it is judged by is unchanged. The
handoff warns about exactly this: a box with six unit normals can still be
inside out.

What does detect it is comparing two independent statements about the same
triangle. Its winding order implies a normal by the right-hand rule; its
vertices carry one explicitly. On correct geometry those agree. Where they
disagree, the renderer lights the face by the stored normal and culls or shades
it by the winding, and the result is a surface that goes black under every style
and every light — which is the symptom being chased.
"""

import json
import struct
import sys
from collections import Counter

path = sys.argv[1]
data = open(path, "rb").read()
total = struct.unpack_from("<III", data, 0)[2]

offset, chunks = 12, {}
while offset < total:
    length, kind = struct.unpack_from("<II", data, offset)
    chunks[kind] = data[offset + 8 : offset + 8 + length]
    offset += 8 + length + (-length % 4)

gltf = json.loads(chunks[0x4E4F534A].decode("utf-8"))
binary = chunks[0x004E4942]

COMPONENT = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4)}


def read(accessor_index, kind):
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]

    if kind == "vec3":
        stride = view.get("byteStride") or 12
        return [struct.unpack_from("<fff", binary, start + i * stride) for i in range(count)]

    code, size = COMPONENT[accessor["componentType"]]
    return list(struct.unpack_from(f"<{count}{code}", binary, start))


for mesh in gltf["meshes"]:
    verdict = Counter()

    for primitive in mesh["primitives"]:
        attributes = primitive["attributes"]
        if "NORMAL" not in attributes or "indices" not in primitive:
            verdict["no data"] += 1
            continue

        positions = read(attributes["POSITION"], "vec3")
        normals = read(attributes["NORMAL"], "vec3")
        indices = read(primitive["indices"], "scalar")

        for i in range(0, len(indices), 3):
            a, b, c = (positions[indices[i + k]] for k in range(3))
            # Right-hand rule: the normal the winding implies.
            u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
            wound = (
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            )
            length = sum(component * component for component in wound) ** 0.5
            if length < 1e-12:
                verdict["degenerate triangle"] += 1
                continue

            stored = normals[indices[i]]
            agreement = sum(w * s for w, s in zip(wound, stored)) / length

            if agreement > 0.3:
                verdict["agree"] += 1
            elif agreement < -0.3:
                verdict["INSIDE OUT"] += 1
            else:
                verdict["perpendicular"] += 1

    name = mesh.get("name", "(unnamed)")
    flipped = verdict["INSIDE OUT"]
    total_tris = sum(verdict.values())
    share = f"{flipped / total_tris:.0%}" if total_tris else "-"
    print(f"{name:22s} {total_tris:6d} triangles  {dict(verdict)}  flipped={share}")
