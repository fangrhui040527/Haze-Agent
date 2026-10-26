#!/usr/bin/env python3
"""Acquire and validate a bounded Data.gov.my PM2.5 source pilot."""

from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "run-output" / "pilot"
SOURCE_ID = "data_gov_my_air_pollution_pm25_api"
SOURCE_URL = (
    "https://api.data.gov.my/data-catalogue/"
    "?id=air_pollution&contains=PM%202.5%40pollutant&sort=-date&limit=3"
)
USER_AGENT = (
    "HazeDamageDataDiscovery/0.1 "
    "(public-data pilot; contact project owner)"
)
MAX_RESPONSE_BYTES = 2_000_000
EXPECTED_ROWS = 3


def validate_records(
    records: object, retrieved_at: str, raw_sha256: str
) -> tuple[dict, dict]:
    """Return a bounded normalized sample and validation report."""
    rows_are_list = isinstance(records, list)
    rows = records if rows_are_list else []
    normalized: list[dict] = []
    errors: list[str] = []
    dates: list[date] = []
    seen_dates: set[str] = set()
    duplicate_dates: list[str] = []
    missing_fields: list[dict] = []
    invalid_rows: list[dict] = []

    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            invalid_rows.append({"row": index, "reason": "row is not an object"})
            continue

        missing = [
            field
            for field in ("date", "pollutant", "concentration")
            if field not in row or row[field] is None
        ]
        if missing:
            missing_fields.append({"row": index, "fields": missing})
            continue

        row_date: date | None = None
        date_value = row["date"]
        if isinstance(date_value, str):
            try:
                row_date = date.fromisoformat(date_value)
            except ValueError:
                pass
        if row_date is None:
            invalid_rows.append(
                {"row": index, "reason": "date is not an ISO calendar date"}
            )
            continue

        pollutant = row["pollutant"]
        is_pm25 = (
            isinstance(pollutant, str)
            and pollutant.strip().casefold() == "pm 2.5"
        )
        if not is_pm25:
            invalid_rows.append(
                {"row": index, "reason": "pollutant is not PM 2.5"}
            )
            continue

        value = row["concentration"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            invalid_rows.append(
                {"row": index, "reason": "concentration is not numeric"}
            )
            continue
        if not math.isfinite(value) or value < 0:
            invalid_rows.append(
                {"row": index, "reason": "concentration must be finite and nonnegative"}
            )
            continue

        date_string = row_date.isoformat()
        if date_string in seen_dates:
            duplicate_dates.append(date_string)
        seen_dates.add(date_string)
        dates.append(row_date)
        normalized.append(
            {
                "observed_month": date_string,
                "pollutant": "PM 2.5",
                "concentration_value": float(value),
                "concentration_unit": None,
                "geography": None,
                "source_id": SOURCE_ID,
                "source_row_index": index,
            }
        )

    if not rows_are_list:
        errors.append("Response root must be a JSON array.")
    if len(rows) != EXPECTED_ROWS:
        errors.append(
            f"Expected {EXPECTED_ROWS} sample rows; received {len(rows)}."
        )
    if missing_fields:
        errors.append("One or more rows are missing required fields.")
    if invalid_rows:
        errors.append("One or more rows have invalid values.")
    if duplicate_dates:
        errors.append("Duplicate observation months were found.")

    dates_descending = dates == sorted(dates, reverse=True)
    if not dates_descending and dates:
        errors.append("Observation months are not ordered newest first.")

    if dates:
        observed_period = {
            "start": min(dates).isoformat(),
            "end": max(dates).isoformat(),
            "distinct_months": len(set(dates)),
        }
    else:
        observed_period = None

    checks = {
        "response_shape": {
            "status": "pass" if rows_are_list else "fail",
            "detail": "JSON array" if rows_are_list else "Expected a JSON array.",
        },
        "row_count": {
            "status": "pass" if len(rows) == EXPECTED_ROWS else "fail",
            "expected": EXPECTED_ROWS,
            "actual": len(rows),
        },
        "required_fields": {
            "status": (
                "fail" if missing_fields or invalid_rows else "pass"
            ),
            "fields": ["date", "pollutant", "concentration"],
            "missing": missing_fields,
            "invalid": invalid_rows,
        },
        "date_values_and_order": {
            "status": (
                "pass"
                if dates and dates_descending and not duplicate_dates
                else "fail"
            ),
            "observed_period": observed_period,
            "newest_first": dates_descending,
            "duplicate_months": sorted(set(duplicate_dates)),
        },
        "missingness": {
            "status": "pass" if not missing_fields else "fail",
            "missing_rows": len(missing_fields),
        },
        "duplicates": {
            "status": "pass" if not duplicate_dates else "fail",
            "duplicate_months": sorted(set(duplicate_dates)),
        },
        "concentration_values": {
            "status": "fail" if invalid_rows else "pass",
            "validated_rows": len(normalized),
            "expected_pollutant": "PM 2.5",
        },
        "units": {
            "status": "unknown",
            "detail": (
                "The sampled response does not include a unit field. "
                "Confirm the official dataset metadata before use."
            ),
        },
        "geographic_coverage": {
            "status": "unknown",
            "detail": (
                "Sample rows contain no station, coordinate, or administrative "
                "geography field. The API provider context does not establish "
                "row-level spatial coverage."
            ),
        },
        "coordinate_reference_system": {
            "status": "not_applicable",
            "detail": "The sampled response contains no coordinates.",
        },
        "independent_comparison": {
            "status": "not_performed",
            "detail": (
                "No independent monitor or product was compared in this "
                "source-acquisition smoke test."
            ),
        },
    }
    pilot_ready = all(
        checks[name]["status"] == "pass"
        for name in (
            "response_shape",
            "row_count",
            "required_fields",
            "date_values_and_order",
            "missingness",
            "duplicates",
            "concentration_values",
        )
    ) and all(
        checks[name]["status"] == "pass"
        for name in ("units", "geographic_coverage", "independent_comparison")
    )

    normalized_artifact = {
        "schema_version": "haze.damage-source-pilot.pm25.v1",
        "source_id": SOURCE_ID,
        "source_url": SOURCE_URL,
        "retrieved_at_utc": retrieved_at,
        "raw_response_sha256": raw_sha256,
        "scope_note": (
            "Bounded monthly source-acquisition sample only; not a defined "
            "haze event, gridded exposure field, or DamageAccountant input."
        ),
        "records": normalized,
    }
    report = {
        "schema_version": "haze.damage-source-pilot.validation.v1",
        "source_id": SOURCE_ID,
        "source_url": SOURCE_URL,
        "retrieved_at_utc": retrieved_at,
        "raw_response_sha256": raw_sha256,
        "observed_period": observed_period,
        "requested_rows": EXPECTED_ROWS,
        "received_rows": len(rows),
        "checks": checks,
        "errors": errors,
        "pilot_ready_for_exposure_modeling": pilot_ready,
        "limitations": [
            "This is a three-row API acquisition smoke test, not an event-level study.",
            "The response does not provide a verified concentration unit.",
            "The response does not provide row-level geography or coordinates.",
            "The monthly aggregates are not a gridded population exposure product.",
            "No independent product or monitor comparison was performed.",
        ],
    }
    return normalized_artifact, report


def write_artifacts(
    body: bytes, retrieved_at: str
) -> tuple[Path, Path, Path, dict]:
    timestamp = datetime.fromisoformat(retrieved_at).strftime("%Y%m%dT%H%M%SZ")
    raw_dir = OUTPUT_DIR / "raw"
    normalized_dir = OUTPUT_DIR / "normalized"
    reports_dir = OUTPUT_DIR / "reports"
    for directory in (raw_dir, normalized_dir, reports_dir):
        directory.mkdir(parents=True, exist_ok=True)

    raw_path = raw_dir / f"pm25_{timestamp}.json"
    normalized_path = normalized_dir / f"pm25_{timestamp}.json"
    report_path = reports_dir / f"pm25_{timestamp}.json"
    raw_path.write_bytes(body)
    raw_sha256 = hashlib.sha256(body).hexdigest()
    records = json.loads(body.decode("utf-8"))
    normalized, report = validate_records(records, retrieved_at, raw_sha256)
    try:
        raw_reference = raw_path.relative_to(ROOT)
        normalized_reference = normalized_path.relative_to(ROOT)
    except ValueError:
        raw_reference = raw_path.relative_to(OUTPUT_DIR)
        normalized_reference = normalized_path.relative_to(OUTPUT_DIR)
    normalized["raw_file"] = str(raw_reference)
    report["raw_file"] = str(raw_reference)
    report["normalized_file"] = str(normalized_reference)
    normalized_path.write_text(
        json.dumps(normalized, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return raw_path, normalized_path, report_path, report


def fetch_sample() -> tuple[bytes, str]:
    request = Request(
        SOURCE_URL,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        method="GET",
    )
    with urlopen(request, timeout=45) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError(
                f"API response exceeded {MAX_RESPONSE_BYTES} bytes."
            )
        if response.status != 200:
            raise RuntimeError(f"API returned unexpected HTTP {response.status}.")
    return body, datetime.now(timezone.utc).isoformat()


def main() -> int:
    try:
        body, retrieved_at = fetch_sample()
        raw_path, normalized_path, report_path, report = write_artifacts(
            body, retrieved_at
        )
        print(f"Retrieved {report['received_rows']} row(s) from {SOURCE_ID}.")
        print(f"Raw response: {raw_path}")
        print(f"Normalized sample: {normalized_path}")
        print(f"Validation report: {report_path}")
        for name, check in report["checks"].items():
            print(f"  {name}: {check['status']}")
        print(
            "Ready for exposure modeling: "
            f"{report['pilot_ready_for_exposure_modeling']}"
        )
        if report["errors"]:
            for error in report["errors"]:
                print(f"Validation issue: {error}", file=sys.stderr)
        return 0 if not report["errors"] else 1
    except HTTPError as error:
        print(f"Data.gov.my API returned HTTP {error.code}.", file=sys.stderr)
        return 1
    except (
        OSError,
        URLError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
        RuntimeError,
    ) as error:
        print(f"PM2.5 source pilot failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
