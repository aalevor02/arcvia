"""
Which room is this render of?

Captions resolve most renders on their own (see apps/studio/src/plan/
roomAssignment.ts), and when they do, nothing here runs. This is for the two
cases a caption cannot settle:

  * AMBIGUOUS - "Bed" fits `bed-1-room` and `bed-2-room`. No amount of string
    work separates those, because the difference is not in the words. It is in
    the plan: one has the balcony, one is on the corridor.
  * UNMATCHED - the deck captions a render "Guest Suite" and the drawing calls
    the same space "Bedroom-3". Different words, same room.

Both are answerable by looking, which is what the vision model is for. The
question put to it is deliberately closed-form -- pick a number -- because that
is what this model class is reliable at, and the same reason the adjudicator
asks about one crop at a time rather than requesting an analysis.

The plan and the render go up as ONE composite image, plan on the left with its
rooms numbered, render on the right. `adjudicate._ask` takes a single image, and
a composite means one round trip and one bill instead of two, with both pictures
guaranteed to reach the model in the same context.

This never assigns on its own. It returns a proposal with a confidence, and the
studio still shows it for confirmation. A model that is right most of the time
is an excellent suggestion and an unacceptable silent decision.
"""

from __future__ import annotations

import cv2
import numpy as np

import adjudicate

#: Below this, the answer is reported but flagged as weak. Chosen to match
#: adjudicate.MIN_CONFIDENCE: the same model answering the same kind of
#: closed-form question should not have two different bars.
MIN_CONFIDENCE = 0.6

#: The composite's long edge. Large enough that room numbers stay legible after
#: JPEG, small enough that _encode does not have to shrink it further.
_COMPOSITE_LONG_EDGE = 1100


def available() -> bool:
    return adjudicate.available()


def name() -> str | None:
    return adjudicate.name()


def _centroid(polygon: list[dict]) -> tuple[float, float]:
    """Area-weighted centre, so an L-shaped room numbers inside itself."""
    points = [(float(p["x"]), float(p["y"])) for p in polygon]
    if len(points) < 3:
        xs = [p[0] for p in points] or [0.5]
        ys = [p[1] for p in points] or [0.5]
        return sum(xs) / len(xs), sum(ys) / len(ys)

    twice_area = 0.0
    cx = cy = 0.0
    for i in range(len(points)):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % len(points)]
        cross = x0 * y1 - x1 * y0
        twice_area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(twice_area) < 1e-9:
        # A degenerate ring would divide by ~zero. The bounding-box centre is
        # wrong for an L, but it is inside the drawing, which is enough to
        # place a label.
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    return cx / (3 * twice_area), cy / (3 * twice_area)


def _numbered_plan(plan: np.ndarray, rooms: list[dict]) -> np.ndarray:
    """The plan with each candidate room outlined and marked by its number."""
    canvas = plan.copy()
    if canvas.ndim == 2:
        canvas = cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)
    height, width = canvas.shape[:2]

    for index, room in enumerate(rooms, start=1):
        polygon = room.get("polygon") or []
        cx, cy = _centroid(polygon)
        px, py = int(cx * width), int(cy * height)

        if polygon:
            ring = np.array(
                [[int(float(p["x"]) * width), int(float(p["y"]) * height)] for p in polygon],
                dtype=np.int32,
            )
            cv2.polylines(canvas, [ring], True, (0, 90, 220), 2, cv2.LINE_AA)

        label = str(index)
        scale = max(0.8, min(width, height) / 700)
        thickness = max(2, int(scale * 2))
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
        pad = int(8 * scale)
        # A filled plate behind the number: plans are dense black-on-white line
        # work, and bare text lands on top of walls and dimension strings.
        cv2.rectangle(
            canvas,
            (px - tw // 2 - pad, py - th // 2 - pad),
            (px + tw // 2 + pad, py + th // 2 + pad),
            (0, 90, 220),
            -1,
        )
        cv2.putText(
            canvas, label, (px - tw // 2, py + th // 2),
            cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thickness, cv2.LINE_AA,
        )
    return canvas


def _composite(plan: np.ndarray, render: np.ndarray) -> np.ndarray:
    """Plan left, render right, matched heights, a visible seam between them."""
    target = _COMPOSITE_LONG_EDGE // 2

    def fit(image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]
        if h == 0 or w == 0:
            return np.full((target, target, 3), 255, np.uint8)
        scale = target / max(h, w)
        resized = cv2.resize(
            image, (max(1, int(w * scale)), max(1, int(h * scale))),
            interpolation=cv2.INTER_AREA,
        )
        rh, rw = resized.shape[:2]
        canvas = np.full((target, target, 3), 255, np.uint8)
        top, left = (target - rh) // 2, (target - rw) // 2
        canvas[top:top + rh, left:left + rw] = resized
        return canvas

    left_panel, right_panel = fit(plan), fit(render)
    seam = np.full((target, 6, 3), 40, np.uint8)
    return np.hstack([left_panel, seam, right_panel])


def _prompt(rooms: list[dict]) -> str:
    lines = []
    for index, room in enumerate(rooms, start=1):
        named = (room.get("name") or "").strip()
        lines.append(f"{index}. {named}" if named else f"{index}. (unlabelled)")
    listing = "\n".join(lines)
    return (
        "The left image is an architectural floor plan. Each candidate room is "
        "outlined and marked with a number:\n"
        f"{listing}\n\n"
        "The right image is a photograph or rendering of ONE of those rooms.\n\n"
        "Which numbered room does the right image show? Judge by what the space "
        "is (a bedroom, a kitchen, a bathroom), by its proportions, and by where "
        "its windows and doors sit relative to the plan.\n\n"
        'Answer with JSON only: {"room": <number>, "confidence": <0 to 1>, '
        '"because": "<up to 12 words>"}\n'
        'If no numbered room matches, answer {"room": 0, "confidence": 0, '
        '"because": "no match"}.'
    )


def assign_render(plan: np.ndarray, rooms: list[dict], render: np.ndarray) -> dict | None:
    """
    Propose which room a render shows - or None when it cannot say.

    None covers unconfigured, unanswered, unparseable and out-of-range alike:
    every one of them means "no proposal", and a caller that has to tell them
    apart is a caller that will get it wrong. The reason is logged, not returned.
    """
    if not available() or not rooms:
        return None

    answer = adjudicate._ask(
        _composite(_numbered_plan(plan, rooms), render), _prompt(rooms), max_tokens=200
    )
    parsed = adjudicate._json_object(answer) if answer else None
    if not parsed:
        return None

    try:
        index = int(parsed.get("room", 0))
        confidence = float(parsed.get("confidence", 0))
    except (TypeError, ValueError):
        return None

    # 0 is the model's own "none of these", and anything outside the list is a
    # hallucinated index. Both mean no proposal rather than a wrong one.
    if index < 1 or index > len(rooms):
        return None

    room = rooms[index - 1]
    return {
        "index": index - 1,
        "name": room.get("name"),
        "confidence": confidence,
        "weak": confidence < MIN_CONFIDENCE,
        "because": str(parsed.get("because", ""))[:120],
        "model": adjudicate.name(),
    }
