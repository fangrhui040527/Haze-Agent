# Crawler status, remaining limits, and AI integration

## Summary

The discovery tool is a source-finding and evidence-triage prototype. It can
crawl a reviewed set of public web pages, inspect one selected page with
Nemotron, and run a small PM2.5 API acquisition smoke test. It is not a
complete data pipeline, a validated scientific model, or a DamageAccountant
estimate.

The screenshot requirements, proposed pilot inputs, and calculation
prototypes are documented. A readiness matrix has also been started. The
current pilot direction is a recent fire-attributable haze episode in Klang,
covering all residents regardless of ethnicity, with intervention evaluation.
The exact episode/date range, boundary version, health outcomes, intervention
and comparator, and domain approvals remain unresolved. Therefore the
readiness assessment is not approved and event-specific acquisition is
blocked.

## What has been completed

- A curated seed list identifies candidate public documentation/catalogue
  pages and labels their potential input roles and known limitations.
- The Crawl4AI discovery script fetches reviewed pages with bounded requests,
  records relevant evidence, and produces local reports. It does not follow
  discovered links automatically.
- The optional Nemotron experiment crawls one selected reviewed seed and asks
  the model to inspect a bounded excerpt of the fetched page.
- The PM2.5 pilot retrieves at most three monthly API rows and preserves raw,
  normalized, validation, and provenance artifacts. Its sample has no
  verified unit or row-level geography and is not suitable as an event-level
  exposure field.
- Isolated arithmetic prototypes exist for source-removal differences,
  population-weighted means, supplied-baseline/supplied-risk health
  calculations, and declared-unit valuation. They do not supply the science
  or empirical parameters.
- Provenance-manifest and one-way sensitivity utilities record artifact
  hashes and calculate scenarios over caller-supplied ranges. The tools do
  not infer defensible uncertainty ranges; the current sample remains
  unquantified.
- The input specification and [pilot readiness matrix](./PILOT_READINESS_MATRIX.md)
  describe the required evidence, coverage, blockers, and stage gates.

## What remains limited or blocked

The current sample and prototypes do not satisfy the screenshot's complete
requirements. In particular, the tool has not yet:

- Acquired and validated event-specific fire detections/emissions,
  meteorology, gridded PM2.5, or compatible population data for the scoped
  Klang area and period.
- Selected or run a transport/dispersion model, established fire attribution,
  or compared modeled exposure with appropriate independent observations.
- Acquired compatible cause-specific health baselines or selected and
  reviewed population-applicable risk functions.
- Acquired intervention-specific effectiveness, adoption, lifecycle costs, or
  a defensible no-intervention comparison.
- Completed economic valuation choices, uncertainty analysis from evidence,
  domain review, or independent numerical reconstruction.
- Passed the readiness gates for mapping results into DamageAccountant.

Crawler findings and AI output are discovery evidence only. Documentation
pages, context indicators, small samples, and passing software tests must not
be treated as complete or scientifically suitable model inputs. Missing
people, dates, cells, or outcomes must not be silently treated as zero.

The next prerequisite is to resolve and approve the pilot scope and criteria
in the readiness matrix. Only then should source-specific acquisition and
event-level processing proceed.

## How the NVIDIA API key is integrated

`nemotron_crawl.py` is a separate optional AI-assisted inspection step:

1. It selects exactly one source from the reviewed seed list.
2. Crawl4AI fetches that page, subject to the configured host and request
   restrictions.
3. The script sends the page title, URL/status, curated triage annotations,
   and up to 16,000 characters of fetched page text to the NVIDIA chat
   completions endpoint.
4. Nemotron is prompted to return candidate fields, documented units and
   coverage, access methods, limitations, short exact evidence quotes, and
   questions requiring verification.
5. The response is printed for human review; it is not automatically stored
   as trusted metadata or used to change the seed inventory.

Configure `NVIDIA_API_KEY` as an environment variable or in the ignored local
`tools/damage_data_discovery/.env` file. The script also supports the
`NVIDIA_BASE_URL` and `NVIDIA_MODEL` settings; its endpoint validation only
allows the NVIDIA HTTPS API host. Do not put a key in source code, command
history, reports, screenshots, or commits.

**Credential caution:** an NVIDIA key was exposed during earlier work. Revoke
and rotate it before using this integration again. Do not reuse an exposed
key. The key is sent to NVIDIA for authentication, and the crawled page text
is also sent to that provider; review the provider's data-handling terms and
the page contents before making the request.

Use `--crawl-only` to fetch and display a short excerpt without calling the
AI API, or `--dry-run` to validate the selected seed and show what would be
sent without making network requests.

## What AI inspection can and cannot do

**It can help with:**

- Summarizing what is visible in one fetched page.
- Identifying candidate fields, units, dates, coverage, and documented access
  methods when those are actually stated in the page text.
- Pointing to short quotations as evidence and listing unanswered questions.
- Comparing page evidence with existing curated triage annotations, while
  treating those annotations as unverified context.

**It cannot reliably or independently:**

- Browse the web, discover and fetch additional sources, follow links, or
  download bulk datasets in this workflow.
- Guarantee that the fetched excerpt contains all relevant page information
  or that model-extracted details are correct.
- Supply facts absent from the page, verify licenses/access rights, or certify
  a dataset's completeness, representativeness, or scientific applicability.
- Estimate fire-attributable exposure, run a transport model, select a health
  risk function, establish intervention effectiveness, value damages, or
  validate a DamageAccountant result.
- Replace source-specific API clients, schema/coverage validation, expert
  review, or independent checks.

Treat every AI statement as a candidate interpretation. Check quotations and
claims against official provider documentation and the acquired data before
changing source metadata or using any value in analysis. The separate local
Meterless report summarizer is not the Nemotron crawler integration and does
not make source claims authoritative either.

## Related documents and tools

- [CRAWLER_CAPABILITIES_AND_DATA_GAPS.md](./CRAWLER_CAPABILITIES_AND_DATA_GAPS.md)
  — broader gap analysis and remaining implementation plan.
- [DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md](./DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md)
  — required quantities, definitions, and proposed coverage criteria.
- [PILOT_READINESS_MATRIX.md](./PILOT_READINESS_MATRIX.md)
  — present pilot scope decisions, evidence state, blockers, and gates.
- [nemotron_crawl.py](./nemotron_crawl.py) — one-page crawl followed by
  optional NVIDIA Nemotron inspection.
- [crawl_sources.py](./crawl_sources.py) — reviewed multi-seed discovery
  crawler.
