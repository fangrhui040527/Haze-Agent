# SmokeLedger USL

The current SmokeLedger USL is a read-only smoke-evidence view over current
Zetaris sources. It exposes `locations`, `fires`, `pm25`, and `wind`, using
Environmental USL records for locations, fires, and PM2.5, plus the published
`wind.hourly_observations` feed. It does not require or start PostgreSQL.

Publish the source snapshots first, including wind:

```powershell
npm run zetaris:bootstrap:sources -- --location kuala-lumpur
```

The normal USL initializer bootstraps Environmental, Law, and SmokeLedger
together:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts
```

To activate SmokeLedger by itself, the Environmental USL must already be
bootstrapped and the source snapshots must already be published:

```powershell
npm run zetaris:bootstrap:smokeledger
```

Use `--dry-run` to preview the SQL without connecting to Zetaris.

This source-backed USL does not include the old PostgreSQL-only tables for
cases, trajectories, attribution, projections, guidance, evidence, or agent
runs. The retained database objects are not dropped or modified by this
bootstrap. If the old PostgreSQL-backed `smokeledger_usl` was already deployed,
an administrator must explicitly remove or migrate that model before deploying
this definition.
