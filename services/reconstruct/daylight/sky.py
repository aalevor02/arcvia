"""
The CIE standard overcast sky, and the closed forms that check the integrator.

── Why this module exists before any daylight feature does ─────────────────────
Daylight factor was deferred once, on the grounds that a daylight number which
has never been checked against a known-correct case is a liability in a document
an architect signs. That reasoning was right and it was recorded as "blocked on
validation data — find reference values first".

The block was real but the framing was wrong. It treated validation data as
something you go and FIND, and none was to hand, so the feature stalled. For a
standard overcast sky the reference values do not have to be found: the sky has a
defined luminance distribution, and for simple geometries the resulting
illuminance has a closed form you can derive in a few lines. Deriving it is
better than finding it, because a derivation can be checked by the next reader
and a downloaded table cannot.

So this module is the validation floor. It defines the sky, integrates it
numerically, and carries the analytic results the numerical integrator must
reproduce. Everything that computes a daylight number stands on it.

── The sky ────────────────────────────────────────────────────────────────────
CIE Standard Overcast Sky (the Moon & Spencer distribution), which is what every
daylight FACTOR is defined against:

    L(θ) = L_z · (1 + 2 sin θ) / 3

θ is altitude above the horizon, L_z the zenith luminance. The zenith is three
times as bright as the horizon, and — this is the part that matters — the
distribution is rotationally symmetric, with no sun in it. That is deliberate.
A daylight factor is a RATIO to the unobstructed horizontal illuminance under
the same sky, so orientation drops out and the number is a property of the room
rather than of the day. It is the reason a daylight factor can be quoted in a
planning document at all, and the reason it must never be computed under a sky
with a sun in it.

── The closed form, derived rather than quoted ────────────────────────────────
Unobstructed horizontal illuminance. Altitude θ from the horizon, azimuth φ, so
the solid angle element is cos θ dθ dφ and the cosine to the horizontal
receiver's normal is sin θ:

    E_h = ∫₀^{2π} ∫₀^{π/2} L_z (1 + 2 sin θ)/3 · sin θ · cos θ  dθ dφ
        = (2π L_z / 3) [ ∫ sin θ cos θ dθ  +  2 ∫ sin²θ cos θ dθ ]
        = (2π L_z / 3) [ 1/2 + 2/3 ]
        = (2π L_z / 3)(7/6)
        = 7π L_z / 9

That is the denominator of every daylight factor, and `test_daylight.py` asserts
the numerical integrator reproduces it. If the integrator is wrong, that single
assertion fails — which is the whole point of having a case whose answer is known
independently of the code being tested.
"""

from __future__ import annotations

import math

#: Zenith luminance, cd/m². The value is arbitrary and cancels in every ratio;
#: it is named rather than inlined as 1.0 so the formulae below read as physics
#: rather than as a normalisation trick.
ZENITH_LUMINANCE = 1.0

#: Unobstructed horizontal illuminance under this sky, per unit zenith
#: luminance. Derived in the module docstring; the numerical integrator is
#: asserted against it rather than the other way round.
UNOBSTRUCTED_HORIZONTAL = 7.0 * math.pi / 9.0


def luminance(altitude: float, zenith: float = ZENITH_LUMINANCE) -> float:
    """
    Sky luminance at an altitude above the horizon, in radians.

    Below the horizon returns 0 rather than a negative luminance. A ray that
    escapes downward has left the sky, and the alternative — letting the formula
    run past θ = 0 — quietly ADDS light for every downward ray, which is the kind
    of sign error that makes a room look better lit the more it is enclosed.
    """
    if altitude <= 0.0:
        return 0.0
    return zenith * (1.0 + 2.0 * math.sin(altitude)) / 3.0


def horizontal_illuminance(
    visible,
    rings: int = 90,
    sectors: int = 360,
    zenith: float = ZENITH_LUMINANCE,
) -> float:
    """
    Illuminance on an upward-facing horizontal surface from the visible sky.

    `visible(altitude, azimuth) -> bool` says whether that direction reaches the
    sky. Passing `lambda a, z: True` must reproduce UNOBSTRUCTED_HORIZONTAL, and
    that is asserted in the tests.

    ── Why uniform angular steps rather than a cosine-weighted quadrature ──────
    A cosine-weighted or equal-solid-angle scheme converges faster for a smooth
    integrand, and this integrand is not smooth: `visible` is a step function
    whose edges are the window reveals, and the answer is dominated by exactly
    where those edges fall. A scheme that clusters samples near the zenith puts
    its resolution where the geometry is simple and starves the horizon band,
    where a window actually is. Uniform steps put the samples where the edges
    are, and the cost of the extra samples is nothing next to being wrong about
    a reveal.

    The default 90 x 360 is one sample per degree in each axis. `test_daylight`
    measures the convergence rather than asserting the default is enough.
    """
    total = 0.0
    d_alt = (math.pi / 2.0) / rings
    d_az = (2.0 * math.pi) / sectors

    for i in range(rings):
        # Mid-point of the ring, not its edge. Sampling at the edge biases every
        # ring the same way, and the biases add rather than cancel.
        altitude = (i + 0.5) * d_alt
        sin_a, cos_a = math.sin(altitude), math.cos(altitude)
        radiance = zenith * (1.0 + 2.0 * sin_a) / 3.0
        # cos_a is the solid-angle element, sin_a the receiver cosine.
        weight = radiance * sin_a * cos_a * d_alt * d_az

        for j in range(sectors):
            azimuth = (j + 0.5) * d_az
            if visible(altitude, azimuth):
                total += weight

    return total


def daylight_factor(interior: float, exterior: float = UNOBSTRUCTED_HORIZONTAL) -> float:
    """
    Interior illuminance as a percentage of the unobstructed exterior.

    Both must be computed under the SAME sky. The ratio is the entire content of
    a daylight factor, and it is meaningless across skies — which is why
    `exterior` defaults to the derived constant rather than being re-integrated
    per call, where a different `rings`/`sectors` would silently change the
    denominator and move every result.
    """
    if exterior <= 0.0:
        return 0.0
    return 100.0 * interior / exterior
