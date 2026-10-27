# Public damage-input source samples

Collected on **27 October 2026** for hackathon source discovery. These are small
access/field examples, not a matched haze episode or a complete damage account.
No API key was used. Their observation years differ.

| File                                                                     | Source and native units                                                                                             | Scope                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [klang-population.json](klang-population.json)                           | [OpenDOSM population](https://open.dosm.gov.my/data-catalogue/population_district), thousands of people             | Three latest Klang annual overall rows extracted from official CSV.                                                        |
| [klang-annual-deaths.json](klang-annual-deaths.json)                     | [Data.gov.my deaths](https://data.gov.my/data-catalogue/deaths_district_sex), counts and crude rate per 1,000       | Three Klang annual all-cause rows, both sexes.                                                                             |
| [malaysia-monthly-pm25.json](malaysia-monthly-pm25.json)                 | [Data.gov.my pollution](https://data.gov.my/data-catalogue/air_pollution), micrograms/m3 for PM2.5                  | Three monthly rows with no district/station field.                                                                         |
| [selangor-annual-wages.json](selangor-annual-wages.json)                 | [OpenDOSM wages](https://open.dosm.gov.my/data-catalogue/wages_state), monthly RM wages and recipients in thousands | Three annual state rows for covered citizen employees, both sexes.                                                         |
| [open-meteo-klang-modeled-pm25.json](open-meteo-klang-modeled-pm25.json) | [Open-Meteo/CAMS](https://open-meteo.com/en/docs/air-quality-api), micrograms/m3                                    | 24 modeled hourly values at a returned grid cell near Klang, 15 October 2026. This date was an arbitrary engineering test. |

The Malaysian government datasets are provided under CC BY 4.0 according to
their metadata. Open-Meteo/CAMS attribution and service-use terms apply as linked
in its documentation. Preserve provider attribution when reusing samples.

[sample-manifest.json](sample-manifest.json) records request URLs, UTC retrieval
timestamps, hashes and limitations. Population filtering through the API failed;
the successful CSV path and failed attempts are retained. Its full raw CSV is
local runtime evidence at
`.state/damage-source-research/2026-10-27/population_district.csv`; exact JSON
API responses are retained beside it. Public JSON samples are formatted for
readability, with raw and public-sample hashes recorded separately. Large raw
files are not part of this small public sample directory.

[source-catalogue.json](source-catalogue.json) lists source access requirements
and discovery queries. See the [full research report](../../../docs/reports/damage-input-source-research-2026-10-27.md)
for the source map, access findings and remaining inputs.

No sample contains attributable health effects, an approved risk function, local
medical resource costs or a verified intervention effect. Raw series need
scientific processing and matching before they can become accounting inputs.
