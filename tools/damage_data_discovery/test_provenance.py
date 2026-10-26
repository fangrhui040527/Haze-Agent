import hashlib
import tempfile
import unittest
from pathlib import Path

from provenance import build_file_manifest, validate_manifest


class ProvenanceManifestTests(unittest.TestCase):
    def test_file_manifest_records_verified_hash_and_explicit_unknowns(self):
        with tempfile.TemporaryDirectory() as directory:
            raw_path = Path(directory) / "raw.json"
            normalized_path = Path(directory) / "normalized.json"
            raw_path.write_bytes(b'{"raw":true}')
            normalized_path.write_bytes(b'{"normalized":true}')
            manifest = build_file_manifest(
                manifest_id="source-run-1",
                created_at_utc="2026-10-27T00:00:00+00:00",
                source_id="source",
                source_url="https://example.org/data",
                retrieved_at_utc="2026-10-27T00:00:00+00:00",
                dataset_version="not provided",
                license_status="not verified",
                artifacts=[
                    {
                        "artifact_id": "raw",
                        "path": raw_path,
                        "display_path": "raw.json",
                        "media_type": "application/json",
                        "role": "unaltered source response",
                    },
                    {
                        "artifact_id": "normalized",
                        "path": normalized_path,
                        "display_path": "normalized.json",
                        "media_type": "application/json",
                        "role": "normalized data",
                    },
                ],
                transformations=[
                    {
                        "step_id": "normalize",
                        "description": "Map fields while preserving null unknowns.",
                        "implementation": "pilot",
                        "version": "1",
                    }
                ],
                quality_checks=[{"check": "row_count", "status": "pass"}],
                exclusions=[],
                uncertainty={
                    "status": "not_quantified",
                    "method": "none",
                    "limitations": ["No uncertainty fields in source."],
                },
            )
            validate_manifest(manifest)
            self.assertEqual(
                manifest["artifacts"][0]["sha256"],
                hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            )

        self.assertEqual(
            manifest["artifacts"][0]["sha256"],
            hashlib.sha256(b'{"raw":true}').hexdigest(),
        )
        self.assertEqual(manifest["sources"][0]["dataset_version"], "not provided")

    def test_manifest_rejects_missing_source_version_or_bad_digest(self):
        base = {
            "schema_version": "haze.data-provenance.v1",
            "manifest_id": "run",
            "created_at_utc": "2026-10-27T00:00:00+00:00",
            "sources": [
                {
                    "source_id": "source",
                    "source_url": "https://example.org",
                    "retrieved_at_utc": "2026-10-27T00:00:00+00:00",
                    "dataset_version": "",
                    "license_status": "unknown",
                }
            ],
            "artifacts": [
                {
                    "artifact_id": "raw",
                    "path": "raw.json",
                    "sha256": "not-a-digest",
                    "media_type": "application/json",
                    "role": "raw",
                }
            ],
            "transformations": [],
            "quality_checks": [],
            "exclusions": [],
            "uncertainty": {
                "status": "not_quantified",
                "method": "none",
                "limitations": [],
            },
        }
        with self.assertRaisesRegex(ValueError, "dataset_version"):
            validate_manifest(base)
        base["sources"][0]["dataset_version"] = "unknown"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            validate_manifest(base)


if __name__ == "__main__":
    unittest.main()
