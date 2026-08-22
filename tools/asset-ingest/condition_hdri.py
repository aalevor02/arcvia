"""
Turn a library HDRI into one the browser can afford.

    python condition_hdri.py --input sky_2k.hdr --output sky.hdr \
        --width 1024 --thumb sky.jpg

── Why an HDRI needs conditioning at all ───────────────────────────────────────
The hub stores 2K masters, because a library should hold the good version and
you can always go down. A 2K equirectangular Radiance map is 6.5 MB, and a
picker is a user clicking through ten of them. Twelve masters is 78 MB of
environment on a page whose entire furniture catalogue is 11 MB.

Halving each axis is a quarter of the pixels and roughly a quarter of the bytes,
and it costs almost nothing that matters: an environment map is integrated over
the hemisphere before it lights anything, and three.js prefilters it into a
PMREM chain whose top mip is coarser than 1K anyway. The resolution is spent on
the *visible background* — what the client sees through the window — not on the
light.

── Why this is not a Blender script, unlike condition_asset.py ─────────────────
Its sibling needs Blender because a model has topology, materials and an origin,
and only a DCC understands those. An equirectangular image has none of that: it
is a float array with a known projection. OpenCV resizes it in 0.15 s, against
several seconds of Blender startup per asset, and pulls in nothing this machine
does not already have.

── What it measures, and why that column exists ────────────────────────────────
Resizing an HDRI is exactly the kind of step that looks correct and silently is
not. Nothing about a darker environment map announces itself: the render simply
comes back a little flatter, and the natural conclusion is that the HDRI was a
poor choice rather than that the pipeline dimmed it.

So every conditioned file is measured against its source on the quantity that
actually matters — how much light it delivers — and a file that drifts is
refused rather than written. See `solid_angle_mean`.
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

#: Beyond this, the conditioned map no longer lights a scene like its source and
#: is refused. Measured drift on a 2K -> 1K reduction is around 0.3%, so 2% is
#: two-thirds of an order of magnitude of headroom rather than a tight fit —
#: it is here to catch a *broken* resize, not to grade a good one.
MAX_DRIFT = 0.02

#: An equirectangular map is twice as wide as it is tall. Anything else is not
#: one, and wrapping it round a scene would smear it.
ASPECT_TOLERANCE = 0.01


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--thumb", default=None, help="Also write a tone-mapped preview JPEG here.")
    parser.add_argument("--thumb-width", type=int, default=400)
    return parser.parse_args()


def read_hdr(path: str) -> np.ndarray:
    """
    Load a Radiance map as float BGR.

    IMREAD_ANYDEPTH is the whole point: without it OpenCV helpfully converts to
    8-bit and every value above 1.0 — which on an HDRI is the sun, the sky and
    every window — is clipped to white. The result still loads, still renders,
    and lights a scene like an overcast afternoon whatever it was a photograph
    of.
    """
    image = cv2.imread(path, cv2.IMREAD_ANYDEPTH | cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Could not read {path} as an image.")
    if image.dtype != np.float32:
        raise SystemExit(
            f"{path} decoded as {image.dtype}, not float32 — it is not an HDR map, "
            "or OpenCV read it at 8 bits and clipped every highlight."
        )
    return image


def solid_angle_mean(image: np.ndarray) -> float:
    """
    Mean luminance weighted by how much sky each row actually covers.

    ── Why not a plain mean ────────────────────────────────────────────────────
    An equirectangular projection stretches the poles across the full width of
    the image. The top row of a 2048-pixel-wide map is one point in the sky
    drawn 2048 times, while a row at the horizon is 2048 genuinely different
    directions. A plain average therefore weights straight-up and straight-down
    hundreds of times too heavily.

    Weighting each row by sin(theta) undoes exactly that, and what comes out is
    proportional to the total light arriving at a point from the whole sphere —
    which is the thing a resize must not change. A comparison of plain means
    would be dominated by the sky and could hide a horizon that had been
    destroyed.
    """
    height, width = image.shape[:2]
    theta = (np.arange(height) + 0.5) / height * np.pi
    weight = np.sin(theta)[:, None]
    luminance = image.mean(axis=2)
    return float((luminance * weight).sum() / weight.sum() / width)


def key_light(image: np.ndarray) -> dict:
    """
    Where the strongest light comes from, and how directional it is.

    ── Why this is measured rather than described ──────────────────────────────
    A picker that says "morning" and "afternoon" is making a claim, and two
    hand-picked skies can turn out to be the same light: the first pass of this
    set had a "clear sun" and a "morning" whose suns sat 1.1 degrees apart in
    elevation and 0.4 degrees in azimuth. Both notes read plausibly. Nothing
    about either file disagreed. Only measuring them did.

    Elevation is the one an architect cares about, because it *is* shadow
    length: a sun at 29 degrees throws a shadow 1.8 times the height of what
    casts it, and one at 43 degrees throws 1.07.

    `directionality` is peak over solid-angle mean — how many times brighter the
    brightest direction is than the average one. It separates a sky with a sun
    in it from a sky without: measured across this library, overcast maps come
    out at 2-6x and clear ones at 80,000x and up. Below roughly 10x there is no
    key light and the elevation is the brightest patch of cloud, which is not a
    meaningful direction and should not be shown as one.
    """
    luminance = image.mean(axis=2)
    height, width = luminance.shape
    row, column = np.unravel_index(int(np.argmax(luminance)), luminance.shape)

    mean = solid_angle_mean(image)
    return {
        # +90 is straight up, 0 is the horizon, negative is below it — which a
        # night map legitimately is, when the brightest thing in frame is a lamp.
        "elevation": round(90 - (row + 0.5) / height * 180, 1),
        "azimuth": round((column + 0.5) / width * 360 - 180, 1),
        "directionality": round(float(luminance.max()) / mean if mean > 0 else 0.0, 1),
    }


def tone_map(image: np.ndarray) -> np.ndarray:
    """
    A preview a person can recognise the sky in.

    Not a colour-managed render — a thumbnail in a picker. What it has to do is
    make two skies distinguishable at 400 pixels wide, which means the exposure
    has to adapt: a night HDRI and a midday one differ by four orders of
    magnitude, and any fixed exposure renders one of them black and the other
    white.

    So the scale comes from a high percentile rather than the maximum. The
    maximum of a daylight map is the sun, which is thousands of times brighter
    than anything else in the frame; normalising to it makes every sky black.
    """
    luminance = image.mean(axis=2)
    reference = float(np.percentile(luminance, 99.0))
    if reference <= 0:
        reference = max(float(luminance.max()), 1e-6)

    scaled = np.clip(image / reference, 0.0, 1.0)
    # sRGB transfer, near enough. The exact curve does not matter at this size;
    # applying none at all does — a linear thumbnail reads as a muddy dark blob.
    return (np.power(scaled, 1 / 2.2) * 255).astype(np.uint8)


def main() -> int:
    args = parse_args()

    source = read_hdr(args.input)
    height, width = source.shape[:2]

    aspect = width / height
    if abs(aspect - 2.0) > ASPECT_TOLERANCE:
        raise SystemExit(
            f"{args.input} is {width}x{height} (aspect {aspect:.3f}), not 2:1. "
            "Equirectangular maps are twice as wide as they are tall; this is "
            "something else and would smear when wrapped round a scene."
        )

    target_width = min(args.width, width)
    if target_width < args.width:
        print(
            f"ARCVIA_WARN:source is only {width} wide; keeping it rather than upscaling",
            flush=True,
        )

    target = (target_width, target_width // 2)
    # INTER_AREA averages every source pixel that falls in a destination pixel,
    # which is what conserves total energy. INTER_LINEAR samples instead, and on
    # a large reduction it can miss the sun entirely between taps — dropping a
    # scene's key light with no error and no visible artefact in the map.
    small = cv2.resize(source, target, interpolation=cv2.INTER_AREA)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    if not cv2.imwrite(args.output, small):
        raise SystemExit(f"Could not write {args.output}.")

    # Measured on the file as written, not on the array in memory. Radiance is
    # an 8-bit mantissa with a shared exponent, so writing is itself lossy, and
    # a check that skipped the round trip would not be checking the artefact
    # that ships.
    written = read_hdr(args.output)
    before = solid_angle_mean(source)
    after = solid_angle_mean(written)
    drift = (after / before - 1) if before > 0 else 0.0

    if abs(drift) > MAX_DRIFT:
        os.remove(args.output)
        raise SystemExit(
            f"Refusing {args.output}: conditioning changed the light it delivers by "
            f"{drift * 100:+.2f}% (limit {MAX_DRIFT * 100:.0f}%). "
            "The file has been removed rather than left for someone to ship."
        )

    thumb_bytes = None
    if args.thumb:
        thumb_width = min(args.thumb_width, target_width)
        preview = cv2.resize(
            written, (thumb_width, thumb_width // 2), interpolation=cv2.INTER_AREA
        )
        os.makedirs(os.path.dirname(os.path.abspath(args.thumb)) or ".", exist_ok=True)
        if not cv2.imwrite(args.thumb, tone_map(preview), [cv2.IMWRITE_JPEG_QUALITY, 82]):
            raise SystemExit(f"Could not write {args.thumb}.")
        thumb_bytes = os.path.getsize(args.thumb)

    report = {
        "input": args.input,
        "output": args.output,
        "source": {"width": width, "height": height, "bytes": os.path.getsize(args.input)},
        "conditioned": {
            "width": target[0],
            "height": target[1],
            "bytes": os.path.getsize(args.output),
        },
        "light": {
            "before": round(before, 6),
            "after": round(after, 6),
            "driftPercent": round(drift * 100, 3),
        },
        "peak": {"before": round(float(source.max()), 1), "after": round(float(written.max()), 1)},
        # Measured on the written file, so it describes what ships rather than
        # what was downloaded.
        "keyLight": key_light(written),
        "thumbnail": {"path": args.thumb, "bytes": thumb_bytes} if args.thumb else None,
    }

    # One unindented line, for the tool driving this in bulk. Same convention as
    # condition_asset.py's ARCVIA_ASSET, and for the same reason: the batch
    # runner there once reported 32 successes as failures because it was
    # scraping indented pretty-print.
    print("ARCVIA_HDRI:" + json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
