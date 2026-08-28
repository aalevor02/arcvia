"""Public reconstruction boundary for the generated building contract.

Consumers import from ``model``. ``model.types`` is generated from the shared
JSON Schema and must not be edited by hand.
"""

from .types import BuildingModel

__all__ = ["BuildingModel"]
