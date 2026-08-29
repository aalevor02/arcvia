"""Bounded lightmap atlas sizing from the scene the worker actually imported."""

from __future__ import annotations

import math

MIN_ATLAS_SIZE = 1024
DEFAULT_MAX_ATLAS_SIZE = 4096
TARGET_CELL_SIDE = 256


def atlas_resolution(
    mesh_count: int,
    *,
    maximum: int = DEFAULT_MAX_ATLAS_SIZE,
    target_cell_side: int = TARGET_CELL_SIDE,
) -> int:
    """Return a safe power-of-two atlas side, or refuse excess geometry."""
    if not isinstance(mesh_count, int) or mesh_count < 1:
        raise ValueError("mesh_count must be a positive integer")
    if maximum < MIN_ATLAS_SIZE or maximum & (maximum - 1):
        raise ValueError("maximum atlas size must be a power of two at least 1024")
    if target_cell_side < 64:
        raise ValueError("target cell side must be at least 64 pixels")

    grid = math.ceil(math.sqrt(mesh_count))
    required = max(MIN_ATLAS_SIZE, grid * target_cell_side)
    size = 1 << math.ceil(math.log2(required))
    if size > maximum:
        capacity = (maximum // target_cell_side) ** 2
        raise ValueError(
            f"{mesh_count} meshes need an atlas larger than {maximum}px; "
            f"single-atlas capacity is {capacity} meshes at "
            f"{target_cell_side}px target density"
        )
    return size
