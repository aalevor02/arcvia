"""
DWG intake — the LibreDWG gate.

── Why this is a gate and not a call ─────────────────────────────────────────
Most architects send DWG, so refusing it pushes a manual export step onto every
client. But the converter has a failure mode worse than an error:

LibreDWG **0.13.3 silently drops model space**. It parses an AC1021 file well
enough to emit the tables and the block *definitions* — around 2,993 plausible
entities — and writes a DXF that opens cleanly in any reader. There is no error,
no warning, and no failing exit code. The drawing is simply not in it. The same
file through 0.14 yields 26,194 model-space entities.

A version check alone is not enough, because the count is the thing that
actually matters and it is cheap to measure. So this asserts three times: the
converter version, that *model space specifically* is populated (not tables, not
blocks — those are exactly what 0.13.3 leaves behind), and that what came out
carries enough linework to be a building.

── Why it converts twice ─────────────────────────────────────────────────────
Recorded on this project: the same DWG converted twice produced two different
DXFs — one with an empty model space because recovery discarded the blocks, and
one with 9,856 lines. The conversion is not deterministic under recovery. Two
passes and keep the larger costs seconds against a job measured in minutes, and
both counts go on the receipt so the disagreement stays visible rather than
being averaged away.

Never falls back. A conversion that cannot be trusted must stop the import,
because every downstream stage will happily reconstruct an empty building and
report success.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import ezdxf
from ezdxf import recover

#: The first version that reliably carries model space. Below this we refuse
#: outright rather than warn — see the module docstring.
MINIMUM_VERSION = (0, 14)

#: Where the converter lives on this machine. Overridable, because a Linux
#: deploy builds LibreDWG from source and will not put it here.
DEFAULT_CONVERTER = Path("A:/Tools/LibreDWG/dwg2dxf.exe")

#: Below this, it is not a building drawing. The 0.13.3 residue lands around
#: 3,000 entities and all of it is block definitions, so the model-space check
#: catches that case first; this is the backstop for a genuinely empty file.
MIN_MODELSPACE_ENTITIES = 50


class ConversionRefused(RuntimeError):
    """The DWG could not be turned into something worth trusting."""


@dataclass
class Receipt:
    """Matches `SourceRef.converter` in the building-model schema."""

    tool: str = "libredwg"
    version: str = ""
    model_space_entities: int = 0
    args: list[str] = field(default_factory=list)
    passes: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "tool": self.tool,
            "version": self.version,
            "modelSpaceEntities": self.model_space_entities,
            "args": self.args,
            "passes": self.passes,
            "warnings": self.warnings,
        }


def converter_version(converter: Path = DEFAULT_CONVERTER) -> tuple[str, tuple[int, ...]]:
    """The converter's own version string, and that string parsed for comparison."""
    if not converter.exists():
        raise ConversionRefused(
            f"No DWG converter at {converter}. Install LibreDWG >= "
            f"{'.'.join(map(str, MINIMUM_VERSION))}, or send DXF instead."
        )

    out = subprocess.run(
        [str(converter), "--version"], capture_output=True, text=True, timeout=30
    ).stdout

    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", out)
    if not match:
        raise ConversionRefused(f"Could not read a version from: {out.strip()!r}")

    parts = tuple(int(g) for g in match.groups() if g is not None)
    return out.strip().splitlines()[0], parts


def _count_model_space(dxf_path: Path) -> int:
    """
    Entities in MODEL SPACE specifically.

    The distinction is the entire point. `recover.readfile` succeeds on a 0.13.3
    output and `doc.blocks` comes back full; only model space is empty. Counting
    anything more general reports a healthy number for a drawing that has none.
    """
    try:
        doc, _auditor = recover.readfile(str(dxf_path))
    except (ezdxf.DXFStructureError, OSError, ValueError):
        return 0
    return sum(1 for _ in doc.modelspace())


def _run_once(converter: Path, dwg: Path, out: Path) -> tuple[int, list[str]]:
    args = [str(converter), "-y", "-o", str(out), str(dwg)]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=900)

    # A non-zero exit is informative but decisive in neither direction:
    # LibreDWG returns non-zero for recoverable problems and still writes a
    # usable file, and returns zero for the empty-model-space case. The count
    # is what decides.
    if not out.exists():
        raise ConversionRefused(
            f"The converter wrote no file. exit={proc.returncode} "
            f"stderr={proc.stderr.strip()[:400]!r}"
        )
    return _count_model_space(out), args


def to_dxf(
    dwg_path: str | Path,
    out_dir: str | Path,
    converter: Path = DEFAULT_CONVERTER,
) -> tuple[Path, Receipt]:
    """
    Convert a DWG, and refuse anything we cannot trust.

    Returns the DXF path and a receipt recording how it got there. The receipt
    travels on `SourceRef.converter`, so a reconstruction can always be traced
    back to the exact converter behaviour that produced its geometry.
    """
    dwg_path = Path(dwg_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not dwg_path.exists():
        raise ConversionRefused(f"No such DWG: {dwg_path}")

    version_string, version = converter_version(converter)
    if version[:2] < MINIMUM_VERSION:
        raise ConversionRefused(
            f"{version_string} silently drops model space on some AC1021 files. "
            f"Upgrade to >= {'.'.join(map(str, MINIMUM_VERSION))}."
        )

    receipt = Receipt(version=version_string.split()[-1])
    best: Path | None = None
    best_count = -1

    # Two passes — see the module docstring. The conversion is not deterministic
    # under recovery, and it fails in exactly the direction that produces an
    # empty building without saying so.
    for attempt in range(2):
        candidate = out_dir / f"{dwg_path.stem}.pass{attempt}.dxf"
        count, args = _run_once(converter, dwg_path, candidate)
        receipt.passes.append(count)
        if not receipt.args:
            receipt.args = args
        if count > best_count:
            best_count, best = count, candidate

    if best is None:
        raise ConversionRefused("No conversion pass produced a file.")

    if len(set(receipt.passes)) > 1:
        receipt.warnings.append(
            f"Passes disagreed: {receipt.passes}. Kept the larger. The converter "
            "is non-deterministic under recovery on this file."
        )

    if best_count == 0:
        raise ConversionRefused(
            "CONVERTER_DROPPED_MODELSPACE: the DXF parses and its block table is "
            "populated, but model space is empty. This is the LibreDWG 0.13.3 "
            f"signature, reported here by {version_string}. Refusing, rather "
            "than reconstructing an empty building and calling it a success."
        )

    if best_count < MIN_MODELSPACE_ENTITIES:
        raise ConversionRefused(
            f"Only {best_count} model-space entities. That is not a building "
            "drawing — check the DWG opens in CAD with geometry visible."
        )

    receipt.model_space_entities = best_count

    final = out_dir / f"{dwg_path.stem}.dxf"
    shutil.copyfile(best, final)
    return final, receipt


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Convert a DWG and gate the result.")
    parser.add_argument("dwg")
    parser.add_argument("--out", required=True)
    parser.add_argument("--converter", default=str(DEFAULT_CONVERTER))
    ns = parser.parse_args()

    try:
        path, rec = to_dxf(ns.dwg, ns.out, Path(ns.converter))
    except ConversionRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(2)

    print(json.dumps({"dxf": str(path), "converter": rec.as_dict()}, indent=2))
