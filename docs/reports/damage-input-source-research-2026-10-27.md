# Damage-account input sources: APIs, websites and acquired samples

Research date: **27 October 2026, Asia/Singapore**.

This is an executed source-discovery and acquisition record for the hackathon's
damage-account examples. Official documentation was checked and five public
samples were retained. No API credentials were needed for these samples. The
authenticated services below were documented, but no accounts, tokens or
authenticated downloads were created.

The samples demonstrate access and field shapes. Their periods and geographic
support differ; they are not a matched episode dataset, a damage estimate or an
accounting import. The existing demo's CU values remain synthetic.

## Files to inspect

- [Public samples and reading guide](../../data/damage-source-research/2026-10-27/README.md).
- [Acquisition manifest](../../data/damage-source-research/2026-10-27/sample-manifest.json):
  exact requests, retrieval timestamps, file hashes, units, limitations and
  failed attempts.
- [Source catalogue](../../data/damage-source-research/2026-10-27/source-catalogue.json):
  reusable source IDs, URLs, access requirements and discovery queries for the
  future web-search feature.

## Acquisitions that succeeded

| Input                    | Retained sample                                                                                                   | Example returned                                                    | Interpretation                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Klang population         | [3 annual rows](../../data/damage-source-research/2026-10-27/klang-population.json) extracted from official CSV   | 2026 population `1191.2` thousand persons, or 1,191,200 persons     | All sexes, ages and ethnic groups. District denominator, not a population grid.                                             |
| Klang deaths             | [3 annual rows](../../data/damage-source-research/2026-10-27/klang-annual-deaths.json) from JSON API              | 2025 all-cause deaths `5576`; crude rate `4.7` per 1,000 population | Annual context/baseline candidate; not deaths caused by haze.                                                               |
| Malaysian monthly PM2.5  | [3 monthly rows](../../data/damage-source-research/2026-10-27/malaysia-monthly-pm25.json) from JSON API           | December 2024 concentration `11.54` micrograms/m3                   | Monthly station-observation aggregate; returned rows have no Klang/station identifier.                                      |
| Selangor wages           | [3 annual rows](../../data/damage-source-research/2026-10-27/selangor-annual-wages.json) from JSON API            | 2025 median `3547` RM/month and mean `4258` RM/month                | Wage context for covered citizen employees, not measured haze-related absence.                                              |
| Modeled PM2.5 near Klang | [24 hourly rows](../../data/damage-source-research/2026-10-27/open-meteo-klang-modeled-pm25.json) from Open-Meteo | First test hour: `2026-10-15T00:00`, `103.1` micrograms/m3          | Arbitrary engineering test date, not a verified haze episode. Requested point 3.04, 101.45; returned model cell 3.0, 101.5. |

The original population CSV is 24,637,855 bytes and was retained locally at
`.state/damage-source-research/2026-10-27/population_district.csv`. The public
sample is a three-row extraction; the manifest records both raw and extraction
hashes and the transformation. Exact API response bytes are also retained under
that local state directory. Public JSON samples are formatted for readability;
the manifest records their hashes separately from the raw responses.

**Observed population API issue:** district-filtered requests to both
`/data-catalogue?id=population_district` and `/opendosm?id=population_district`
returned HTTP 400, reporting an invalid `district` filter with an empty valid
column list. This is an observed failure of these requests, not evidence that
all population API access is unavailable. The official CSV succeeded. Future
integration should preserve this distinction instead of assuming a catalogue
example guarantees a working filtered endpoint.

## Environmental data and episode evidence

| Need                                    | Official website / API                                                                                                            | Authentication                                                                                              | What is available and what remains                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Easy point PM2.5 series                 | [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)                                                      | No key for permitted free noncommercial use; [terms](https://open-meteo.com/en/terms) and attribution apply | CAMS modeled ambient concentrations; global archive from August 2022. The tested endpoint returned hourly `pm2_5` with units. Coarse global model support requires suitability assessment for Klang. It supplies no selected-fire-removed counterfactual.                                       |
| Fire locations and activity             | [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/)                                                             | Free NASA FIRMS `MAP_KEY`                                                                                   | Detections with location, acquisition time, confidence and fire-radiative-power fields. Bounding box and 1-5 days/request; check product availability. Detections alone do not establish emitted PM2.5 or exposure at Klang.                                                                    |
| Fire emissions                          | [CAMS GFAS](https://ads.atmosphere.copernicus.eu/datasets/cams-global-fire-emissions-gfas?tab=overview)                           | Copernicus ADS account and personal access token; manual dataset-terms acceptance                           | Estimated emissions including PM2.5 and fire activity, 0.1-degree grid. v1.2 daily covers 2003-2025; v1.4.2 hourly/daily starts in 2026. Requires transport/attribution processing.                                                                                                             |
| Weather fields                          | [ERA5 hourly single levels](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview)                | Copernicus CDS account/token and dataset terms                                                              | Hourly reanalysis from 1940; select the transport model's required variables, levels and domain. The single-level product alone may not satisfy a transport model.                                                                                                                              |
| Easy point weather series               | [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)                                        | No key for permitted free noncommercial use                                                                 | Wind, temperature and other historical point variables. Useful for prototyping and context; not a complete transport-model domain.                                                                                                                                                              |
| Historical pollution grid               | [CAMS EAC4](https://ads.atmosphere.copernicus.eu/datasets/cams-global-reanalysis-eac4?tab=overview)                               | ADS token and terms                                                                                         | Catalogue currently lists 2003-2025; 0.75-degree global, three-hourly output. PM2.5 fields use kg/m3 and need explicit unit conversion. Candidate for a 2015 episode, not a promised 2026 source.                                                                                               |
| Recent pollution grid                   | [CAMS global forecasts](https://ads.atmosphere.copernicus.eu/datasets/cams-global-atmospheric-composition-forecasts?tab=overview) | ADS token and terms                                                                                         | Archive from 2015 onward, including recent periods. Modeled fields; model changes and grid suitability need review.                                                                                                                                                                             |
| Official Malaysian pollution context    | [Monthly Air Pollution](https://data.gov.my/data-catalogue/air_pollution)                                                         | No key                                                                                                      | Public JSON/CSV/Parquet; monthly PM2.5 in micrograms/m3, currently through 2024. Not an event-hour/day Klang exposure surface.                                                                                                                                                                  |
| Station status and historical-data lead | [DOE APIMS](https://eqms.doe.gov.my/apims/main)                                                                                   | Public dashboard; no documented historical raw station API verified                                         | Here “API” means Air Pollutant Index. An index value is not a PM2.5 concentration. Obtain a documented raw concentration route or an authorized DOE data extract for station validation.                                                                                                        |
| Episode notices and smoke maps          | [ASMC alerts](https://asmc.asean.org/asmc-alerts/) and [WIS2 catalogue](https://wis2.asmc.asean.org/data-catalog/)                | Public pages/products                                                                                       | Useful to corroborate an event window and smoke context. The checked regional-haze endpoint serves PNG; the dispersion endpoint serves GIF. The [dispersion product](https://wis2.asmc.asean.org/smoke-haze-dispersion-model/) is PM10, not a structured PM2.5 or project-counterfactual table. |

Copernicus's [API setup guide](https://ads.atmosphere.copernicus.eu/how-to-api)
explains account/token setup, manual terms acceptance and generating the exact
dataset request from its download form. Reuse generated requests for the selected
product/version rather than assuming all Copernicus products have one schema.

## Population, boundaries and health

| Need                               | Official source                                                                                                                                                                         | Access                                                                                                                               | Fit and gap                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Klang population totals and strata | [OpenDOSM district population](https://open.dosm.gov.my/data-catalogue/population_district)                                                                                             | Public CSV/Parquet; filtered API issue recorded above                                                                                | Annual 2020-2026, with sex, age and ethnicity; source unit is thousands. Use overall strata for totals and avoid adding overlapping totals and subgroups.                                                           |
| Population raster                  | [WorldPop REST catalogue](https://hub.worldpop.org/rest/data/pop), [Malaysia STAC collection](https://stac.worldpop.org/collections/MYS)                                                | [Exploration is unauthenticated](https://www.worldpop.org/sdi/api_rate_limits/); documented limit 1,000 REST calls/day without a key | Current R2025A catalogue lists 2015-2030 at 100 m/1 km. Select the actual Malaysia file, year, grid, strata and terms; align it to pollution fields and validate totals. No raster was downloaded in this research. |
| District boundary                  | [DOSM district GeoJSON](https://raw.githubusercontent.com/dosm-malaysia/data-open/main/datasets/geodata/administrative_2_district.geojson)                                              | Public raw download                                                                                                                  | Simplified administrative district geometry includes Klang. Pin a commit/version and assess simplification. Administrative district, municipal and parliamentary boundaries differ. No boundary was retained here.  |
| Mortality baseline candidate       | [Annual deaths by district and sex](https://data.gov.my/data-catalogue/deaths_district_sex)                                                                                             | No-key JSON/CSV/Parquet                                                                                                              | Annual all-cause counts and crude rates through 2025; usual residence basis. No age/cause/day breakdown in these rows. Applicability depends on the selected health method.                                         |
| Cause-specific mortality           | [DOSM Causes of Death 2025 release](https://www.dosm.gov.my/portal-main/release-content/statistics-on-causes-of-death-malaysia-2025)                                                    | Public report/tables; detailed API not verified                                                                                      | Report covers 2024 deaths. A local cause/age-specific baseline may require detailed tables or a data request. Do not assume a report title names its observation year.                                              |
| Morbidity and admissions           | [MOH Health Facts](https://www.moh.gov.my/en/publications-and-reports/infographics-reports-statistics/health-facts/list-of-health-facts), [MyHDW](https://myhdw.moh.gov.my/public/home) | Public summaries; detailed access requires registration/permission                                                                   | No public event-day, diagnosis-specific Klang-resident admissions API was verified. Hospital capacity and staffing are not admission outcomes.                                                                      |
| Country health indicator discovery | [WHO GHO OData guide](https://www.who.int/data/gho/info/gho-odata-api)                                                                                                                  | Public documented API; actual selected indicator not tested here                                                                     | Country-level indicators can support discovery/context. They are not automatically a compatible district baseline.                                                                                                  |
| Health-response methods            | [WHO AirQ+](https://www.who.int/tools/airq), [HRAPIE-2 guidance](https://www.who.int/publications/b/81870)                                                                              | Public methods/software, not a live local-coefficient API                                                                            | Requires selection of endpoint, exposure duration/metric, lag and applicability. WHO calls for epidemiology/impact-assessment expertise. No coefficient was selected or applied here.                               |

## Economics and intervention evidence

| Need                                  | Official source                                                                                                                                                             | Useful access                                                                              | Remaining work                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wage context                          | [DOSM wages by state and sex](https://open.dosm.gov.my/data-catalogue/wages_state)                                                                                          | No-key `id=wages_state`; annual values, monthly RM wages; tested for Selangor              | Covered citizen employees aged 15-64. Wage context does not establish haze-attributable absence or lost workdays.                                                                    |
| Labour-force context                  | [DOSM district labour force](https://open.dosm.gov.my/data-catalogue/lfs_district)                                                                                          | Public catalogue/CSV/Parquet; `id=lfs_district` is a documented candidate, not tested here | Workforce denominator only; event-caused work disruption needs separate evidence.                                                                                                    |
| Price year                            | [DOSM state CPI](https://open.dosm.gov.my/data-catalogue/cpi_state)                                                                                                         | No-key candidate `id=cpi_state`; monthly indices, 2010=100                                 | Choose and document a suitable price basis/deflator. An index is not a treatment cost.                                                                                               |
| Exchange rates                        | [BNM daily rates via Data.gov.my](https://data.gov.my/data-catalogue/exchangerates_daily_1700)                                                                              | No-key candidate `id=exchangerates_daily_1700`                                             | Select date and buying/selling/middle basis. Currency conversion does not resolve valuation transfer assumptions.                                                                    |
| Patient payments                      | [MOH outpatient charges](https://www.moh.gov.my/en/core/health-information/service-rates/caj-pesakit-luar)                                                                  | Public fee schedule                                                                        | Useful financing/incidence evidence. Patient charges are not full medical resource costs.                                                                                            |
| Medical resource-cost source trail    | [MOH/WHO NCD cost report](https://www.moh.gov.my/images/04-penerbitan/rujukan/penyakit-berjangkit/laporan/HEALTH-COST_of_NCDs-7a-WEB.pdf)                                   | Public PDF with costing methods and original source references                             | National 2017 NCD analysis, not a ready acute haze-treatment unit-cost table. Endpoint-compatible local costs need acquisition/review.                                               |
| Mortality welfare valuation           | [OECD mortality-risk valuation report](https://www.oecd.org/en/publications/mortality-risk-valuation-in-policy-assessment_76ca89a2-en.html)                                 | Public report and linked data/transfer methods                                             | No Malaysian account value selected. Requires transfer/applicability, currency/price-year and uncertainty decisions.                                                                 |
| Intervention definition and authority | [DOE open-burning responsibilities](https://www.doe.gov.my/en/open-burning/), [Klang enforcement department](https://www.mbdk.gov.my/en/department/jabatan-penguatkuasa)    | Public policy/operational information                                                      | Specify the actual project, authority, source fires and incremental activities.                                                                                                      |
| Intervention budget and effects       | [Klang 2023 annual report](https://www.mbdk.gov.my/sites/default/files/node/publications/files/2024-08/Laporan%20Tahunan%202023.pdf) and relevant programme records/studies | Public report is a source trail; no project-effectiveness API verified                     | A departmental budget, fine or patrol count does not establish incremental lifecycle cost or causal pollution reduction. Obtain project-specific costing and effectiveness evidence. |

No ready public endpoint was verified for local haze-attributable workdays,
endpoint-specific medical resource costs, or this project's causal effectiveness.
The table identifies the next source/permission/method work rather than filling
those gaps with inferred values.

## Requests that can be reproduced

The exact encoded URLs used are in the acquisition manifest. Human-readable
examples for successful JSON requests:

```text
https://api.data.gov.my/data-catalogue?id=deaths_district_sex&filter=Klang@district,both@sex&sort=-date&limit=3
https://api.data.gov.my/data-catalogue?id=air_pollution&contains=2.5@pollutant&sort=-date&limit=3
https://api.data.gov.my/data-catalogue?id=wages_state&filter=Selangor@state,both@sex&sort=-date&limit=3
https://air-quality-api.open-meteo.com/v1/air-quality?latitude=3.04&longitude=101.45&hourly=pm2_5&start_date=2026-10-15&end_date=2026-10-15&timezone=GMT
```

Data.gov.my's [quickstart](https://developer.data.gov.my/quickstart) documents
token-free access. Its [rate limits](https://developer.data.gov.my/rate-limit)
currently allow four catalogue requests/minute. Samples were bounded to three
rows/request and spaced 16 seconds apart. The [filter documentation](https://developer.data.gov.my/request-query)
uses `value@column`; verify the live dataset's supported columns as well as its
page metadata.

## How the future web-search feature can use this research

1. Resolve a requested place, event and intended outputs. Find a documented event
   window, rather than treating the arbitrary API test date as an episode.
2. Search official source pages using the catalogue's `discovery_query` values.
   Retain page links, publication/update dates and support for units/coverage.
3. Fetch numerical data using the documented provider API/download. A search
   snippet or generated answer is not a numerical input table.
4. Preserve raw responses, versions, hashes, access terms and transformations.
   Check spatial/temporal support, units, strata and missingness before joining.
5. Obtain or compute reviewed attribution, exposure and health quantities. None
   of the discovered raw-data services supplies the complete verified
   with-selected-fires/without-selected-fires pair for this Klang account.
6. Collect compatible unit values, financing and project residual outcomes.
   Map reviewed results to `scope`, `effects`, `unit_values`, `coverage`,
   `incidence` and `scenarios`, then retain them for the existing World Model
   accounting-input adapter and independent checker.

Search-provider keys and dataset-provider keys are separate credentials. For a
future connector, [Brave Web Search](https://api-dashboard.search.brave.com/api-reference/web/search/get)
documents `GET https://api.search.brave.com/res/v1/web/search` with an
`X-Subscription-Token` header. [Tavily Search](https://help.tavily.com/articles/4840311948-tavily-search-api)
documents `POST https://api.tavily.com/search` with a bearer API key. These are
documented options, not provisioned integrations; no subscription was created
or provider-key request made in this research.

For the three hackathon cases, historical and intervention scenarios can share
the acquired episode evidence. Real source data can replace synthetic inputs
only where it meets the matching and method requirements. Intervention effects
and costs must remain explicitly assumed or unestimated until their own evidence
is obtained. The 2015 fixture requires historical sources; Open-Meteo's global
air-quality archive and the sampled district population table do not cover 2015.
