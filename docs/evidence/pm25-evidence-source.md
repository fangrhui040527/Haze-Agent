# PM2.5 evidence boundary

The enabled tool is `zetaris-open-meteo-pm25`. It reads the
`air_quality.hourly_observations` view through the configured Zetaris REST API
for the request's exact town and start-inclusive, end-exclusive UTC period. The
view federates Open-Meteo/CAMS modeled PM2.5. A task does not query public
Open-Meteo directly, connect to PostgreSQL, refresh source registrations, or
substitute another provider when Zetaris is unavailable.

## Ingestion and publication

`app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts` registers one
Open-Meteo REST table per selected canonical location and creates the
`air_quality.hourly_observations` view. The view includes `location_name`,
`requested_latitude`, `requested_longitude`, `observation_time`, and
`pm2_5_ug_m3`/`pm10_ug_m3`.

Preview single-location REST registration from the repository root:

```powershell
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
```

After reviewing the plan, rerun without `--dry-run` to register. The generated
endpoint uses `past_days=1`, `forecast_days=3`, and `timezone=GMT`. In `--test`
mode the source registers Kuala Lumpur only; normal mode registers all
canonical locations unless specific `--location` IDs are supplied. Zetaris may
contact provider endpoints while registering or querying them. Source setup is
operator tooling, separate from task execution. The PM2.5 task reads the base
view and does not require environmental USL compilation or activation.

## Data and provenance

The task capture retains the exact UTF-8 JSON response returned by Zetaris, SQL,
request ID, retrieval time, raw row count, selected raw row indices and
truncation status. Task artifact storage hashes and persists this capture.
Local receipt does not establish provider issuance.

The provider defines `pm2_5` as an instantaneous near-surface concentration in
µg/m³, and describes the model and output grids in the
[Open-Meteo Air Quality API documentation](https://open-meteo.com/en/docs/air-quality-api).
The adapter's unit mapping is explicit. Missing hourly timestamps indicate
missing sample slots, not missing hour-long measurements. Null values remain
unknown. Hourly API output does not establish native hourly model resolution.

The view exposes requested town coordinates. Model grid-cell support and
town-wide representativeness remain unverified. The adapter does not claim
ground-station observations or an exhaustive search for observational data.
The source view does not claim a provider model issue time. A saved task's exact
capture remains unchanged when a later query returns different provider data.

Each tool call has one request, a 30-second maximum, a 512-KiB response bound,
and a 1,500-row retained selection. It requests one additional row to detect
truncation. A task may request at most 31 days, but that limit does not establish
31 days of stored coverage. Only published rows can be returned. Truncation is
disclosed and cannot establish complete coverage.

## Migration from SmokeLedger PostgreSQL

The earlier `zetaris-smokeledger-pm25` boundary queried `sl_pg.pm25` and
`sl_pg.towns`. Its ingestion scripts, PostgreSQL schema and Compose service
have been removed. The current `smokeledger_usl` is a read-only model over
Zetaris Environmental and wind sources, not the old PostgreSQL model. The root
Compose file starts the Zetaris platform; the default source path publishes
Zetaris FileStore snapshots. Existing PostgreSQL volumes, registered Zetaris
objects and saved task artifacts are not dropped, rewritten or migrated
automatically. Historical evidence and milestone records continue to describe
the source actually used at that time.

## Access and live verification

Use the shared root `.env` for existing Zetaris credentials and pass them to the
server process. Runtime access requires `ZETARIS_API_KEY`; `ZETARIS_REST_URL` and
the numeric `ZETARIS_ORG_ID` select the existing instance and organisation. The
documented local defaults are used if those last two settings are absent. The
runtime does not log in with username/password or create credentials.
`SAMPLE_MODE=true` explicitly disables retrieval.

This source migration changes code and local setup tooling. It does not itself
establish that a live Zetaris instance has the new REST tables, view or
requested coverage. A successful live check must capture the configured source
execution; fixture and captured transport tests establish adapter wiring only.

### Historical access check on 25 October 2026

The original SmokeLedger access check reported `NOT READY`: no `.env.local`,
and missing `ZETARIS_API_KEY`, `ZETARIS_USERNAME` and `ZETARIS_PASSWORD`. The root
environment file then contained model configuration but no Zetaris
configuration. No credentials were printed, created or requested, and no
external setup was changed. That check did not verify the old datasource or any
live rows and does not verify the current REST-federated source.

### Historical SmokeLedger source check on 26 October 2026

After starting the local `smokeledger-db` Compose service, the read-only
preflight passed: Zetaris REST was reachable, `SELECT 1` succeeded, and the
`sl_pg` datasource was listed. The then-current SmokeLedger PM2.5 adapter retrieved
Kuala Lumpur samples for 2026-10-23 UTC and the analysis reported 24 usable
modeled rows, from 00:00 through 23:00 UTC, without truncation.

The live response serialized numeric SQL values as strings. The adapter
accepts only strictly formatted finite numeric strings and normalizes them
before analysis; malformed values remain rejected. Focused tests, type checks,
the production build, and the live adapter/analysis check passed.

The full live task and World Model acceptance flow did not complete. The
isolated task server lacked `HAZE_PROVIDER` and its server-side model API key,
so the initial planning assignment failed before the PM2.5 workflow ran.
Consequently this check verified Zetaris access and the legacy SmokeLedger PM2.5
retrieval/analysis boundary. It does not verify the current snapshot source,
a live task, independent review, World Model projection, or live acceptance.
No World Model task
records were created by the direct adapter check.
