# Start the local SmokeLedger PostgreSQL database

SmokeLedger runs in a PostgreSQL container defined in the repository-root
`compose.yaml`. From the repository root, start it with:

```powershell
docker compose up -d smokeledger-db
```

Check that it is running and healthy:

```powershell
docker compose ps smokeledger-db
```

The host port is **5433** and the container's PostgreSQL port is **5432**.
The mapping is `127.0.0.1:5433:5432`, so local clients connect to
`localhost:5433`. Zetaris uses `host.docker.internal:5433` to reach this
database from its container.

The database container must be running for Zetaris's `sl_pg` datasource to
query SmokeLedger tables. Starting Zetaris does not automatically start this
separate service. To view its logs:

```powershell
docker compose logs --tail 50 smokeledger-db
```

Stop the database without deleting its persisted data:

```powershell
docker compose stop smokeledger-db
```

Run `docker compose up -d smokeledger-db` again to restart it. Do not use
`docker compose down -v` unless you intend to delete the persistent
`smokeledger-data` database volume.

This starts an existing database; it does not fetch or refresh PM2.5 data.
For initialization, ingestion, and Zetaris registration instructions, see the
[SmokeLedger database README](../../sources/smokeledger/README.md).
