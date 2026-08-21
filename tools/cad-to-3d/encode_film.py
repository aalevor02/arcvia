"""
Encode a rendered frame sequence into the looping film the villa page plays.

  python encode_film.py <frames_glob> <out.mp4> [fps]

Two things the page depends on:

  * It must loop seamlessly. The orbit renders a full 360 degrees, so the last
    frame meets the first - do NOT duplicate either end.
  * It autoplays muted on a sales page, so it has to be small and it has to be
    encoded with `faststart`, or a visitor waits for the whole file before the
    first frame appears.
"""
import sys, os, glob
import imageio.v2 as imageio

SRC = sys.argv[1]
OUT = sys.argv[2]
FPS = int(sys.argv[3]) if len(sys.argv) > 3 else 24

frames = sorted(glob.glob(SRC))
if not frames:
    raise SystemExit(f"no frames matched {SRC}")

# Ping-pong when the sweep is partial.
#
# A full 360 orbit meets its own start and loops on its own. A partial arc does
# not, and cutting from the last frame back to the first is a visible jump.
# Playing it forward then backward loops seamlessly from any arc - and reads as
# a deliberate camera move rather than a turntable. Drop the two end frames on
# the return leg so neither extreme is held for two frames.
if os.environ.get("ARCVIA_PINGPONG", "auto") != "off":
    full_turn = os.environ.get("ARCVIA_FULL_TURN") == "1"
    if not full_turn:
        frames = frames + frames[-2:0:-1]

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
writer = imageio.get_writer(
    OUT, fps=FPS, codec="libx264", quality=None,
    output_params=["-crf", "23", "-preset", "slow", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart"],
)
for f in frames:
    writer.append_data(imageio.imread(f))
writer.close()

size = os.path.getsize(OUT)
print(f"{len(frames)} frames @ {FPS}fps -> {OUT}")
print(f"{len(frames) / FPS:.1f}s, {size / 1024 / 1024:.2f} MB")
