# Legacy SmokeLedger PostgreSQL store

This package retains the earlier PostgreSQL ingestion path and schema. It is
optional legacy tooling, separate from the current Zetaris FileStore source
ingestion. Existing databases and volumes are preserved; no stored rows are
migrated automatically.

Use the current provider sources for new collection:

```powershell
npm run zetaris:fetch:pm25 -- --location kuala-lumpur --dry-run
npm run zetaris:fetch:wind -- --location kuala-lumpur --dry-run
npm run zetaris:fetch:firms -- --dry-run
npm run zetaris:bootstrap:sources -- --location kuala-lumpur --dry-run
```

Review a plan before running its command without `--dry-run`. The PM2.5 task now
queries the published `air_quality.hourly_observations` snapshot through
Zetaris, rather than `sl_pg.pm25`.

## Retained PostgreSQL workflow

The optional root Compose service initializes `sql/01_schema.sql` on a fresh
volume. It publishes PostgreSQL only at localhost port `5433`, with database and
user `smokeledger`. The included password is for local development only. Run
`npm run db:init` only when deliberately using this legacy store.

These retained fetchers read the shared canonical locations, then write towns
and measurements to PostgreSQL. Invoke their explicit paths from the repository
root so that current source command aliases are not confused with legacy
database writes:

```powershell
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/fetch_firms.ts
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/open_meteo_wind/fetch.ts --location kuala-lumpur
node --experimental-strip-types app/adapters/zetaris/legacy/smokeledger/open_meteo_pm25/fetch.ts --location kuala-lumpur
```

`SMOKELEDGER_DATABASE_URL` in root `.env` overrides the local connection. FIRMS
uses `FIRMS_MAP_KEY`; its retained `FIRMS_DAYS` option accepts 1–10 days. The
legacy fetchers' `--dry-run` still fetches and validates upstream responses but
does not write measurements. This differs from the offline preview used by the
current source ingesters.

The legacy PM2.5 table upserts matching town/time/kind rows when provider
issuance is unknown. `ingested_utc` is local receipt time; it is not a provider
model issue time. These rows do not form an immutable model-run archive.

## Optional Zetaris registration and USL

`sql/02_zetaris_register.sql` exposes this existing PostgreSQL schema as `sl_pg`.
The `host.docker.internal:5433` JDBC address lets Docker Desktop containers
reach the local PostgreSQL port. The related model remains under
`app/adapters/zetaris/usl/smokeledger_usl/`.

Preview its optional bootstrap with:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
```

The real bootstrap starts the optional database, registers its tables, compiles
and activates the legacy USL and runs verification queries. Repeated USL
activation refresh behaviour is unverified. This workflow is not required for
current PM2.5 task execution and does not migrate rows to the new source view.

The schema also retains planned domain tables for concessions, companies,
trajectories, attribution, projections, cases, guidance and agent runs. Their
presence alone does not establish implemented task capabilities. The optional
`sql/03_openmeteo_live_demo.sql` is a historical federation example that still
joins `sl_pg.towns`.
