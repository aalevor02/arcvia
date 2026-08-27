"""
A vision model adjudicates what the heuristic proposed.

â”€â”€ Why this exists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
On a rendered presentation plan the heuristic's geometry is precise and its
CLASSIFICATION is blind: a bed drawn as a crisp rectangle encloses a
room-sized area, so its outline ships as four walls; a potted plant becomes
masonry. Measured on a real client plan (2026-08-24, the owner marked five
failures â€” see A:/Tools/FloorplanModel/realdecks). Three heuristic prototypes
hit this same ceiling; nothing local to a stroke separates furniture from
wall. What CAN separate them is looking at the picture, which is exactly what
a vision-language model does.

The division of labour is the whole design: the heuristic keeps deciding
WHERE things are (it is pixel-exact; VLMs are not), the model only ever
decides WHAT a proposed thing is. Each suspect wall cluster is cropped with
its proposal drawn on top, and the model answers one closed question about
it. Coordinates never come from the model.

â”€â”€ Fail-open, always â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
No key, no network, a slow answer, an unparseable answer: every failure path
returns the input unchanged with a note. The adjudicator can only ever make
the result better or leave it alone â€” a detector that got WORSE when a third
party had a bad day would be a regression dressed as a feature.

â”€â”€ Cost and terms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Uses NVIDIA's hosted NIM endpoint (free developer tier: dev/test/eval only,
40 req/min). A plan costs at most ADJUDICATE_MAX_CROPS + 1 calls. For
production traffic the operator must supply a key whose terms allow it â€”
which is why the env var, not this file, decides whether any of this runs.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import urllib.error
import urllib.request

import cv2
import numpy as np

_PROVIDER = os.environ.get("FLOORPLAN_AI_PROVIDER", "auto").lower()

# The service speaks the OpenAI-compatible chat/completions shape.  NVIDIA
# remains the default when its key is present; setting OPENAI_API_KEY is enough
# to opt a deployment into OpenAI without putting a provider key in the browser.
if _PROVIDER == "openai" or (
    _PROVIDER == "auto"
    and os.environ.get("OPENAI_API_KEY")
    and not (os.environ.get("FLOORPLAN_ADJUDICATOR_KEY") or os.environ.get("NVIDIA_API_KEY"))
):
    PROVIDER = "openai"
    ENDPOINT = os.environ.get(
        "FLOORPLAN_ADJUDICATOR_URL", "https://api.openai.com/v1/chat/completions"
    )
    MODEL = os.environ.get("OPENAI_VISION_MODEL", "gpt-5.5")
    KEY = os.environ.get("OPENAI_API_KEY", "")
else:
    PROVIDER = "nvidia"
    ENDPOINT = os.environ.get(
        "FLOORPLAN_ADJUDICATOR_URL", "https://integrate.api.nvidia.com/v1/chat/completions"
    )
#: The nano VL model, not the 90B. Measured 2026-08-24: the 90B timed out on
#: 5 of 12 calls at 25 s on the free tier â€” an adjudicator that answers
#: SOMETIMES is worse than none, because the result depends on the weather.
#: The 12B answers in seconds and the questions here are closed-form
#: classification of a small crop, not reasoning.
    MODEL = os.environ.get("FLOORPLAN_ADJUDICATOR_MODEL", "nvidia/nemotron-nano-12b-v2-vl")
    KEY = os.environ.get("FLOORPLAN_ADJUDICATOR_KEY") or os.environ.get("NVIDIA_API_KEY", "")

#: At most this many cluster crops per plan â€” the free tier allows 40 req/min
#: and a plan should never be a minute of API calls. Suspects are ordered
#: smallest first (beds and plants are small; real wall networks are not), so
#: the cap drops the least suspicious, not the most.
MAX_CROPS = int(os.environ.get("ADJUDICATE_MAX_CROPS", "10"))

#: A cluster whose bounding-box diagonal exceeds this fraction of the image is
#: not a suspect. Structural, not tuned: the classes this pass exists to catch
#: â€” a bed, a plant pot, a wardrobe outline â€” are furniture-sized, and the
#: genuine wall network of any real plan spans most of the sheet. Measured on
#: the eval plan: both beds sit near 0.16, the plant under 0.08, the true
#: network above 0.8.
SUSPECT_MAX_DIAGONAL = 0.35

#: Confidence floor for acting on a verdict. Below it the proposal stands â€”
#: the heuristic was there first, and doubt goes to the incumbent.
MIN_CONFIDENCE = 0.6

_TIMEOUT_S = float(os.environ.get("ADJUDICATE_TIMEOUT_S", "25"))

# Optional process-wide guardrails for evaluation and low-spend deployments.
MAX_PROVIDER_CALLS = max(
    0, int(os.environ.get("FLOORPLAN_AI_MAX_PROVIDER_CALLS", "0"))
)
MAX_OUTPUT_TOKENS = max(
    1, int(os.environ.get("FLOORPLAN_AI_MAX_OUTPUT_TOKENS", "1200"))
)

_budget_lock = threading.Lock()
_calls_started = 0
#: Started calls that came back with an answer. The gap between this and
#: _calls_started is the whole point: a provider that has been retired still
#: accepts the request shape, so "we called it" proves nothing about whether
#: anyone is home. See adjudicator_liveness() in main.py.
_calls_answered = 0
#: Cumulative failures, and why the most recent one failed -- truncated and
#: free of the key. A dead adjudicator is only actionable if it says HTTP 410
#: rather than "unavailable", so the reason is STICKY: a later success does not
#: erase it. Wiping it on success loses the diagnostic for exactly the case
#: that is hardest to catch, an intermittent failure.
_calls_failed = 0
_last_failure: str | None = None
#: Did the most recent call fail? State is read from this rather than from the
#: cumulative count, because counters live as long as the process: one transient
#: timeout would otherwise brand a service "degraded" for its entire lifetime.
#: This answers "is it working NOW"; the counts above answer "at what rate".
_last_call_failed = False
_input_tokens = 0
_output_tokens = 0
_total_tokens = 0


def _reserve_call() -> bool:
    global _calls_started
    with _budget_lock:
        if MAX_PROVIDER_CALLS and _calls_started >= MAX_PROVIDER_CALLS:
            return False
        _calls_started += 1
        return True


def _record_answer() -> None:
    global _calls_answered, _last_call_failed
    with _budget_lock:
        _calls_answered += 1
        _last_call_failed = False


def _record_failure(reason: str) -> None:
    global _calls_failed, _last_failure, _last_call_failed
    with _budget_lock:
        _calls_failed += 1
        _last_failure = reason[:160]
        _last_call_failed = True


def _record_usage(payload: dict) -> None:
    global _input_tokens, _output_tokens, _total_tokens
    raw = payload.get("usage")
    if not isinstance(raw, dict):
        return
    prompt = int(raw.get("prompt_tokens", raw.get("input_tokens", 0)) or 0)
    completion = int(raw.get("completion_tokens", raw.get("output_tokens", 0)) or 0)
    total = int(raw.get("total_tokens", prompt + completion) or 0)
    with _budget_lock:
        _input_tokens += prompt
        _output_tokens += completion
        _total_tokens += total


def usage() -> dict:
    """Non-secret provider budget/usage telemetry for health checks and evals."""
    with _budget_lock:
        return {
            "calls_started": _calls_started,
            "calls_answered": _calls_answered,
            "calls_failed": _calls_failed,
            "last_failure": _last_failure,
            "last_call_failed": _last_call_failed,
            "max_calls": MAX_PROVIDER_CALLS or None,
            "input_tokens": _input_tokens,
            "output_tokens": _output_tokens,
            "total_tokens": _total_tokens,
            "max_output_tokens_per_call": MAX_OUTPUT_TOKENS,
        }

#: Data-URL images above ~180 KB are refused by the hosted endpoint, so crops
#: re-encode until they fit. The full-image window pass downsamples to this
#: long edge first for the same reason.
_MAX_IMAGE_BYTES = 170_000
_WINDOW_PASS_LONG_EDGE = 896


def available() -> bool:
    return bool(KEY)


def name() -> str | None:
    return f"{PROVIDER}:{MODEL}" if available() else None


# --------------------------------------------------------------------------
# The one network call
# --------------------------------------------------------------------------

def _encode(image: np.ndarray) -> str | None:
    """JPEG at descending quality, then descending size, until it fits the
    endpoint's data-URL cap.

    Quality alone is not enough and the gap was load-bearing. Crops are small
    and fit at 85 on the first try, so this read as working for the adjudicator
    while being unusable for the design reader, whose input is a full deck page:
    a 2400x2135 render exceeded the cap even at quality 40, `_encode` returned
    None, and `_ask` bailed BEFORE `_reserve_call()` -- so the attempt was never
    counted, no failure was recorded, and /design answered 422 "it may not be a
    render, or the vision model did not answer". Neither was true. The model was
    never asked.

    Shrinking beats crushing: for reading materials and colour a clean image at
    half size is worth more than a blocky one at full size, so size is reduced
    at good quality rather than quality being driven into the floor."""
    for scale in (1.0, 0.75, 0.5, 0.375, 0.25):
        candidate = image
        if scale < 1.0:
            candidate = cv2.resize(
                image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
            )
        for quality in (85, 70, 55, 40):
            ok, buf = cv2.imencode(".jpg", candidate, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok and buf.size <= _MAX_IMAGE_BYTES:
                return base64.b64encode(buf.tobytes()).decode("ascii")
    # Reaching here means even a quarter-size, quality-40 encode does not fit,
    # which should not happen for any real render. Say so rather than returning
    # a bare None that the caller will misattribute to the model.
    print(
        f"[adjudicate] could not encode a {image.shape[1]}x{image.shape[0]} image "
        f"under {_MAX_IMAGE_BYTES} bytes - the model was NOT asked",
        flush=True,
    )
    return None


def _ask(image: np.ndarray, prompt: str, max_tokens: int = 300) -> str | None:
    """One image, one question, the raw text answer â€” or None on any failure."""
    encoded = _encode(image)
    if not encoded:
        return None
    if not _reserve_call():
        print("[adjudicate] provider call budget exhausted", flush=True)
        return None
    max_tokens = min(max(1, max_tokens), MAX_OUTPUT_TOKENS)
    request_body = {
        "model": MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}},
            ],
        }],
        # 300 fits a verdict; a caller wanting a whole DesignSpec passes more â€”
        # the first truncated spec parsed as "no answer" and read as a refusal.
    }
    # GPT-5 family Chat Completions renamed this limit. NVIDIA's compatible
    # endpoint still expects the older key, so choose it at the provider seam.
    if PROVIDER == "openai":
        request_body["max_completion_tokens"] = max_tokens
        request_body["reasoning_effort"] = "none"
    else:
        request_body["max_tokens"] = max_tokens
        request_body["temperature"] = 0.0
    body = json.dumps(request_body).encode("utf-8")

    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            payload = json.loads(response.read().decode("utf-8"))
        _record_usage(payload)
        answer = payload["choices"][0]["message"]["content"]
        # OpenAI can return content as typed text parts; the compatible NVIDIA
        # endpoint returns a plain string. Normalize both to the reader's
        # existing parser contract.
        if isinstance(answer, list):
            answer = "".join(
                part.get("text", "") for part in answer if isinstance(part, dict)
            )
        # A 200 carrying an empty body is not an answer. Counting it as one
        # would rebuild the exact blind spot this counter exists to close:
        # liveness would read healthy while every crop note said "went
        # unanswered". This also covers content being null outright, which
        # would otherwise raise TypeError on the slice below and escape the
        # except clauses -- they list ValueError and KeyError, not TypeError.
        if not answer or not str(answer).strip():
            print("[adjudicate] empty answer body", flush=True)
            _record_failure(f"HTTP 200 with an empty answer body from {MODEL}")
            return None
        print(f"[adjudicate] answered: {answer[:160]!r}", flush=True)
        _record_answer()
        return answer
    except urllib.error.HTTPError as error:
        # A 429 from the free tier and a 400 from an oversized payload need
        # DIFFERENT fixes, and both were invisible inside the catch-all.
        detail = ""
        try:
            detail = error.read().decode("utf-8", "replace")[:200]
        except OSError:
            pass
        print(f"[adjudicate] HTTP {error.code}: {detail}", flush=True)
        _record_failure(f"HTTP {error.code}: {detail}")
        return None
    except (urllib.error.URLError, OSError, KeyError, IndexError, ValueError, TimeoutError) as error:
        print(f"[adjudicate] failed: {type(error).__name__}: {error}", flush=True)
        _record_failure(f"{type(error).__name__}: {error}")
        return None


def _json_object(text: str) -> dict | None:
    """The first JSON object in a model answer, which may wrap it in prose."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _verdict_of(text: str) -> dict | None:
    """
    A verdict from an answer that may or may not have obeyed the format.

    Even at temperature 0 the model sometimes narrates instead â€” observed:
    "the bright orange lines are tracing the outline of a bed", no JSON
    anywhere, and the bed survived because the parse failed. When the words
    plainly assert a classification, use it at reduced confidence; a plain
    negation nearby ("not a bed") disqualifies that word.
    """
    parsed = _json_object(text)
    if parsed:
        return parsed
    lowered = text.lower()
    for word in ("bed", "sofa", "wardrobe", "plant", "railing", "boundary",
                 "furniture", "fixture", "wall", "room"):
        if word in lowered and not re.search(
            rf"(?:not|isn't|is not|no)\s+(?:a\s+|an\s+)?{word}", lowered
        ):
            return {"verdict": word, "confidence": 0.7, "prose": True}
    return None


# --------------------------------------------------------------------------
# Suspects: small connected clusters of proposed walls
# --------------------------------------------------------------------------

def _clusters(walls) -> list[list[int]]:
    """Group wall indices whose endpoints touch, union-find over proximity."""
    n = len(walls)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    points = [
        ((w.start.x, w.start.y), (w.end.x, w.end.y)) for w in walls
    ]
    for i in range(n):
        for j in range(i + 1, n):
            close = any(
                abs(a[0] - b[0]) < 0.015 and abs(a[1] - b[1]) < 0.015
                for a in points[i] for b in points[j]
            )
            if close:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def _bbox(walls, members) -> tuple[float, float, float, float]:
    xs = [c for i in members for c in (walls[i].start.x, walls[i].end.x)]
    ys = [c for i in members for c in (walls[i].start.y, walls[i].end.y)]
    return min(xs), min(ys), max(xs), max(ys)


_CROP_PROMPT = (
    "This is a crop of an architectural floor plan. The bright orange lines "
    "are WALL segments proposed by an automatic reader. Look at what the "
    "underlying drawing actually shows beneath and around the orange lines, "
    "and classify the object they trace. Answer ONLY a JSON object: "
    '{"verdict": one of "wall", "bed", "furniture", "plant", "railing", '
    '"boundary", "other", "confidence": 0..1}. '
    "A bed, sofa, wardrobe or other furniture drawn on the plan is furniture "
    "even if its outline is crisp. A balcony railing or parapet is railing. "
    "A site or plot boundary is boundary. Only real building walls are wall."
)

_ROOM_PROMPT = (
    "This is a crop of an architectural floor plan. The orange outline traces "
    "a small enclosed shape that an automatic reader classified as a ROOM "
    "with walls. Look at what is drawn INSIDE and AS the orange outline. Is "
    "it actually a room, or is it a piece of furniture drawn on the plan â€” a "
    "bed, sofa, wardrobe, table â€” whose outline merely closed? Answer ONLY a "
    'JSON object: {"verdict": one of "room", "bed", "sofa", "wardrobe", '
    '"furniture", "fixture", "other", "confidence": 0..1}. '
    "A mattress with pillows is a bed. Only a genuine walled space is room."
)

#: Verdicts that remove the proposal. "railing" and "boundary" are NOT
#: removed in v1 â€” a balcony edge legitimately carries a parapet wall and a
#: removal there needs the parapet-height build the engine does not yet have.
#: They are reported in the notes instead, so the reviewer's eye goes there.
_DROP = {"bed", "sofa", "wardrobe", "furniture", "fixture", "plant"}


def _suspects(walls, rooms) -> list[dict]:
    """
    What deserves a second look, from TWO structural sources.

    Isolated small clusters catch a free-standing plant or fitting. They MISS
    the worst offender: a bed whose headboard touches the room wall joins the
    main network and never looks small. But that bed already betrayed itself
    another way â€” it closed, so it is sitting in `rooms` as a small UNNAMED
    room. Measured on the eval plan: both beds are exactly that. So small
    unnamed rooms are suspects too, cropped by their own outline.
    """
    found: list[dict] = []

    for members in _clusters(walls):
        x0, y0, x1, y1 = _bbox(walls, members)
        diagonal = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if diagonal <= SUSPECT_MAX_DIAGONAL:
            found.append({
                "kind": "cluster", "size": diagonal,
                "members": members, "box": (x0, y0, x1, y1),
            })

    for index, room in enumerate(rooms):
        if room.name or room.kind != "room":
            continue  # a NAMED small room is a real room â€” SHOWER, WC
        xs = [p.x for p in room.polygon]
        ys = [p.y for p in room.polygon]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        diagonal = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if diagonal <= SUSPECT_MAX_DIAGONAL and room.area <= 0.08:
            found.append({
                "kind": "room", "size": diagonal,
                "room_index": index, "box": (x0, y0, x1, y1),
                "polygon": room.polygon,
            })

    # Room-suspects first, whatever their size. An enclosure that CLOSED is
    # the strongest furniture signal there is (a bed reads as a small unnamed
    # room), and on the eval plan the cap dropped exactly those two while
    # spending its budget on stray one-wall clusters. Within a class, small
    # before large.
    found.sort(key=lambda s: (0 if s["kind"] == "room" else 1, s["size"]))
    return found[:MAX_CROPS]


def _crop_for(image, walls, suspect):
    height, width = image.shape[:2]
    x0, y0, x1, y1 = suspect["box"]
    margin = 0.06
    px0 = max(0, int((x0 - margin) * width))
    py0 = max(0, int((y0 - margin) * height))
    px1 = min(width, int((x1 + margin) * width))
    py1 = min(height, int((y1 + margin) * height))
    if px1 - px0 < 24 or py1 - py0 < 24:
        return None
    crop = image[py0:py1, px0:px1].copy()

    if suspect["kind"] == "cluster":
        for i in suspect["members"]:
            a = (int(walls[i].start.x * width) - px0, int(walls[i].start.y * height) - py0)
            b = (int(walls[i].end.x * width) - px0, int(walls[i].end.y * height) - py0)
            cv2.line(crop, a, b, (0, 128, 255), 3)
    else:
        # The room's own POLYGON, not its bounding box. A rectangle around
        # the area contains the bed AND the genuine walls beside it, and the
        # model â€” reasonably â€” answered about the walls: measured, both bed
        # enclosures came back "wall, confidence 1". The polygon traces
        # exactly the strokes in question and nothing else.
        points = np.array(
            [[int(p.x * width) - px0, int(p.y * height) - py0]
             for p in suspect["polygon"]],
            dtype=np.int32,
        )
        cv2.polylines(crop, [points], True, (0, 128, 255), 3)
    return crop


def _adjudicate_clusters(image, walls, rooms, notes) -> tuple[list, list]:
    keep = [True] * len(walls)
    drop_rooms: set[int] = set()
    dropped_boxes: list[tuple] = []

    suspects = _suspects(walls, rooms)
    crops = [(s, _crop_for(image, walls, s)) for s in suspects]
    crops = [(s, c) for s, c in crops if c is not None]

    # The calls are independent questions about different crops; asking them
    # in parallel is what keeps a ten-suspect plan interactive. Four at a time
    # stays comfortably under the endpoint's 40 req/min.
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=4) as pool:
        answers = list(pool.map(
            lambda sc: _ask(
                sc[1],
                _ROOM_PROMPT if sc[0]["kind"] == "room" else _CROP_PROMPT,
            ),
            crops,
        ))

    for (suspect, _), answer in zip(crops, answers):
        verdict = _verdict_of(answer) if answer else None
        if not verdict:
            notes.append("adjudicator: a crop went unanswered; its proposal stands")
            continue

        kind = str(verdict.get("verdict", "")).lower()
        confidence = float(verdict.get("confidence", 0) or 0)
        if kind in _DROP and confidence >= MIN_CONFIDENCE:
            x0, y0, x1, y1 = suspect["box"]
            if suspect["kind"] == "cluster":
                for i in suspect["members"]:
                    keep[i] = False
                dropped_boxes.append(suspect["box"])
                notes.append(
                    f"adjudicator: dropped {len(suspect['members'])} proposed "
                    f"wall(s) â€” {kind} ({confidence:.0%})"
                )
            else:
                # The room IS the furniture's enclosure. It goes, along with
                # every wall living strictly inside its outline â€” the bed's
                # own edges â€” while the room's boundary walls, which sit ON
                # the outline, stay. The pad is what separates "inside" from
                # "on": tight, because the wall a headboard touches must
                # survive.
                drop_rooms.add(suspect["room_index"])
                pad = 0.008
                dropped = 0
                for i, wall in enumerate(walls):
                    if not keep[i]:
                        continue
                    inside = all(
                        x0 + pad < p[0] < x1 - pad and y0 + pad < p[1] < y1 - pad
                        for p in (
                            (wall.start.x, wall.start.y),
                            (wall.end.x, wall.end.y),
                        )
                    )
                    if inside:
                        keep[i] = False
                        dropped += 1
                notes.append(
                    f"adjudicator: an unnamed {room_label(rooms[suspect['room_index']])} "
                    f"enclosure is {kind} ({confidence:.0%}) â€” removed it "
                    f"and {dropped} inner wall(s)"
                )
        elif kind in ("railing", "boundary") and confidence >= MIN_CONFIDENCE:
            # Mark the walls themselves, not just the transcript.
            #
            # This verdict is deliberately non-destructive (see _DROP): a
            # balcony edge really does carry a parapet, so deleting it would
            # open the balcony to the drop. But leaving it an ordinary wall
            # builds it full height, which is how a client ends up on a
            # balcony boxed in by masonry. Recording the KIND lets the
            # builder raise it to parapet height instead of choosing between
            # a wrong wall and no wall at all.
            #
            # Only cluster suspects name their members. A room-shaped
            # railing verdict is left as a note rather than guessing which
            # of its boundary walls the model meant.
            for index in suspect.get("members", []):
                if 0 <= index < len(walls):
                    walls[index].kind = kind
            marked = len([i for i in suspect.get("members", []) if 0 <= i < len(walls)])
            x0, y0, x1, y1 = suspect["box"]
            notes.append(
                f"adjudicator: {marked or 1} proposed structure(s) look like "
                f"{kind} ({confidence:.0%}) near {((x0 + x1) / 2):.0%},"
                f"{((y0 + y1) / 2):.0%} of the drawing \u2014 kept, and marked "
                f"{kind} so they are not built as full-height wall"
            )

    kept_walls = [w for w, k in zip(walls, keep) if k]

    def survives(index, room) -> bool:
        if index in drop_rooms:
            return False
        xs = [p.x for p in room.polygon]
        ys = [p.y for p in room.polygon]
        for x0, y0, x1, y1 in dropped_boxes:
            pad = 0.01
            if (min(xs) >= x0 - pad and max(xs) <= x1 + pad
                    and min(ys) >= y0 - pad and max(ys) <= y1 + pad):
                return False
        return True

    return kept_walls, [r for i, r in enumerate(rooms) if survives(i, r)]


def room_label(room) -> str:
    size = room.size
    if size and len(size) == 2:
        return f"{size[0]:.1f}x{size[1]:.1f} m"
    return "small"


# --------------------------------------------------------------------------
# Windows: found semantically, snapped to the nearest proposed wall
# --------------------------------------------------------------------------

_WINDOW_PROMPT = (
    "This is an architectural floor plan. List every WINDOW you can see "
    "drawn on the walls (thin double or triple lines across a wall opening, "
    "usually on the outer walls). Answer ONLY a JSON object: "
    '{"windows": [{"x": 0..1, "y": 0..1}]} where x,y is each window\'s '
    "centre as a fraction of image width and height. An empty list is a "
    "valid answer. Do not include doors."
)


def _find_windows(image, walls, detection_cls, notes) -> list:
    # Two sizes, because the first run's full-image pass silently failed:
    # a 1024-edge plan JPEG can still overrun the endpoint's payload comfort
    # zone once base64 inflates it. Smaller is answered more reliably, and a
    # window is still legible at 640.
    parsed = None
    for edge in (_WINDOW_PASS_LONG_EDGE, 640):
        scale = edge / max(image.shape[:2])
        small = cv2.resize(image, None, fx=scale, fy=scale) if scale < 1 else image
        answer = _ask(small, _WINDOW_PROMPT)
        parsed = _json_object(answer) if answer else None
        if parsed and isinstance(parsed.get("windows"), list):
            break
    if not parsed or not isinstance(parsed.get("windows"), list):
        notes.append("adjudicator: the window pass went unanswered")
        return []

    found = []
    for entry in parsed["windows"][:24]:
        try:
            x, y = float(entry["x"]), float(entry["y"])
        except (TypeError, KeyError, ValueError):
            continue
        if not (0 <= x <= 1 and 0 <= y <= 1):
            continue
        # The model's positions are approximate by nature; a window that is
        # not near any proposed wall is more likely a hallucination than a
        # discovery, so it is refused. 4% of the image width is generous for
        # "on a wall" and tight enough to reject the middle of a room.
        near = min(
            (_point_to_segment(x, y, w) for w in walls),
            default=1.0,
        )
        if near > 0.04:
            continue
        found.append(detection_cls(
            label="window",
            bbox=[max(0.0, x - 0.02), max(0.0, y - 0.02), 0.04, 0.04],
            confidence=0.5,
            attaches_to="wall",
        ))
    if found:
        notes.append(f"adjudicator: {len(found)} window(s) read off the drawing")
    return found


def _point_to_segment(x: float, y: float, wall) -> float:
    ax, ay = wall.start.x, wall.start.y
    bx, by = wall.end.x, wall.end.y
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 <= 0:
        return ((x - ax) ** 2 + (y - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length2))
    px, py = ax + t * dx, ay + t * dy
    return ((x - px) ** 2 + (y - py) ** 2) ** 0.5


# --------------------------------------------------------------------------
# Entry
# --------------------------------------------------------------------------

def adjudicate(image, walls, objects, rooms, detection_cls):
    """
    Second-guess the proposals against the picture. Returns
    (walls, objects, rooms, notes) â€” unchanged plus a note on any failure.
    """
    notes: list[str] = []
    if not available():
        return walls, objects, rooms, notes

    try:
        walls, rooms = _adjudicate_clusters(image, walls, rooms, notes)
        objects = list(objects) + _find_windows(image, walls, detection_cls, notes)
    except Exception as exc:  # noqa: BLE001 â€” fail-open is the contract
        notes.append(f"adjudicator: skipped ({type(exc).__name__})")
    return walls, objects, rooms, notes
