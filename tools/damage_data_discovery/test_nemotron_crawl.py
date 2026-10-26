import json
import unittest

from nemotron_crawl import (
    MAX_PAGE_CHARS,
    make_request,
    nvidia_chat_endpoint,
    page_text,
)


class NemotronCrawlTests(unittest.TestCase):
    def test_nvidia_endpoint_is_restricted_to_expected_https_service(self):
        self.assertEqual(
            nvidia_chat_endpoint("https://integrate.api.nvidia.com/v1"),
            "https://integrate.api.nvidia.com/v1/chat/completions",
        )
        for url in (
            "https://example.org/v1",
            "http://integrate.api.nvidia.com/v1",
            "https://user:pass@integrate.api.nvidia.com/v1",
            "https://integrate.api.nvidia.com:8443/v1",
            "https://integrate.api.nvidia.com/v1?redirect=example.org",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                nvidia_chat_endpoint(url)

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

    def test_request_contains_bounded_page_evidence_and_nemotron_settings(self):
        request = make_request(
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "test-model",
            "test-key",
            {
                "id": "pm25",
                "category": "air quality",
                "purpose": "Sample public pollution data",
            },
            "PM2.5 data",
            "https://api.example.org/data",
            200,
            "A" * (MAX_PAGE_CHARS + 100),
        )
        payload = json.loads(request.data.decode("utf-8"))
        evidence = json.loads(payload["messages"][1]["content"])
        self.assertEqual(len(evidence["page_text"]), MAX_PAGE_CHARS)
        self.assertEqual(payload["model"], "test-model")
        self.assertTrue(
            payload["extra_body"]["chat_template_kwargs"]["enable_thinking"]
        )
        self.assertEqual(payload["extra_body"]["reasoning_budget"], 1024)
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")


if __name__ == "__main__":
    unittest.main()
