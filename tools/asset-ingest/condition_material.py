"""
Turn an ambientCG material into three maps the studio can afford.

    python condition_material.py --input A:/Assets/Hub/materials/WoodFloor007 \
        --out apps/studio/public/surfaces --id floor-wood --size 512 --tile-metres 1.2

── What a downloaded material is, and why it is not shippable ─────────────────
An ambientCG 1K-JPG folder is about 9 MB: colour, roughness, two normal maps, an
ambient-occlusion pass, a displacement pass, plus .blend, .usdc, .mtlx and .tres
scene files for four different DCCs. The studio wants three of those images, at
half that resolution, and none of the scene files.

512 is not a compromise here. `plan/materials.ts` already generates its
procedural maps at `SIZE = 512`, so a real map at 512 is the resolution the
sampling was designed around, and a tiling surface is at full resolution
whenever its tile is about a metre — which is the entire point of tiling.

── The trap this file exists to make impossible ───────────────────────────────
ambientCG ships `NormalGL` and `NormalDX`. They are the same map with the green
channel inverted, because DirectX and OpenGL disagree about which way +Y points.
glTF and three.js are OpenGL convention, so GL is the correct one and DX is
silently wrong: every bump becomes a dent lit from the wrong side. The geometry
is right, the colour is right, the roughness is right, and the surface simply
reads oddly.

Measured on Asphalt014, the two files differ by 58.2 mean levels in green and
0.9 in red and blue — but their green MEANS are 127.4 and 127.6. The
distribution is symmetric about the midpoint, so no summary statistic tells them
apart. The filename is the only evidence there is, which is precisely why this
script refuses to guess: it requires a file named NormalGL and will not fall
back to NormalDX, however tempting a missing map makes it.
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

#: Maps the studio actually binds, and the colour space each must be read in.
#:
#: Ambient occlusion and displacement are deliberately not shipped. `materials.ts`
#: binds map, roughnessMap and normalMap and nothing else; AO needs a second UV
#: set to be correct, and displacement needs tessellation the viewer does not do.
#: Shipping them would be three more files nobody samples.
WANTED = {
    "color": ("Color", True),
    "roughness": ("Roughness", False),
    "normal": ("NormalGL", False),
}

#: Never accepted, and named so the refusal can say why rather than "not found".
FORBIDDEN = {"NormalDX": "DirectX normal convention; glTF and three.js need NormalGL"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="A hub material directory.")
    parser.add_argument("--out", required=True)
    parser.add_argument("--id", required=True, help="Surface key, e.g. floor-wood.")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=85)
    parser.add_argument(
        "--tile-metres",
        type=float,
        required=True,
        help="Real-world size of one tile. Hand-set; see the note in materials.mjs.",
    )
    parser.add_argument(
        "--check-dir",
        default=None,
        help=(
            "Write the metre-rule proof here. Deliberately separate from --out: "
            "it is evidence for whoever set --tile-metres, not something to ship."
        ),
    )
    return parser.parse_args()


def find_map(directory: str, suffix: str) -> str | None:
    """
    The file for one map, at the highest resolution present.

    Matched on the `_<suffix>.` ending rather than by `in`, because `Normal` is a
    substring of both NormalGL and NormalDX and a loose match here would pick
    whichever the filesystem listed first. That is the same defect class as the
    licence and rate-table substring matches already recorded in this repo, and
    it would land on exactly the trap this file exists to prevent.
    """
    candidates = [
        name
        for name in os.listdir(directory)
        if name.lower().endswith((".jpg", ".png"))
        and name.rsplit(".", 1)[0].endswith(f"_{suffix}")
    ]
    if not candidates:
        return None

    def resolution(name: str) -> int:
        for token in name.split("_"):
            if token[:-1].isdigit() and token.lower().endswith("k"):
                return int(token[:-1])
        return 0

    return os.path.join(directory, sorted(candidates, key=resolution, reverse=True)[0])


def scale_preview(image: np.ndarray, tile_metres: float, path: str) -> None:
    """
    The tile, repeated, with a one-metre rule across it.

    ── Why a picture and not a measurement ─────────────────────────────────────
    ambientCG declares `dimensionX/Y/Z` in its API and leaves them at zero — 0 of
    15 sampled materials had a real size — so every tile's physical scale is
    hand-set. A hand-set number can be wrong by a factor of four with nothing to
    say so: a wood floor with 400 mm planks still renders, still tiles, and just
    quietly reads as a photograph of a floor rather than a floor.

    ── The measurement that was tried, and does not work ───────────────────────
    The obvious check is to find the dominant spatial period and divide, giving
    plank width in millimetres. It was implemented and abandoned, and the reason
    is worth keeping so nobody builds it again:

      * A column-mean luminance profile of WoodFloor007 reports 3 cycles. There
        are about 13 plank rows. Running-bond flooring staggers its planks, so
        the profile is dominated by large blocks of similar-toned boards rather
        than by the seams between them.
      * Switching to a gradient profile reports 32 cycles at a spectral strength
        of 0.019 — no dominant frequency at all, because wood grain and plank
        seams live at the same scale and the grain is stronger.

    Two plausible millimetre figures, four times apart, neither trustworthy. A
    number that confident and that wrong is worse than none, because it would be
    believed.

    ── What this does instead ──────────────────────────────────────────────────
    It renders the claim so a person can refute it in one glance: the tile at the
    size it will actually appear, with a metre marked on it. A floorboard is
    100-300 mm and a floor tile 300-600 mm, and both are things the eye judges
    instantly against a rule and badly in the abstract.
    """
    tiles = 2
    size = image.shape[0]
    sheet = np.tile(image, (tiles, tiles, 1))

    # One metre in pixels, given that one tile spans `tile_metres`.
    metre = size / tile_metres if tile_metres > 0 else size
    y = int(sheet.shape[0] * 0.9)
    x0 = int(size * 0.15)
    x1 = int(x0 + metre)

    if x1 < sheet.shape[1]:
        cv2.line(sheet, (x0, y), (x1, y), (0, 0, 0), 5)
        cv2.line(sheet, (x0, y), (x1, y), (255, 255, 255), 2)
        for x in (x0, x1):
            cv2.line(sheet, (x, y - 12), (x, y + 12), (0, 0, 0), 5)
            cv2.line(sheet, (x, y - 12), (x, y + 12), (255, 255, 255), 2)
        cv2.putText(sheet, "1 m", (x0, y - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(sheet, "1 m", (x0, y - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1, cv2.LINE_AA)

    cv2.imwrite(path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])


def main() -> int:
    args = parse_args()

    if not os.path.isdir(args.input):
        raise SystemExit(f"{args.input} is not a directory.")

    present = os.listdir(args.input)
    os.makedirs(args.out, exist_ok=True)

    written = {}
    for key, (suffix, srgb) in WANTED.items():
        path = find_map(args.input, suffix)
        if path is None:
            # Say what WAS there. "NormalGL not found" plus a directory holding
            # NormalDX is a decision someone has to make, not a missing file.
            alternatives = [n for n in present if suffix.rstrip("GL") in n]
            forbidden = [n for n in present for bad in FORBIDDEN if bad in n]
            raise SystemExit(
                f"{args.input} has no _{suffix} map.\n"
                f"  present that look related: {alternatives or 'none'}\n"
                + (
                    f"  refusing to substitute {forbidden}: {list(FORBIDDEN.values())[0]}\n"
                    if forbidden
                    else ""
                )
            )

        # Roughness is data, not a picture: one channel, and never colour-managed.
        # Reading it as BGR would triple the bytes for three identical channels.
        flags = cv2.IMREAD_COLOR if srgb or suffix.startswith("Normal") else cv2.IMREAD_GRAYSCALE
        image = cv2.imread(path, flags)
        if image is None:
            raise SystemExit(f"Could not read {path}.")

        small = cv2.resize(image, (args.size, args.size), interpolation=cv2.INTER_AREA)
        out_path = os.path.join(args.out, f"{args.id}-{key}.jpg")
        if not cv2.imwrite(out_path, small, [cv2.IMWRITE_JPEG_QUALITY, args.quality]):
            raise SystemExit(f"Could not write {out_path}.")

        written[key] = {
            "source": os.path.basename(path),
            "output": out_path,
            "bytes": os.path.getsize(out_path),
            "sourceBytes": os.path.getsize(path),
            "srgb": srgb,
        }

    colour = cv2.imread(written["color"]["output"], cv2.IMREAD_COLOR)

    check_path = None
    if args.check_dir:
        os.makedirs(args.check_dir, exist_ok=True)
        check_path = os.path.join(args.check_dir, f"{args.id}-scale.jpg")
        scale_preview(colour, args.tile_metres, check_path)

    report = {
        "id": args.id,
        "input": args.input,
        "size": args.size,
        "tileMetres": args.tile_metres,
        "maps": written,
        "bytes": sum(m["bytes"] for m in written.values()),
        "sourceBytes": sum(m["sourceBytes"] for m in written.values()),
        # Not shipped with the studio — a proof for whoever set tileMetres.
        "scaleCheck": check_path,
        # Recorded so the generated module can state it rather than a reader
        # having to trust that the right file was picked.
        "normalConvention": "OpenGL",
    }

    print("ARCVIA_MATERIAL:" + json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
