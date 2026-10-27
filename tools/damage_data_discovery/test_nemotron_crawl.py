import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from nemotron_crawl import (
    EXTRACTION_FIELDS,
    MAX_PAGE_CHARS,
    build_extraction_strategy,
    inspect_page,
    main,
    nvidia_api_base_url,
    page_text,
)

TEST_SEED = {
    "id": "pm25",
    "category": "air quality",
    "purpose": "Sample public pollution data",
    "triage_role": "bounded_api_sample",
    "potential_inputs": ["ambient_pm25_validation"],
    "known_limitations": "Not a gridded exposure product.",
}


class NemotronCrawlTests(unittest.TestCase):
    def test_nvidia_base_url_is_restricted_to_expected_https_service(self):
        self.assertEqual(
            nvidia_api_base_url("https://integrate.api.nvidia.com/v1"),
            "https://integrate.api.nvidia.com/v1",
        )
        for url in (
            "https://example.org/v1",
            "http://integrate.api.nvidia.com/v1",
            "******integrate.api.nvidia.com/v1",
            "https://integrate.api.nvidia.com:8443/v1",
            "https://integrate.api.nvidia.com/v1?redirect=example.org",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                nvidia_api_base_url(url)

    def test_page_text_handles_crawl4ai_markdown_and_enforces_limit(self):
        class Result:
            markdown = "x" * (MAX_PAGE_CHARS + 20)

        self.assertEqual(len(page_text(Result())), MAX_PAGE_CHARS)

        class RichMarkdown:
            raw_markdown = "Fetched page content"

        class RichResult:
            markdown = RichMarkdown()

        self.assertEqual(page_text(RichResult()), "Fetched page content")

        class EmptyResult:
            markdown = ""

        with self.assertRaises(ValueError):
            page_text(EmptyResult())

    def test_strategy_uses_crawl4ai_and_nvidia_compatible_configuration(self):
        strategy = build_extraction_strategy(
            "https://integrate.api.nvidia.com/v1",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "test-key",
        )

        self.assertEqual(
            strategy.llm_config.provider,
            "openai/nvidia/nemotron-3.5-lightning-30b-a3b",
        )
        self.assertEqual(
            strategy.llm_config.base_url,
            "https://integrate.api.nvidia.com/v1",
        )
        self.assertEqual(strategy.llm_config.api_token, "test-key")
        self.assertTrue(strategy.force_json_response)
        self.assertFalse(strategy.apply_chunking)
        self.assertEqual(
            strategy.extra_args["max_tokens"],
            4096,
        )
        self.assertEqual(
            strategy.extra_args["extra_body"]["chat_template_kwargs"],
            {"enable_thinking": True},
        )
        self.assertEqual(
            strategy.schema["required"],
            list(EXTRACTION_FIELDS),
        )

    def test_strategy_calls_configured_provider_and_parses_schema_response(self):
        strategy = build_extraction_strategy(
            "https://integrate.api.nvidia.com/v1",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "test-key",
        )
        expected = {field: [] for field in EXTRACTION_FIELDS}
        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=json.dumps(expected)),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(
                completion_tokens=1,
                prompt_tokens=1,
                total_tokens=2,
                completion_tokens_details=None,
                prompt_tokens_details=None,
            ),
        )

        with patch(
            "crawl4ai.extraction_strategy.perform_completion_with_backoff",
            return_value=response,
        ) as complete:
            result = strategy.run("https://source.example/data", ["page evidence"])

        self.assertEqual(result[0]["candidate_fields"], [])
        self.assertFalse(result[0]["error"])
        self.assertEqual(
            complete.call_args.args[0],
            "openai/nvidia/nemotron-3.5-lightning-30b-a3b",
        )
        self.assertEqual(complete.call_args.args[2], "test-key")
        self.assertEqual(
            complete.call_args.kwargs["base_url"],
            "https://integrate.api.nvidia.com/v1",
        )
        self.assertTrue(complete.call_args.kwargs["json_response"])

    def test_inspection_caps_evidence_and_returns_only_schema_fields(self):
        class FakeStrategy:
            def run(self, url, sections):
                self.url = url
                self.evidence = sections[0]
                return [
                    {
                        **{
                            field: ["verified candidate"]
                            for field in EXTRACTION_FIELDS
                        },
                        "index": 0,
                        "error": False,
                    }
                ]

        strategy = FakeStrategy()
        answer = inspect_page(
            strategy,
            TEST_SEED,
            "PM2.5 data",
            "https://api.example.org/data",
            200,
            "A" * (MAX_PAGE_CHARS + 100),
        )

        self.assertEqual(strategy.url, "https://api.example.org/data")
        self.assertEqual(
            len(json.loads(strategy.evidence)["page_text"]),
            MAX_PAGE_CHARS,
        )
        self.assertEqual(set(answer), set(EXTRACTION_FIELDS))

    def test_inspection_surfaces_extraction_and_schema_errors(self):
        class FailedStrategy:
            def run(self, _url, _sections):
                return [{"error": True, "content": "provider request failed"}]

        with self.assertRaisesRegex(RuntimeError, "provider request failed"):
            inspect_page(
                FailedStrategy(), TEST_SEED, "", "https://example.org", 200, "page"
            )

        class InvalidStrategy:
            def run(self, _url, _sections):
                return [{"candidate_fields": ["one field"]}]

        with self.assertRaisesRegex(ValueError, "invalid extraction schema"):
            inspect_page(
                InvalidStrategy(), TEST_SEED, "", "https://example.org", 200, "page"
            )

    def test_dry_run_does_not_read_environment_file_or_call_network(self):
        with patch(
            "nemotron_crawl.read_env_file",
            side_effect=AssertionError("dry run must not load credentials"),
        ):
            self.assertEqual(main(["--dry-run"]), 0)


if __name__ == "__main__":
    unittest.main()
