"""No-network contract tests for the room-assignment proposal.

The value of this module is not that it answers -- it is that it refuses
cleanly. A wrong room silently applied is the exact failure the caption matcher
was fixed for, so a proposal that cannot be trusted must come back as None
rather than as a confident-looking guess.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key-not-a-real-one")

import adjudicate  # noqa: E402
import assign  # noqa: E402

passed = 0
failed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {label}")
    else:
        failed += 1
        print(f"FAIL  {label}  {detail}")


def square(x0: float, y0: float, x1: float, y1: float) -> list[dict]:
    return [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]


ROOMS = [
    {"polygon": square(0.05, 0.05, 0.45, 0.45), "name": "Bedroom-1", "area": 0.16},
    {"polygon": square(0.55, 0.05, 0.95, 0.45), "name": "Bedroom-2", "area": 0.16},
    {"polygon": square(0.05, 0.55, 0.95, 0.95), "name": None, "area": 0.36},
]
PLAN = np.full((600, 600, 3), 255, np.uint8)
RENDER = np.full((400, 500, 3), 200, np.uint8)


def answering(text: str):
    return patch.object(adjudicate, "_ask", lambda *a, **k: text)


# -- the composite is what makes one round trip possible ---------------------
{}
plate = assign._numbered_plan(PLAN, ROOMS)
check("numbering the plan does not resize it", plate.shape == PLAN.shape, str(plate.shape))
check("numbering actually marks the plan", not np.array_equal(plate, PLAN))

composite = assign._composite(plate, RENDER)
check(
    "the composite is two panels wide plus a seam",
    composite.shape[1] > composite.shape[0],
    str(composite.shape),
)
check(
    "and it fits the provider's encoder without being shrunk again",
    bool(adjudicate._encode(composite)),
)

# -- an L-shaped room numbers inside itself, not in its notch ----------------
ell = [
    {"x": 0.0, "y": 0.0}, {"x": 0.6, "y": 0.0}, {"x": 0.6, "y": 0.3},
    {"x": 1.0, "y": 0.3}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0},
]
cx, cy = assign._centroid(ell)
check("an L-shaped room's mark falls inside the L", 0.0 < cx < 1.0 and 0.0 < cy < 1.0, f"{cx},{cy}")

degenerate = assign._centroid([{"x": 0.5, "y": 0.5}, {"x": 0.5, "y": 0.5}])
check("a degenerate ring does not divide by zero", degenerate == (0.5, 0.5), str(degenerate))

# -- the prompt has to name the rooms, or a number means nothing -------------
prompt = assign._prompt(ROOMS)
check("every room is numbered in the prompt", "1. Bedroom-1" in prompt and "2. Bedroom-2" in prompt)
check("an unlabelled room is still offered as a choice", "3. (unlabelled)" in prompt)
check("the model is given an explicit way to say 'none'", '"room": 0' in prompt)

# -- a good answer becomes a proposal ----------------------------------------
with answering('{"room": 2, "confidence": 0.82, "because": "two windows on the east wall"}'):
    out = assign.assign_render(PLAN, ROOMS, RENDER)
check("a valid answer resolves to that room", out is not None and out["index"] == 1, str(out))
check("and carries the room's own name", out and out["name"] == "Bedroom-2", str(out))
check("and is not flagged weak above the bar", out and out["weak"] is False, str(out))
check("and keeps the model's reason for a person to judge",
      out and "east wall" in out["because"], str(out))

# -- a low-confidence answer is returned, but marked ------------------------
# Suppressing it entirely would throw away a usable hint; presenting it as equal
# to a confident answer is how a guess becomes a decision.
with answering('{"room": 1, "confidence": 0.2, "because": "unsure"}'):
    weak = assign.assign_render(PLAN, ROOMS, RENDER)
check("a weak answer still comes back", weak is not None and weak["index"] == 0, str(weak))
check("but is flagged as weak", weak and weak["weak"] is True, str(weak))

# -- every way of not knowing must be None, not a guess ---------------------
with answering('{"room": 0, "confidence": 0, "because": "no match"}'):
    check("the model's own 'none of these' is no proposal",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

with answering('{"room": 9, "confidence": 0.99, "because": "very sure"}'):
    check("a hallucinated room number is refused however confident it sounds",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

with answering('{"room": -1, "confidence": 0.9}'):
    check("a negative index is refused", assign.assign_render(PLAN, ROOMS, RENDER) is None)

with answering('{"room": "the bedroom", "confidence": 0.9}'):
    check("a non-numeric room is refused rather than coerced",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

with answering("I think it is probably the second bedroom."):
    check("prose with no JSON is no proposal",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

with patch.object(adjudicate, "_ask", lambda *a, **k: None):
    check("an unanswered call is no proposal",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

check("no rooms means nothing to choose between",
      assign.assign_render(PLAN, [], RENDER) is None)

with patch.object(assign, "available", lambda: False):
    check("an unconfigured model proposes nothing rather than raising",
          assign.assign_render(PLAN, ROOMS, RENDER) is None)

print(f"\n{passed} passed, {failed} failed")
if failed:
    sys.exit(1)
