# PM2.5 evidence boundary

The enabled tool is `zetaris-open-meteo-pm25`. It reads the published
`air_quality.hourly_observations` snapshot through the configured Zetaris direct
REST API for the request's exact town and start-inclusive, end-exclusive UTC
period. The source contains Open-Meteo/CAMS modeled PM2.5. A task does not query
public Open-Meteo, connect to PostgreSQL, refresh a source, or substitute another
provider when Zetaris is unavailable.

## Ingestion and publication

`app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts` collects PM2.5 and
PM10 for canonical locations, normalizes the hourly response and publishes a CSV
snapshot to the Zetaris driver. Zetaris exposes that file through
`OPEN_METEO_AIR_QUALITY.hourly_snapshot` and the stable
`air_quality.hourly_observations` view. The view includes `location_name`,
`requested_latitude`, `requested_longitude`, `observation_time`, `pm2_5_ug_m3`,
`pm10_ug_m3`, `ingested_utc` and `issued_utc`.

Preview a single-location publication from the repository root:

```powershell
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
```

After reviewing the plan, rerun without `--dry-run` to collect and publish. The
default upstream request uses `past_days=1`, `forecast_days=3` and `timezone=GMT`.
The local snapshot merges rows by location and sample time, replaces matching
values, and retains previously collected hours and other locations. The cache
retains the latest raw response for each collected location and receipt
metadata. It is not an immutable archive of all provider model runs. A
`--skip-api` publication reuses the cached snapshot without making data newer.

`npm run zetaris:bootstrap:sources -- --location kuala-lumpur --dry-run` previews
the PM2.5, wind and FIRMS source setup together. Source publication is operator
tooling, separate from task execution. The PM2.5 task reads the base snapshot
view and does not require environmental USL compilation or activation.

## Data and provenance

The capture retains the exact UTF-8 JSON response, SQL, request ID, retrieval
time, raw row count, selected raw row indices and truncation status. Task
artifact storage hashes and persists this capture. Duplicate sample times select
the latest local ingestion. Local receipt does not establish provider issuance.

The provider defines `pm2_5` as an instantaneous near-surface concentration in
µg/m³, and describes the model and output grids in the
[Open-Meteo Air Quality API documentation](https://open-meteo.com/en/docs/air-quality-api).
The adapter's unit mapping is explicit. Missing hourly timestamps indicate
missing sample slots, not missing hour-long measurements. Null values remain
unknown. Hourly API output does not establish native hourly model resolution.

The view exposes requested town coordinates. Model grid-cell support and
town-wide representativeness remain unverified. The adapter does not claim
ground-station observations or an exhaustive search for observational data.
`issued_utc` remains unknown when the provider does not supply its model issue
time; `ingested_utc` records local receipt. A saved task's exact capture remains
unchanged when a later publication updates the source snapshot.

Each tool call has one request, a 30-second maximum, a 512-KiB response bound,
and a 1,500-row retained selection. It requests one additional row to detect
truncation. A task may request at most 31 days, but that limit does not establish
31 days of stored coverage. Only published rows can be returned. Truncation is
disclosed and cannot establish complete coverage.

## Migration from SmokeLedger PostgreSQL

The earlier `zetaris-smokeledger-pm25` boundary queried `sl_pg.pm25` and
`sl_pg.towns`. Its ingestion, SQL schema and optional USL are retained under
`app/adapters/zetaris/legacy/smokeledger/` and
`app/adapters/zetaris/usl/smokeledger_usl/`. The default source path now publishes
Zetaris FileStore snapshots. Existing PostgreSQL rows and saved task artifacts
are not dropped, rewritten or migrated automatically. Historical evidence and
milestone records continue to describe the source actually used at that time.

## Access and live verification

Use the shared root `.env` for existing Zetaris credentials and pass them to the
server process. Runtime access requires `ZETARIS_API_KEY`; `ZETARIS_REST_URL` and
the numeric `ZETARIS_ORG_ID` select the existing instance and organisation. The
documented local defaults are used if those last two settings are absent. The
runtime does not log in with username/password or create credentials.
`SAMPLE_MODE=true` explicitly disables retrieval.

This source migration changes code and local setup tooling. It does not itself
establish that a live Zetaris instance has the new FileStore table, view or
requested coverage. A successful live check must capture the configured source
execution after publication; fixture and captured transport tests establish
adapter wiring only.

### Historical access check on 25 October 2026

The original SmokeLedger access check reported `NOT READY`: no `.env.local`,
and missing `ZETARIS_API_KEY`, `ZETARIS_USERNAME` and `ZETARIS_PASSWORD`. The root
environment file then contained model configuration but no Zetaris
configuration. No credentials were printed, created or requested, and no
external setup was changed. That check did not verify the old datasource or any
live rows and does not verify the current snapshot source.
