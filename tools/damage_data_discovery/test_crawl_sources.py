import json
import tempfile
import unittest
from pathlib import Path

from crawl_sources import (
    SeedError,
    candidate_links,
    load_seeds,
    relevant_excerpts,
    request_is_allowed,
    summarize_result,
    write_report,
)
from summarize_report import local_chat_endpoint, make_request, select_record


class SourceDiscoveryTests(unittest.TestCase):
    def test_seed_file_contains_unique_https_sources_with_allowed_hosts(self):
        seeds = load_seeds()
        self.assertGreaterEqual(len(seeds), 8)
        self.assertEqual(len({seed["id"] for seed in seeds}), len(seeds))
        self.assertEqual(len({seed["url"] for seed in seeds}), len(seeds))

    def test_invalid_seed_host_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seeds.json"
            path.write_text(
                json.dumps(
                    {
                        "sources": [
                            {
                                "id": "bad",
                                "url": "https://evil.example/data",
                                "allowed_hosts": ["official.example"],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SeedError):
                load_seeds(path)

    def test_seed_sources_have_curated_triage_annotations(self):
        seeds = load_seeds()
        for seed in seeds:
            with self.subTest(source_id=seed["id"]):
                self.assertIn(
                    seed["triage_role"],
                    {
                        "candidate_product",
                        "catalogue_documentation",
                        "bounded_api_sample",
                        "supporting_context",
                        "method_reference",
                    },
                )
                self.assertTrue(seed["potential_inputs"])
                self.assertTrue(seed["known_limitations"].strip())

    def test_missing_seed_triage_annotation_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seeds.json"
            path.write_text(
                json.dumps(
                    {
                        "sources": [
                            {
                                "id": "unannotated",
                                "url": "https://official.example/data",
                                "allowed_hosts": ["official.example"],
                                "category": "data",
                                "purpose": "test",
                                "terms": ["data"],
                                "triage_role": "candidate_product",
                                "potential_inputs": ["ambient_pm25_field"],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SeedError):
                load_seeds(path)

    def test_network_guard_allows_only_https_get_on_approved_hosts(self):
        approved = {"hub.worldpop.org"}
        self.assertTrue(
            request_is_allowed(
                "https://hub.worldpop.org/rest/data/pop", "GET", approved
            )
        )
        self.assertFalse(
            request_is_allowed(
                "http://hub.worldpop.org/rest/data/pop", "GET", approved
            )
        )
        self.assertFalse(
            request_is_allowed(
                "https://hub.worldpop.org/rest/data/pop", "POST", approved
            )
        )
        self.assertFalse(
            request_is_allowed(
                "https://hub.worldpop.org:8443/rest/data/pop", "GET", approved
            )
        )
        self.assertFalse(
            request_is_allowed(
                "https://evil.example/rest/data/pop", "GET", approved
            )
        )

    def test_excerpts_are_relevant_bounded_and_unique(self):
        text = (
            "This is a general page introduction with no dataset details.\n"
            "The product provides global PM2.5 reanalysis at 0.75 degree resolution.\n"
            "The product provides global PM2.5 reanalysis at 0.75 degree resolution.\n"
        )
        excerpts = relevant_excerpts(text, ["PM2.5", "resolution"])
        self.assertEqual(len(excerpts), 1)
        self.assertLessEqual(len(excerpts[0]), 360)

    def test_candidate_links_are_same_host_only(self):
        links = candidate_links(
            {
                "internal": [
                    {
                        "href": "https://hub.worldpop.org/rest/data/pop/123",
                        "text": "Dataset API",
                    },
                    {
                        "href": "https://evil.example/redirect",
                        "text": "External",
                    },
                ]
            },
            {"hub.worldpop.org"},
        )
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["text"], "Dataset API")

    def test_candidate_links_rank_terms_and_reject_nonstandard_ports(self):
        links = candidate_links(
            {
                "internal": [
                    {
                        "href": "https://hub.worldpop.org/catalog/other",
                        "text": "General dataset",
                    },
                    {
                        "href": "https://hub.worldpop.org/catalog/population",
                        "text": "Population grid",
                    },
                    {
                        "href": "https://hub.worldpop.org:8443/catalog/population",
                        "text": "Population grid alternate port",
                    },
                ]
            },
            {"hub.worldpop.org"},
            ["population"],
        )
        self.assertEqual(links[0]["text"], "Population grid")
        self.assertNotIn(":8443", links[0]["url"])

    def test_failed_result_never_claims_source_is_verified(self):
        class FailedResult:
            success = False
            status_code = 403
            redirected_url = None
            metadata = {}
            markdown = ""
            links = {}
            error_message = "blocked by robots policy"

        record = summarize_result(
            {
                "id": "example",
                "category": "population grid",
                "purpose": "test seed",
                "url": "https://hub.worldpop.org/rest/data/pop",
                "allowed_hosts": ["hub.worldpop.org"],
                "terms": ["population"],
                "triage_role": "candidate_product",
                "potential_inputs": ["population_grid"],
                "known_limitations": "Catalog not data.",
            },
            FailedResult(),
        )
        self.assertEqual(record["status"], "unavailable_or_blocked")
        self.assertIn("Discovery lead only", record["assessment"])
        self.assertEqual(record["potential_inputs"], ["population_grid"])
        self.assertEqual(record["triage_role"], "candidate_product")

    def test_report_includes_source_triage_in_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            _, markdown_path = write_report(
                [
                    {
                        "id": "pm25",
                        "category": "air quality",
                        "purpose": "Compare monitor data.",
                        "triage_role": "bounded_api_sample",
                        "potential_inputs": ["ambient_pm25_validation"],
                        "known_limitations": "Not a gridded exposure product.",
                        "status": "candidate_page_crawled",
                        "seed_url": "https://api.example.org/data",
                        "title": None,
                        "http_status": 200,
                        "matched_terms": [],
                        "error": None,
                        "evidence_excerpts": [],
                        "official_candidate_links": [],
                        "assessment": "Discovery lead only.",
                    }
                ],
                Path(directory),
            )
            report_text = markdown_path.read_text(encoding="utf-8")
        self.assertIn("Triage role: `bounded_api_sample`", report_text)
        self.assertIn("Potential inputs: ambient_pm25_validation", report_text)
        self.assertIn("Not a gridded exposure product.", report_text)

    def test_summary_endpoint_is_limited_to_local_meterless(self):
        self.assertEqual(
            local_chat_endpoint("http://127.0.0.1:8088/v1"),
            "http://127.0.0.1:8088/v1/chat/completions",
        )
        with self.assertRaises(ValueError):
            local_chat_endpoint("https://integrate.api.nvidia.com/v1")

    def test_summary_sends_only_bounded_selected_report_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            report_path.write_text(
                json.dumps(
                    {
                        "records": [
                            {
                                "id": "pm25",
                                "category": "air quality",
                                "purpose": "monitor data",
                                "status": "candidate_page_crawled",
                                "http_status": 200,
                                "seed_url": "https://example.org/private-extra",
                                "official_candidate_links": [{"url": "https://example.org"}],
                                "evidence_excerpts": [
                                    "x" * 900,
                                    "Second excerpt",
                                    "Third excerpt",
                                    "Fourth excerpt",
                                    "Fifth excerpt",
                                    "Sixth excerpt",
                                ],
                                "assessment": "Discovery only.",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            evidence = select_record(report_path, "pm25")

        self.assertNotIn("seed_url", evidence)
        self.assertNotIn("official_candidate_links", evidence)
        self.assertEqual(len(evidence["evidence_excerpts"]), 5)
        self.assertEqual(len(evidence["evidence_excerpts"][0]), 800)

        request = make_request(
            "http://127.0.0.1:8088/v1/chat/completions",
            "meterless/auto",
            "test-key",
            evidence,
        )
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "meterless/auto")
        self.assertIn('"id": "pm25"', payload["messages"][1]["content"])
        self.assertNotIn("private-extra", payload["messages"][1]["content"])


if __name__ == "__main__":
    unittest.main()
