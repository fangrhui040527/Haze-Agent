import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pilot_pm25


def sample_rows():
    return [
        {"date": "2024-12-01", "pollutant": "PM 2.5", "concentration": 11.54},
        {"date": "2024-11-01", "pollutant": "PM 2.5", "concentration": 12.33},
        {"date": "2024-10-01", "pollutant": "PM 2.5", "concentration": 14.4},
    ]


class Pm25SourcePilotTests(unittest.TestCase):
    def test_valid_sample_passes_row_date_and_value_checks_but_is_not_ready(self):
        raw_sha = hashlib.sha256(b"sample").hexdigest()
        normalized, report = pilot_pm25.validate_records(
            sample_rows(), "2026-10-27T00:00:00+00:00", raw_sha
        )

        self.assertEqual(len(normalized["records"]), 3)
        self.assertEqual(report["observed_period"]["start"], "2024-10-01")
        self.assertEqual(report["observed_period"]["end"], "2024-12-01")
        for name in (
            "response_shape",
            "row_count",
            "required_fields",
            "date_values_and_order",
            "missingness",
            "duplicates",
            "concentration_values",
        ):
            self.assertEqual(report["checks"][name]["status"], "pass")
        self.assertEqual(report["checks"]["units"]["status"], "unknown")
        self.assertEqual(
            report["checks"]["geographic_coverage"]["status"], "unknown"
        )
        self.assertEqual(
            report["checks"]["independent_comparison"]["status"],
            "not_performed",
        )
        self.assertFalse(report["pilot_ready_for_exposure_modeling"])
        self.assertIsNone(normalized["records"][0]["concentration_unit"])
        self.assertIsNone(normalized["records"][0]["geography"])

    def test_invalid_and_duplicate_rows_are_reported(self):
        records = sample_rows()
        records[1] = dict(records[0])
        records[2]["concentration"] = -1
        _, report = pilot_pm25.validate_records(
            records, "2026-10-27T00:00:00+00:00", "abc"
        )
        self.assertEqual(report["checks"]["duplicates"]["status"], "fail")
        self.assertEqual(report["checks"]["concentration_values"]["status"], "fail")
        self.assertTrue(report["errors"])

    def test_missing_fields_and_wrong_polarity_do_not_pass_validation(self):
        records = sample_rows()
        records[0]["concentration"] = None
        records[1]["pollutant"] = "PM10"
        _, report = pilot_pm25.validate_records(
            records, "2026-10-27T00:00:00+00:00", "abc"
        )
        self.assertEqual(report["checks"]["missingness"]["status"], "fail")
        self.assertEqual(report["checks"]["required_fields"]["status"], "fail")
        self.assertEqual(report["checks"]["concentration_values"]["status"], "fail")

    def test_raw_response_is_preserved_separately_from_normalized_output(self):
        body = json.dumps(sample_rows()).encode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(pilot_pm25, "OUTPUT_DIR", Path(directory)):
                raw_path, normalized_path, report_path, report = (
                    pilot_pm25.write_artifacts(
                        body, "2026-10-27T00:00:00+00:00"
                    )
                )

            self.assertEqual(raw_path.read_bytes(), body)
            self.assertNotEqual(raw_path, normalized_path)
            normalized = json.loads(normalized_path.read_text(encoding="utf-8"))
            saved_report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(len(normalized["records"]), 3)
            self.assertEqual(
                saved_report["raw_response_sha256"],
                hashlib.sha256(body).hexdigest(),
            )
            self.assertFalse(report["pilot_ready_for_exposure_modeling"])


if __name__ == "__main__":
    unittest.main()
