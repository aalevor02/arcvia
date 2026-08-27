"""How much does one drawing through one service actually vary, and where?

Not a pass/fail test — a measuring instrument. It exists because every headline
number this service produced was quoted from a single POST, and a single sample
of a varying system is an anecdote wearing a measurement's clothes.

  python test/variance.py [--runs N] [--plan PATH]

Two things it reports that a plain mean would hide:

  IDENTICAL rows print no mean at all. A mean over N identical values invents
  an estimate out of a fact, and it invites a reader to treat it like a mean
  over N different ones. Those rows are also the MOST important to keep
  printing: walls, rooms and named rooms are the heuristic's own output, so a
  spread that has read 0 for a month is the only thing that will notice when
  the heuristic moves. A stable number is not a solved problem, it is an
  unattended alarm.

  DISCRETE rows print the distribution, not an average. "railing: mean 0.8" is
  a state the system is never in — it returns 0 or 1. A segment that reads
  railing in 2 runs of 5 and unstable in 2 others is bimodal, and averaging it
  describes nothing that ever happened.

And it localises. Spread tells you a number is unreliable; only knowing WHICH
segment varies tells you which conclusions it poisons. The FloorplanModel
session localised its baseline to a parapet by plausible inference, and the
verdicts turned out to land on three separate segments — none of them in the
region it had reasoned about.
"""
from __future__ import annotations

import argparse
import collections
import json
import mimetypes
import re
import sys
import urllib.request
import uuid

BASE = "http://127.0.0.1:8090"
DEFAULT_PLAN = r"A:\Tools\FloorplanModel\realdecks\49b4f5f96a40c7bddf27e09915de195e.png"

#: Everything the heuristic decides. These must not move between runs; if one
#: does, the detector itself changed and that is worth an alarm.
GEOMETRY = ("walls", "rooms", "named")

_AT = re.compile(r"near (\d+)%,(\d+)%")


def detect(path: str) -> dict:
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="plan.png"\r\nContent-Type: {ctype}\r\n\r\n').encode()
    with open(path, "rb") as fh:
        body += fh.read()
    body += f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        BASE + "/detect", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def measure(result: dict) -> dict:
    notes = result.get("notes") or []
    kinds = collections.Counter(w.get("kind", "wall") for w in result["walls"])
    return {
        "walls": len(result["walls"]),
        "rooms": len(result["rooms"]),
        "named": len([r for r in result["rooms"] if r.get("name")]),
        "railing": kinds.get("railing", 0) + kinds.get("boundary", 0),
        "objects": len(result["objects"]),
        "windows": len([o for o in result["objects"] if o.get("label") == "window"]),
        "corrections": len([n for n in notes if "adjudicator" in n]),
        "unstable": len([n for n in notes if "unstable" in n]),
    }


def where(result: dict) -> tuple[list[str], list[str], list[str]]:
    """Confirmed, rejected, and the segments actually carrying a non-wall kind."""
    confirmed, rejected = [], []
    for note in result.get("notes") or []:
        found = _AT.search(note)
        if not found:
            continue
        at = f"{found.group(1)}%,{found.group(2)}%"
        if "unstable" in note:
            rejected.append(at)
        elif "look like railing" in note or "look like boundary" in note:
            confirmed.append(at)
    marked = [
        f'{(w["start"]["x"] + w["end"]["x"]) / 2:.0%},'
        f'{(w["start"]["y"] + w["end"]["y"]) / 2:.0%}'
        for w in result["walls"] if w.get("kind", "wall") != "wall"
    ]
    return confirmed, rejected, marked


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--plan", default=DEFAULT_PLAN)
    args = parser.parse_args()

    rows: list[dict] = []
    confirmed = collections.Counter()
    rejected = collections.Counter()
    marked = collections.Counter()

    for i in range(args.runs):
        result = detect(args.plan)
        rows.append(measure(result))
        c, r, m = where(result)
        confirmed.update(c)
        rejected.update(r)
        marked.update(m)
        print(f"  run {i + 1}: " + "  ".join(f"{k}={v}" for k, v in rows[i].items()), flush=True)

    print(f"\n  {args.runs} runs, one file, one service\n")
    print(f"  {'metric':<13} {'observed':<26} verdict")
    for key in rows[0]:
        values = [r[key] for r in rows]
        counts = collections.Counter(values)
        if len(counts) == 1:
            shown = f"{values[0]} every run"
            verdict = "IDENTICAL" + ("  (heuristic — watch this)" if key in GEOMETRY else "")
        else:
            # The distribution, not an average: these are small integers and the
            # mean of a bimodal one is a value the system never returns.
            shown = "  ".join(f"{v}x{n}" for v, n in sorted(counts.items()))
            verdict = f"VARIES  {min(values)}-{max(values)}"
        print(f"  {key:<13} {shown:<26} {verdict}")

    print("\n  WHERE the verdicts land — intersect these against any region you score:")
    seen = set(confirmed) | set(rejected)
    if not seen:
        print("    none in this sample")
    for at in sorted(seen, key=lambda a: -(confirmed[a] + rejected[a])):
        note = ""
        if confirmed[at] and rejected[at]:
            note = "  BIMODAL — averaging this describes a state that never occurs"
        print(f"    {at:<10} confirmed {confirmed[at]}/{args.runs}"
              f"  rejected {rejected[at]}/{args.runs}{note}")
    print(f"\n  distinct candidate segments: {len(seen)}")
    print("  A region containing none of these is verdict-free and one sample stands.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
