# First PM2.5 evidence boundary

The enabled tool is `zetaris-smokeledger-pm25`. It reads the existing
`sl_pg.pm25` and `sl_pg.towns` datasource tables through the configured Zetaris
direct REST API. It selects only `kind = 'model'` and
`source = 'open-meteo-air-quality'` for the request's exact town and explicit
start-inclusive, end-exclusive period. It does not query public Open-Meteo,
PostgreSQL directly, other providers, or observation sources when Zetaris is
unavailable.

The source was selected from the existing SmokeLedger ingestion implementation,
PostgreSQL schema, datasource registration, USL definitions, and REST runner.
The USL activations copy table contents, and their refresh behavior is not
established, so this adapter queries the registered datasource through Zetaris.
No new registration or refresh action is performed by a task.

## Data and provenance

The selection returns `town`, `valid_utc`, `kind`, `issued_utc`, `pm25`, `source`,
`ingested_utc`, and joined town target coordinates. The capture retains the exact
UTF-8 JSON response, SQL, request ID, retrieval time, raw row count, selected raw
row indices, and truncation status. Task artifact storage hashes and persists
the capture. Duplicate valid timestamps select the latest local ingestion;
this is not a provider model-run version.

The provider defines `pm2_5` as an instantaneous near-surface concentration in
µg/m³, and describes the model and output grids in the
[Open-Meteo Air Quality API documentation](https://open-meteo.com/en/docs/air-quality-api).
The adapter's unit mapping is explicit; legacy rows do not store provider unit
metadata. Missing hourly output timestamps indicate missing sample slots, not
missing hour-long measurements. Null values remain unknown. Hourly API output
does not establish native hourly model resolution.

The ingestion stores requested town coordinates but does not preserve returned
model grid-cell coordinates. Grid support and town-wide representativeness
therefore remain unverified. The adapter does not claim observations or an
exhaustive search for observational data.

`issued_utc` was previously populated with rounded local collection time. New
PM2.5 ingestion writes `NULL` when provider issuance is absent; local receipt
remains in `ingested_utc`. The adapter treats every existing Open-Meteo
`issued_utc` as unverified and reports provider issuance as unknown, retaining the
legacy value in raw evidence. No stored data is rewritten by this milestone.
The existing unique key coalesces a null issue time to the epoch, so repeated
unknown-issuance ingestion updates the current town/time/kind row without
creating duplicates. Earlier rows with nonnull legacy issue times remain;
retrieval selects the latest ingestion and preserves all returned raw rows.
This store does not establish a provider model-run archive.

Each tool call has one request, a 30-second maximum, a 512-KiB response bound,
and a 1,500-row retained selection. It requests one additional row to detect
truncation. A task may request at most 31 days. Truncation is disclosed and
cannot establish complete coverage.

## Access check on 25 October 2026

Running `python scripts/preflight.py` inside `app/adapters/zetaris` reported
`NOT READY`: no `.env.local`, and missing `ZETARIS_API_KEY`,
`ZETARIS_USERNAME`, and `ZETARIS_PASSWORD`. The root environment file contained
model configuration but no Zetaris configuration. No credentials were printed,
created, or requested, and no external setup was changed.

Consequently the actual Zetaris endpoint, registered datasource, live rows,
temporal/spatial coverage, query syntax, and response behavior could not be
verified. Captured transport tests establish adapter wiring only. A successful
live task still requires the existing configured Zetaris source to be reachable
and to contain the requested selection; these checks do not establish live
integration readiness.

Use the shared root `.env` for existing Zetaris credentials and pass
them to the server process. Required runtime access is `ZETARIS_API_KEY`;
`ZETARIS_REST_URL` and numeric `ZETARIS_ORG_ID` select the existing instance and
organization. The existing documented local defaults are used if those last two
settings are absent. The runtime does not log in with username/password or
create credentials. `SAMPLE_MODE=true` explicitly disables retrieval.

## Live source check on 26 October 2026

After starting the local `smokeledger-db` Compose service, the read-only
preflight passed: Zetaris REST was reachable, `SELECT 1` succeeded, and the
`sl_pg` datasource was listed. The production PM2.5 adapter then retrieved
Kuala Lumpur samples for 2026-10-23 UTC and the analysis reported 24 usable
modeled rows, from 00:00 through 23:00 UTC, without truncation.

The live response serialized numeric SQL values as strings. The adapter now
accepts only strictly formatted finite numeric strings and normalizes them
before analysis; malformed values remain rejected. Focused tests, type checks,
the production build, and the live adapter/analysis check passed.

The full live task and World Model acceptance flow did not complete. The
isolated task server lacked `HAZE_PROVIDER` and its server-side model API key,
so the initial planning assignment failed before the PM2.5 workflow ran.
Consequently this check verifies Zetaris access and the production PM2.5
retrieval/analysis boundary, but does not verify a live task, independent
review, World Model projection, or live acceptance. No World Model task
records were created by the direct adapter check.
