#!/usr/bin/env python3
"""Explicit, versioned calculation primitives for a reviewed pilot.

These functions do not fetch data, run atmospheric transport, select health
risk functions, or establish source/method applicability. All numeric inputs
must come from separately reviewed evidence.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Mapping

METHODS = {
    "fire.paired-source-removal.v1": {
        "version": "1",
        "formula": (
            "paired source contribution = concentration_with_target_source "
            "- concentration_with_target_source_removed"
        ),
    },
    "exposure.population-weighted-mean.v1": {
        "version": "1",
        "formula": "sum(population_i * concentration_i) / sum(population_i)",
    },
    "health.baseline-rate-relative-risk.v1": {
        "version": "1",
        "formula": (
            "baseline_expected = baseline_rate_per_100k_person_year "
            "* population * duration_days / (100000 * 365.2425); "
            "excess = baseline_expected * (relative_risk - 1)"
        ),
    },
    "economics.declared-unit-value.v1": {
        "version": "1",
        "formula": "valued_amount = physical_quantity * declared_unit_value",
    },
}

PERSON_YEAR_DAYS = 365.2425


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string.")
    return value.strip()


def _number(value: object, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric.")
    try:
        result = float(value)
    except OverflowError as error:
        raise ValueError(f"{field} must be finite.") from error
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite.")
    if minimum is not None and result < minimum:
        raise ValueError(f"{field} must be at least {minimum}.")
    return result


def _iso_date(value: object, field: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO calendar date.")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO calendar date.") from error


def paired_source_removal(
    rows: list[Mapping[str, object]],
    *,
    model_name: str,
    model_version: str,
    configuration_reference: str,
) -> dict:
    """Subtract paired source-removed concentrations from historical runs.

    Concentrations are paired by grid cell, period and population stratum.
    Negative results are retained: this function does not clip or reinterpret
    them. The supplied runs must already have been generated and reviewed by
    an appropriate atmospheric method.
    """
    if not rows:
        raise ValueError("At least one paired model row is required.")
    model = _text(model_name, "model_name")
    version = _text(model_version, "model_version")
    config = _text(configuration_reference, "configuration_reference")
    result_rows: list[dict] = []
    seen: set[tuple[str, str, str, str]] = set()
    common_unit: str | None = None

    for index, row in enumerate(rows):
        cell_id = _text(row.get("grid_cell_id"), f"rows[{index}].grid_cell_id")
        start = _iso_date(row.get("period_start"), f"rows[{index}].period_start")
        end = _iso_date(row.get("period_end"), f"rows[{index}].period_end")
        if end < start:
            raise ValueError(f"rows[{index}] period_end precedes period_start.")
        stratum = _text(
            row.get("population_stratum"),
            f"rows[{index}].population_stratum",
        )
        unit = _text(row.get("unit"), f"rows[{index}].unit")
        if common_unit is None:
            common_unit = unit
        elif common_unit != unit:
            raise ValueError("All paired concentrations must use the same unit.")
        historical = _number(
            row.get("concentration_with_target_source"),
            f"rows[{index}].concentration_with_target_source",
            minimum=0,
        )
        counterfactual = _number(
            row.get("concentration_with_target_source_removed"),
            f"rows[{index}].concentration_with_target_source_removed",
            minimum=0,
        )
        key = (cell_id, start.isoformat(), end.isoformat(), stratum)
        if key in seen:
            raise ValueError(f"Duplicate paired scenario row: {key}.")
        seen.add(key)
        result_rows.append(
            {
                "grid_cell_id": cell_id,
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
                "population_stratum": stratum,
                "unit": unit,
                "historical_concentration": historical,
                "source_removed_concentration": counterfactual,
                "paired_source_contribution": historical - counterfactual,
            }
        )

    return {
        "method_id": "fire.paired-source-removal.v1",
        "method_version": METHODS["fire.paired-source-removal.v1"]["version"],
        "model_name": model,
        "model_version": version,
        "configuration_reference": config,
        "formula": METHODS["fire.paired-source-removal.v1"]["formula"],
        "interpretation": (
            "Paired modeled concentration difference only; not a fire "
            "emissions inventory, transport simulation, causal validation, "
            "or proof of physical source contribution."
        ),
        "records": result_rows,
    }


def population_weighted_exposure(
    rows: list[Mapping[str, object]],
) -> dict:
    """Calculate paired population-weighted exposure means for one scope."""
    if not rows:
        raise ValueError("At least one population/exposure grid row is required.")
    period_start: str | None = None
    period_end: str | None = None
    stratum: str | None = None
    unit: str | None = None
    total_population = 0.0
    weighted_historical = 0.0
    weighted_counterfactual = 0.0
    seen_cells: set[str] = set()

    for index, row in enumerate(rows):
        cell_id = _text(row.get("grid_cell_id"), f"rows[{index}].grid_cell_id")
        if cell_id in seen_cells:
            raise ValueError(f"Duplicate grid cell: {cell_id}.")
        seen_cells.add(cell_id)

        start = _iso_date(row.get("period_start"), f"rows[{index}].period_start")
        end = _iso_date(row.get("period_end"), f"rows[{index}].period_end")
        if end < start:
            raise ValueError(f"rows[{index}] period_end precedes period_start.")
        row_stratum = _text(
            row.get("population_stratum"),
            f"rows[{index}].population_stratum",
        )
        row_unit = _text(row.get("unit"), f"rows[{index}].unit")
        if period_start is None:
            period_start, period_end = start.isoformat(), end.isoformat()
            stratum, unit = row_stratum, row_unit
        elif (
            period_start != start.isoformat()
            or period_end != end.isoformat()
            or stratum != row_stratum
            or unit != row_unit
        ):
            raise ValueError(
                "All rows must share the same period, population stratum, "
                "and concentration unit."
            )

        population = _number(
            row.get("population_count"),
            f"rows[{index}].population_count",
            minimum=0,
        )
        historical = _number(
            row.get("historical_concentration"),
            f"rows[{index}].historical_concentration",
            minimum=0,
        )
        counterfactual = _number(
            row.get("counterfactual_concentration"),
            f"rows[{index}].counterfactual_concentration",
            minimum=0,
        )
        total_population += population
        weighted_historical += population * historical
        weighted_counterfactual += population * counterfactual

    if total_population <= 0:
        raise ValueError("Total population must be greater than zero.")
    if not all(
        math.isfinite(value)
        for value in (total_population, weighted_historical, weighted_counterfactual)
    ):
        raise ValueError("Population-weighted aggregates must be finite.")
    historical_mean = weighted_historical / total_population
    counterfactual_mean = weighted_counterfactual / total_population
    return {
        "method_id": "exposure.population-weighted-mean.v1",
        "method_version": METHODS[
            "exposure.population-weighted-mean.v1"
        ]["version"],
        "formula": METHODS["exposure.population-weighted-mean.v1"]["formula"],
        "period_start": period_start,
        "period_end": period_end,
        "population_stratum": stratum,
        "unit": unit,
        "population_total": total_population,
        "grid_cells": len(seen_cells),
        "historical_population_weighted_mean": historical_mean,
        "counterfactual_population_weighted_mean": counterfactual_mean,
        "population_weighted_difference": historical_mean - counterfactual_mean,
        "limitations": (
            "Assumes cell populations and concentrations share compatible "
            "grid, period, stratum, and units. This calculation does not "
            "correct missing cells, validate exposure, or infer causality."
        ),
    }


def estimate_attributable_outcomes(
    *,
    endpoint_id: str,
    population_stratum: str,
    baseline_rate_per_100k_person_year: float,
    population: float,
    duration_days: float,
    relative_risk_event_vs_counterfactual: float,
    risk_function_reference: str,
    baseline_rate_reference: str,
) -> dict:
    """Estimate excess outcomes from supplied baseline rate and relative risk.

    The baseline rate is defined under the counterfactual. The supplied
    relative risk compares the event scenario with that counterfactual.
    """
    endpoint = _text(endpoint_id, "endpoint_id")
    stratum = _text(population_stratum, "population_stratum")
    risk_ref = _text(risk_function_reference, "risk_function_reference")
    baseline_ref = _text(baseline_rate_reference, "baseline_rate_reference")
    rate = _number(
        baseline_rate_per_100k_person_year,
        "baseline_rate_per_100k_person_year",
        minimum=0,
    )
    people = _number(population, "population", minimum=0)
    days = _number(duration_days, "duration_days", minimum=0)
    relative_risk = _number(
        relative_risk_event_vs_counterfactual,
        "relative_risk_event_vs_counterfactual",
    )
    if relative_risk <= 0:
        raise ValueError(
            "relative_risk_event_vs_counterfactual must be greater than zero."
        )

    baseline_expected = (
        rate * people * days / (100_000 * PERSON_YEAR_DAYS)
    )
    excess = baseline_expected * (relative_risk - 1)
    if not math.isfinite(baseline_expected) or not math.isfinite(excess):
        raise ValueError("Estimated outcome quantities must be finite.")
    return {
        "method_id": "health.baseline-rate-relative-risk.v1",
        "method_version": METHODS[
            "health.baseline-rate-relative-risk.v1"
        ]["version"],
        "formula": METHODS["health.baseline-rate-relative-risk.v1"]["formula"],
        "endpoint_id": endpoint,
        "population_stratum": stratum,
        "baseline_rate_per_100k_person_year": rate,
        "population": people,
        "duration_days": days,
        "relative_risk_event_vs_counterfactual": relative_risk,
        "baseline_expected_outcomes": baseline_expected,
        "estimated_excess_outcomes": excess,
        "baseline_rate_reference": baseline_ref,
        "risk_function_reference": risk_ref,
        "assumptions": [
            "The baseline rate represents the declared counterfactual.",
            "The supplied relative risk applies to the same outcome, "
            "population stratum, geography, exposure window, and duration.",
            "The rate and relative risk are constant over the modeled period.",
            "No lag, competing-risk, age-standardization, or uncertainty "
            "calculation is performed by this primitive.",
        ],
        "scientific_review_status": "not_assessed_by_software",
    }


def value_physical_outcome(
    *,
    endpoint_id: str,
    quantity: float,
    quantity_unit: str,
    unit_value: float,
    compatible_unit: str,
    currency: str,
    price_year: int,
    unit_value_reference: str,
) -> dict:
    """Multiply one physical quantity by an explicitly supplied unit value."""
    endpoint = _text(endpoint_id, "endpoint_id")
    unit = _text(quantity_unit, "quantity_unit")
    compatible = _text(compatible_unit, "compatible_unit")
    money = _text(currency, "currency")
    reference = _text(unit_value_reference, "unit_value_reference")
    if unit != compatible:
        raise ValueError(
            f"Unit mismatch: quantity unit {unit!r} != unit value unit {compatible!r}."
        )
    amount = _number(quantity, "quantity", minimum=0)
    value = _number(unit_value, "unit_value", minimum=0)
    valued_amount = amount * value
    if not math.isfinite(valued_amount):
        raise ValueError("valued_amount is not finite.")
    if isinstance(price_year, bool) or not isinstance(price_year, int):
        raise ValueError("price_year must be an integer.")
    if price_year < 1900 or price_year > 2200:
        raise ValueError("price_year must be between 1900 and 2200.")
    return {
        "method_id": "economics.declared-unit-value.v1",
        "method_version": METHODS[
            "economics.declared-unit-value.v1"
        ]["version"],
        "formula": METHODS["economics.declared-unit-value.v1"]["formula"],
        "endpoint_id": endpoint,
        "quantity": amount,
        "quantity_unit": unit,
        "unit_value": value,
        "unit_value_reference": reference,
        "valued_amount": valued_amount,
        "currency": money,
        "price_year": price_year,
        "limitations": (
            "Arithmetic only. No currency conversion, inflation adjustment, "
            "discounting, incidence reconciliation, or unit-value "
            "applicability review is performed."
        ),
        "valuation_review_status": "not_assessed_by_software",
    }
