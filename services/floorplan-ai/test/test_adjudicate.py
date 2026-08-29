"""No-network contract tests for the vision provider seam.

The reader must accept the OpenAI-compatible response shape without ever
calling a live provider in CI.  This test deliberately uses a placeholder key
and a mocked urlopen.
"""

from __future__ import annotations

import base64
import io
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
    assert body["max_completion_tokens"] == 25
    assert "max_tokens" not in body
    assert "temperature" not in body
    assert body["reasoning_effort"] == "none"
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
    # Answers, counted separately from starts. A retired model still accepts
    # the request shape, so a started call proves nothing about whether the
    # provider is reachable -- this is the gap main.py reads liveness from.
    "calls_answered": 1,
    "calls_failed": 0,
    "last_failure": None,
    "last_call_failed": False,
    "failure_run": 0,
    "worst_failure_run": 0,
    "max_calls": 1,
    "input_tokens": 40,
    "output_tokens": 7,
    "total_tokens": 47,
    "max_output_tokens_per_call": 25,
}

# --------------------------------------------------------------------------
# A dead provider must be VISIBLE, not merely survivable.
#
# On 2026-08-26 the pinned model was retired and began returning HTTP 410.
# adjudicate.py fails open by contract, so detection kept succeeding with the
# heuristic's proposals untouched and /health kept naming the model. The
# outage was real for a day and nothing said so. These assertions are that
# day, written down: a failure must be counted and must keep its reason.
# --------------------------------------------------------------------------

adjudicate.MAX_PROVIDER_CALLS = 0          # budget must not mask the failure
adjudicate._calls_started = 0
adjudicate._calls_answered = 0
adjudicate._calls_failed = 0
adjudicate._last_failure = None
adjudicate._last_call_failed = False


def gone_urlopen(request, timeout=None):
    raise adjudicate.urllib.error.HTTPError(
        adjudicate.ENDPOINT, 410, "Gone", {},
        io.BytesIO(json.dumps({
            "status": 410,
            "detail": "The model 'x' has reached its end of life on 2026-08-26T09:00:00Z",
        }).encode()),
    )


with patch.object(adjudicate.urllib.request, "urlopen", gone_urlopen):
    assert adjudicate._ask(image, "Return JSON.") is None

dead = adjudicate.usage()
assert dead["calls_started"] == 1, dead
assert dead["calls_answered"] == 0, dead
# The reason survives, and names the status. "unavailable" would have cost
# another round trip to diagnose; "HTTP 410" is actionable on sight.
assert "HTTP 410" in dead["last_failure"], dead
assert "end of life" in dead["last_failure"], dead
# The credential must never ride along in telemetry.
assert adjudicate.KEY not in dead["last_failure"]

assert dead["last_call_failed"] is True, dead

# A later success clears the STATE but not the REASON. Wiping the reason would
# destroy the diagnostic for an intermittent failure, which is the hardest kind
# to catch; keeping the state sticky would brand a recovered service degraded
# for the rest of the process's life. They are two different questions.
with patch.object(adjudicate.urllib.request, "urlopen", fake_urlopen):
    assert adjudicate._ask(image, "Return JSON.") is not None
recovered = adjudicate.usage()
assert recovered["last_call_failed"] is False, recovered
assert recovered["calls_answered"] == 1, recovered
assert recovered["calls_failed"] == 1, recovered
assert "HTTP 410" in recovered["last_failure"], recovered

# --------------------------------------------------------------------------
# An empty 200 is a failure, not an answer.
#
# The liveness check reads answered-vs-started. If a 200 carrying no content
# counted as answered, a model that had degraded to silence would report
# healthy while every crop note said "went unanswered" -- the same blind spot
# one level down. Counting must mean "produced usable content".
# --------------------------------------------------------------------------

for empty_body in ("", "   ", None):
    adjudicate._calls_started = 0
    adjudicate._calls_answered = 0
    adjudicate._calls_failed = 0
    adjudicate._last_failure = None
    adjudicate._last_call_failed = False

    def empty_urlopen(request, timeout=None, _body=empty_body):
        return FakeResponse({
            "usage": {"prompt_tokens": 5, "completion_tokens": 0, "total_tokens": 5},
            "choices": [{"message": {"content": _body}}],
        })

    with patch.object(adjudicate.urllib.request, "urlopen", empty_urlopen):
        assert adjudicate._ask(image, "Return JSON.") is None, repr(empty_body)

    empty = adjudicate.usage()
    assert empty["calls_started"] == 1, (empty_body, empty)
    assert empty["calls_answered"] == 0, (empty_body, empty)
    assert empty["calls_failed"] == 1, (empty_body, empty)
    assert "empty answer body" in empty["last_failure"], (empty_body, empty)

# --------------------------------------------------------------------------
# A full-page render must be encodable.
#
# _encode descended quality but never size. Crops are small and fit at quality
# 85 on the first try, so this looked healthy for the adjudicator while making
# the design reader impossible: a full deck page exceeded the cap at every
# quality, _encode returned None, and _ask gave up BEFORE _reserve_call() --
# so no call was counted and no failure recorded. /design answered "it may not
# be a render, or the vision model did not answer" about an image the model had
# never been shown.
# --------------------------------------------------------------------------

# A real deck page, and deliberately noisy: flat colour would compress far too
# well to reproduce the bug.
rng = np.random.default_rng(0)
big = rng.integers(0, 256, size=(2135, 2400, 3), dtype=np.uint8)

encoded_big = adjudicate._encode(big)
assert encoded_big, "a full-page render must encode"
# The cap is on the raw JPEG; base64 inflates it by 4/3.
assert len(encoded_big) <= adjudicate._MAX_IMAGE_BYTES * 4 / 3 + 4, len(encoded_big)

# Small inputs must be untouched by the new size ladder -- the adjudicator's
# crops still want full resolution at good quality.
small_crop = rng.integers(0, 256, size=(64, 64, 3), dtype=np.uint8)
ok, at_85 = cv2.imencode(".jpg", small_crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
assert ok and adjudicate._encode(small_crop) == base64.b64encode(
    at_85.tobytes()).decode("ascii"), "a crop must still encode at full size, quality 85"

print("full-page-render-encodes: PASS")
print("empty-200-is-not-an-answer: PASS")
print("dead-provider visibility: PASS")
prompt = design._prompt(["#74777a"], "Bedroom")
assert "carpet is continuous soft pile" in prompt
assert "wood requires visible plank seams or grain" in prompt

print("vision provider contract: PASS")

# ---- reasoning_effort is not universal, and a wrong value is a hard 400 ------
# Found live by codex-01a047: gpt-4.1-mini answers HTTP 400 "Unrecognized
# request argument: reasoning_effort" because this seam sent the field for
# every OpenAI model. The values differ between reasoning models too -- legacy
# gpt-5-mini takes minimal/low/medium/high but NOT none -- so the previous
# constant "none" was wrong for that model as well, and this was never only a
# 4.1 problem.

assert adjudicate.reasoning_effort_for("gpt-5.5") == "none"
assert adjudicate.reasoning_effort_for("gpt-5.5-2026-01-31") == "none", (
    "a dated snapshot is still gpt-5.5")
assert adjudicate.reasoning_effort_for("openai/gpt-5.5") == "none", (
    "a provider-qualified name is still the same model")

assert adjudicate.reasoning_effort_for("gpt-5-mini") == "minimal", (
    "gpt-5-mini rejects 'none', so it must not inherit the gpt-5.5 value")

assert adjudicate.reasoning_effort_for("gpt-4.1-mini") is None, (
    "a non-reasoning model must have the field OMITTED, not set")
assert adjudicate.reasoning_effort_for("gpt-4o") is None
assert adjudicate.reasoning_effort_for("nvidia/nemotron-nano-12b-v2-vl") is None
assert adjudicate.reasoning_effort_for("") is None, (
    "an unset model must degrade to omission rather than guess")

# THE ASSERTION THAT WOULD HAVE CAUGHT IT. The table above is a unit test of a
# lookup; this checks the field actually leaves the process, because the bug
# was in the request builder and not in any table.
_sent = {}


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, *a):
        return json.dumps(
            {"choices": [{"message": {"content": "{}"}}]}).encode()


def _capture(request, timeout=None):
    _sent["body"] = json.loads(request.data.decode("utf-8"))
    return _Reply()


_blank = np.full((64, 64, 3), 255, np.uint8)

for model, expected in (("gpt-4.1-mini", None), ("gpt-5.5", "none"), ("gpt-5-mini", "minimal")):
    _sent.clear()
    with patch.object(adjudicate, "MODEL", model), \
            patch.object(adjudicate.urllib.request, "urlopen", _capture):
        adjudicate._ask(_blank, "hello", max_tokens=25)
    body = _sent.get("body")
    assert body is not None, f"{model}: no request was sent"
    assert body["model"] == model
    if expected is None:
        assert "reasoning_effort" not in body, (
            f"{model} is non-reasoning: the field must be ABSENT, got "
            f"{body.get('reasoning_effort')!r} -- this is the live HTTP 400")
    else:
        assert body["reasoning_effort"] == expected, (
            f"{model}: expected {expected!r}, sent {body.get('reasoning_effort')!r}")

print("reasoning-effort model policy: PASS")
