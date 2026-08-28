"""Parity and boundary checks for the generated building-model contract."""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

from pydantic import ValidationError


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from model import BuildingModel  # noqa: E402
from model.types import P2  # noqa: E402


ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = ROOT / "packages" / "building-model" / "schema" / "building-1.json"


def minimal_model() -> dict[str, object]:
    return {
        "schema": "arcvia.building/1",
        "id": "building:test",
        "name": "Contract fixture",
        "units": "m",
        "up": "z",
        "status": "surveying",
        "sources": [],
        "frames": [],
        "unit": {
            "unit": "m",
            "scale": 1.0,
            "posterior": {"m": 1.0, "mm": 0.0, "cm": 0.0, "in": 0.0, "ft": 0.0},
            "margin": 100.0,
            "decidedBy": "user",
            "candidates": [],
            "agreement": {"dimension": None, "wallThickness": None, "conflict": False},
        },
        "sourceOrigin": {},
        "northAngle": 0.0,
        "storeys": [],
        "storeyLinks": [],
        "definitions": {},
        "annotations": [],
        "residuals": [],
        "patches": [],
        "quality": {
            "solved": False,
            "blocking": 0,
            "unitMargin": 100.0,
            "closedSpaceFraction": 0.0,
            "meanWallResidual": 0.0,
            "unpairedRuns": 0,
            "openingsUnassigned": 0,
            "mitreFallbacks": 0,
            "dimSamples": 0,
            "dimAgreement": None,
        },
    }


def expect_invalid(payload: dict[str, object]) -> None:
    try:
        BuildingModel.model_validate(payload)
    except ValidationError:
        return
    raise AssertionError("generated Pydantic boundary accepted an invalid model")


def test_required_field_parity() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    required = set(schema["definitions"]["BuildingModel"]["required"])
    generated = {
        field.alias or name
        for name, field in BuildingModel.model_fields.items()
        if field.is_required()
    }
    assert generated == required


def test_alias_round_trip_and_strict_boundaries() -> None:
    payload = minimal_model()
    model = BuildingModel.model_validate(payload)
    assert model.model_dump(mode="json", by_alias=True) == payload

    unexpected_root = deepcopy(payload)
    unexpected_root["unexpected"] = True
    expect_invalid(unexpected_root)

    unexpected_nested = deepcopy(payload)
    quality = unexpected_nested["quality"]
    assert isinstance(quality, dict)
    quality["unexpected"] = True
    expect_invalid(unexpected_nested)

    missing_required = deepcopy(payload)
    del missing_required["storeys"]
    expect_invalid(missing_required)


def test_fixed_length_coordinates() -> None:
    assert P2.model_validate([1.0, 2.0]).model_dump(mode="json") == [1.0, 2.0]
    try:
        P2.model_validate([1.0, 2.0, 3.0])
    except ValidationError:
        return
    raise AssertionError("generated P2 accepted more than two coordinates")


if __name__ == "__main__":
    test_required_field_parity()
    test_alias_round_trip_and_strict_boundaries()
    test_fixed_length_coordinates()
    print("generated Pydantic model matches the checked building-model schema")