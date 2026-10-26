# SmokeLedger USL

The current SmokeLedger USL is a read-only smoke-evidence view over the
Environmental USL. It exposes source-backed `locations`, `fires`, `pm25`, and
`wind` entities. It uses Zetaris' existing feeds and does not require or start
PostgreSQL.

The normal initializer bootstraps Environmental, Law, and SmokeLedger together:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts
```

To add SmokeLedger while bootstrapping only one other layer, pass
`--with-smokeledger`, for example `--env-only --with-smokeledger`. To activate
SmokeLedger by itself, the Environmental USL must already be bootstrapped:

```powershell
node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_usl.ts --smokeledger-only
```

Use `--dry-run` to preview the SQL without connecting to Zetaris.

This source-backed USL does not include the old PostgreSQL-only tables for
cases, trajectories, attribution, projections, guidance, evidence, or agent
runs. The retained PostgreSQL schema and data are legacy tooling and are not
migrated or modified by this bootstrap.

If the old PostgreSQL-backed `smokeledger_usl` was already deployed to an
instance, this bootstrap does not drop or replace that existing model. Have an
administrator explicitly remove or migrate the old USL before deploying this
definition; its PostgreSQL data is left untouched.
