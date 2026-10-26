#!/usr/bin/env python3
"""Bounded Crawl4AI discovery of reviewed official data/product pages.

This is source discovery only. It does not download datasets, call discovered
links, access authenticated endpoints, or write to Zetaris.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SEEDS_PATH = ROOT / "seed_sources.json"
OUTPUT_DIR = ROOT / "run-output"
USER_AGENT = "HazeDamageDataDiscovery/0.1 (official-source research; contact project owner)"
REQUEST_DELAY_SECONDS = 1.0
MAX_EXCERPTS = 12
MAX_LINKS = 60
MAX_EXCERPT_CHARS = 360

# Keep Crawl4AI's browser cache/log under the ignored output folder.
os.environ.setdefault("CRAWL4_AI_BASE_DIRECTORY", str(OUTPUT_DIR))
os.environ.setdefault("CRAWL4AI_NO_CLOUD_NOTICE", "1")


class SeedError(ValueError):
    pass


TRIAGE_ROLES = {
    "candidate_product",
    "catalogue_documentation",
    "bounded_api_sample",
    "supporting_context",
    "method_reference",
}


def load_seeds(path: Path = SEEDS_PATH) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    seeds = data.get("sources")
    if not isinstance(seeds, list) or not seeds:
        raise SeedError("Seed file must contain a non-empty sources array.")

    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for seed in seeds:
        if not isinstance(seed, dict):
            raise SeedError("Each source seed must be an object.")
        seed_id = seed.get("id")
        url = seed.get("url")
        hosts = seed.get("allowed_hosts")
        triage_role = seed.get("triage_role")
        potential_inputs = seed.get("potential_inputs")
        known_limitations = seed.get("known_limitations")
        if not isinstance(seed_id, str) or not seed_id or seed_id in seen_ids:
            raise SeedError(f"Missing or duplicate source id: {seed_id!r}")
        if not isinstance(url, str) or url in seen_urls:
            raise SeedError(f"Missing or duplicate seed URL for {seed_id}.")
        parts = urlsplit(url)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.fragment
            or not isinstance(hosts, list)
            or parts.hostname.lower() not in {host.lower() for host in hosts}
        ):
            raise SeedError(f"Unsafe or unapproved seed URL for {seed_id}: {url}")
        if (
            triage_role not in TRIAGE_ROLES
            or not isinstance(potential_inputs, list)
            or not potential_inputs
            or not all(isinstance(item, str) and item.strip() for item in potential_inputs)
            or not isinstance(known_limitations, str)
            or not known_limitations.strip()
        ):
            raise SeedError(
                f"Missing or invalid source triage annotations for {seed_id}."
            )
        seen_ids.add(seed_id)
        seen_urls.add(url)
    return seeds


def request_is_allowed(url: str, method: str, allowed_hosts: set[str]) -> bool:
    parts = urlsplit(url)
    try:
        safe_port = parts.port in (None, 443)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and parts.hostname is not None
        and parts.hostname.lower() in allowed_hosts
        and parts.username is None
        and parts.password is None
        and safe_port
        and method.upper() == "GET"
    )


def relevant_excerpts(markdown: str, terms: list[str]) -> list[str]:
    phrases = [term.casefold() for term in terms if term.strip()]
    excerpts: list[str] = []
    seen: set[str] = set()
    for raw in markdown.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        normalized = line.casefold()
        if len(line) < 30 or not any(term in normalized for term in phrases):
            continue
        excerpt = line[:MAX_EXCERPT_CHARS]
        if excerpt not in seen:
            excerpts.append(excerpt)
            seen.add(excerpt)
        if len(excerpts) == MAX_EXCERPTS:
            break
    if excerpts:
        return excerpts
    return [
        re.sub(r"\s+", " ", line).strip()[:MAX_EXCERPT_CHARS]
        for line in markdown.splitlines()
        if len(line.strip()) >= 30
    ][:3]


def candidate_links(
    links: object, allowed_hosts: set[str], terms: list[str] | None = None
) -> list[dict[str, str]]:
    if not isinstance(links, dict):
        return []
    found: dict[str, tuple[str, int]] = {}
    search_terms = [term.casefold() for term in (terms or []) if term.strip()]
    for group in ("internal", "external"):
        entries = links.get(group, [])
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get("href")
            if not isinstance(url, str):
                continue
            parts = urlsplit(url)
            if not request_is_allowed(url, "GET", allowed_hosts):
                continue
            text = re.sub(r"\s+", " ", str(entry.get("text") or "")).strip()
            relevance = sum(
                term in f"{text} {url}".casefold() for term in search_terms
            )
            found[url] = (text[:160], relevance)
    ranked = sorted(found.items(), key=lambda item: (-item[1][1], item[0]))
    return [
        {"url": url, "text": details[0]}
        for url, details in ranked[:MAX_LINKS]
    ]


def summarize_result(seed: dict, result: object) -> dict:
    markdown_value = getattr(result, "markdown", "") or ""
    markdown = (
        markdown_value
        if isinstance(markdown_value, str)
        else getattr(markdown_value, "raw_markdown", "") or ""
    )
    allowed_hosts = {host.lower() for host in seed["allowed_hosts"]}
    final_url = getattr(result, "redirected_url", None) or seed["url"]
    final_host = (urlsplit(final_url).hostname or "").lower()
    success = bool(getattr(result, "success", False)) and final_host in allowed_hosts
    metadata = getattr(result, "metadata", None) or {}
    title = metadata.get("title") if isinstance(metadata, dict) else None

    return {
        "id": seed["id"],
        "category": seed["category"],
        "purpose": seed["purpose"],
        "triage_role": seed["triage_role"],
        "potential_inputs": seed["potential_inputs"],
        "known_limitations": seed["known_limitations"],
        "status": "candidate_page_crawled" if success else "unavailable_or_blocked",
        "seed_url": seed["url"],
        "final_url": final_url,
        "http_status": getattr(result, "status_code", None),
        "title": title,
        "word_count": len(markdown.split()),
        "matched_terms": [
            term for term in seed["terms"] if term.casefold() in markdown.casefold()
        ],
        "evidence_excerpts": relevant_excerpts(markdown, seed["terms"]),
        "official_candidate_links": candidate_links(
            getattr(result, "links", None), allowed_hosts, seed["terms"]
        ),
        "error": None
        if success
        else getattr(result, "error_message", None)
        or "Crawl failed or redirect ended outside the seed's approved hosts.",
        "assessment": "Discovery lead only; verify dataset access, values, units, coverage, terms and Zetaris compatibility independently.",
    }


async def _crawl(seeds: list[dict]) -> list[dict]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    except ImportError as error:
        raise RuntimeError(
            "Crawl4AI is not installed in this Python environment. Use the "
            "provided crawler virtual environment."
        ) from error

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    browser_config = BrowserConfig(
        headless=True,
        user_agent=USER_AGENT,
        verbose=False,
        text_mode=True,
    )
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        check_robots_txt=True,
        page_timeout=45000,
        word_count_threshold=20,
        exclude_external_links=True,
        exclude_social_media_links=True,
        verbose=False,
    )
    records: list[dict] = []
    async with AsyncWebCrawler(
        config=browser_config,
        base_directory=str(OUTPUT_DIR),
    ) as crawler:
        for index, seed in enumerate(seeds):
            allowed_hosts = {host.lower() for host in seed["allowed_hosts"]}

            async def install_egress_guard(page, **_kwargs):
                async def guard(route):
                    request = route.request
                    if request_is_allowed(request.url, request.method, allowed_hosts):
                        await route.continue_()
                    else:
                        await route.abort()

                await page.context.route("**/*", guard)
                return page

            crawler.crawler_strategy.set_hook(
                "on_page_context_created", install_egress_guard
            )
            if index:
                await asyncio.sleep(REQUEST_DELAY_SECONDS)
            try:
                result = await crawler.arun(url=seed["url"], config=run_config)
                records.append(summarize_result(seed, result))
            except Exception as error:
                records.append(
                    {
                        "id": seed["id"],
                        "category": seed["category"],
                        "purpose": seed["purpose"],
                        "triage_role": seed["triage_role"],
                        "potential_inputs": seed["potential_inputs"],
                        "known_limitations": seed["known_limitations"],
                        "status": "unavailable_or_blocked",
                        "seed_url": seed["url"],
                        "final_url": None,
                        "http_status": None,
                        "title": None,
                        "word_count": 0,
                        "matched_terms": [],
                        "evidence_excerpts": [],
                        "official_candidate_links": [],
                        "error": f"{type(error).__name__}: {error}",
                        "assessment": "No source usability conclusion; investigate the crawl failure manually.",
                    }
                )
    return records


def write_report(records: list[dict], output_dir: Path = OUTPUT_DIR) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema_version": "haze.damage-source-discovery.v1",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "crawler": "Crawl4AI",
        "seed_pages_attempted": len(records),
        "warning": "Candidate discovery only; this report does not validate dataset/API usability, legal terms, Malaysia applicability or scientific methods.",
        "records": records,
    }
    json_path = output_dir / "latest.json"
    markdown_path = output_dir / "latest.md"
    json_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# Damage data source discovery",
        "",
        f"Retrieved: {report['retrieved_at_utc']}",
        "",
        f"Attempted official seed pages: {len(records)}",
        "",
        f"> {report['warning']}",
        "",
    ]
    for record in records:
        lines.extend(
            [
                f"## {record['id']} — {record['category']}",
                "",
                f"- Status: `{record['status']}`",
                f"- Page: {record['seed_url']}",
                f"- Purpose: {record['purpose']}",
                f"- Triage role: `{record['triage_role']}`",
                f"- Potential inputs: {', '.join(record['potential_inputs'])}",
                f"- Known limitations: {record['known_limitations']}",
            ]
        )
        if record["title"]:
            lines.append(f"- Page title: {record['title']}")
        if record["http_status"] is not None:
            lines.append(f"- HTTP status: {record['http_status']}")
        if record["matched_terms"]:
            lines.append(f"- Matched terms: {', '.join(record['matched_terms'])}")
        if record["error"]:
            lines.append(f"- Crawl note: {record['error']}")
        if record["evidence_excerpts"]:
            lines.extend(["", "Evidence excerpts:"])
            lines.extend(f"- {excerpt}" for excerpt in record["evidence_excerpts"])
        if record["official_candidate_links"]:
            lines.extend(["", "Same-host links for manual review:"])
            lines.extend(
                f"- [{link['text'] or link['url']}]({link['url']})"
                for link in record["official_candidate_links"]
            )
        lines.extend(["", f"> {record['assessment']}", ""])
    markdown_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, markdown_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit",
        type=int,
        help="Crawl only the first N reviewed seed pages (for a bounded test).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List approved seed URLs without making network requests.",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be a positive integer.")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        seeds = load_seeds()
    except (OSError, json.JSONDecodeError, SeedError) as error:
        print(f"Seed configuration error: {error}", file=sys.stderr)
        return 2
    if args.limit is not None:
        seeds = seeds[: args.limit]
    if args.dry_run:
        print(f"Dry run: {len(seeds)} reviewed official seed page(s); no requests sent.")
        for seed in seeds:
            print(f"{seed['id']}: {seed['url']}")
        return 0

    try:
        records = asyncio.run(_crawl(seeds))
    except RuntimeError as error:
        print(f"Crawl4AI could not start: {error}", file=sys.stderr)
        return 2
    json_path, markdown_path = write_report(records)
    print(f"Crawled {len(records)} reviewed seed page(s).")
    print(f"JSON report: {json_path}")
    print(f"Markdown report: {markdown_path}")
    for record in records:
        print(
            f"  {record['id']}: {record['status']}"
            + (f" (HTTP {record['http_status']})" if record["http_status"] else "")
        )
    return 0 if any(r["status"] == "candidate_page_crawled" for r in records) else 1


if __name__ == "__main__":
    raise SystemExit(main())
