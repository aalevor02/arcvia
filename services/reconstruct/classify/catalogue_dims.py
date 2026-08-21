# GENERATED — do not edit.
#
# Source: apps/studio/src/catalogue/items.ts
# Regenerate: node tools/cad-engine/gen-catalogue-dims.mjs
#
# The dimension table the footprint classifier matches against. Metres.
# `w` is width across the front, `d` is depth away from the wall, `h` is height.
# `placement` decides what a match even means: a 'wall' item hangs on a wall
# face and can never be a free-standing footprint, and an 'in-wall' item is an
# opening rather than an object.

CATALOGUE_DIMS: dict[str, dict] = {
    "sofa-3": {"category": "Seating", "placement": "floor", "w": 2.1, "d": 0.9, "h": 0.82, "mount": None},
    "sofa-2": {"category": "Seating", "placement": "floor", "w": 1.5, "d": 0.9, "h": 0.82, "mount": None},
    "armchair": {"category": "Seating", "placement": "floor", "w": 0.85, "d": 0.85, "h": 0.82, "mount": None},
    "dining-chair": {"category": "Seating", "placement": "floor", "w": 0.45, "d": 0.5, "h": 0.9, "mount": None},
    "bench": {"category": "Seating", "placement": "floor", "w": 1.4, "d": 0.4, "h": 0.45, "mount": None},
    "dining-table-6": {"category": "Tables", "placement": "floor", "w": 1.8, "d": 0.9, "h": 0.75, "mount": None},
    "dining-table-4": {"category": "Tables", "placement": "floor", "w": 1.2, "d": 0.8, "h": 0.75, "mount": None},
    "coffee-table": {"category": "Tables", "placement": "floor", "w": 1.1, "d": 0.6, "h": 0.42, "mount": None},
    "side-table": {"category": "Tables", "placement": "floor", "w": 0.45, "d": 0.45, "h": 0.55, "mount": None},
    "desk": {"category": "Tables", "placement": "floor", "w": 1.4, "d": 0.7, "h": 0.75, "mount": None},
    "bed-king": {"category": "Beds", "placement": "floor", "w": 1.83, "d": 2.03, "h": 0.6, "mount": None},
    "bed-queen": {"category": "Beds", "placement": "floor", "w": 1.52, "d": 2.03, "h": 0.6, "mount": None},
    "bed-single": {"category": "Beds", "placement": "floor", "w": 0.91, "d": 1.9, "h": 0.6, "mount": None},
    "bedside": {"category": "Beds", "placement": "floor", "w": 0.45, "d": 0.4, "h": 0.55, "mount": None},
    "wardrobe": {"category": "Storage", "placement": "floor", "w": 1.8, "d": 0.6, "h": 2.1, "mount": None},
    "wardrobe-small": {"category": "Storage", "placement": "floor", "w": 0.9, "d": 0.6, "h": 2.1, "mount": None},
    "bookshelf": {"category": "Storage", "placement": "floor", "w": 0.9, "d": 0.32, "h": 1.8, "mount": None},
    "tv-unit": {"category": "Storage", "placement": "floor", "w": 1.6, "d": 0.4, "h": 0.5, "mount": None},
    "chest": {"category": "Storage", "placement": "floor", "w": 0.9, "d": 0.45, "h": 0.85, "mount": None},
    "counter": {"category": "Kitchen", "placement": "floor", "w": 2.4, "d": 0.6, "h": 0.9, "mount": None},
    "island": {"category": "Kitchen", "placement": "floor", "w": 1.8, "d": 0.9, "h": 0.9, "mount": None},
    "sink-unit": {"category": "Kitchen", "placement": "floor", "w": 1.2, "d": 0.6, "h": 0.9, "mount": None},
    "fridge": {"category": "Kitchen", "placement": "floor", "w": 0.7, "d": 0.7, "h": 1.8, "mount": None},
    "hob": {"category": "Kitchen", "placement": "floor", "w": 0.6, "d": 0.6, "h": 0.9, "mount": None},
    "overhead": {"category": "Kitchen", "placement": "wall", "w": 1.8, "d": 0.35, "h": 0.7, "mount": 1.45},
    "wc": {"category": "Bathroom", "placement": "floor", "w": 0.38, "d": 0.7, "h": 0.78, "mount": None},
    "basin": {"category": "Bathroom", "placement": "wall", "w": 0.6, "d": 0.45, "h": 0.2, "mount": 0.8},
    "bathtub": {"category": "Bathroom", "placement": "floor", "w": 1.7, "d": 0.75, "h": 0.55, "mount": None},
    "shower": {"category": "Bathroom", "placement": "floor", "w": 0.9, "d": 0.9, "h": 2, "mount": None},
    "door": {"category": "Doors & windows", "placement": "in-wall", "w": 0.9, "d": 0.05, "h": 2.1, "mount": None},
    "door-main": {"category": "Doors & windows", "placement": "in-wall", "w": 1.05, "d": 0.05, "h": 2.1, "mount": None},
    "door-double": {"category": "Doors & windows", "placement": "in-wall", "w": 1.5, "d": 0.05, "h": 2.1, "mount": None},
    "door-sliding": {"category": "Doors & windows", "placement": "in-wall", "w": 1.8, "d": 0.05, "h": 2.1, "mount": None},
    "window": {"category": "Doors & windows", "placement": "in-wall", "w": 1.2, "d": 0.05, "h": 1.2, "mount": 0.9},
    "window-wide": {"category": "Doors & windows", "placement": "in-wall", "w": 2.1, "d": 0.05, "h": 1.2, "mount": 0.9},
    "window-full": {"category": "Doors & windows", "placement": "in-wall", "w": 1.8, "d": 0.05, "h": 2.1, "mount": None},
    "opening": {"category": "Doors & windows", "placement": "in-wall", "w": 1, "d": 0.05, "h": 2.1, "mount": None},
    "ceiling-light": {"category": "Lighting", "placement": "ceiling", "w": 0.4, "d": 0.4, "h": 0.08, "mount": 0},
    "pendant": {"category": "Lighting", "placement": "ceiling", "w": 0.32, "d": 0.32, "h": 0.3, "mount": 0.7},
    "wall-light": {"category": "Lighting", "placement": "wall", "w": 0.16, "d": 0.14, "h": 0.24, "mount": 1.8},
    "rug": {"category": "Decor", "placement": "floor", "w": 2.4, "d": 1.7, "h": 0.012, "mount": None},
    "plant": {"category": "Decor", "placement": "floor", "w": 0.55, "d": 0.55, "h": 1.3, "mount": None},
    "tv": {"category": "Decor", "placement": "wall", "w": 1.25, "d": 0.07, "h": 0.72, "mount": 1},
    "painting": {"category": "Decor", "placement": "wall", "w": 0.9, "d": 0.05, "h": 0.7, "mount": 1.45},
    "mirror": {"category": "Decor", "placement": "wall", "w": 0.7, "d": 0.04, "h": 1, "mount": 1.1},
    "curtain": {"category": "Decor", "placement": "wall", "w": 2, "d": 0.12, "h": 2.3, "mount": 0.05},
}

#: Items that occupy a hole through a wall rather than standing in a room.
IN_WALL = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "in-wall"}

#: Items that hang on a wall face — a TV, a painting, a mirror. These have a
#: footprint on the drawing but no floor area, which is why they are separated:
#: matching one as a free-standing object puts a television on the carpet.
WALL_MOUNTED = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "wall"}

#: Everything that genuinely stands on the floor and can be matched by footprint.
FLOOR_STANDING = {k for k, v in CATALOGUE_DIMS.items() if v["placement"] == "floor"}
