"""No-network contract tests for the vision provider seam.

The reader must accept the OpenAI-compatible response shape without ever
calling a live provider in CI.  This test deliberately uses a placeholder key
and a mocked urlopen.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager
from unittest.mock import patch

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ["FLOORPLAN_AI_PROVIDER"] = "openai"
os.environ["OPENAI_API_KEY"] = "test-placeholder"
os.environ["FLOORPLAN_AI_MAX_PROVIDER_CALLS"] = "1"
os.environ["FLOORPLAN_AI_MAX_OUTPUT_TOKENS"] = "25"

import adjudicate  # noqa: E402
import design  # noqa: E402


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


calls = []


def fake_urlopen(request, timeout):
    assert timeout == adjudicate._TIMEOUT_S
    body = json.loads(request.data.decode("utf-8"))
    assert body["max_tokens"] == 25
    calls.append(body)
    return FakeResponse({
        "usage": {"prompt_tokens": 40, "completion_tokens": 7, "total_tokens": 47},
        "choices": [{
            "message": {
                "content": [{"type": "output_text", "text": '{"verdict":"furniture"}'}],
            }
        }]
    })


image = np.zeros((32, 32, 3), dtype=np.uint8)
with patch.object(adjudicate.urllib.request, "urlopen", fake_urlopen):
    answer = adjudicate._ask(image, "Return JSON.", max_tokens=200)
    refused = adjudicate._ask(image, "This call must not start.")

assert adjudicate.PROVIDER == "openai"
assert adjudicate.available()
assert adjudicate.name().startswith("openai:")
assert adjudicate._json_object(answer) == {"verdict": "furniture"}
assert refused is None
assert len(calls) == 1
assert adjudicate.usage() == {
    "calls_started": 1,
    "max_calls": 1,
    "input_tokens": 40,
    "output_tokens": 7,
    "total_tokens": 47,
    "max_output_tokens_per_call": 25,
}
prompt = design._prompt(["#74777a"], "Bedroom")
assert "carpet is continuous soft pile" in prompt
assert "wood requires visible plank seams or grain" in prompt

print("vision provider contract: PASS")
