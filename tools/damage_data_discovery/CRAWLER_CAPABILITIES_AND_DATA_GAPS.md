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

The task-three acquisition pilot is implemented in
[pilot_pm25.py](./pilot_pm25.py). It retrieves and validates only a bounded
three-row monthly PM2.5 API sample, preserves raw and normalized artifacts
separately, and records unresolved unit, geography, and independent-comparison
gaps. It is an acquisition smoke test, not an event-level exposure or damage
pilot.

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

| Screenshot area / required inputs | What discovery can find or inspect | What's still missing | How to address the gap |
|---|---|---|---|
| **Fire attribution:** fire detections, emissions, weather, transport model | The reviewed list includes a CAMS GFAS product page and ERA5 documentation. The repository also has a NASA FIRMS source directory. | A page crawl does not supply a harmonized event-level fire/emissions/weather dataset or estimate how much observed PM2.5 came from fires. The transport model and attribution method are not implemented by this crawler. | Define the event, geography, time window, and baseline. Acquire fire detections, emissions, and meteorological data using their documented APIs or downloads. Have atmospheric-science reviewers choose and configure a defensible transport/attribution method. Validate outputs against independent observations and document alternative sources. |
| **Exposure engine:** PM2.5 grids, population, time | The reviewed seeds include CAMS EAC4 and WorldPop/GHSL product documentation, and a Data.gov.my PM2.5 sample. The repository has air-quality and Open-Meteo PM2.5 source directories. The tested Data.gov.my sample returned three monthly PM2.5 records. | Those three monthly records are not a gridded exposure product. The crawler does not retrieve complete gridded time series, population rasters, or align and aggregate them. | Select products that cover the event dates and geography. Retrieve full data through the provider's documented API/download process. Check units, coordinate systems, resolution, temporal coverage, missing cells, and licensing. Align PM2.5 and population grids and calculate population-weighted exposure with a reproducible pipeline. Use ground observations for appropriate validation, not as a substitute for a grid without justification. |
| **Health impact engine:** exposure, baseline health rates, risk functions | The seed list includes Malaysian all-cause district deaths, WHO mortality pages/API examples, WHO air-quality guidance, and EPA BenMAP documentation. | All-cause or country-level estimates may not be the needed cause-, age-, sex-, time-, and geography-specific baseline. A method reference is not a risk function, and a U.S. function is not automatically applicable to Malaysia. | Identify the exact health outcomes and strata required. Seek Malaysian cause-specific health statistics from authoritative health sources. Have epidemiology experts select or adapt concentration-response functions and assess population applicability. If local estimates are unavailable, label any transfer from another population and model that uncertainty explicitly. |
| **Economic engine:** health outcomes, work disruption, unit costs, valuation assumptions | Seeds include Malaysian labour-market and wage context, hospital beds/staffing, producer prices, and health-method references. | These contextual indicators are not measured haze-attributable work loss, treatment costs per outcome, a value per statistical death, or a complete welfare valuation. | Obtain defensible local treatment-cost and outcome-valuation evidence, including currency and price year. Find event-related absenteeism/productivity evidence or use a clearly justified proxy. Separate transfers from real resource costs, avoid double counting, state whose costs are counted, and document valuation assumptions. |
| **Prevention evaluator:** effectiveness, implementation cost, exposure reduction | The current source inventory may help find general background information, but it does not establish a complete intervention evidence base. | Intervention-specific cost, effectiveness, adoption, maintenance, and resulting exposure changes are not supplied by the current crawl workflow. | Choose a specific intervention and counterfactual. Obtain implementation and lifecycle costs, empirical or reviewed effectiveness evidence, adoption assumptions, and modeled exposure changes. Estimate avoided outcomes and costs for each scenario, with sensitivity ranges. |
| **Evidence and uncertainty layer:** sources, versions, parameter ranges, limitations | The discovery report records seed/page metadata, crawl status, selected excerpts, and candidate same-host links. Nemotron can help describe fetched page evidence. | The reports do not constitute full source provenance, data-quality validation, model versioning, uncertainty propagation, or confidence limits for a damage estimate. Model output is not source verification. | Preserve source URLs, access/retrieval time, downloaded-file checksums, licenses, dataset versions, schemas, transformations, assumptions, and model versions. Build data-quality checks and an input-to-output lineage. Run sensitivity or probabilistic analyses and clearly report limitations and exclusions. |

## Recommended implementation sequence

### 1. Turn the screenshot into an input specification

For each required quantity, write down its definition, unit, geography,
population group, time resolution, comparison baseline, acceptable source
types, and minimum coverage. Distinguish required model inputs from supporting
context indicators. This prevents a related-looking dataset (for example,
monthly wages or all-cause deaths) from being mistaken for the required
measure.

### 2. Use the crawler to triage sources, not to replace data clients

Keep the seed list curated and annotate each source with which input it might
support and what it cannot support. Use page crawling and Nemotron inspection
to extract candidate fields, documented units, coverage, access methods, and
limitations. A human should verify these against the provider's official
documentation.

When a source offers a usable dataset, use its documented API or download
mechanism for actual acquisition. Add pagination, authentication, retries,
rate limits, licensing checks, and schema validation in a source-specific
client where required. Do not have an LLM invent API queries or treat links
found in a page as trusted without review.

### 3. Acquire and validate data for a small pilot

Start with one haze event, a clearly specified Malaysian geography, and a
bounded period. Acquire only the minimum data needed for a vertical pilot.
Validate row counts, units, dates, coordinate reference systems, geographic
coverage, missingness, duplicate records, and consistency with independent
observations. Keep the raw source separate from transformed analysis data.

### 4. Implement the scientific and valuation methods separately

Implement fire attribution, exposure aggregation, health impact, and economic
valuation as explicit, testable calculations with named inputs and versions.
Require domain review for choices that the crawler cannot make: transport
assumptions, risk functions, baseline rates, counterfactuals, valuation, and
double-counting rules.

### 5. Add provenance and uncertainty before broadening coverage

Store the source/version and transformation history for every input. Record
exclusions and limitations. Test sensitivity to uncertain or transferred
parameters, then report ranges and caveats alongside point estimates. Expand
to additional events and regions only after the pilot is reproducible.

## Readiness gate

Do not treat the workflow as ready to produce defensible damage estimates
until each required screenshot input has:

1. A precise definition, unit, geography, and time resolution.
2. An identified source and a verified acquisition path.
3. Data-quality checks and documented coverage/limitations.
4. A reproducible transformation into the model's expected input.
5. An owner or reviewer for methodological assumptions.
6. Uncertainty or sensitivity treatment appropriate to the evidence.

The crawler helps with items 2 and 3 at the **source-discovery** stage. It
does not satisfy the full readiness gate on its own.
