"""
Write an equirectangular sky as a Radiance .hdr for the viewer's environment.

The viewer's default rig is three directional/hemisphere lights with no global
illumination, so an unbaked interior reads flat and the walls away from the key
light go muddy. An environment map costs one file and gives image-based
lighting: sky above, warm ground bounce below, and a sun disc for specular.

Goa, mid-morning: high sun, hazy warm horizon, dry ground bounce.
"""
import numpy as np, struct, os

W, H = 512, 256
OUT = r"A:\Web\Arcvia\tools\cad-to-3d\sky.hdr"

# Direction for every texel of the equirect map.
u = (np.arange(W) + 0.5) / W
v = (np.arange(H) + 0.5) / H
phi = (u * 2.0 - 1.0) * np.pi            # azimuth, -pi..pi
theta = v * np.pi                        # 0 at zenith, pi at nadir
PH, TH = np.meshgrid(phi, theta)

dy = np.cos(TH)                          # +1 up, -1 down
dx = np.sin(TH) * np.sin(PH)
dz = np.sin(TH) * np.cos(PH)

ZENITH = np.array([0.16, 0.28, 0.58])
HORIZON = np.array([0.85, 0.86, 0.82])
GROUND = np.array([0.20, 0.17, 0.13])

up = np.clip(dy, 0.0, 1.0)[..., None]
sky = HORIZON * (1.0 - up ** 0.45) + ZENITH * (up ** 0.45)
sky *= 2.4                               # overall sky radiance

below = np.clip(-dy, 0.0, 1.0)[..., None]
ground = GROUND * (0.55 + 0.45 * (1.0 - below))
img = np.where(dy[..., None] >= 0.0, sky, ground * 1.15)

# Sun: 35 deg elevation, north-west, so it rakes the deck and the west rooms.
sel, saz = np.radians(35.0), np.radians(-125.0)
sun = np.array([np.cos(sel) * np.sin(saz), np.sin(sel), np.cos(sel) * np.cos(saz)])
cosang = dx * sun[0] + dy * sun[1] + dz * sun[2]
disc = np.clip((cosang - np.cos(np.radians(2.6))) / (1.0 - np.cos(np.radians(2.6))), 0, 1)
img += (disc ** 0.6)[..., None] * np.array([46.0, 42.0, 36.0])
# broad glow so the sky near the sun lifts the interiors
glow = np.clip((cosang - 0.55) / 0.45, 0, 1) ** 2
img += glow[..., None] * np.array([1.8, 1.6, 1.3])

img = np.maximum(img, 1e-6).astype(np.float64)

# ---- Radiance RGBE, flat (non-RLE); RGBELoader reads both ----
mx = img.max(axis=2)
exp = np.zeros_like(mx)
mant = np.zeros_like(mx)
nz = mx > 1e-32
mant[nz], expi = np.frexp(mx[nz])
exp[nz] = expi
scale = np.where(nz, mant / np.where(mx > 0, mx, 1.0) * 256.0, 0.0)
rgb = np.clip(img * scale[..., None], 0, 255).astype(np.uint8)
e = np.clip(exp + 128, 0, 255).astype(np.uint8)
rgbe = np.dstack([rgb, e])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "wb") as f:
    f.write(b"#?RADIANCE\n")
    f.write(b"SOFTWARE=arcvia\n")
    f.write(b"FORMAT=32-bit_rle_rgbe\n\n")
    f.write(f"-Y {H} +X {W}\n".encode())
    f.write(rgbe.astype(np.uint8).tobytes())

print(f"wrote {OUT}  {os.path.getsize(OUT)/1024:.0f} KB  {W}x{H}")
print(f"  zenith {img[0, W//2]}  horizon {img[H//2, W//2]}  ground {img[-1, W//2]}")
print(f"  sun peak {img.max():.1f}")
