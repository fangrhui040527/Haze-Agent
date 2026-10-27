# SmokeLedger USL

`smokeledger_usl` defines the same 15 entities as the reference SmokeLedger
schema: `towns`, `fires`, `wind`, `pm25`, `concessions`, `companies`, `runs`,
`trajectory_points`, `attribution`, `projections`, `cases`, `case_events`,
`evidence`, `guidance`, and `agent_runs`. It does not require PostgreSQL or an
`sl_pg` datasource.

Current Zetaris Environmental feeds populate `towns`, `fires`, `wind`, and
`pm25`. The remaining 11 entities are created and activated as typed empty
relations: there is no non-PostgreSQL source in this repository for concession
registries or durable SmokeLedger workflow state. The bootstrap does not invent
records or write application-local SQLite data to Zetaris. Fire IDs are stable
derived keys from acquisition time and coordinates; peat and concession
attribution, source file, and source ingestion time remain null when the source
does not provide them.

The normal USL initializer bootstraps Environmental, Law, and SmokeLedger
together:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts
```

To activate SmokeLedger by itself, the Environmental USL must already be
bootstrapped with its source feeds registered:

```powershell
npm run zetaris:bootstrap:smokeledger
```

The standard bootstrap skips post-bootstrap entity verification queries. To
run the same SmokeLedger bootstrap and then verify the entities explicitly:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl_and_verify.ts --smokeledger-only
```

Use `--dry-run` to preview the SQL without connecting to Zetaris.

The bootstrap is intended for first-time setup. If an earlier four-entity
`smokeledger_usl` is already deployed, `COMPILE USL IF NOT EXISTS` will not
replace its definition. Preview the explicit replacement flow with:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --smokeledger-only --replace-smokeledger --dry-run
```

After confirming the deployed model's contents and ownership, use
`--replace-smokeledger` (optionally with `--test`) to remove and recreate it.
This removes the existing USL, so do not run it without that confirmation.
