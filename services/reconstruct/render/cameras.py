"""
Solving camera positions from the building itself.

── This is the difference, stated precisely ─────────────────────────────────
An image generator's "camera angle" cannot orbit anything. With no mesh, moving
the camera means sampling a new image and hoping the building comes back the
same — which is why those products ship a user-settable Seed and an "input:
previous render" control, and why two views of one house disagree about how many
windows it has.

Here the camera is a camera. It has a position in metres, a target, a focal
length and a clearance measurement, and every view is a projection of the same
geometry. Cross-view consistency is not a feature; it is unavoidable.

── What "solving" means ─────────────────────────────────────────────────────
An interior camera dropped at a room's centroid ends up inside a wall whenever
the room is L-shaped, and a camera against a wall renders a wall. So the eye
goes at the room's **pole of inaccessibility** — the point furthest from any
boundary — which is the same reason map labels are placed there. That distance
is reported as `clearance`, and a view whose clearance is under about half a
metre is not worth rendering.

Aim is chosen by what the room has: toward a glazed opening if there is one,
because windows are the brightest thing in an interior photograph and the eye
calibrates on them; otherwise along the room's longest axis, which is the view
that shows the most of it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import Point, Polygon

#: Standing eye height. Architectural interiors are shot slightly lower than a
#: person's actual eyeline — it reads as composed rather than as a snapshot.
EYE_HEIGHT = 1.55

#: Below this there is not enough room to see anything but the wall in front.
MIN_CLEARANCE = 0.6

#: Height to aim at when the subject is a piece of furniture rather than a
#: window. The top of most furniture: a bed is 0.6 m, a table 0.75, a sofa
#: 0.82. Aiming at eye level instead looks straight over the object at the
#: wall behind it, which is what the first version of the furniture aim did.
FURNITURE_AIM_HEIGHT = 0.7

#: 24 mm equivalent. Interiors are shot wide; anything longer and a normal room
#: fills the frame with one wall.
INTERIOR_FOV_DEG = 74.0
EXTERIOR_FOV_DEG = 50.0

#: True isometric. Not 30 degrees, which is the drafting convention and looks
#: subtly wrong when the geometry is real.
ISO_PITCH_DEG = 35.264
ISO_YAW_DEG = 45.0


@dataclass
class View:
    """One camera. Metres and degrees, ready for any renderer."""

    id: str
    kind: str                       # interior | exterior | isometric | plan
    eye: tuple[float, float, float]
    target: tuple[float, float, float]
    fov: float
    clearance: float = 0.0
    orthographic: bool = False
    ortho_scale: float = 0.0
    space: int | None = None
    name: str | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "eye": [round(v, 3) for v in self.eye],
            "target": [round(v, 3) for v in self.target],
            "fov": round(self.fov, 2),
            "clearance": round(self.clearance, 3),
            "orthographic": self.orthographic,
            "orthoScale": round(self.ortho_scale, 3),
            "space": self.space,
            "name": self.name,
            "notes": self.notes,
        }


def pole_of_inaccessibility(poly: Polygon, precision: float = 0.15) -> tuple[Point, float]:
    """
    The interior point furthest from any edge, and that distance.

    A grid-and-refine search rather than the quadtree algorithm: rooms are small
    and few, the answer only has to be good enough to stand in, and this has no
    dependency beyond what is already here.

    The centroid is not usable for this. An L-shaped room's centroid frequently
    falls in the missing corner, which is outside the room — so a camera placed
    there is inside a wall, and the render is black.
    """
    minx, miny, maxx, maxy = poly.bounds
    best_point, best_distance = poly.representative_point(), 0.0

    step = max((maxx - minx), (maxy - miny)) / 12 or precision
    while step >= precision:
        x = minx
        while x <= maxx:
            y = miny
            while y <= maxy:
                candidate = Point(x, y)
                if poly.contains(candidate):
                    d = poly.exterior.distance(candidate)
                    for ring in poly.interiors:
                        d = min(d, ring.distance(candidate))
                    if d > best_distance:
                        best_point, best_distance = candidate, d
                y += step
            x += step
        # Refine around the winner rather than over the whole room again.
        minx, maxx = best_point.x - step, best_point.x + step
        miny, maxy = best_point.y - step, best_point.y + step
        step /= 3

    return best_point, best_distance


def _longest_axis(poly: Polygon) -> tuple[float, float]:
    """Unit vector along the room's longest dimension."""
    coords = list(poly.exterior.coords)
    best, best_length = (1.0, 0.0), 0.0
    for (ax, ay), (bx, by) in zip(coords, coords[1:]):
        length = math.hypot(bx - ax, by - ay)
        if length > best_length:
            best_length = length
            best = ((bx - ax) / length, (by - ay) / length)
    return best


def interior_views(spaces, openings=None, walls=None, height: float = 2.7,
                   fixtures=None) -> list[View]:
    """One camera per room, standing where there is most space."""
    views: list[View] = []

    for space in spaces:
        poly = Polygon(space.loop)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon":
            continue

        eye, clearance = pole_of_inaccessibility(poly)
        notes: list[str] = []
        if clearance < MIN_CLEARANCE:
            notes.append(
                f"clearance {clearance:.2f} m — too tight to render usefully"
            )

        # Aim at a glazed opening if the room has one. A window is the brightest
        # thing in the frame and the exposure calibrates on it; pointing at a
        # blank wall instead produces a correctly-lit picture of nothing.
        aim = None
        aim_z = EYE_HEIGHT * 0.92
        if openings and walls:
            best = None
            for op in openings:
                if op.kind != "window" or op.wall >= len(walls):
                    continue
                w = walls[op.wall]
                t = op.along / max(w.length, 1e-9)
                px = w.ax + (w.bx - w.ax) * t
                py = w.ay + (w.by - w.ay) * t
                if not poly.buffer(0.4).contains(Point(px, py)):
                    continue
                d = math.hypot(px - eye.x, py - eye.y)
                if best is None or d < best[0]:
                    best = (d, px, py)
            if best:
                aim = (best[1], best[2])
                notes.append("aimed at glazing")

        # No glazing to aim at ? then aim at what is IN the room.
        #
        # ?? Why this matters more than it looks ???????????????????????????????
        # The glazing branch above is right and it almost never fires. Measured
        # across every reconstruction on this machine, 129 of 132 models carry
        # ZERO windows, so `op.kind != "window"` rejects everything and every
        # interior in every one of those models falls through to the longest
        # axis ? which points the camera at the far wall. The comment above
        # already names the result: "a correctly-lit picture of nothing". That
        # is exactly what the villa renders, a 14.9 m look down the foyer at
        # plaster.
        #
        # Furniture is the other thing worth looking at, and by this point the
        # reconstruction knows where it is: each fixture carries a plan position
        # and a resolved catalogue id. A bedroom camera should look at the bed.
        #
        # ?? Containment, never proximity ??????????????????????????????????????
        # Deliberately `poly.contains`, not "nearest fixture to the eye".
        # claude-d8fec1 measured the cost of the proximity version on the raster
        # side today: matching a detection to a window by centre-distance
        # credited a detection sitting on a DIFFERENT feature 0.021 away, and
        # the metric moved the wrong way while looking better. Two rooms share a
        # wall, so the nearest fixture to a camera can easily be the neighbour's
        # bed, seen through masonry. A point is either in this room or it is
        # not.
        if aim is None and fixtures:
            biggest = None
            for fixture in fixtures:
                position = fixture.get("position") or {}
                fx, fy = position.get("x"), position.get("y")
                if fx is None or fy is None:
                    continue
                if not poly.contains(Point(fx, fy)):
                    continue
                footprint = fixture.get("footprint") or {}
                area = float(footprint.get("w") or 0) * float(footprint.get("d") or 0)
                # Largest first: a bed says what a bedroom is, a plant does not.
                # Ties keep the first, which is the drawing's own order.
                if biggest is None or area > biggest[0]:
                    biggest = (area, fx, fy)
            if biggest is not None:
                aim = (biggest[1], biggest[2])
                # And LOWER the target, which the first version of this did not
                # and which made the whole change do nothing visible. Aiming at
                # a bed's x,y while the target height stays at eye level looks
                # straight OVER it at the wall behind ? measured, and the
                # bedroom rendered as plaster with a skirting board.
                #
                # 0.7 m is the top of most furniture (a bed is 0.6, a table
                # 0.75, a sofa 0.82), so the object lands in the lower middle of
                # the frame with the room above it. That is where an archviz
                # interior puts it.
                aim_z = FURNITURE_AIM_HEIGHT
                notes.append("aimed at furniture")

        if aim is None:
            dx, dy = _longest_axis(poly)
            reach = max(poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1])
            aim = (eye.x + dx * reach, eye.y + dy * reach)

        views.append(
            View(
                id=f"interior-{space.index}",
                kind="interior",
                eye=(eye.x, eye.y, EYE_HEIGHT),
                target=(aim[0], aim[1], aim_z),
                fov=INTERIOR_FOV_DEG,
                clearance=clearance,
                space=space.index,
                name=space.name,
                notes=notes,
            )
        )

    return views


def _bounds_of(walls) -> tuple[float, float, float, float]:
    xs = [c for w in walls for c in (w.ax, w.bx)]
    ys = [c for w in walls for c in (w.ay, w.by)]
    return min(xs), min(ys), max(xs), max(ys)


def exterior_views(walls, height: float = 2.7, count: int = 4) -> list[View]:
    """
    Cameras orbiting the building.

    Every one of these is the same model from a different angle — which is the
    claim that cannot be made about a generated image, where each angle is an
    independent sample of a building that never existed.
    """
    if not walls:
        return []

    x0, y0, x1, y1 = _bounds_of(walls)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    span = max(x1 - x0, y1 - y0)
    # Far enough to hold the whole footprint at the exterior field of view,
    # with a little air. Derived, not chosen, so it scales with the building.
    distance = (span / 2) / math.tan(math.radians(EXTERIOR_FOV_DEG / 2)) * 1.25
    eye_z = height * 1.35

    views = []
    for i in range(count):
        angle = math.radians(45 + i * (360 / count))
        views.append(
            View(
                id=f"exterior-{i}",
                kind="exterior",
                eye=(cx + math.cos(angle) * distance, cy + math.sin(angle) * distance, eye_z),
                target=(cx, cy, height * 0.45),
                fov=EXTERIOR_FOV_DEG,
                clearance=distance,
                notes=[f"orbit {int(math.degrees(angle)) % 360}°"],
            )
        )
    return views


def isometric_view(walls, height: float = 2.7) -> View | None:
    """
    The cutaway isometric — the picture an image generator is asked for.

    Here it is a real orthographic camera at the true isometric angle, looking at
    the actual model with its roof off. Same building as every other view, by
    construction rather than by luck.
    """
    if not walls:
        return None

    x0, y0, x1, y1 = _bounds_of(walls)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    span = max(x1 - x0, y1 - y0)
    distance = span * 1.6

    yaw = math.radians(ISO_YAW_DEG)
    pitch = math.radians(ISO_PITCH_DEG)

    return View(
        id="isometric",
        kind="isometric",
        eye=(
            cx + math.cos(yaw) * math.cos(pitch) * distance,
            cy + math.sin(yaw) * math.cos(pitch) * distance,
            math.sin(pitch) * distance,
        ),
        target=(cx, cy, height * 0.4),
        fov=0.0,
        orthographic=True,
        # Orthographic scale is the width the frame covers, in metres.
        ortho_scale=span * 1.35,
        notes=["true isometric, 35.264° pitch"],
    )


def plan_view(walls, cut_height: float = 1.2) -> View | None:
    """Orthographic, straight down, cut at the height a plan is cut at."""
    if not walls:
        return None

    x0, y0, x1, y1 = _bounds_of(walls)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    span = max(x1 - x0, y1 - y0)

    return View(
        id="plan",
        kind="plan",
        eye=(cx, cy, 60.0),
        target=(cx, cy, 0.0),
        fov=0.0,
        orthographic=True,
        ortho_scale=span * 1.1,
        notes=[f"section plane at {cut_height} m"],
    )


def solve(spaces, walls, openings=None, height: float = 2.7,
          orbit: int = 4, fixtures=None) -> list[View]:
    """Every view the model can support, best interior first."""
    views: list[View] = []
    inside = interior_views(spaces, openings=openings, walls=walls, height=height,
                            fixtures=fixtures)
    inside.sort(key=lambda v: -v.clearance)
    views.extend(inside)
    views.extend(exterior_views(walls, height=height, count=orbit))

    iso = isometric_view(walls, height=height)
    if iso:
        views.append(iso)
    plan = plan_view(walls)
    if plan:
        views.append(plan)

    return views


def summarise(views: list[View]) -> dict:
    usable = [v for v in views if v.clearance >= MIN_CLEARANCE or v.kind != "interior"]
    return {
        "total": len(views),
        "usable": len(usable),
        "interior": sum(1 for v in views if v.kind == "interior"),
        "tooTight": sum(
            1 for v in views if v.kind == "interior" and v.clearance < MIN_CLEARANCE
        ),
        "bestClearance": round(
            max((v.clearance for v in views if v.kind == "interior"), default=0.0), 2
        ),
    }
