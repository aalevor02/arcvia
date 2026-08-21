"""
The weekly rate refresh, as something a scheduler can run unattended.

── Why this is a separate entry point and not a flag on the CLI ───────────────
`cli.py rates --refresh` already exists and is the right thing for a person at a
keyboard: it prints, it asks before writing, and a human reads the result. None
of that survives contact with a scheduler. An unattended run has nobody to read
its output, nobody to decide whether a partial result is acceptable, and nobody
to notice that it silently did nothing for six weeks.

So this makes the decisions a human would otherwise make, in writing, in advance:

  IT WRITES ONLY WHAT WAS CONFIRMED.       `refresh` already refuses to stamp a
                                           date a page did not give. This adds
                                           the second half: if nothing at all was
                                           confirmed, the library is not rewritten
                                           AT ALL, so a run that reaches no source
                                           cannot quietly re-date the old numbers.
  IT BACKS UP BEFORE IT WRITES.            The single worst outcome available to a
                                           scheduled job is corrupting the priced
                                           library at 3 a.m. with nobody watching.
  IT LEAVES A TRACE EVERY TIME.            Including when nothing changed, because
                                           "nothing changed" and "did not run" look
                                           identical six weeks later and only one
                                           of them is fine.
  IT FAILS LOUDLY, NOT SILENTLY.           Exit 1 when no source could be reached.
                                           A scheduler can act on an exit code; it
                                           cannot act on a sad message.

── The thing that makes this feature look broken when it is working ───────────
Measured on 2026-08-22: all 235 rates carry 2026-08-12, and every source page
also reports 2026-08-12. The library is 10 days old because THE SOURCE HAS NOT
PUBLISHED NEW PRICES, not because a refresh failed.

A refresher that "helpfully" stamped today's date on an unchanged number would
make the library look fresh and be a lie — and it is the kind of lie that only
shows up in a client quotation. So the expected steady state of this job is
`updated 0, unreachable 0, untrusted 0`, and the report says CHECKED rather than
REFRESHED. Anyone reading the log needs to be able to tell "we looked and nothing
moved" from "we did not look".
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import date, datetime
from pathlib import Path

from .rates import RateLibrary
from .refresh import refresh, write_csv

#: Where a run leaves its evidence. One file per run, never overwritten, because
#: the history is the only way to answer "when did this price actually move?".
REPORT_DIR = "reports/rates"

#: Keep this many library backups. Enough to walk back from a bad refresh;
#: bounded so an unattended weekly job cannot fill a disk over years.
KEEP_BACKUPS = 12


def _stamp(when: datetime) -> str:
    return when.strftime("%Y%m%d-%H%M%S")


def _prune(directory: Path, pattern: str, keep: int) -> None:
    backups = sorted(directory.glob(pattern))
    for old in backups[:-keep] if len(backups) > keep else []:
        try:
            old.unlink()
        except OSError:
            # A backup that cannot be deleted is not worth failing a refresh
            # over. The refresh is the job; pruning is housekeeping.
            pass


def run(rates_path: str, out_dir: str | None = None, older_than: int = 7,
        dry_run: bool = False, now: datetime | None = None) -> dict:
    """
    One refresh pass. Returns the report as a dict; writes unless `dry_run`.

    `older_than` defaults to 7 so a weekly schedule re-fetches only pages that
    have had a week to move. A rate refreshed yesterday costs nothing today.
    """
    now = now or datetime.now()
    path = Path(rates_path)
    library = RateLibrary.load(path)

    before = library.freshness(now.date())
    report = refresh(library, today=now.date(), only_older_than=older_than)
    result = report.as_dict()

    result["library"] = str(path)
    result["before"] = before
    result["ratesConsidered"] = before["refreshable"]
    result["dryRun"] = dry_run

    # CONFIRMED IS NOT MOVED, AND `updated` COUNTS BOTH.
    #
    # ── The first live run, and why this branch exists ──────────────────────
    # Against the real library on 2026-08-22: `updated 37, unreachable 0,
    # untrusted 162`. Every one of the 37 carried `"move": 0.0` — from 383.0 to
    # 383.0, from 1250.0 to 1250.0. Not one price had changed. `refresh` counts
    # a rate as updated when it CONFIRMS it against a page, which is the right
    # thing for that module to mean and the wrong thing to write a file on.
    #
    # Taken at face value the job would have rewritten the library, taken a
    # backup and bumped its mtime every week, for nothing — and the log would
    # have read "37 rates updated" while no number in the building had moved.
    # A weekly report that says 37 changed when 0 changed trains its reader to
    # stop looking, which is worse than no report.
    moved = [e for e in report.updated if abs(float(e.get("move") or 0.0)) > 1e-9]
    result["moved"] = len(moved)
    result["confirmed"] = result["updated"] - len(moved)
    result["detail"]["moved"] = moved[:50]

    reached = result["updated"] + result["untrusted"]
    nothing_reached = reached == 0 and result["unreachable"] > 0

    # THE GUARD THAT MATTERS. A pass where every source was unreachable must not
    # touch the library. Rewriting it would preserve the same numbers with the
    # same dates -- harmless in itself -- but it also rewrites the file's mtime,
    # which is the one signal outside the CSV that says when this was last
    # genuinely confirmed. Leaving the file alone keeps that true.
    result["written"] = False
    result["backup"] = None

    if dry_run:
        result["outcome"] = "dry run — nothing written"
    elif nothing_reached:
        result["outcome"] = (
            f"no source could be reached ({result['unreachable']} failed); "
            "the library keeps its old values AND its old dates, so the "
            "staleness surfaces at quotation time"
        )
    elif not moved:
        # The expected steady state. See the module docstring: an unchanged
        # source is not a failed refresh, and saying so is the whole point.
        result["outcome"] = (
            f"confirmed {result['confirmed']} rates against their sources and "
            f"none had moved; {result['untrusted']} could not be matched. "
            "Nothing written, so the library keeps the mtime of the last run "
            "that genuinely changed something"
        )
    else:
        backup = path.with_name(f"{path.stem}.{_stamp(now)}{path.suffix}.bak")
        shutil.copy2(path, backup)
        _prune(path.parent, f"{path.stem}.*{path.suffix}.bak", KEEP_BACKUPS)
        write_csv(library, str(path))
        result["written"] = True
        result["backup"] = str(backup)
        biggest = max(moved, key=lambda e: abs(float(e.get("move") or 0.0)))
        result["outcome"] = (
            f"{len(moved)} rates moved (largest: {biggest.get('material')} "
            f"{biggest.get('from')} -> {biggest.get('to')})"
        )

    result["after"] = RateLibrary.load(path).freshness(now.date())

    directory = Path(out_dir or (path.parent.parent.parent / REPORT_DIR))
    directory.mkdir(parents=True, exist_ok=True)
    report_path = directory / f"refresh-{_stamp(now)}.json"
    report_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["report"] = str(report_path)

    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m quantify.weekly",
        description="Refresh the rate library from its sources. Safe to schedule.",
    )
    parser.add_argument("--rates", default="data/rates/hyderabad-2026.csv",
                        help="the library CSV to refresh in place")
    parser.add_argument("--out", default=None,
                        help=f"where to write run reports (default {REPORT_DIR})")
    parser.add_argument("--older-than", type=int, default=7,
                        help="only re-fetch rates older than this many days")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and report, but never write")
    args = parser.parse_args(argv)

    try:
        result = run(args.rates, out_dir=args.out,
                     older_than=args.older_than, dry_run=args.dry_run)
    except FileNotFoundError as error:
        print(f"RATE REFRESH FAILED: {error}", file=sys.stderr)
        return 2

    print(f"[{result['checkedAt']}] {result['outcome']}")
    print(f"  considered {result['ratesConsidered']} refreshable rates")
    # `moved` first and `confirmed` beside it, because the number a reader cares
    # about is how many prices changed, and `updated` conflates the two.
    print(f"  moved {result['moved']}  "
          f"confirmed unchanged {result['confirmed']}  "
          f"unreachable {result['unreachable']}  "
          f"untrusted {result['untrusted']}")
    matched = result["updated"]
    considered = result["ratesConsidered"] or 1
    if matched < considered:
        print(f"  COVERAGE {matched}/{considered} ({100 * matched // considered}%) "
              "of refreshable rates could be matched to a row on their source "
              "page. The rest keep their old value and old date.")
    print(f"  oldest rate now {result['after']['oldestDays']} days")
    if result["backup"]:
        print(f"  backup {result['backup']}")
    print(f"  report {result['report']}")

    for entry in result["detail"]["unreachable"][:5]:
        print(f"    UNREACHABLE {entry.get('id')}: {entry.get('reason', '')[:80]}")
    for entry in result["detail"]["untrusted"][:5]:
        print(f"    UNTRUSTED   {entry.get('id')}: {entry.get('reason', '')[:80]}")

    # Exit non-zero ONLY when nothing could be reached. "Nothing had changed" is
    # a success: it is the honest result of looking at an unchanged page, and a
    # scheduler that treated it as failure would cry wolf every week.
    reached = result["updated"] + result["untrusted"]
    return 1 if (reached == 0 and result["unreachable"] > 0) else 0


if __name__ == "__main__":
    sys.exit(main())
