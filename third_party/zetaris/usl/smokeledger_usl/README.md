# SmokeLedger USL

`smokeledger_usl` is the Zetaris semantic model for the 15 SmokeLedger
PostgreSQL tables. The fetchers write to PostgreSQL; Zetaris's `sl_pg`
datasource exposes the raw tables; this USL gives them a separate namespace
with declared types and relationships.

## Bootstrap

From the repository root, make sure Zetaris is running and
`third_party/zetaris/.env.local` has the Zetaris connection settings. Preview
the ordered setup without changing anything:

```powershell
npm run zetaris:bootstrap:smokeledger -- --dry-run
```

Then initialize PostgreSQL, register datasource `sl_pg`, compile the USL,
activate the tables, and run the sample verification queries:

```powershell
npm run zetaris:bootstrap:smokeledger
```

The script stops at the first failed command. Use `--skip-db-init` if
PostgreSQL is already running, or `--skip-activation` to register and compile
without loading the USL tables.

The USL definitions cover all 15 schema tables, including tables that remain
empty until later data sources or agent workflows populate them. The
bootstrap is intended for first-time setup. Repeated `ACTIVATE USL TABLE`
behavior is not established, so don't assume rerunning activation refreshes
existing USL tables after new data arrives.

The USL definitions cover all 15 schema tables, including tables that remain
empty until later data sources or agent workflows populate them. Compiling
and activating the USL in a live Zetaris instance is a separate step from
creating these SQL files.
