#!/usr/bin/env python3
"""Summarize one crawler report record through a local Meterless endpoint."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DEFAULT_REPORT = ROOT / "run-output" / "latest.json"
DEFAULT_ENV = ROOT / ".env"
DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1"
DEFAULT_MODEL = "meterless/auto"
MAX_EXCERPTS = 5
MAX_EXCERPT_CHARS = 800


def read_env_file(path: Path = DEFAULT_ENV) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip("\"'")
    return values


def get_config(name: str, file_values: dict[str, str], default: str = "") -> str:
    return os.environ.get(name, file_values.get(name, default)).strip()


def local_chat_endpoint(base_url: str) -> str:
    parts = urlsplit(base_url)
    if (
        parts.scheme != "http"
        or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parts.username is not None
        or parts.password is not None
        or parts.port not in {None, 80, 8088}
        or parts.query
        or parts.fragment
    ):
        raise ValueError(
            "Meterless base URL must be a local HTTP endpoint on localhost."
        )
    return base_url.rstrip("/") + "/chat/completions"


def select_record(report_path: Path, source_id: str) -> dict:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    records = report.get("records") if isinstance(report, dict) else None
    if not isinstance(records, list):
        raise ValueError("Crawler report must contain a records array.")
    for record in records:
        if isinstance(record, dict) and record.get("id") == source_id:
            return {
                "id": record.get("id"),
                "category": record.get("category"),
                "purpose": record.get("purpose"),
                "status": record.get("status"),
                "http_status": record.get("http_status"),
                "evidence_excerpts": [
                    excerpt[:MAX_EXCERPT_CHARS]
                    for excerpt in record.get("evidence_excerpts", [])[
                        :MAX_EXCERPTS
                    ]
                    if isinstance(excerpt, str)
                ],
                "assessment": record.get("assessment"),
            }
    raise ValueError(f"Source id not found in crawler report: {source_id}")


def make_request(
    endpoint: str, model: str, api_key: str, evidence: dict
) -> Request:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Summarize only the supplied crawler evidence. State the "
                    "finding and one limitation. Do not infer facts absent "
                    "from the evidence."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(evidence, ensure_ascii=False),
            },
        ],
        "temperature": 0,
        "max_tokens": 300,
        "stream": False,
    }
    return Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-id",
        default="data_gov_my_air_pollution_pm25_api",
        help="Reviewed source id to summarize from the latest crawler report.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT,
        help="Path to the crawler JSON report.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        file_values = read_env_file()
        base_url = get_config("METERLESS_BASE_URL", file_values, DEFAULT_BASE_URL)
        endpoint = local_chat_endpoint(base_url)
        model = get_config("METERLESS_MODEL", file_values, DEFAULT_MODEL)
        api_key = get_config("METERLESS_API_KEY", file_values)
        if not api_key or api_key == "-" or api_key.startswith("replace-with-"):
            raise ValueError(
                "Set a valid METERLESS_API_KEY in tools\\damage_data_discovery\\.env."
            )
        evidence = select_record(args.report, args.source_id)
        request = make_request(endpoint, model, api_key, evidence)
        with urlopen(request, timeout=90) as response:
            result = json.loads(response.read().decode("utf-8"))
        content = result.get("choices", [{}])[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Meterless returned no assistant message content.")
        print(f"Source: {args.source_id}")
        print(content.strip())
        return 0
    except HTTPError as error:
        print(f"Meterless returned HTTP {error.code}.", file=sys.stderr)
        try:
            result = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = result.get("error", {})
            message = detail.get("message")
            if message:
                print(f"API error: {message}", file=sys.stderr)
            provider_detail = detail.get("meterless_detail")
            if provider_detail:
                print(f"Provider detail: {provider_detail}", file=sys.stderr)
        except (json.JSONDecodeError, AttributeError):
            pass
        return 1
    except (OSError, URLError, json.JSONDecodeError, ValueError) as error:
        print(f"AI summary failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
