# Malaysia Environmental USL: Table Architecture

The sources use a mixture of REST federation and local FileStore snapshots.
Air quality and wind now publish one normalized snapshot per provider source,
instead of nesting PostgreSQL ingestion under a separate SmokeLedger source.

## Raw table topology

| Data source | Raw tables | Storage and refresh |
| --- | --- | --- |
| Open-Meteo air quality | One `OPEN_METEO_AIR_QUALITY.hourly_snapshot` | CSV FileStore snapshot published by `sources/air_quality/fetch_air_quality.ts` |
| Open-Meteo wind | One `OPEN_METEO_WIND.hourly_snapshot` | CSV FileStore snapshot published by `sources/wind/fetch_wind.ts`; separate from the environmental USL |
| NASA POWER climate | One REST table per selected location | Coordinate/date-keyed endpoints with a generated union view |
| Data.gov.my weather | One `forecasts_raw` REST table | Nationwide response queried through Zetaris |
| NASA FIRMS fires | One `active_fires` FileStore table | Downloaded CSV with location matching, published by the FIRMS source |
| Windy point forecast | Two FileStore tables | One GFS and one CAMS CSV snapshot for the configured point |
| Location dimensions | Two FileStore tables | Canonical location and administrative-code reference files |

The physical count depends on which sources and NASA POWER locations are
registered. Air-quality and wind location coverage changes their snapshot row
counts, rather than creating a raw REST table per location.

## Stable views and task consumption

`air_quality.hourly_observations` exposes the normalized air-quality snapshot.
Its fields include `location_name`, requested coordinates, UTC
`observation_time`, PM2.5/PM10 values, local `ingested_utc` and provider
`issued_utc` when known. The current PM2.5 task queries this base view directly.
An environmental USL activation may consume the same view, but that separate
model lifecycle is not a prerequisite for the task.

`wind.hourly_observations` exposes 10 m and 850 hPa winds as `u`/`v` components
with their location, valid time and local receipt metadata.

## Refresh boundary

Queries read the published files without making new Open-Meteo API calls.
Run `npm run zetaris:fetch:pm25` or `npm run zetaris:fetch:wind` to fetch and
publish newer rows. Both commands accept repeated `--location` IDs and an
offline `--dry-run` preview. A `--skip-api` run republishes cached data.

The snapshot merges matching location/time rows (plus level for wind), keeps
previously collected hours and leaves other locations intact. Matching values
can be replaced; this is not an immutable model-run archive. Exact task captures
remain separate and retain the response used by that task.

Data.gov.my and NASA POWER retain their REST access paths. Filtering by
location and date is still useful for all sources, but a filter over the
air-quality snapshot does not select an upstream HTTP endpoint.
