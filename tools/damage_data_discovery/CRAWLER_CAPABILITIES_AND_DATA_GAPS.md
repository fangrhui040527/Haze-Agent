# Crawler capabilities, data gaps, and a path to close them

## Executive summary

The current crawler is useful for **finding, fetching, and inspecting a
reviewed set of public source pages**. It is not a complete data-acquisition or
damage-estimation system. It can identify what a page appears to document, and
it can capture a small public API sample, but it does not establish that a
source is scientifically suitable, retrieve and harmonize all required
datasets, or calculate the screenshot's outputs.

The Nemotron experiment adds one optional step: Crawl4AI fetches one selected
seed page, then Nemotron analyzes up to 16,000 characters of fetched text. The
model is analyzing the crawl result; it is not independently browsing, finding
sources, downloading data, or validating scientific assumptions.

**Bottom line:** use the crawler for discovery and evidence triage. Close the
remaining gaps with appropriate source-specific data access, processing,
domain review, and model validation.

The screenshot requirements have been converted into a field-by-field
specification in [DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md](./DAMAGE_ACCOUNTANT_INPUT_SPECIFICATION.md).
It defines units, scope, temporal/geographic coverage, comparison baselines,
source types, and proposed pilot minimums, and distinguishes required model
inputs from supporting context.

For a concise current-status summary, remaining limitations, and the exact
role and constraints of the NVIDIA Nemotron API integration, see
[CRAWLER_STATUS_AND_AI_SUMMARY.md](./CRAWLER_STATUS_AND_AI_SUMMARY.md).

The task-three acquisition pilot is implemented in
[pilot_pm25.py](./pilot_pm25.py). It retrieves and validates only a bounded
three-row monthly PM2.5 API sample, preserves raw and normalized artifacts
separately, and records unresolved unit, geography, and independent-comparison
gaps. This was a separate, completed discovery experiment. The current
DamageAccountant implementation plan does not include further PM2.5 source
acquisition: the project owner says PM2.5 is already fetchable through Zetaris.

Task four has a separate, versioned method prototype in
[pilot_methods.py](./pilot_methods.py): paired source-removal concentration
differences, population-weighted exposure, supplied-baseline/supplied-relative-
risk outcome arithmetic, and declared-unit-value multiplication. The code does
not run transport, select or validate a risk function, or establish valuation
applicability. Its outputs are not decision-grade estimates or DamageAccountant
inputs; domain review and empirical inputs are still required.

Task five adds [provenance.py](./provenance.py) to record source/retrieval
metadata, transformation steps, quality checks, exclusions, uncertainty
status, and SHA-256 checksums for retained pilot artifacts. It also provides
deterministic one-way sensitivity analysis over caller-supplied ranges. The
three-row PM2.5 sample is a limited historical smoke test, not an active
acquisition task or evidence of event-level exposure readiness.

## What the current tool can do

The current implementation can:

- Crawl a reviewed seed list of HTTPS pages, including public documentation,
  catalogue pages, and selected API examples.
- Restrict browser requests to HTTPS `GET` requests on the approved hosts for
  the selected seed, honor `robots.txt`, and avoid following discovered links.
- Extract bounded, keyword-relevant page excerpts, matched terms, page status,
  and same-host links for later manual review into a local JSON/Markdown
  discovery report.
- Carry curated per-seed annotations for its research role, potentially
  relevant model inputs, and known limitations into those reports.
- For a few Data.gov.my entries, request a deliberately small sample through
  the public API. A tested PM2.5 seed returned three monthly values.
- In the separate Nemotron experiment, fetch one reviewed page and ask
  Nemotron to identify candidate fields, units, coverage, documented access
  methods, limitations, and exact evidence quotes from bounded page text. The
  crawl-only option can inspect the fetched excerpt without contacting NVIDIA.

These are discovery functions, not evidence that the data is complete,
licensed for the intended use, correctly interpreted, representative, or
appropriate for a causal health or economic estimate. The standard discovery
crawler processes its reviewed seeds serially; the Nemotron experiment handles
one selected seed per run.

Nemotron output is not automatically parsed or accepted as verified metadata.
Review model-extracted claims against official documentation before changing
curated annotations or using a dataset.

Relevant implementation and source inventory:

- [crawl_sources.py](./crawl_sources.py) — bounded multi-seed page discovery.
- [nemotron_crawl.py](./nemotron_crawl.py) — one-page crawl followed by optional
  Nemotron inspection.
- [seed_sources.json](./seed_sources.json) — reviewed starting URLs and
  discovery terms.
- [summarize_report.py](./summarize_report.py) — optional local Meterless
  summary of one existing report record; it is separate from Nemotron crawling.
- [app/adapters/zetaris/sources/](../../app/adapters/zetaris/sources/) —
  existing source-adapter directories, which must be checked individually for
  coverage and suitability before use in a damage estimate.

## Screenshot requirements: status and how to close each gap

| Screenshot area / required inputs                                                        | What discovery can find or inspect                                                                                                                                                                                                                        | What's still missing                                                                                                                                                                                                               | How to address the gap                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fire attribution:** fire detections, emissions, weather, transport model               | The reviewed list includes a CAMS GFAS product page and ERA5 documentation. The repository also has a NASA FIRMS source directory.                                                                                                                        | A page crawl does not supply a harmonized event-level fire/emissions/weather dataset or estimate how much observed PM2.5 came from fires. The transport model and attribution method are not implemented by this crawler.          | Define the event, geography, time window, and baseline. Acquire fire detections, emissions, and meteorological data using their documented APIs or downloads. Have atmospheric-science reviewers choose and configure a defensible transport/attribution method. Validate outputs against independent observations and document alternative sources.                                                                                                   |
| **Exposure engine:** PM2.5 grids, population, time                                       | The project owner says PM2.5 is already fetchable through Zetaris. Discovery materials also include product pages and a separate, bounded Data.gov.my sample.                                                                                           | No new PM2.5 source acquisition is in scope. The pilot still needs a compatible population grid and reproducible time/geography/population alignment; the existing Zetaris output contract must be checked against the approved pilot coverage at integration. | Treat the existing Zetaris PM2.5 source as supplied. Do not build, replace, or extend its acquisition. Select and acquire compatible population data, then calculate the reviewed population-weighted exposure using the supplied PM2.5 output. If its contract does not meet the approved pilot need, raise a scope decision instead of starting PM2.5 source work. |
| **Health impact engine:** exposure, baseline health rates, risk functions                | The seed list includes Malaysian all-cause district deaths, WHO mortality pages/API examples, WHO air-quality guidance, and EPA BenMAP documentation.                                                                                                     | All-cause or country-level estimates may not be the needed cause-, age-, sex-, time-, and geography-specific baseline. A method reference is not a risk function, and a U.S. function is not automatically applicable to Malaysia. | Identify the exact health outcomes and strata required. Seek Malaysian cause-specific health statistics from authoritative health sources. Have epidemiology experts select or adapt concentration-response functions and assess population applicability. If local estimates are unavailable, label any transfer from another population and model that uncertainty explicitly.                                                                       |
| **Economic engine:** health outcomes, work disruption, unit costs, valuation assumptions | Seeds include Malaysian labour-market and wage context, hospital beds/staffing, producer prices, and health-method references.                                                                                                                            | These contextual indicators are not measured haze-attributable work loss, treatment costs per outcome, a value per statistical death, or a complete welfare valuation.                                                             | Obtain defensible local treatment-cost and outcome-valuation evidence, including currency and price year. Find event-related absenteeism/productivity evidence or use a clearly justified proxy. Separate transfers from real resource costs, avoid double counting, state whose costs are counted, and document valuation assumptions.                                                                                                                |
| **Prevention evaluator:** effectiveness, implementation cost, exposure reduction         | The current source inventory may help find general background information, but it does not establish a complete intervention evidence base.                                                                                                               | Intervention-specific cost, effectiveness, adoption, maintenance, and resulting exposure changes are not supplied by the current crawl workflow.                                                                                   | Choose a specific intervention and counterfactual. Obtain implementation and lifecycle costs, empirical or reviewed effectiveness evidence, adoption assumptions, and modeled exposure changes. Estimate avoided outcomes and costs for each scenario, with sensitivity ranges.                                                                                                                                                                        |
| **Evidence and uncertainty layer:** sources, versions, parameter ranges, limitations     | The discovery report records seed/page metadata, crawl status, selected excerpts, and candidate same-host links. Nemotron can help describe fetched page evidence.                                                                                        | The reports do not constitute full source provenance, data-quality validation, model versioning, uncertainty propagation, or confidence limits for a damage estimate. Model output is not source verification.                     | Preserve source URLs, access/retrieval time, downloaded-file checksums, licenses, dataset versions, schemas, transformations, assumptions, and model versions. Build data-quality checks and an input-to-output lineage. Run sensitivity or probabilistic analyses and clearly report limitations and exclusions.                                                                                                                                      |

## Current implementation plan

The plan for achieving both screenshot workflows, including its scope
exclusions and readiness gates, is maintained in
[DAMAGE_ACCOUNTANT_IMPLEMENTATION_PLAN.md](../DAMAGE_ACCOUNTANT_IMPLEMENTATION_PLAN.md).
The older bounded Data.gov.my PM2.5 sample described above is a completed,
separate discovery experiment; it is not a remaining implementation task.
