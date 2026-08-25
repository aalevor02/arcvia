"""Bounded live evaluation of one real plan and one deck render.

The script never accepts a key as an argument and never writes it anywhere.
Set OPENAI_API_KEY in the process environment, then provide the two source
paths. The default budget is three provider calls: one render DesignSpec, at
most one suspicious plan crop, and one whole-plan window pass.

The geometry itself remains the heuristic/CAD engine's responsibility.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, help="Path to one complete plan image")
    parser.add_argument("--deck", required=True, help="Path to its presentation PDF")
    parser.add_argument("--render-page", type=int, required=True)
    parser.add_argument("--render-index", type=int, default=0)
    parser.add_argument("--room", default=None, help="Optional trusted render caption")
    parser.add_argument("--max-calls", type=int, default=3, choices=range(1, 4))
    return parser.parse_args()


def main() -> int:
    args = arguments()
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit(
            "OPENAI_API_KEY is not set. Put it in this process environment; "
            "never pass it on the command line."
        )

    # Provider configuration is fixed when adjudicate is imported.
    os.environ["FLOORPLAN_AI_PROVIDER"] = "openai"
    os.environ["FLOORPLAN_AI_MAX_PROVIDER_CALLS"] = str(args.max_calls)
    os.environ["FLOORPLAN_AI_MAX_OUTPUT_TOKENS"] = "1200"
    os.environ["ADJUDICATE_MAX_CROPS"] = "1"

    import adjudicate
    import deck
    import design
    import main as service

    plan = cv2.imread(str(Path(args.plan)))
    if plan is None:
        raise SystemExit(f"Could not read plan image: {args.plan}")

    deck_raw = Path(args.deck).read_bytes()
    render_raw = deck.extract(
        deck_raw, page=args.render_page, index=args.render_index, long_edge=1600
    )
    render = cv2.imdecode(np.frombuffer(render_raw, np.uint8), cv2.IMREAD_COLOR)
    if render is None:
        raise SystemExit("Could not decode the selected deck render.")

    # The render is one call and proves the image/structured-output contract.
    spec = design.read_design(render, deck.palette(render), room_hint=args.room)

    walls, objects, rooms, scale = service.detect_heuristic(plan)
    before = {"walls": len(walls), "objects": len(objects), "rooms": len(rooms)}
    walls, objects, rooms, notes = adjudicate.adjudicate(
        plan, walls, objects, rooms, service.Detection
    )

    result = {
        "provider": adjudicate.name(),
        "budget": adjudicate.usage(),
        "render": spec,
        "plan": {
            "before": before,
            "after": {
                "walls": len(walls),
                "objects": len(objects),
                "rooms": len(rooms),
                "windows": sum(item.label == "window" for item in objects),
            },
            "scale": scale.model_dump() if scale else None,
            "notes": notes,
        },
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if spec is not None else 2


if __name__ == "__main__":
    raise SystemExit(main())
