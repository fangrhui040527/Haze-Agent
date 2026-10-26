# Legacy SmokeLedger USL

This optional model mirrors the 15 tables in the retained SmokeLedger
PostgreSQL schema. Its source is the `sl_pg` datasource, and its namespace is
`lightning.metastore.smokeledger.smokeledger_usl`. The retained schema and
fetchers live in [legacy/smokeledger](../../legacy/smokeledger/README.md).

Current source ingestion publishes PM2.5, wind and FIRMS through their provider
folders under `sources/`. The current PM2.5 task reads the published
`air_quality.hourly_observations` snapshot directly; it does not use this model
or require a PostgreSQL service. Preview the current source setup from the
repository root with:

```powershell
npm run zetaris:bootstrap:sources -- --location kuala-lumpur --dry-run
```

## Optional legacy setup

Use this only when deliberately working with the old PostgreSQL-backed store.
With the existing Zetaris connection configured in root `.env`, preview:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
```

After reviewing the plan, running without `--dry-run` starts the optional local
PostgreSQL service, registers `sl_pg`, compiles this model, activates its tables
and runs sample verification queries. `--skip-db-init` leaves the database
service alone; `--skip-activation` registers and compiles without copying table
contents into the USL.

The schema includes domain tables that may remain empty until separate source
or application workflows populate them. Their presence does not establish an
implemented attribution, case-management or other task capability. Repeated
`ACTIVATE USL TABLE` refresh behaviour is unverified; do not assume rerunning the
bootstrap refreshes previously activated copies.

Moving the ingestion code does not remove existing PostgreSQL data, registered
datasources, USL objects or saved task captures. Existing PostgreSQL rows are not
automatically copied into the new FileStore sources.
