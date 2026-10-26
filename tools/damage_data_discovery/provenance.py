#!/usr/bin/env python3
"""Build and validate compact provenance manifests for pilot artifacts."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Callable, Mapping


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(manifest: Mapping[str, object]) -> None:
    required = {
        "schema_version",
        "manifest_id",
        "created_at_utc",
        "sources",
        "artifacts",
        "transformations",
        "quality_checks",
        "exclusions",
        "uncertainty",
    }
    missing = required.difference(manifest)
    if missing:
        raise ValueError(f"Provenance manifest missing fields: {sorted(missing)}")
    if manifest["schema_version"] != "haze.data-provenance.v1":
        raise ValueError("Unsupported provenance manifest schema.")
    for collection in ("sources", "artifacts", "transformations", "quality_checks"):
        if not isinstance(manifest[collection], list):
            raise ValueError(f"{collection} must be an array.")
    if not manifest["sources"] or not manifest["artifacts"]:
        raise ValueError("Manifest must describe at least one source and artifact.")

    for index, source in enumerate(manifest["sources"]):
        if not isinstance(source, Mapping):
            raise ValueError(f"sources[{index}] must be an object.")
        for field in (
            "source_id",
            "source_url",
            "retrieved_at_utc",
            "dataset_version",
            "license_status",
        ):
            value = source.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"sources[{index}].{field} must be explicit.")

    for index, artifact in enumerate(manifest["artifacts"]):
        if not isinstance(artifact, Mapping):
            raise ValueError(f"artifacts[{index}] must be an object.")
        for field in ("artifact_id", "path", "sha256", "media_type", "role"):
            value = artifact.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"artifacts[{index}].{field} must be explicit.")
        if len(artifact["sha256"]) != 64 or any(
            character not in "0123456789abcdef"
            for character in artifact["sha256"]
        ):
            raise ValueError(f"artifacts[{index}].sha256 is not a SHA-256 digest.")

    for index, step in enumerate(manifest["transformations"]):
        if not isinstance(step, Mapping):
            raise ValueError(f"transformations[{index}] must be an object.")
        for field in ("step_id", "description", "implementation", "version"):
            value = step.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"transformations[{index}].{field} must be explicit."
                )
    exclusions = manifest["exclusions"]
    if not isinstance(exclusions, list):
        raise ValueError("exclusions must be an array.")
    for index, exclusion in enumerate(exclusions):
        if not isinstance(exclusion, Mapping):
            raise ValueError(f"exclusions[{index}] must be an object.")
        for field in ("item", "reason"):
            value = exclusion.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"exclusions[{index}].{field} must be explicit.")
    uncertainty = manifest["uncertainty"]
    if not isinstance(uncertainty, Mapping):
        raise ValueError("uncertainty must be an object.")
    for field in ("status", "method"):
        value = uncertainty.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"uncertainty.{field} must be explicit.")
    if not isinstance(uncertainty.get("limitations"), list) or any(
        not isinstance(item, str) or not item.strip()
        for item in uncertainty["limitations"]
    ):
        raise ValueError("uncertainty.limitations must be an array of strings.")


def build_file_manifest(
    *,
    manifest_id: str,
    created_at_utc: str,
    source_id: str,
    source_url: str,
    retrieved_at_utc: str,
    dataset_version: str,
    license_status: str,
    artifacts: list[dict],
    transformations: list[dict],
    quality_checks: list[dict],
    exclusions: list[dict],
    uncertainty: dict,
) -> dict:
    """Create a manifest with checksums verified from on-disk artifacts."""
    artifact_entries = []
    for artifact in artifacts:
        path = Path(artifact["path"])
        if not path.is_file():
            raise FileNotFoundError(f"Provenance artifact does not exist: {path}")
        artifact_entries.append(
            {
                "artifact_id": artifact["artifact_id"],
                "path": artifact["display_path"],
                "sha256": sha256_file(path),
                "media_type": artifact["media_type"],
                "role": artifact["role"],
            }
        )
    manifest = {
        "schema_version": "haze.data-provenance.v1",
        "manifest_id": manifest_id,
        "created_at_utc": created_at_utc,
        "sources": [
            {
                "source_id": source_id,
                "source_url": source_url,
                "retrieved_at_utc": retrieved_at_utc,
                "dataset_version": dataset_version,
                "license_status": license_status,
            }
        ],
        "artifacts": artifact_entries,
        "transformations": transformations,
        "quality_checks": quality_checks,
        "exclusions": exclusions,
        "uncertainty": uncertainty,
    }
    validate_manifest(manifest)
    return manifest


def _finite_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric.")
    try:
        result = float(value)
    except OverflowError as error:
        raise ValueError(f"{field} must be finite.") from error
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite.")
    return result


def one_way_sensitivity(
    *,
    method_id: str,
    central_inputs: Mapping[str, float],
    input_ranges: Mapping[str, Mapping[str, float]],
    evaluate: Callable[[dict[str, float]], float],
) -> dict:
    """Vary one explicitly ranged input at a time around central values.

    No distributions or ranges are inferred. The caller supplies all central
    values, lower/upper bounds, units, and a deterministic scalar evaluator.
    """
    if not central_inputs:
        raise ValueError("At least one central input is required.")
    if not isinstance(method_id, str) or not method_id.strip():
        raise ValueError("method_id must be a non-empty string.")
    central: dict[str, float] = {}
    ranges: dict[str, tuple[float, float]] = {}
    for name, value in central_inputs.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Input names must be non-empty strings.")
        central[name] = _finite_number(value, f"central_inputs.{name}")
    if set(input_ranges) != set(central):
        raise ValueError(
            "Every central input must have exactly one explicit sensitivity range."
        )
    for name, bounds in input_ranges.items():
        if (
            not isinstance(bounds, Mapping)
            or "lower" not in bounds
            or "upper" not in bounds
        ):
            raise ValueError(f"input_ranges.{name} requires lower and upper bounds.")
        lower = _finite_number(bounds["lower"], f"input_ranges.{name}.lower")
        upper = _finite_number(bounds["upper"], f"input_ranges.{name}.upper")
        if lower > upper:
            raise ValueError(f"input_ranges.{name}.lower exceeds upper.")
        if not lower <= central[name] <= upper:
            raise ValueError(
                f"central_inputs.{name} is outside its sensitivity range."
            )
        ranges[name] = (lower, upper)

    central_output = _finite_number(evaluate(dict(central)), "central_output")
    results = []
    for name in central:
        lower, upper = ranges[name]
        low_inputs = dict(central)
        high_inputs = dict(central)
        low_inputs[name] = lower
        high_inputs[name] = upper
        low_output = _finite_number(evaluate(low_inputs), f"{name}.low_output")
        high_output = _finite_number(evaluate(high_inputs), f"{name}.high_output")
        results.append(
            {
                "input": name,
                "central_value": central[name],
                "lower_bound": lower,
                "upper_bound": upper,
                "output_at_lower": low_output,
                "output_at_upper": high_output,
                "output_minimum": min(low_output, high_output),
                "output_maximum": max(low_output, high_output),
                "change_from_central_at_lower": low_output - central_output,
                "change_from_central_at_upper": high_output - central_output,
            }
        )
    return {
        "schema_version": "haze.damage-sensitivity.one-way.v1",
        "method_id": method_id,
        "method": "one-at-a-time deterministic endpoint sensitivity",
        "central_inputs": central,
        "central_output": central_output,
        "results": results,
        "limitations": (
            "Uses only caller-supplied bounds; does not infer probability "
            "distributions, parameter dependence, joint uncertainty, or "
            "scientific validity. One-way ranges are not confidence intervals."
        ),
    }
