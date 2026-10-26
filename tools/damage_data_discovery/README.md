# Damage data source discovery

This isolated tool uses the Crawl4AI checkout/environment supplied at
`C:\Users\user\Desktop\crawler`. It crawls a small fixed list of public
official dataset and documentation pages related to the six DamageAccountant
modules in the workflow screenshot.

It is a research/discovery prototype, not a production source adapter. It does
not create Zetaris registrations, call discovered links, download bulk
datasets, use credentials, or change the existing DamageAccountant workflow.
Every result is an unverified candidate until access, fields, units, coverage,
terms, scientific applicability and the supported Zetaris path are checked
separately. The EPA page is a method reference only, not evidence that US risk
functions apply in Malaysia.

Every reviewed seed includes curated triage annotations: its role, potential
model inputs it may support, and known limitations. These annotations are
research guidance rather than automatically verified facts and appear beside
the crawl evidence in generated reports.

## Run

From the Haze-Agent repository root:

```powershell
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\crawl_sources.py --dry-run
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\test_crawl_sources.py
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\crawl_sources.py --limit 3
```

Use no `--limit` to crawl all reviewed seed pages. The crawler runs requests
serially, waits one second between pages, identifies itself, honors
`robots.txt`, and uses a browser route guard that permits only HTTPS GET
requests to the current seed's approved hosts. It does not follow page links;
same-host published links are reported for manual review only. A redirect to a
non-approved host is blocked by the route guard.

The output directory `run-output/` is local and ignored by Git. It contains a
compact JSON/Markdown discovery report, not a mirror of page contents.

## Bounded PM2.5 acquisition pilot

The separate `pilot_pm25.py` script makes one fixed, bounded HTTPS GET to the
reviewed Data.gov.my PM2.5 sample endpoint (maximum three records). It does not
use the LLM, follow links, or write into Zetaris. Run:

```powershell
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\pilot_pm25.py
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\test_pilot_pm25.py
```

The script preserves the exact response under `run-output\pilot\raw\`, writes
a separate normalized sample under `run-output\pilot\normalized\`, and writes
validation results under `run-output\pilot\reports\`. Reports include a
SHA-256 reference to the raw response and checks for row shape/count, required
fields, dates/order, missing values, duplicates, and numeric PM2.5 values.
The sample response does not provide a verified unit or row-level geography,
and this smoke test performs no independent monitor comparison. These are
reported as unresolved; the pilot will not claim readiness for exposure
modeling or a DamageAccountant estimate. A passing process exit means the
bounded sample passed its available structural/value checks, not that the
source is scientifically validated.

## Optional AI API credentials

For local experiments, copy `.env.example` in this folder to `.env` and put
your rotated API key in the matching variable. `.env` is ignored by Git; never
commit or share it. The template includes NVIDIA and optional local Meterless
settings. The crawler itself does not call an AI API. To summarize one selected
record from the latest report using the local Meterless runtime, configure
`METERLESS_API_KEY` in `.env` and run:

```powershell
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\summarize_report.py
```

The script defaults to `data_gov_my_air_pollution_pm25_api`. Select another
reviewed report record with `--source-id <id>`. It sends only that record's
category, purpose, status, HTTP status, bounded evidence excerpts and
assessment. It accepts only an HTTP endpoint on `localhost`, `127.0.0.1` or
`::1`; it will not send crawler data or credentials to a hosted provider.

## Nemotron crawl experiment

This is a separate experiment from both the crawler report and its
Meterless-only summarizer. It crawls exactly one reviewed seed page with
Crawl4AI, then sends a bounded excerpt of the fetched page text to Nemotron to
inspect the content and report what data it can identify. It does not follow
discovered links or download bulk datasets.

After rotating the exposed NVIDIA key, set `NVIDIA_API_KEY` in `.env` and run:

```powershell
& 'C:\Users\user\Desktop\crawler\law_agent\.venv\Scripts\python.exe' tools\damage_data_discovery\nemotron_crawl.py
```

Use `--source-id <id>` to choose another reviewed seed, `--list-sources` to
list available seeds, `--dry-run` to validate selection without network
requests, or `--crawl-only` to test the crawl and print a short excerpt without
calling NVIDIA. The fetched page text is sent to NVIDIA in the normal run, so
review it and the provider's data-handling terms before running the experiment.
Nemotron is prompted to return JSON identifying candidate fields, documented
units, coverage, access methods, limitations, short exact evidence quotes, and
questions that remain unverified. The response is not parsed as trusted
metadata; check every claim against the provider's official documentation
before relying on it or changing the curated seed annotations.

## Screenshot coverage

The reviewed seeds cover candidate pages for fire emissions (CAMS GFAS),
historical meteorology (ERA5), gridded PM2.5 (CAMS EAC4), population grids
(WorldPop and GHSL), Malaysia government statistics (Data.gov.my and DOSM),
and health-impact references (WHO and EPA BenMAP). The expanded seeds include
the Malaysia government data catalogue, WHO Global Health Observatory
mortality metadata and its documented OData API pattern. DOSM pages also
expose district population, monthly air-pollution, labour-market and
producer-price context; none of these is assumed to be a compatible exposure
grid, a haze-attributable work-loss measure, or a health unit-cost source. WHO
GHO mortality estimates are country-level estimates and may not match official
national estimates or the outcome/geographic resolution needed for a damage
calculation. Data.gov.my's documented filter syntax is `value@column`, with
`contains` supporting case-sensitive partial matches. A three-row
`contains=PM 2.5@pollutant`, descending-date API sample returned recent
non-null PM2.5 concentrations. Bounded Data.gov.my API samples additionally cover district
all-cause deaths, public healthcare staffing, hospital beds, labour-force
aggregates, state wages and monthly pollution. These are context/capacity
measures, not a cause-specific health baseline, haze-attributable absence,
unit medical costs, or a population-weighted exposure surface. Monthly PM2.5
values are aggregated from monitoring-station observations and are not a
station-level or gridded exposure product. The initial unfiltered pollution
sample only returned CO; the filtered sample avoids treating that as evidence
about PM2.5 availability. A sampled
healthcare-staff API response used `type` where its page metadata documents
`staff_type`; validate this before any reuse. Filtered WHO GHO API requests
returned HTTP 500 during the latest run and remain unverified. This is not a
claim that any input has a validated method. Current FIRMS, Open-Meteo, and
environmental USL sources are reused from `app\adapters\zetaris\sources\` and
are not duplicated here.
